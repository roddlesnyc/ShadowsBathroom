/* 3D room viewer. Units are inches; plan (x, y) maps to world (x, z), world y is up.
   Relies on globals from index.html: BATHS, el(). */
const View3D = (() => {
  const WALL_H = 96;
  let renderer, scene, camera, controls, host, bathKey, raf = 0, onPick, selId;
  let wallOv = {}, offSet = {}, ceiling = null, picks = [], wallMeshes = [], samples = [], bounds = null, size = [0, 0];
  const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();

  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const c = v => Math.max(0, Math.min(255, Math.round(v * f)));
    return (c(n >> 16) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255);
  };
  const std = (color, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: .55, metalness: 0 }, o));

  /* Tile texture: a canvas holding `per` x `per` tiles with grout lines. */
  function tileTexture(e) {
    const per = e.image ? 1 : 2, px = 128, S = px * per;
    const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const g = cv.getContext("2d"), tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    const gw = Math.max(2, ((+e.grout_w || 0.25) / (+e.tileSize || 2)) * px);
    const draw = img => {
      for (let i = 0; i < per; i++) for (let j = 0; j < per; j++) {
        if (img) g.drawImage(img, i * px, j * px, px, px);
        else { g.fillStyle = "#" + shade(e.color, .93 + Math.random() * .14).toString(16).padStart(6, "0"); g.fillRect(i * px, j * px, px, px); }
      }
      g.strokeStyle = e.grout; g.lineWidth = gw;
      for (let i = 0; i < per; i++) for (let j = 0; j < per; j++) g.strokeRect(i * px, j * px, px, px);
      tex.needsUpdate = true;
    };
    draw(null);
    if (e.image) { const img = new Image(); img.onload = () => draw(img); img.src = e.image; }
    tex.userData = { span: per * (+e.tileSize || 2) };
    return tex;
  }

  function paint(e) {
    if (!e.tile) return std(e.color);
    const m = std(0xffffff, { map: tileTexture(e), roughness: .35 });
    m.userData = { span: m.map.userData.span };
    return m;
  }
  const scaleUV = (geo, su, sv) => {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  };

  function add(mesh, id) {
    scene.add(mesh); mesh.castShadow = mesh.receiveShadow = true;
    if (id) { mesh.userData.id = id; picks.push(mesh); }
    return mesh;
  }
  function box(x, z, w, d, y0, h, mat, id) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x + w / 2, y0 + h / 2, z + d / 2);
    return add(m, id);
  }
  function cyl(rt, rb, h, x, y0, z, mat, id, seg = 24) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y0 + h / 2, z);
    return add(m, id);
  }
  function flatPoly(pts, y, e, id) {
    const geo = new THREE.ShapeGeometry(new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1]))));
    const mat = paint(e);
    if (e.tile) scaleUV(geo, 1 / mat.userData.span, 1 / mat.userData.span);
    geo.rotateX(Math.PI / 2);
    mat.side = THREE.DoubleSide;
    const m = new THREE.Mesh(geo, mat); m.position.y = y;
    return add(m, id);
  }
  const rectPts = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const flatRect = (x, y, w, h, yy, e, id) => flatPoly(rectPts(x, y, w, h), yy, e, id);
  function pathPts(d) {
    const t = d.match(/[MHVLZ]|-?[\d.]+/g), pts = []; let i = 0, x = 0, y = 0;
    while (i < t.length) {
      const c = t[i++];
      if (c === "M" || c === "L") { x = +t[i++]; y = +t[i++]; pts.push([x, y]); }
      else if (c === "H") { x = +t[i++]; pts.push([x, y]); }
      else if (c === "V") { y = +t[i++]; pts.push([x, y]); }
    }
    return pts;
  }
  function vPanel(w, h, cx, cy, cz, rotY, e) {
    const geo = new THREE.PlaneGeometry(w, h), mat = paint(e);
    if (e.tile) scaleUV(geo, w / mat.userData.span, h / mat.userData.span);
    mat.side = THREE.DoubleSide;
    const m = new THREE.Mesh(geo, mat); m.position.set(cx, cy, cz); m.rotation.y = rotY;
    return add(m, null), m;
  }

  /* ---------- scene construction ---------- */
  function clearScene() {
    if (!scene) return;
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { (o.material.map) && o.material.map.dispose(); o.material.dispose(); }
    });
    scene.clear();
  }

  function build(key) {
    const b = BATHS[key], E = id => el(key, id), has = id => b.elements.some(e => e.id === id);
    clearScene(); picks = []; wallMeshes = [];

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b2a8, .85));
    const sun = new THREE.DirectionalLight(0xffffff, .7);
    sun.position.set(80, 200, 60);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 500 });
    scene.add(sun);

    const wE = E("walls"), texCache = {};
    // per-wall tile size / grout overrides fall back to the "all walls" settings
    const wallTex = surf => {
      if (!wE.tile) return null;
      const ov = [].concat(surf || []).map(i => wallOv[i]).find(Boolean) || {};
      const e = Object.assign({}, wE, ov), k = [e.tileSize, e.grout_w, e.grout].join("|");
      return texCache[k] || (texCache[k] = tileTexture(e));
    };
    const wallMat = tex => tex ? std(0xffffff, { map: tex, roughness: .35, transparent: true }) : std(wE.color, { roughness: .9, transparent: true });
    // BoxGeometry faces: +x, -x, +y, -y, +z, -z (4 vertices each)
    const tileBoxUV = (geo, w, h, d, tex) => {
      if (!tex) return;
      const wSpan = tex.userData.span;
      const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]], uv = geo.attributes.uv;
      for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
        const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0] / wSpan, uv.getY(k) * dims[f][1] / wSpan);
      }
    };
    const bedC = has("bedwalls") ? E("bedwalls").color : "#e9e4da";
    const wall = (x, z, w, d, y0, h, paintOnly, surf) => {
      const tex = paintOnly ? null : wallTex(surf);
      const m = box(x, z, w, d, y0, h, paintOnly ? std(bedC, { roughness: .9, transparent: true }) : wallMat(tex));
      if (!paintOnly) tileBoxUV(m.geometry, w, h, d, tex);
      m.userData.c = new THREE.Vector3(x + w / 2, 0, z + d / 2); m.userData.surf = surf; wallMeshes.push(m); return m;
    };

    // bounds from wall footprints
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    [...b.walls3d, ...b.diagWalls.map(d => ({ x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), w: Math.abs(d.x1 - d.x2), h: Math.abs(d.y1 - d.y2) }))].forEach(w => {
      x0 = Math.min(x0, w.x); z0 = Math.min(z0, w.y); x1 = Math.max(x1, w.x + w.w); z1 = Math.max(z1, w.y + w.h);
    });
    bounds = { x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, r: Math.max(x1 - x0, z1 - z0) };

    // walls
    const hid = id => b.surfaces.some(q => q.id === id && q.hidden);
    b.walls3d.forEach(w => { if (!hid(w.s)) wall(w.x, w.y, w.w, w.h, 0, WALL_H, w.paint, w.s); });
    b.diagWalls.forEach(d => {
      const dx = d.x2 - d.x1, dz = d.y2 - d.y1, L = Math.hypot(dx, dz), nx = dz / L, nz = -dx / L;
      const sgn = (nx * (bounds.cx - (d.x1 + d.x2) / 2) + nz * (bounds.cz - (d.y1 + d.y2) / 2)) > 0 ? -1 : 1;
      const geo = new THREE.BoxGeometry(L, WALL_H, 4), tex = wallTex(d.s); tileBoxUV(geo, L, WALL_H, 4, tex);
      const m = new THREE.Mesh(geo, wallMat(tex));
      m.position.set((d.x1 + d.x2) / 2 + sgn * nx * 2, WALL_H / 2, (d.y1 + d.y2) / 2 + sgn * nz * 2);
      m.rotation.y = -Math.atan2(dz, dx);
      add(m); m.userData.c = m.position.clone(); m.userData.surf = d.s; wallMeshes.push(m);
    });

    // window and door openings
    b.openings.forEach(o => {
      if (o.label === "Window") {
        wall(o.x, o.y, o.w, o.h, 0, 36, false, "w-back"); wall(o.x, o.y, o.w, o.h, 72, WALL_H - 72, false, "w-back");
        const glass = new THREE.MeshStandardMaterial({ color: 0xbfe0f0, transparent: true, opacity: .35, roughness: .1 });
        box(o.x, o.y + o.h / 2 - .3, o.w, .6, 36, 36, glass);
        const fr = std(0xffffff);
        box(o.x, o.y + o.h / 2 - .8, o.w, 1.6, 35, 1.5, fr); box(o.x, o.y + o.h / 2 - .8, o.w, 1.6, 71, 1.5, fr);
        box(o.x, o.y + o.h / 2 - .8, 1.5, 1.6, 36, 36, fr); box(o.x + o.w - 1.5, o.y + o.h / 2 - .8, 1.5, 1.6, 36, 36, fr);
      } else {
        const hs = b.surfaces.some(q => q.id === "w-header") ? "w-header" : "w-door";
        if (!hid(hs)) wall(o.x, o.y, o.w, o.h, 80, WALL_H - 80, false, hs);
        const f = has(b.doorFloor) ? E(b.doorFloor) : E("floor");
        flatRect(o.x, o.y, o.w, o.h, .05, f, null);
      }
    });

    // floors
    b.elements.forEach(e0 => {
      const e = E(e0.id);
      if (e.id === "floor") flatPoly(e.shape === "path" ? pathPts(e.d) : rectPts(e.x, e.y, e.w, e.h), 0, e, e.id);
      else if (["nook", "bedroom", "closetfloor", "closetwood"].includes(e.id)) flatRect(e.x, e.y, e.w, e.h, e.id === "closetwood" || e.id === "nook" ? .2 : .1, e, e.id);
    });

    if (has("nookshelves")) {
      const n = E("nook"), wm = std(E("nookshelves").color, { roughness: .6 });
      [18, 34, 50, 66, 82].forEach(y => box(n.x, n.y, n.w - 1, n.h, y, 1.25, wm, "nookshelves"));
    }

    // shower
    const sh = E("shower"), sw = sh.w, sd = sh.h, sx = sh.x, sz = sh.y;
    flatRect(sx, sz, sw, sd, .4, sh, "shower");
    b.showerWalls.forEach(side => {
      if (side === "top") vPanel(sw, WALL_H, sx + sw / 2, WALL_H / 2, sz + .15, 0, sh);
      if (side === "bottom") vPanel(sw, WALL_H, sx + sw / 2, WALL_H / 2, sz + sd - .15, Math.PI, sh);
      if (side === "left") vPanel(sd, WALL_H, sx + .15, WALL_H / 2, sz + sd / 2, Math.PI / 2, sh);
    });
    box(sx + sw - 2, sz, 2, sd, 0, 3, std(shade(sh.color, 1.05)), "shower");
    // fluted glass fixed panel set beside a tiled pillar (open end is the entry)
    const gl = sd * .45, gx = sx + sw, pw = 3, top = WALL_H - 4;
    const glass = new THREE.MeshStandardMaterial({ color: 0xe6efe9, transparent: true, opacity: .4, roughness: .15, depthWrite: false });
    const rib = new THREE.MeshStandardMaterial({ color: 0xf4f8f4, transparent: true, opacity: .45, roughness: .1, depthWrite: false });
    box(gx - .5, sz, .5, gl, 3, top - 3, glass, "showerdoor");
    for (let z = sz + .35; z < sz + gl - .2; z += .7) cyl(.33, .33, top - 3, gx + .1, 3, z, rib, "showerdoor", 8);
    const bn = std(0xb4b0a6, { metalness: .55, roughness: .4 });
    box(gx - .8, sz, 1.2, gl, 2.4, .6, bn, "showerdoor");
    const px = gx - pw, pz = sz + gl;
    box(px, pz, pw, pw, 0, WALL_H, std(sh.color), "shower");
    vPanel(pw, WALL_H, px + pw / 2, WALL_H / 2, pz + pw + .05, 0, sh);
    vPanel(pw, WALL_H, px - .05, WALL_H / 2, pz + pw / 2, -Math.PI / 2, sh);
    vPanel(pw, WALL_H, px + pw + .05, WALL_H / 2, pz + pw / 2, Math.PI / 2, sh);
    box(px, sz, pw, gl, top, WALL_H - top, std(sh.color), "shower");

    // shower valve, arm and head (mounted on the "top" wall)
    if (has("handshower")) {
      const e = E("handshower"), hx = e.x + e.w / 2, hz = e.y, m = std(e.color, { metalness: .55, roughness: .4 });
      box(hx - .6, hz, 1.2, .8, 40, 28, m, "handshower");
      box(hx - 1.2, hz + .8, 2.4, 1.6, 62, 3, m, "handshower");
      const hs = cyl(1.3, 1.1, 8, hx, 0, hz, m, "handshower", 20); hs.position.set(hx, 66, hz + 2.4);
      const hose = cyl(.35, .35, 30, hx, 0, hz, m, "handshower"); hose.position.set(hx + 1.5, 49, hz + 2.2);
    }
    if (has("showerhead")) {
      const e = E("showerhead"), cx = e.x + e.w / 2, wz = e.y, m = std(e.color, { metalness: .55, roughness: .4 });
      box(cx - 3, wz - .2, 6, .8, 45, 6, m, "showerhead");
      const knob = cyl(1.4, 1.4, 2, cx, 0, wz + 1, m, "showerhead"); knob.rotation.x = Math.PI / 2; knob.position.set(cx, 48, wz + 1.5);
      const arm = cyl(.5, .5, 9, cx, 0, wz, m, "showerhead"); arm.rotation.x = Math.PI / 2; arm.position.set(cx, 80, wz + 4.5);
      const head = cyl(4.5, 4.5, .8, cx, 0, wz, m, "showerhead", 32); head.position.set(cx, 79, wz + 9); head.rotation.x = .35;
    }
    if (has("towelwarmer") && E("towelwarmer").mount) {
      const e = E("towelwarmer"), t = e.mount, m = std(e.color, { metalness: .15, roughness: .45 });
      const g = new THREE.Group();
      const part = (geo, x, y, z, material = m) => { const p = new THREE.Mesh(geo, material); p.position.set(x, y, z); p.castShadow = true; p.userData.id = "towelwarmer"; g.add(p); picks.push(p); };
      const sp = t.w - .92, rz = t.d - .4, mountY = t.h / 2 - 3;
      const support = std(shade(e.color, .82), { metalness: .65, roughness: .35 });
      [-sp / 2, sp / 2].forEach(x => {
        part(new THREE.CylinderGeometry(.375, .375, t.h, 16), x, 0, rz);
        const disc = new THREE.CylinderGeometry(1.1, 1.1, .9, 24); disc.rotateX(Math.PI / 2);
        part(disc, x, mountY, .75, support);
        const stem = new THREE.CylinderGeometry(.28, .28, rz - .8, 16); stem.rotateX(Math.PI / 2);
        part(stem, x, mountY, (rz + .8) / 2, support);
      });
      if (t.controller) {
        const c = t.controller, bezel = std(0x111111, { metalness: .25, roughness: .35 });
        const face = std(0x292929, { metalness: .15, roughness: .4 });
        const screen = std(0xc9c9c3, { emissive: 0x111111, roughness: .35 });
        const button = std(0xbabbb8, { metalness: .35, roughness: .3 });
        const dial = new THREE.CylinderGeometry(1.4, 1.4, .75, 32); dial.rotateX(Math.PI / 2);
        part(dial, c.x, c.y, c.z + .4, bezel);
        part(new THREE.CircleGeometry(1.18, 32), c.x, c.y, c.z + .8, face);
        part(new THREE.BoxGeometry(.72, .2, .04), c.x, c.y + .48, c.z + .83, screen);
        [-.42, 0, .42].forEach(x => part(new THREE.CircleGeometry(.15, 16), c.x + x, c.y - .15, c.z + .84, button));
      }
      g.position.set(t.cx, t.bottom + t.h / 2, t.cy);
      g.rotation.y = -Math.atan2(t.uz, t.ux);
      scene.add(g);
    }
    if (has("drain")) { const e = E("drain"); cyl(2.4, 2.4, .3, e.cx, .4, e.cy, std(e.color, { metalness: .6 }), "drain", 32); }

    // vanity, sink and faucet
    const v = E("vanity"), vm = std(v.color, { roughness: .45 });
    let topY = 33.5;
    if (v.tile) {
      const tbox = (e, x, z, w, d, y0, h, id) => {
        const tex = tileTexture(e), span = tex.userData.span, geo = new THREE.BoxGeometry(w, h, d), uv = geo.attributes.uv;
        const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
        for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0] / span, uv.getY(k) * dims[f][1] / span); }
        const m = new THREE.Mesh(geo, std(0xffffff, { map: tex, roughness: .35 }));
        m.position.set(x + w / 2, y0 + h / 2, z + d / 2); return add(m, id);
      };
      topY = 34;
      tbox(v, v.x, v.y, v.w, v.h, 20, 14, "vanity");
      const sh = E("vanityshelf");
      tbox(sh, sh.x, sh.y, sh.w, sh.h, 32, 2, "vanityshelf");
      const wood = std(E("vanitywood").color, { roughness: .6 });
      box(v.x - .5, v.y + 1.5, .5, v.h - 3, 20.75, 5.1, wood, "vanitywood");
      box(v.x - .5, v.y + 1.5, .5, v.h - 3, 26.15, 5.1, wood, "vanitywood");
      // half-circle finger-pull cutouts centered on the top edge of each drawer front
      const cut = std(0x1a1008, { roughness: .9, side: THREE.DoubleSide });
      [25.85, 31.25].forEach(top => {
        const c = new THREE.Mesh(new THREE.CircleGeometry(1.75, 32, Math.PI, Math.PI), cut);
        c.rotation.y = -Math.PI / 2; c.position.set(v.x - .52, top, v.y + v.h / 2);
        add(c, "vanitywood");
      });
    } else {
      box(v.x, v.y, v.w, v.h, 0, 32, vm, "vanity");
      box(v.x - .3, v.y, v.w + .3, v.h, 32, 1.5, std(shade(v.color, 1.6), { roughness: .25 }), "vanity");
      for (let i = 1; i < 3; i++) box(v.x - .2, v.y + v.h * i / 3 - .2, .4, .4, 3, 27, std(shade(v.color, .5)), "vanity");
    }
    const s = E("sink"), pts = [[0, 0], [.5, 0], [.85, .25], [1, .7], [1, 1], [.93, 1], [.93, .7], [.78, .3], [.5, .12], [0, .12]].map(p => new THREE.Vector2(p[0], p[1]));
    if (s.shape === "rect") {
      const sm = std(s.color, { roughness: .5 }), t = .9, h = 5, y0 = topY;
      box(s.x, s.y, s.w, s.h, y0, 1, sm, "sink");
      box(s.x, s.y, s.w, t, y0, h, sm, "sink"); box(s.x, s.y + s.h - t, s.w, t, y0, h, sm, "sink");
      box(s.x, s.y + t, t, s.h - 2 * t, y0, h, sm, "sink"); box(s.x + s.w - t, s.y + t, t, s.h - 2 * t, y0, h, sm, "sink");
    } else {
      const bowl = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), std(s.color, { roughness: .2, side: THREE.DoubleSide }));
      bowl.scale.set(s.rx, 6, s.ry); bowl.position.set(s.cx, topY, s.cy); add(bowl, "sink");
    }
    const f = E("faucet"), fm = std(f.color, f.wall ? { metalness: .55, roughness: .4 } : { metalness: .8, roughness: .2 });
    if (f.wall) {
      const wx = f.x + f.w, fz = f.y + f.h / 2, fy = topY + 10;
      box(wx - 6.75, fz - .6, 6.75, 1.2, fy, 1.2, fm, "faucet");
      for (const dz of [-4.25, 4.25]) {
        box(wx - 1, fz + dz - 1.25, 1, 2.5, fy - 1.25, 2.5, fm, "faucet");
        box(wx - 2.6, fz + dz - .4, 1.6, .8, fy - .4, .8, fm, "faucet");
        box(wx - 3.2, fz + dz - 1.5, .8, 3, fy - .4, .8, fm, "faucet");
      }
    } else {
    const fz = f.y + f.h / 2, fxx = f.x + f.w - 1;
    cyl(.8, .8, 9, fxx, topY, fz, fm, "faucet");
    box(f.dir ? fxx - .5 : fxx - 4.5, fz - .6, 5, 1.2, topY + 8, 1.2, fm, "faucet");
    }

    if (has("mirror")) {
      const e = E("mirror"), mi = e.mirror, f2 = E("faucet"), wx = f2.x + f2.w, cz = mi.cz;
      box(wx - mi.d, cz - mi.w / 2, mi.d, mi.w, mi.bottom, mi.h, std("#2b2b2b", { roughness: .5 }), "mirror");
      const face = box(wx - mi.d - .05, cz - mi.w / 2 + .75, .05, mi.w - 1.5, mi.bottom + .75, mi.h - 1.5, new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#fff3d6", emissiveIntensity: .85, metalness: .1, roughness: .1 }), "mirror");
      face.castShadow = false;
      // backlit glow on the wall around the mirror
      [[1, .55], [3, .3], [5.5, .14]].forEach(([g, op], i) => {
        const h = new THREE.Mesh(new THREE.BoxGeometry(.02, mi.h + g * 2, mi.w + g * 2), new THREE.MeshBasicMaterial({ color: "#fff1cf", transparent: true, opacity: op, depthWrite: false }));
        h.position.set(wx - .03 - i * .005, mi.bottom + mi.h / 2, cz);
        scene.add(h);
      });
      const glow = new THREE.PointLight("#ffe9c2", .9, 90);
      glow.position.set(wx - 12, mi.bottom + mi.h / 2, cz);
      scene.add(glow);
    }

    // toilet (tank at the back wall on the +x side, bowl facing -x)
    const t = E("toilet"), [bx, bz, bw, bd] = t.box, tm = std(t.color, { roughness: .2 });
    const tankD = Math.min(8, bw * .45);
    box(bx + bw - tankD, bz + bd * .1, tankD, bd * .8, 12, 19, tm, "toilet");
    box(bx + bw - tankD - .3, bz + bd * .1 - .3, tankD + .3, bd * .8 + .6, 31, 1, std(shade(t.color, .96)), "toilet");
    const bowlLen = bw - 1, bowlM = cyl(.5, .42, 15, 0, 0, 0, tm, "toilet", 40);
    bowlM.scale.set(bowlLen, 1, bd * .9); bowlM.position.set(bx + bowlLen / 2, 7.5, bz + bd / 2);
    const seat = cyl(.5, .5, 1.6, 0, 0, 0, std(shade(t.color, .97), { roughness: .3 }), "toilet", 40);
    seat.scale.set(bowlLen * 1.02, 1, bd * .93); seat.position.set(bx + bowlLen / 2, 16.5, bz + bd / 2);

    // ceiling (only when the plan defines one); hidden when the camera is above it
    ceiling = null;
    if (has("ceiling")) {
      const c = E("ceiling"), fl = E("floor");
      ceiling = flatPoly(fl.shape === "path" ? pathPts(fl.d) : rectPts(fl.x, fl.y, fl.w, fl.h), WALL_H, c, null);
      ceiling.castShadow = false;
    }

    // points the camera should be able to see (walls blocking them fade out)
    samples = [
      new THREE.Vector3(sx + sw / 2, 40, sz + sd / 2), new THREE.Vector3(bx + bw / 2, 20, bz + bd / 2),
      new THREE.Vector3(v.x + v.w / 2, 30, v.y + v.h / 2), new THREE.Vector3((sx + sw + v.x) / 2, 1, (sz + sd / 2)),
    ];
  }

  /* ---------- camera ---------- */
  function preset(name) {
    if (!bounds) return;
    const { cx, cz } = bounds, r = Math.max(bounds.r, 125);
    controls.target.set(cx, 28, cz);
    camera.fov = 38;
    if (name === "top") { camera.position.set(cx, r * 1.9, cz + .1); controls.target.set(cx, 0, cz); }
    else if (name === "door") {
      const d = BATHS[bathKey].openings.find(o => o.label === "Door");
      const dx = d.x + d.w / 2, dz = d.y + d.h / 2, inward = dz > cz ? -1 : 1;
      camera.fov = 80;
      camera.position.set(dx, 58, dz - inward * 12);
      controls.target.set(dx, 40, dz + inward * 40);
    } else camera.position.set(cx + r * .25, r * 1.4, cz + r * 1.7);
    camera.updateProjectionMatrix();
    controls.update();
  }

  /* Fade any wall that sits between the camera and a point of interest in the room. */
  function fade() {
    const origin = camera.position, ray = new THREE.Ray(), hit = new THREE.Vector3();
    const blocked = new Set();
    wallMeshes.forEach(m => {
      const box = new THREE.Box3().setFromObject(m);
      for (const s of samples) {
        const dir = s.clone().sub(origin), dist = dir.length();
        ray.set(origin, dir.normalize());
        const h = ray.intersectBox(box, hit);
        if (h && origin.distanceTo(h) < dist - 1) { blocked.add(m); break; }
      }
    });
    wallMeshes.forEach(m => {
      const hide = blocked.has(m);
      m.material.opacity = hide ? ([].concat(m.userData.surf || []).some(i => offSet[i]) ? .45 : .1) : 1; m.material.depthWrite = !hide; m.castShadow = !hide;
    });
  }

  function loop() {
    if (!host || !host.isConnected) { raf = 0; return; }
    const w = host.clientWidth, h = host.clientHeight;
    if (w !== size[0] || h !== size[1]) { size = [w, h]; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    controls.update(); fade();
    if (ceiling) ceiling.visible = camera.position.y < WALL_H - 1;
    picks.forEach(m => m.material.emissive && m.material.emissive.setHex(m.userData.id === "floor" && offSet.floor ? 0xffffff : m.userData.id === selId && m.userData.id !== "floor" ? 0x3a1414 : 0));
    wallMeshes.forEach(m => {
      const ids = [].concat(m.userData.surf || []), off = ids.some(i => offSet[i]);
      m.material.color.setHex(off ? 0 : (m.userData.col == null ? (m.userData.col = m.material.color.getHex()) : m.userData.col));
      m.material.emissive.setHex(off ? 0xffffff : 0);
    });
    if (ceiling) { ceiling.material.emissive.setHex(offSet.ceiling ? 0xffffff : 0); if (offSet.ceiling) ceiling.material.color.setHex(0); }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    scene = new THREE.Scene(); scene.background = new THREE.Color(0xeef0f3);
    camera = new THREE.PerspectiveCamera(38, 1, 1, 3000);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - .01; controls.minDistance = 15; controls.maxDistance = 600;
    let down = null;
    renderer.domElement.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !onPick) return;
      const r = renderer.domElement.getBoundingClientRect();
      mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(mouse, camera);
      const hit = raycaster.intersectObjects(picks, false)[0];
      if (hit) onPick(hit.object.userData.id);
    });
  }

  function mount(container, key, sel, pickCb) {
    if (!renderer) init();
    onPick = pickCb; selId = sel;
    const fresh = key !== bathKey;
    host = container; host.appendChild(renderer.domElement); size = [0, 0];
    bathKey = key;
    build(key);
    if (fresh) preset("corner");
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function setOff(o) { offSet = o || {}; }
  function setWallOv(o) { wallOv = o || {}; }
  return { mount, preset, setOff, setWallOv };
})();
