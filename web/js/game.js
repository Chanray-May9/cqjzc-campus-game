/* =============================================================================
 *  重庆建筑工程职业学院 · 东站校区  —  自由漫游 (GTA-style free roam)
 *
 *  Terrain maths mirror blender/build_campus.py so the collision surface and
 *  the rendered mesh agree exactly.
 * ========================================================================== */
(function () {
  'use strict';

  /* Height configuration comes from the same build as the visible GLB. */
  let terrain = null;
  let CAMPUS = null;
  function groundAt(X,Z) { return terrain ? terrain.ground(X,Z) : 0; }
  function clamp(v,a,b) { return Math.max(a,Math.min(b,v)); }
  function smoothstep(a,b,v) { const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t); }

  /* ------------------------------------------------------------- helpers --- */
  const $ = (s) => document.querySelector(s);
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function damp(a, b, l, dt) { return lerp(a, b, 1 - Math.exp(-l * dt)); }
  function angLerp(a, b, t) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  /* ------------------------------------------------------------ globals --- */
  const G = {
    meta: null,
    scene: null, camera: null, renderer: null, clock: null,
    colliders: [], grid: new Map(), CELL: 40,
    player: null, cars: [], activeCar: null,
    keys: {}, yaw: 0, pitch: -0.16, camDist: 7.2, camMode: 0,
    time: 8.0, autoTime: true,
    started: false, paused: false,
    matFacade: null, matGlass: null, night: 0,
    sun: null, hemi: null, amb: null,
    toastT: 0,
  };

  /* -------------------------------------------------------- collisions --- */
  function key(cx, cz) { return cx + ',' + cz; }

  function buildGrid(colliders) {
    G.grid.clear();
    for (const c of colliders) {
      const cs=Math.abs(Math.cos(c.rot)),sn=Math.abs(Math.sin(c.rot));
      const hw=(c.w*cs+c.d*sn)/2+1.5,hd=(c.w*sn+c.d*cs)/2+1.5;
      const x0 = Math.floor((c.px - hw) / G.CELL), x1 = Math.floor((c.px + hw) / G.CELL);
      const z0 = Math.floor((c.pz - hd) / G.CELL), z1 = Math.floor((c.pz + hd) / G.CELL);
      for (let i = x0; i <= x1; i++) {
        for (let j = z0; j <= z1; j++) {
          const k = key(i, j);
          let a = G.grid.get(k);
          if (!a) { a = []; G.grid.set(k, a); }
          a.push(c.id);
        }
      }
    }
  }
  function nearColliders(X, Z) {
    const i = Math.floor(X / G.CELL), j = Math.floor(Z / G.CELL);
    const out = [];
    const seen = new Set();
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const arr = G.grid.get(key(i + a, j + b));
        if (!arr) continue;
        for (const id of arr) if (!seen.has(id)) { seen.add(id); out.push(G.byId.get(id)); }
      }
    }
    return out;
  }

  /* Resolve a vertical capsule against one rotated box.
   * Returns {pushX, pushZ, standY} or null. */
  function collideBox(c, X, Z, feetY, headY, radius) {
    const dx = X - c.px, dz = Z - c.pz;
    const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
    const lx = dx * cs - dz * sn;
    const lz = dx * sn + dz * cs;
    const hw = c.w / 2, hd = c.d / 2;
    const top = c.py + c.h / 2, bot = c.py - c.h / 2;

    if (feetY >= top - 0.45 && feetY <= top + 1.2) {
      // horizontally over the roof?
      if (Math.abs(lx) < hw + radius * 0.4 && Math.abs(lz) < hd + radius * 0.4) {
        return { standY: top };
      }
    }
    if (headY < bot || feetY > top) return null;

    const qx = clamp(lx, -hw, hw), qz = clamp(lz, -hd, hd);
    let px = lx - qx, pz = lz - qz;
    let d = Math.hypot(px, pz);
    let nlx, nlz;
    if (d > 1e-5) {
      if (d >= radius) return null;
      nlx = px / d; nlz = pz / d;
      const need = radius - d;
      px = nlx * need; pz = nlz * need;
    } else {
      // centre inside: escape along the shallowest axis
      const ox = hw - Math.abs(lx), oz = hd - Math.abs(lz);
      if (ox < oz) { px = (lx >= 0 ? 1 : -1) * (ox + radius); pz = 0; }
      else { px = 0; pz = (lz >= 0 ? 1 : -1) * (oz + radius); }
    }
    const wx = px * Math.cos(c.rot) - pz * Math.sin(c.rot);
    const wz = px * Math.sin(c.rot) + pz * Math.cos(c.rot);
    return { pushX: wx, pushZ: wz };
  }

  /* --------------------------------------------------------------- sky --- */
  const SKY_DAY = new THREE.Color(0x8fb6dd);
  const SKY_DUSK = new THREE.Color(0xd98a55);
  const SKY_NIGHT = new THREE.Color(0x070c18);

  function updateSky() {
    const t = G.time;                       // hours
    const sunAlt = Math.sin((t - 6) / 12 * Math.PI);   // -1..1, >0 = day
    G.night = clamp(1 - (sunAlt + 0.12) / 0.42, 0, 1);

    if (!G.sky) G.sky = new THREE.Color();
    if (sunAlt > 0.22) G.sky.copy(SKY_DAY);
    else if (sunAlt > -0.08) G.sky.copy(SKY_DUSK).lerp(SKY_DAY, (sunAlt + 0.08) / 0.30);
    else G.sky.copy(SKY_NIGHT).lerp(SKY_DUSK, clamp((sunAlt + 0.35) / 0.27, 0, 1));
    G.scene.background = G.sky;
    G.scene.fog.color.copy(G.sky);

    const dayI = clamp(sunAlt * 1.6, 0, 1);
    if (G.sun) {
      const a = (t - 6) / 12 * Math.PI;
      G.sun.position.set(Math.cos(a) * 300 + 80, Math.max(Math.sin(a), -0.2) * 320 + 40,
        Math.sin(a * 0.6) * 180 - 120);
      G.sun.intensity = 0.12 + dayI * 2.6;
      G.sun.color.setHSL(0.10 - 0.02 * dayI, 0.35 - 0.25 * dayI, 0.62 + 0.16 * dayI);
    }
    if (G.hemi) G.hemi.intensity = 0.16 + dayI * 0.55;
    if (G.amb) G.amb.intensity = 0.10 + dayI * 0.30;

    if (G.matFacade) G.matFacade.emissiveIntensity = G.night * 1.25;
    if (G.matGlass) G.matGlass.emissiveIntensity = G.night * 0.30;
  }

  /* ------------------------------------------------------------- models --- */
  function mat(color, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({
      color: color, roughness: 0.6, metalness: 0.15
    }, opts || {}));
  }

  function buildHuman() {
    const g = new THREE.Group();
    const skin = mat(0xd9a97e, { roughness: 0.85 });
    const cloth = mat(0x2b5f8f, { roughness: 0.9 });
    const trous = mat(0x28323e, { roughness: 0.95 });
    const shoe = mat(0x1a1d21, { roughness: 0.8 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.58, 0.23), cloth);
    torso.position.y = 1.24; g.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.20, 0.22), trous);
    hips.position.y = 0.90; g.add(hips);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.11), skin);
    neck.position.y = 1.57; g.add(neck);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.24, 0.21), skin);
    head.position.y = 1.73; g.add(head);
    const hair = new THREE.Mesh(new THREE.BoxGeometry(0.215, 0.11, 0.225), mat(0x1d1a18));
    hair.position.y = 1.83; g.add(hair);

    function limb(w, h, d, m, px, py) {
      const pivot = new THREE.Group();
      pivot.position.set(px, py, 0);
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      box.position.y = -h / 2;
      pivot.add(box);
      g.add(pivot);
      return pivot;
    }
    const armL = limb(0.105, 0.52, 0.105, cloth, 0.255, 1.49);
    const armR = limb(0.105, 0.52, 0.105, cloth, -0.255, 1.49);
    const legL = limb(0.135, 0.82, 0.145, trous, 0.105, 0.86);
    const legR = limb(0.135, 0.82, 0.145, trous, -0.105, 0.86);
    const shoeL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.09, 0.24), shoe);
    shoeL.position.set(0, -0.845, 0.035); legL.add(shoeL);
    const shoeR = shoeL.clone(); legR.add(shoeR);

    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { group: g, armL, armR, legL, legR, torso };
  }

  const CAR_SPEC = {
    sedan: { len: 4.50, wid: 1.82, bodyH: 0.62, bodyY: 0.72, cabin: [1.62, 0.56, 2.05], cabinY: 1.28, cabinZ: -0.16, wr: 0.32, ww: 0.24, wb: 1.42, acc: 9.5, top: 30 },
    suv: { len: 4.78, wid: 1.94, bodyH: 0.76, bodyY: 0.86, cabin: [1.74, 0.70, 2.35], cabinY: 1.52, cabinZ: -0.10, wr: 0.38, ww: 0.28, wb: 1.50, acc: 8.4, top: 27 },
    van: { len: 5.20, wid: 1.98, bodyH: 1.05, bodyY: 1.02, cabin: [1.80, 0.86, 3.10], cabinY: 1.86, cabinZ: -0.30, wr: 0.35, ww: 0.26, wb: 1.66, acc: 6.6, top: 23 },
  };

  function buildCar(kind, colorHex) {
    const s = CAR_SPEC[kind] || CAR_SPEC.sedan;
    const g = new THREE.Group();
    const paint = mat(new THREE.Color(colorHex), { roughness: 0.34, metalness: 0.42 });
    const dark = mat(0x14181d, { roughness: 0.35, metalness: 0.2 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x1a2833, roughness: 0.1, metalness: 0.55,
      emissive: 0x0a1018, emissiveIntensity: 0.4
    });

    const body = new THREE.Mesh(new THREE.BoxGeometry(s.wid, s.bodyH, s.len), paint);
    body.position.y = s.bodyY; g.add(body);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(s.wid - 0.10, 0.22, s.len - 0.30), dark);
    skirt.position.y = s.bodyY - s.bodyH / 2 - 0.02; g.add(skirt);

    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(s.cabin[0], s.cabin[1], s.cabin[2]), paint);
    cab.position.set(0, s.cabinY, s.cabinZ); g.add(cab);
    const win = new THREE.Mesh(
      new THREE.BoxGeometry(s.cabin[0] + 0.02, s.cabin[1] * 0.62, s.cabin[2] + 0.02), glass);
    win.position.set(0, s.cabinY + 0.04, s.cabinZ); g.add(win);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(s.cabin[0] + 0.04, 0.07, s.cabin[2] + 0.04), paint);
    roof.position.set(0, s.cabinY + s.cabin[1] / 2 + 0.02, s.cabinZ); g.add(roof);

    const wheelGeo = new THREE.CylinderGeometry(s.wr, s.wr, s.ww, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const tyre = mat(0x0e1114, { roughness: 0.95, metalness: 0.0 });
    const rimGeo = new THREE.CylinderGeometry(s.wr * 0.55, s.wr * 0.55, s.ww + 0.02, 12);
    rimGeo.rotateZ(Math.PI / 2);
    const rim = mat(0xa9b0b8, { roughness: 0.3, metalness: 0.8 });
    const wheels = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const w = new THREE.Group();
        w.add(new THREE.Mesh(wheelGeo, tyre));
        w.add(new THREE.Mesh(rimGeo, rim));
        w.position.set(sx * (s.wid / 2 - 0.06), s.wr, sz * s.wb);
        g.add(w);
        wheels.push(w);
      }
    }
    const hl = new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xffe9b0, emissiveIntensity: 0.9 });
    const tl = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2a12, emissiveIntensity: 0.6 });
    for (const sx of [-1, 1]) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.06), hl);
      a.position.set(sx * (s.wid / 2 - 0.34), s.bodyY + 0.10, -s.len / 2 - 0.01); g.add(a);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.14, 0.06), tl);
      b.position.set(sx * (s.wid / 2 - 0.32), s.bodyY + 0.14, s.len / 2 + 0.01); g.add(b);
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x2a52a0, roughness: 0.6 }));
    plate.position.set(0, s.bodyY - 0.16, s.len / 2 + 0.02); g.add(plate);

    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return { group: g, wheels, spec: s };
  }

  /* ------------------------------------------------------------ player --- */
  const PLAYER = {
    radius: 0.34, height: 1.80, eye: 1.62,
    walk: 4.6, run: 9.0, jump: 8.2, gravity: -22,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    grounded: true, animT: 0, inCar: false,
  };

  function spawnPlayer() {
    const s = G.meta.spawn;
    PLAYER.pos.set(s.x, groundAt(s.x, s.z) + 0.05, s.z);
    PLAYER.vel.set(0, 0, 0);
  }

  function movePlayer(dt) {
    const camYaw = G.yaw;
    let fx = 0, fz = 0;
    if (G.keys['KeyW'] || G.keys['ArrowUp']) fz -= 1;
    if (G.keys['KeyS'] || G.keys['ArrowDown']) fz += 1;
    if (G.keys['KeyA'] || G.keys['ArrowLeft']) fx -= 1;
    if (G.keys['KeyD'] || G.keys['ArrowRight']) fx += 1;
    const len = Math.hypot(fx, fz);
    if (len > 0) { fx /= len; fz /= len; }

    const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
    const wx = fx * cos + fz * sin;
    const wz = -fx * sin + fz * cos;

    const sprint = G.keys['ShiftLeft'] || G.keys['ShiftRight'];
    const speed = sprint ? PLAYER.run : PLAYER.walk;

    const accel = PLAYER.grounded ? 42 : 9;
    PLAYER.vel.x = damp(PLAYER.vel.x, wx * speed, accel * 0.22, dt);
    PLAYER.vel.z = damp(PLAYER.vel.z, wz * speed, accel * 0.22, dt);

    if (G.keys['Space'] && PLAYER.grounded) {
      PLAYER.vel.y = PLAYER.jump;
      PLAYER.grounded = false;
    }
    PLAYER.vel.y += PLAYER.gravity * dt;

    PLAYER.pos.x += PLAYER.vel.x * dt;
    PLAYER.pos.z += PLAYER.vel.z * dt;
    PLAYER.pos.y += PLAYER.vel.y * dt;

    // --- colliders -------------------------------------------------------
    const feet = PLAYER.pos.y;
    const head = feet + PLAYER.height;
    let bestStand = -Infinity;
    const cands = nearColliders(PLAYER.pos.x, PLAYER.pos.z);
    for (let pass = 0; pass < 2; pass++) {
      for (const c of cands) {
        const r = collideBox(c, PLAYER.pos.x, PLAYER.pos.z, feet, head, PLAYER.radius);
        if (!r) continue;
        if (r.standY !== undefined) { bestStand = Math.max(bestStand, r.standY); continue; }
        PLAYER.pos.x += r.pushX; PLAYER.pos.z += r.pushZ;
      }
    }
    // --- ground ----------------------------------------------------------
    const g = groundAt(PLAYER.pos.x, PLAYER.pos.z);
    let floor = g;
    if (bestStand > -Infinity && PLAYER.vel.y <= 0.01 && bestStand >= g - 0.6) floor = bestStand;
    if (PLAYER.pos.y <= floor + 0.001) {
      PLAYER.pos.y = floor;
      if (PLAYER.vel.y < 0) PLAYER.vel.y = 0;
      PLAYER.grounded = true;
    } else {
      PLAYER.grounded = false;
    }
    if (PLAYER.pos.y < g - 0.05 && bestStand <= -Infinity) {
      PLAYER.pos.y = g; PLAYER.vel.y = 0; PLAYER.grounded = true;
    }

    // --- animation -------------------------------------------------------
    const hs = Math.hypot(PLAYER.vel.x, PLAYER.vel.z);
    PLAYER.animT += dt * (2.4 + hs * 1.15);
    const amp = clamp(hs / PLAYER.run, 0, 1);
    const sw = Math.sin(PLAYER.animT * 3.4) * amp;
    const body = G.playerMesh;
    body.legL.rotation.x = sw * 1.05;
    body.legR.rotation.x = -sw * 1.05;
    body.armL.rotation.x = -sw * 0.85;
    body.armR.rotation.x = sw * 0.85;
    body.torso.rotation.y = -sw * 0.10;
    const bob = G.playerMesh.group.position;
    if (!PLAYER.grounded) {
      body.armL.rotation.x = -1.5; body.armR.rotation.x = -1.5;
      body.legL.rotation.x = 0.4; body.legR.rotation.x = -0.3;
    }
    G.playerMesh.group.position.set(PLAYER.pos.x, PLAYER.pos.y + Math.abs(sw) * 0.035 * amp, PLAYER.pos.z);
    G.playerMesh.group.rotation.y = G.yaw + Math.PI;
  }

  /* ------------------------------------------------------------ vehicle --- */
  function CarState(v) {
    return {
      id: v.id, kind: v.kind, color: v.color,
      pos: new THREE.Vector3(v.x, groundAt(v.x, v.z), v.z),
      yaw: v.yaw || 0, speed: 0, steer: 0,
      spec: CAR_SPEC[v.kind] || CAR_SPEC.sedan,
      mesh: null, wheelSpin: 0,
    };
  }

  function driveCar(car, dt) {
    const s = car.spec;
    const fwd = (G.keys['KeyW'] || G.keys['ArrowUp']) ? 1 : 0;
    const back = (G.keys['KeyS'] || G.keys['ArrowDown']) ? 1 : 0;
    const left = (G.keys['KeyA'] || G.keys['ArrowLeft']) ? 1 : 0;
    const right = (G.keys['KeyD'] || G.keys['ArrowRight']) ? 1 : 0;
    const hand = G.keys['Space'] ? 1 : 0;
    const boost = (G.keys['ShiftLeft'] || G.keys['ShiftRight']) ? 1 : 0;

    const targetSteer = (left - right) * (1 - clamp(Math.abs(car.speed) / (s.top * 1.1), 0, 0.55));
    car.steer = damp(car.steer, targetSteer, 9, dt);

    if (fwd) car.speed += s.acc * (boost ? 1.35 : 1) * dt;
    else if (back) {
      if (car.speed > 0.6) car.speed -= s.acc * 1.9 * dt;
      else car.speed -= s.acc * 0.55 * dt;
    }
    if (hand) car.speed -= Math.sign(car.speed) * 16 * dt;

    const drag = hand ? 3.4 : 0.55;
    car.speed -= car.speed * drag * dt * 0.55;
    car.speed -= Math.sign(car.speed) * 0.9 * dt;
    if (Math.abs(car.speed) < 0.06) car.speed = 0;
    car.speed = clamp(car.speed, -s.top * 0.42, s.top * (boost ? 1.15 : 1));

    const grip = hand ? 1.75 : 1.0;
    car.yaw -= car.steer * 1.75 * grip * dt * clamp(Math.abs(car.speed) / 7, 0, 1.4)
      * Math.sign(car.speed || 1);

    const nx = car.pos.x - Math.sin(car.yaw) * car.speed * dt;
    const nz = car.pos.z - Math.cos(car.yaw) * car.speed * dt;

    // ---- collide with buildings (circle of radius ~1.3) ----------------
    const R = 1.30;
    let hit = false;
    for (const c of nearColliders(nx, nz)) {
      const dx = nx - c.px, dz = nz - c.pz;
      const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const hw = c.w / 2, hd = c.d / 2;
      const bot = c.py - c.h / 2, top = c.py + c.h / 2;
      if (top < car.pos.y + 0.25) continue;
      if (bot > car.pos.y + 2.2) continue;
      const qx = clamp(lx, -hw, hw), qz = clamp(lz, -hd, hd);
      const ox = lx - qx, oz = lz - qz;
      const d = Math.hypot(ox, oz);
      if (d < R) {
        hit = true;
        let pxl, pzl;
        if (d > 1e-5) { const need = (R - d) / d; pxl = ox * need; pzl = oz * need; }
        else {
          const ex = hw - Math.abs(lx), ez = hd - Math.abs(lz);
          if (ex < ez) { pxl = (lx >= 0 ? 1 : -1) * (ex + R); pzl = 0; }
          else { pxl = 0; pzl = (lz >= 0 ? 1 : -1) * (ez + R); }
        }
        const wx = pxl * Math.cos(c.rot) - pzl * Math.sin(c.rot);
        const wz = pxl * Math.sin(c.rot) + pzl * Math.cos(c.rot);
        car.pos.x += wx; car.pos.z += wz;
      }
    }
    if (!hit) { car.pos.x = nx; car.pos.z = nz; }
    else { car.speed *= -0.16; }

    // ---- ground / attitude --------------------------------------------
    const gy = groundAt(car.pos.x, car.pos.z);
    car.pos.y = damp(car.pos.y, gy, 12, dt);

    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const ahead = groundAt(car.pos.x + fx * s.wb, car.pos.z + fz * s.wb);
    const behind = groundAt(car.pos.x - fx * s.wb, car.pos.z - fz * s.wb);
    const pitch = Math.atan2(ahead - behind, s.wb * 2);
    const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
    const rgt = groundAt(car.pos.x + rx * s.wid / 2, car.pos.z + rz * s.wid / 2);
    const lft = groundAt(car.pos.x - rx * s.wid / 2, car.pos.z - rz * s.wid / 2);
    const roll = Math.atan2(rgt - lft, s.wid);

    car.wheelSpin += car.speed / s.wr * dt;
    const m = car.mesh;
    m.group.position.copy(car.pos);
    m.group.rotation.set(pitch, car.yaw, roll, 'YXZ');
    for (const w of m.wheels) {
      w.rotation.x = car.wheelSpin;
      w.rotation.y = (w.position.z < 0) ? car.steer * 0.42 : 0;
    }
  }

  function nearestCar() {
    let best = null, bd = 4.2;
    for (const c of G.cars) {
      const d = Math.hypot(c.pos.x - PLAYER.pos.x, c.pos.z - PLAYER.pos.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  function enterCar(car) {
    G.activeCar = car;
    PLAYER.inCar = true;
    G.playerMesh.group.visible = false;
    setCamMode(1);
    toast('已上车 · ' + (car.kind === 'van' ? '面包车' : car.kind === 'suv' ? 'SUV' : '轿车'));
  }
  function exitCar() {
    const car = G.activeCar;
    if (!car) return;
    const ox = Math.cos(car.yaw) * 1.9, oz = -Math.sin(car.yaw) * 1.9;
    let X = car.pos.x + ox, Z = car.pos.z + oz;
    const gy = groundAt(X, Z);
    PLAYER.pos.set(X, Math.max(gy, car.pos.y), Z);
    PLAYER.vel.set(0, 0, 0);
    PLAYER.inCar = false;
    G.activeCar = null;
    G.playerMesh.group.visible = true;
    setCamMode(0);
    toast('已下车');
  }

  /* ------------------------------------------------------------- camera --- */
  function setCamMode(m) { G.camMode = m % 3; }

  function updateCamera(dt) {
    const follow = PLAYER.inCar && G.activeCar
      ? tmpV.copy(G.activeCar.pos).add(tmpV2.set(0, 1.5, 0))
      : tmpV.copy(PLAYER.pos).add(tmpV2.set(0, PLAYER.eye, 0));

    if (G.camMode === 2) {                       // first person
      const dir = new THREE.Vector3(
        -Math.sin(G.yaw) * Math.cos(G.pitch),
        Math.sin(G.pitch),
        -Math.cos(G.yaw) * Math.cos(G.pitch));
      G.camera.position.copy(follow).addScaledVector(dir, 0.22);
      G.camera.lookAt(tmpV2.copy(follow).addScaledVector(dir, 12));
      return;
    }

    let dist = PLAYER.inCar ? G.camDist + 3.4 : G.camDist;
    const cp = Math.cos(G.pitch), sp = Math.sin(G.pitch);
    const dir = new THREE.Vector3(
      Math.sin(G.yaw) * cp, -sp, Math.cos(G.yaw) * cp).normalize();

    // pull in when the line of sight is blocked
    let want = dist;
    for (let i = 1; i <= 10; i++) {
      const t = dist * i / 10;
      const px = follow.x + dir.x * t, pz = follow.z + dir.z * t;
      const py = follow.y + dir.y * t;
      if (py < groundAt(px, pz) + 0.5) { want = Math.max(1.4, t - 0.4); break; }
      let blocked = false;
      for (const c of nearColliders(px, pz)) {
        const dx = px - c.px, dz = pz - c.pz;
        const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
        if (Math.abs(lx) < c.w / 2 + 0.4 && Math.abs(lz) < c.d / 2 + 0.4 &&
          py > c.py - c.h / 2 && py < c.py + c.h / 2) { blocked = true; break; }
      }
      if (blocked) { want = Math.max(1.4, t - 0.5); break; }
    }
    G.camSmooth = damp(G.camSmooth == null ? want : G.camSmooth, want, 14, dt);

    G.camera.position.set(
      follow.x + dir.x * G.camSmooth,
      follow.y + dir.y * G.camSmooth,
      follow.z + dir.z * G.camSmooth);
    G.camera.lookAt(follow);
    if (G.camSmooth < 3.0) G.playerMesh.group.visible = !PLAYER.inCar ? true : false;
  }

  /* ---------------------------------------------------------------- HUD --- */
  const HUD = {};
  let toastTimer = 0;

  function toast(msg) {
    HUD.toast.textContent = msg;
    HUD.toast.style.opacity = '1';
    toastTimer = 2.2;
  }

  function placeName() {
    let best = null, bd = 90;
    const px = PLAYER.inCar && G.activeCar ? G.activeCar.pos.x : PLAYER.pos.x;
    const pz = PLAYER.inCar && G.activeCar ? G.activeCar.pos.z : PLAYER.pos.z;
    for (const p of G.meta.pois) {
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? best.name : '东站校区';
  }

  function drawMinimap() {
    const cv = HUD.minimap, ctx = HUD.mapCtx;
    const W = cv.width, H = cv.height;
    const cx = W / 2, cy = H / 2;
    const px = PLAYER.inCar && G.activeCar ? G.activeCar.pos.x : PLAYER.pos.x;
    const pz = PLAYER.inCar && G.activeCar ? G.activeCar.pos.z : PLAYER.pos.z;
    const heading = PLAYER.inCar && G.activeCar ? G.activeCar.yaw : G.yaw;
    const scale = W / 330;                       // 330 m across

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#12202c';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading);
    ctx.translate(-px * scale, pz * scale);

    // campus grass
    ctx.fillStyle = '#1d3324';
    ctx.fillRect(CAMPUS.x0 * scale, -CAMPUS.y1 * scale,
      (CAMPUS.x1 - CAMPUS.x0) * scale, (CAMPUS.y1 - CAMPUS.y0) * scale);

    // roads
    ctx.strokeStyle = '#3c4650';
    ctx.lineCap = 'round';
    for (const r of G.meta.roads) {
      ctx.lineWidth = Math.max(2, r.w * scale);
      ctx.beginPath();
      r.pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p[0] * scale, p[1] * scale);
        else ctx.lineTo(p[0] * scale, p[1] * scale);
      });
      if (r.closed) ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(220,225,230,.35)';
    ctx.lineWidth = 1.4;
    for (const r of G.meta.roads) {
      ctx.beginPath();
      r.pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p[0] * scale, p[1] * scale);
        else ctx.lineTo(p[0] * scale, p[1] * scale);
      });
      if (r.closed) ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // buildings
    for (const c of G.meta.colliders) {
      ctx.save();
      ctx.translate(c.px * scale, c.pz * scale);
      ctx.rotate(-c.rot);
      ctx.fillStyle = c.id === 'b07' ? '#d8d2c4' : '#c9cfd6';
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1;
      ctx.fillRect(-c.w / 2 * scale, -c.d / 2 * scale, c.w * scale, c.d * scale);
      ctx.strokeRect(-c.w / 2 * scale, -c.d / 2 * scale, c.w * scale, c.d * scale);
      ctx.restore();
    }
    // track
    const tr = G.meta.pois.find(p => p.id === 'track');
    if (tr) {
      ctx.strokeStyle = '#b8443a';
      ctx.lineWidth = 9 * scale;
      ctx.beginPath();
      ctx.ellipse(tr.x * scale, tr.z * scale, 83.8 * scale, 51.8 * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // vehicles
    for (const c of G.cars) {
      ctx.fillStyle = c === G.activeCar ? '#ffd479' : '#7fd6ff';
      ctx.beginPath();
      ctx.arc(c.pos.x * scale, c.pos.z * scale, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // player arrow
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(7.5, 9); ctx.lineTo(0, 5); ctx.lineTo(-7.5, 9);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // ring + north mark
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, W / 2 - 5, 0, Math.PI * 2); ctx.stroke();
  }

  function updateHUD(dt) {
    const kph = PLAYER.inCar && G.activeCar
      ? Math.abs(G.activeCar.speed) * 3.6
      : Math.hypot(PLAYER.vel.x, PLAYER.vel.z) * 3.6 * 0.42;
    HUD.speed.textContent = Math.round(kph);
    HUD.gear.textContent = PLAYER.inCar
      ? (G.activeCar.speed < -0.4 ? '倒车' : '驾驶 · ' + G.activeCar.kind.toUpperCase())
      : '步行';
    HUD.place.textContent = placeName();
    const hh = Math.floor(G.time) % 24, mm = Math.floor((G.time % 1) * 60);
    HUD.clock.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
      + (G.night > 0.5 ? ' · 夜' : ' · 昼');

    // compass
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const deg = ((-G.yaw * 180 / Math.PI) % 360 + 360) % 360;
    HUD.compass.textContent = dirs[Math.round(deg / 45) % 8] + '  ' + Math.round(deg) + '°';

    // prompts
    let pr = '';
    if (!PLAYER.inCar) {
      const c = nearestCar();
      if (c) pr = '<b>F</b> 上车';
      else if (nearPOI()) pr = '按 <b>C</b> 切换视角';
    } else {
      pr = '<b>F</b> 下车 &nbsp;·&nbsp; <b>Space</b> 手刹';
    }
    HUD.prompt.innerHTML = pr;
    HUD.prompt.style.display = pr ? 'block' : 'none';

    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) HUD.toast.style.opacity = '0';
    }
    drawMinimap();
  }
  function nearPOI() { return false; }

  /* -------------------------------------------------------------- input --- */
  function bindInput(dom) {
    window.addEventListener('keydown', (e) => {
      G.keys[e.code] = true;
      if (e.code === 'KeyF') {
        if (PLAYER.inCar) exitCar();
        else { const c = nearestCar(); if (c) enterCar(c); }
      }
      if (e.code === 'KeyC') {
        if (!PLAYER.inCar) setCamMode((G.camMode + 1) % 3);
      }
      if (e.code === 'KeyH') $('#help').classList.toggle('min');
      if (e.code === 'KeyN') G.time = (G.time + 6) % 24;
      if (e.code === 'Escape') document.exitPointerLock();
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { G.keys[e.code] = false; });
    window.addEventListener('blur', () => { G.keys = {}; });

    dom.addEventListener('mousedown', (e) => {
      if (!G.started) return;
      if (document.pointerLockElement !== dom) {
        const p = dom.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      }
      if (e.button === 2) setCamMode((G.camMode + 1) % 3);
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      G.yaw -= e.movementX * 0.0026;
      G.pitch = clamp(G.pitch - e.movementY * 0.0022, -0.95, 0.72);
    });
    dom.addEventListener('wheel', (e) => {
      G.camDist = clamp(G.camDist + e.deltaY * 0.006, 2.6, 16);
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    G.camera.aspect = window.innerWidth / window.innerHeight;
    G.camera.updateProjectionMatrix();
    G.renderer.setSize(window.innerWidth, window.innerHeight);
    G.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
  }

  /* --------------------------------------------------------------- boot --- */
  function setProgress(p, msg) {
    $('#barfill').style.width = (p * 100).toFixed(0) + '%';
    if (msg) $('#bootmsg').textContent = msg;
  }

  function fatal(msg) {
    const e = $('#err');
    e.style.display = 'flex';
    e.innerHTML = msg;
    $('#boot').classList.add('ready');
  }

  function initRenderer() {
    const canvas = $('#gl');
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas, antialias: true, powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    G.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x9fc0e0, 260, 1500);
    G.scene = scene;

    const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 4000);
    G.camera = camera;

    const hemi = new THREE.HemisphereLight(0xbcd8f5, 0x39442f, 0.6);
    scene.add(hemi); G.hemi = hemi;
    const amb = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(amb); G.amb = amb;

    const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 140;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 700;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.5;
    scene.add(sun);
    scene.add(sun.target);
    G.sun = sun;
  }

  function loadGLB(onDone) {
    const loader = new THREE.GLTFLoader();
    loader.load('assets/campus.glb', (gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = true;
        const m = o.material;
        if (!m) return;
        m.side = THREE.FrontSide;
        if (m.name === 'M_facade' || m.name === 'facade') {
          G.matFacade = m;
          m.emissive = new THREE.Color(0xffffff);
          m.emissiveIntensity = 0;
        } else if (m.name === 'M_glass' || m.name === 'glass') {
          G.matGlass = m;
          m.emissive = new THREE.Color(0xffd9a0);
          m.emissiveIntensity = 0;
        }
        m.envMapIntensity = 0.8;
      });
      G.scene.add(root);
      G.campusRoot = root;
      onDone();
    }, (ev) => {
      if (ev.total) setProgress(0.1 + 0.85 * (ev.loaded / ev.total), '载入校园模型…');
      else setProgress(0.6, '载入校园模型… (' + (ev.loaded / 1048576).toFixed(1) + ' MB)');
    }, (err) => {
      console.error(err);
      fatal('无法载入 <code>assets/campus.glb</code>。<br><br>' +
        '请通过本地服务器打开本页（双击项目根目录的 <code>启动游戏.bat</code>），' +
        '不要直接双击 index.html —— 浏览器不允许 file:// 读取模型文件。');
    });
  }

  function placeVehicles() {
    for (const v of G.meta.vehicles) {
      const car = CarState(v);
      const m = buildCar(v.kind, v.color);
      car.mesh = m;
      m.group.position.copy(car.pos);
      m.group.rotation.y = car.yaw;
      G.scene.add(m.group);
      G.cars.push(car);
    }
  }

  function start() {
    $('#boot').classList.add('ready');
    setTimeout(() => { $('#boot').style.display = 'none'; }, 700);
    $('#hud').classList.add('on');
    G.started = true;
    const p = $('#gl').requestPointerLock();
    if (p && p.catch) p.catch(() => {});
    toast('欢迎来到重庆建筑工程职业学院 · 东站校区');
  }

  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!G.renderer) return;
    const dt = Math.min((now - last) / 1000 || 0, 0.05);
    last = now;

    if (G.autoTime) G.time = (G.time + dt * (24 / 900)) % 24;

    if (G.started) {
      if (PLAYER.inCar && G.activeCar) {
        driveCar(G.activeCar, dt);
        PLAYER.pos.copy(G.activeCar.pos);
      } else {
        movePlayer(dt);
      }
    }
    updateSky();

    if (G.sun) {
      const px = PLAYER.pos.x, pz = PLAYER.pos.z;
      G.sun.position.set(px + Math.cos((G.time - 6) / 12 * Math.PI) * 240 + 40,
        340, pz + Math.sin((G.time - 6) / 12 * Math.PI * 0.6) * -160 - 60);
      G.sun.target.position.set(px, 0, pz);
      G.sun.target.updateMatrixWorld();
    }
    updateCamera(dt);
    if (G.started) updateHUD(dt);
    G.renderer.render(G.scene, G.camera);
  }

  function boot() {
    setProgress(0.04, '读取校园数据…');
    fetch('assets/campus_meta.json').then(r => r.json()).then((meta) => {
      G.meta = meta;
      CAMPUS = meta.meta.campus;
      terrain = CampusTerrain.create(meta.terrain.config);
      G.byId = new Map();
      for (const c of meta.colliders) G.byId.set(c.id, c);
      buildGrid(meta.colliders);

      initRenderer();
      buildGrid(meta.colliders);

      // buildings block the camera too -> colliders already in the grid
      placeVehicles();

      setProgress(0.10, '载入校园模型…');
      loadGLB(() => {
        const hm = buildHuman();
        G.playerMesh = hm;
        G.scene.add(hm.group);
        spawnPlayer();
        G.yaw = (meta.camera_yaw || 0) + Math.PI;
        G.camSmooth = G.camDist;

        HUD.speed = $('#spd');
        HUD.gear = $('#gear');
        HUD.place = $('#place');
        HUD.clock = $('#clock');
        HUD.compass = $('#compass');
        HUD.prompt = $('#prompt');
        HUD.toast = $('#toast');
        HUD.minimap = $('#minimap');
        HUD.mapCtx = HUD.minimap.getContext('2d');

        bindInput($('#gl'));
        setProgress(1, '就绪');
        $('#bootmsg').textContent =
          '占地 375 亩 · 19 栋建筑 · 169,660 ㎡ · 数字设计 / 财经商贸 / 人工智能学院';
        $('#startbtn').onclick = start;
        $('#startbtn').style.display = 'block';

        let acc = 0;
        const warm = () => {
          updateSky();
          updateCamera(0.016);
          G.renderer.render(G.scene, G.camera);
          acc++;
          if (acc < 3) requestAnimationFrame(warm);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(warm);
      });
    }).catch((e) => {
      console.error(e);
      fatal('无法读取 <code>assets/campus_meta.json</code>。<br><br>' +
        '请通过本地服务器打开（<code>启动游戏.bat</code>）。');
    });
  }

  if (!window.THREE) {
    document.getElementById('err').style.display = 'flex';
    document.getElementById('err').textContent = 'three.js 未加载';
  } else {
    boot();
  }
})();
