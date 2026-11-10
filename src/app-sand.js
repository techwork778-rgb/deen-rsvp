/* Silver sand: a full-screen three.js field of shining silver grains behind the live board, built the
   same way as the Argonaut landing ("The Voyage"). It opens with the sand gathering into the DEEN
   Properties logo while the board waits dimmed; the logo then flows into the Dubai skyline and the
   board fades in. After that the grains follow the scroll: the skyline at the top, the crown at the
   ranking, desert dunes at the bottom. Left alone on the opening screen (and always in TV mode) the
   sand keeps changing: skyline, DEEN logo, crown, dunes. Every change runs on ONE eased timeline:
   the grains, the camera, the spin and the drift start together and land together. The mouse pushes
   grains away, a confirmed guest sends a ripple through the sand and a new leader gathers it into the
   crown. three.js loads only where it can run (WebGL, motion allowed); otherwise the stage stays black. */
const Sand = (() => {
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js';
  const MOUSE_FORCE = 1.4;
  const G = -9.5;                        // ground level of the skyline
  const SPREAD = 1.3;                    // the skyline is drawn 30% wider than it is modelled
  const MORPH = 2.8;                     // seconds for one formation to become the next
  // left alone (or in TV mode) the sand keeps changing: shape and seconds it stays
  const CYCLE = [['skyline', 16], ['logo', 9], ['crown', 11], ['dunes', 11]];
  const IDLE = 8;                        // seconds without a touch, wheel, key or mouse move before the cycle starts
  const CFG = {                          // camera position, look-at, spin (rad/s), rock, drift (slow pan)
    skyline: { cam: [0, -3, 38], look: [0, -5.7, 0], spin: 0, rock: 0.005, drift: 1 },   // spire tip ~18% down: clear of the taller CEO header too
    crown: { cam: [0, 5.5, 23], look: [0, 0.4, 0], spin: 0.24, rock: 0, drift: 0 },
    logo: { cam: [0, 0.4, 21], look: [0, 0, 0], spin: 0, rock: 0.014, drift: 0 },
    dunes: { cam: [0, 1.5, 24], look: [0, -4.5, -6], spin: 0.012, rock: 0, drift: 0 }
  };
  // bright silver, white, cool silver, steel, blue silver (rgb 0..1, share of grains)
  const PALETTE = [[0.93, 0.95, 0.98, 0.32], [1, 1, 1, 0.2], [0.78, 0.82, 0.89, 0.24], [0.64, 0.68, 0.75, 0.14], [0.82, 0.88, 0.98, 0.1]];
  const R = Math.random;
  const TAU = Math.PI * 2;

  let THREE = null, renderer, scene, cam, points, clock, colorAttr;
  let N = 0, forms = null, fa, ta, cur, ox, oy, oz, ovx, ovy, ovz, base, tw, tp, gw, gp;
  let current = '', mt = 1, mdur = MORPH, override = '', overrideUntil = 0, cycleIndex = 0, cycleNext = 0, lastInput = 0, dim = false;
  let look, lookT, lookFrom, camT, camFrom, zoom = 1, ang = 0;
  let spin = 0, spinT = 0, spinFrom = 0, rock = 0, rockT = 0, rockFrom = 0, drift = 0, driftT = 0, driftFrom = 0;
  let mouse, m3, m3t, ray, plane, tmpV;
  let raf = 0, time = 0, failed = false, loading = false, intro = false;

  /* ---------- formations ---------- */

  const dune = (x, z) => 0.9 * Math.sin(x * 0.18 + z * 0.35) + 0.6 * Math.sin(x * 0.41 - z * 0.23 + 1.3) + 0.3 * Math.sin(x * 0.93 + z * 0.8);
  const sphere = (rad) => {
    const u = R() * 2 - 1, a = R() * TAU, s = Math.sqrt(1 - u * u), rr = rad * Math.cbrt(R());
    return [Math.cos(a) * s * rr, u * rr, Math.sin(a) * s * rr];
  };

  // x, z, width, depth, height, kind (0 box, 1 sloped roof like Emirates Towers, 2 twisting like Cayan)
  const TOWERS = [
    [-20.5, -6, 2.6, 2.0, 5.1, 0], [-17.4, -4, 1.7, 1.7, 7.4, 0], [-14.7, -5.2, 1.5, 1.5, 9.5, 0],
    [-11.9, -3.6, 2.2, 1.6, 5.9, 0], [-8.7, -2.6, 1.5, 1.5, 8.3, 1], [-6.6, -2.9, 1.3, 1.3, 6.9, 1],
    [-3.7, -5.6, 2.0, 2.0, 4.8, 0], [5.7, -2.1, 1.5, 1.5, 8.7, 2], [8.5, -4.1, 2.4, 1.8, 5.5, 0],
    [11.3, -2.6, 1.6, 1.6, 7.5, 0], [14.1, -5.1, 2.0, 2.0, 5.1, 0]
  ];
  const towerArea = TOWERS.map((t) => 2 * (t[2] + t[3]) * t[4] + t[2] * t[3]);
  const towerTotal = towerArea.reduce((s, a) => s + a, 0);

  function towerPoint() {
    let pick = R() * towerTotal, i = 0;
    while (pick > towerArea[i]) { pick -= towerArea[i]; i++; }
    const [cx, cz, w, d, h, kind] = TOWERS[i];
    const faces = [w * h, w * h, d * h, d * h, w * d];
    let f = 0, r = R() * (faces[0] + faces[1] + faces[2] + faces[3] + faces[4]);
    while (r > faces[f]) { r -= faces[f]; f++; }
    const u = R() - 0.5;
    let x, y, z;
    if (f < 2) { x = u * w; z = (f ? 0.5 : -0.5) * d; y = R() * h; }
    else if (f < 4) { z = u * d; x = (f === 3 ? 0.5 : -0.5) * w; y = R() * h; }
    else { x = u * w; z = (R() - 0.5) * d; y = h; }
    if (kind === 1) { const roof = h - (x / w + 0.5) * 1.8; if (y > roof) y = roof; }
    if (R() < 0.72) y = Math.floor(y / 0.32) * 0.32;                 // floor lines
    if (kind === 2) { const a = (y / h) * 1.7, c = Math.cos(a), s = Math.sin(a), nx = x * c - z * s; z = x * s + z * c; x = nx; }
    return [cx + x, G + y, cz + z];
  }

  function burjPoint() {                                              // Burj Khalifa: stepped, three wings, spire
    const h = Math.pow(R(), 0.8), H = 15.5;
    let r;
    if (h > 0.86) r = 0.07 + (1 - h) * 0.25;
    else r = 2.1 * (h < 0.22 ? 1 : h < 0.4 ? 0.8 : h < 0.56 ? 0.64 : h < 0.7 ? 0.5 : h < 0.8 ? 0.38 : 0.27) * (1 - h * 0.35);
    const a = R() * TAU, lobe = 0.7 + 0.3 * Math.abs(Math.cos(1.5 * a));
    let y = h * H;
    if (h < 0.86 && R() < 0.7) y = Math.floor(y / 0.3) * 0.3;
    return [1.2 + Math.cos(a) * r * lobe, G + y, -3.2 + Math.sin(a) * r * lobe];
  }

  function sailPoint() {                                              // Burj Al Arab
    const mast = 20.3, H = 8.4, v = R(), u = R();
    const front = mast - 3.6 * Math.pow(Math.sin((1 - v) * Math.PI / 2), 0.85);
    let x = mast + (front - mast) * u, y = v * H;
    if (R() < 0.15) { x = mast; y = R() * (H + 1.2); }
    return [x, G + y, -3.4 + (R() - 0.5) * 0.7 * (1 - u * 0.5)];
  }

  function framePoint() {                                             // Dubai Frame
    const w = 3.0, h = 6.2, t = 0.42, s = R();
    let x, y;
    if (s < 0.38) { x = -w / 2 + R() * t; y = R() * h; }
    else if (s < 0.76) { x = w / 2 - R() * t; y = R() * h; }
    else if (s < 0.9) { x = (R() - 0.5) * w; y = h - R() * t; }
    else { x = (R() - 0.5) * w; y = R() * t; }
    return [-24.6 + x, G + y, -7 + (R() - 0.5) * 0.5];
  }

  function skylinePoint() {
    const r = R();
    let p;
    if (r < 0.12) { const x = (R() * 2 - 1) * 30, z = -18 + R() * 24; p = [x, G - 0.3 + dune(x, z) * 0.5, z]; }
    else if (r < 0.34) p = burjPoint();
    else if (r < 0.78) p = towerPoint();
    else if (r < 0.87) p = sailPoint();
    else if (r < 0.9) p = framePoint();
    else if (r < 0.95) p = [(R() * 2 - 1) * 30, G + 3 + R() * 18, -26 + R() * 30];
    else p = [(R() * 2 - 1) * 28, G + Math.pow(R(), 2) * 2.4, -14 + R() * 20];
    p[0] *= SPREAD;
    return p;
  }

  function crownPoint() {
    const r = R(), RAD = 6.2;
    if (r < 0.32) {
      const a = R() * TAU;
      let y = -2.6 + R() * 2.2;
      if (R() < 0.4) y = R() < 0.5 ? -2.6 : -0.4;                    // bright rims
      return [Math.cos(a) * RAD, y, Math.sin(a) * RAD];
    }
    if (r < 0.66) {                                                   // five points
      const ak = ((R() * 5) | 0) * TAU / 5 + Math.PI / 2, v = Math.pow(R(), 0.8);
      const a = ak + (R() - 0.5) * 0.9 * (1 - v), rad = RAD * (1 + 0.05 * Math.sin(v * Math.PI));
      return [Math.cos(a) * rad, -0.4 + v * 4.8, Math.sin(a) * rad];
    }
    if (r < 0.74) {                                                   // orbs on the tips
      const ak = ((R() * 5) | 0) * TAU / 5 + Math.PI / 2, p = sphere(0.5);
      return [Math.cos(ak) * RAD + p[0], 4.75 + p[1], Math.sin(ak) * RAD + p[2]];
    }
    if (r < 0.8) {                                                    // jewels on the band
      const ak = ((R() * 5) | 0) * TAU / 5 + Math.PI / 2 + TAU / 10, p = sphere(0.38);
      return [Math.cos(ak) * (RAD + 0.1) + p[0], -1.5 + p[1], Math.sin(ak) * (RAD + 0.1) + p[2]];
    }
    const a = R() * TAU, rad = 8 + R() * 5;                           // halo of dust
    return [Math.cos(a) * rad, (R() - 0.5) * 2.2 - 1, Math.sin(a) * rad];
  }

  function dunePoint() {
    const x = (R() * 2 - 1) * 34, z = -30 + R() * 38;
    const y = -6.5 + dune(x * 0.8, z * 0.8) * 1.6 + Math.sin(x * 2.1 + z * 0.4) * 0.06;
    return R() < 0.85 ? [x, y, z] : [x, y + 0.6 + Math.pow(R(), 2) * 3.5, z];   // sand blowing off the crests
  }

  /** The DEEN logo, sampled from the traced artwork on the page (never retyped in a font). */
  function logoPixels() {
    const path = document.querySelector('#deen-logo path');
    if (!path || !window.Path2D) return null;
    const W = 640, H = 290;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.scale(W / 1016, H / 460);
    g.translate(0, 2);
    g.fill(new Path2D(path.getAttribute('d')), 'evenodd');
    const px = g.getImageData(0, 0, W, H).data;
    const pts = [];
    for (let y = 0; y < H; y += 2) {
      const copies = y > H * 0.8 ? 3 : 1;                             // the small PROPERTIES line gets 3x the grains so it reads
      for (let x = 0; x < W; x += 2) {
        if (px[(y * W + x) * 4 + 3] > 120) for (let c = 0; c < copies; c++) pts.push(x / W - 0.5, 0.5 - y / H);
      }
    }
    return pts.length > 40 ? { pts, aspect: H / W } : null;
  }

  function genForms(n) {
    const out = { skyline: new Float32Array(n * 3), crown: new Float32Array(n * 3), logo: new Float32Array(n * 3), dunes: new Float32Array(n * 3) };
    const logo = logoPixels();
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      out.skyline.set(skylinePoint(), j);
      out.crown.set(crownPoint(), j);
      out.dunes.set(dunePoint(), j);
      if (logo && R() < 0.9) {
        const k = ((R() * logo.pts.length / 2) | 0) * 2;
        out.logo[j] = logo.pts[k] * 24 + (R() - 0.5) * 0.08;
        out.logo[j + 1] = logo.pts[k + 1] * 24 * logo.aspect;
        out.logo[j + 2] = (R() - 0.5) * 0.7;
      } else {
        const a = R() * TAU, rad = 13 + R() * 5;                      // dust ring around the logo
        out.logo[j] = Math.cos(a) * rad; out.logo[j + 1] = Math.sin(a) * rad * 0.45; out.logo[j + 2] = (R() - 0.5) * 3;
      }
    }
    return out;
  }

  /* ---------- scene ---------- */

  function dotTexture() {                                             // a bright core with a soft halo: a shining grain
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.32)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  function build() {
    const small = Math.min(innerWidth, innerHeight) < 700;
    N = small ? 4500 : 12000;
    forms = genForms(N);
    cur = new Float32Array(N * 3);
    fa = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {                                     // start as a loose cloud of dust
      const p = sphere(34);
      fa[i * 3] = p[0]; fa[i * 3 + 1] = p[1] * 0.6; fa[i * 3 + 2] = p[2] * 0.5;
    }
    cur.set(fa);
    ox = new Float32Array(N); oy = new Float32Array(N); oz = new Float32Array(N);
    ovx = new Float32Array(N); ovy = new Float32Array(N); ovz = new Float32Array(N);
    base = new Float32Array(N * 3);
    tw = new Float32Array(N); tp = new Float32Array(N); gw = new Float32Array(N); gp = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let r = R(), k = 0;
      while (k < PALETTE.length - 1 && r > PALETTE[k][3]) { r -= PALETTE[k][3]; k++; }
      const c = PALETTE[k], b = 0.82 + R() * 0.18;
      base[i * 3] = c[0] * b; base[i * 3 + 1] = c[1] * b; base[i * 3 + 2] = c[2] * b;
      tw[i] = 0.6 + R() * 1.8; tp[i] = R() * TAU;                     // slow shimmer
      gw[i] = 0.35 + R() * 1.1; gp[i] = R() * TAU;                    // rare bright glint
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fa), 3));
    colorAttr = new THREE.BufferAttribute(new Float32Array(base), 3);
    geo.setAttribute('color', colorAttr);
    const dot = dotTexture();
    const mat = new THREE.PointsMaterial({
      size: small ? 0.28 : 0.27, map: dot, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending
    });
    points = new THREE.Points(geo, mat);
    // the same grains again, large and faint: the soft shine around them
    const glow = new THREE.Points(geo, new THREE.PointsMaterial({
      size: small ? 0.95 : 0.9, map: dot, vertexColors: true, transparent: true, opacity: 0.1,
      depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending
    }));
    points.userData.size = mat.size;
    glow.userData.size = glow.material.size;
    points.add(glow);
    scene.add(points);
  }

  function init() {
    const canvas = $('sand');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 26, 78);
    cam = new THREE.PerspectiveCamera(50, 1, 0.1, 260);
    look = new THREE.Vector3(0, -2, 0);
    lookT = new THREE.Vector3();
    lookFrom = new THREE.Vector3();
    camT = new THREE.Vector3();
    camFrom = new THREE.Vector3();
    cam.position.set(0, 2, 52);
    mouse = new THREE.Vector2(-99, -99);
    m3 = new THREE.Vector3(999, 999, 0);
    m3t = new THREE.Vector3(999, 999, 0);
    ray = new THREE.Raycaster();
    plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    tmpV = new THREE.Vector3();
    build();
    resize();
    clock = new THREE.Clock();
    const opening = scrollY < 80 && !$('view-board').hidden && openWithLogo();
    goTo(wanted(), opening ? 2.6 : 3.6);                              // the dust gathers into the logo (or the first shape)
    addEventListener('resize', resize);
    // any real use of the page pauses the idle cycle (a resting cursor or a re-render can fire
    // synthetic mousemove/scroll events, so those only count when the pointer or the page actually moved)
    const touched = () => { lastInput = time; };
    let px = -1, py = -1, sy = scrollY;
    addEventListener('mousemove', (e) => { if (Math.abs(e.clientX - px) + Math.abs(e.clientY - py) > 3) { px = e.clientX; py = e.clientY; touched(); } }, { passive: true });
    addEventListener('scroll', () => { if (Math.abs(scrollY - sy) > 3) { sy = scrollY; touched(); } }, { passive: true });
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((ev) => addEventListener(ev, touched, { passive: true }));
    addEventListener('mousemove', (e) => mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
    addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) mouse.set((t.clientX / innerWidth) * 2 - 1, -(t.clientY / innerHeight) * 2 + 1); }, { passive: true });
    document.addEventListener('mouseleave', () => { mouse.set(-99, -99); m3t.set(999, 999, 0); });
    addEventListener('touchend', () => { mouse.set(-99, -99); m3t.set(999, 999, 0); }, { passive: true });
  }

  function camTarget(name) {
    const c = CFG[name];
    let z = c.cam[2] * zoom;
    if (name === 'logo') z = Math.max(c.cam[2], 15 / (Math.tan(25 * Math.PI / 180) * cam.aspect));   // the whole logo fits any screen
    camT.set(c.cam[0] * zoom, c.cam[1], z);
    lookT.set(c.look[0], c.look[1], c.look[2]);
  }

  /** The opening: the dust gathers into the DEEN Properties logo while the board waits dimmed, holds,
      then flows into the skyline as the board fades in. Any tap, key or wheel skips straight on. */
  function openWithLogo() {
    intro = true;
    document.body.classList.add('sand-intro');
    override = 'logo';
    overrideUntil = time + 2.6 + 2.2;                                 // gather, then hold
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((ev) => addEventListener(ev, endIntro, { once: true, passive: true }));
    return true;
  }

  function endIntro() {
    if (!intro) return;
    intro = false;
    document.body.classList.remove('sand-intro');
    if (override === 'logo') overrideUntil = time;
  }

  function resize() {
    if (!renderer) return;
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    zoom = Math.pow(Math.max(1, 1.45 / cam.aspect), 0.75);           // portrait screens step back to fit
    cam.updateProjectionMatrix();
    scene.fog.near = 26 * zoom;                                       // ...so the haze and the grain size step back too
    scene.fog.far = 78 * zoom;
    const grow = Math.pow(zoom, 0.7);
    points.material.size = points.userData.size * grow;
    points.children[0].material.size = points.children[0].userData.size * grow;
    if (current) camTarget(current);
  }

  /** Start the next formation: everything eases from where it is now to the new shape on one timeline. */
  function goTo(name, dur) {
    if (!forms || name === current) return;
    if (current) fa.set(cur);
    ta = forms[name];
    current = name;
    mt = 0;
    mdur = dur || MORPH;
    ang = 0;
    camFrom.copy(cam.position);
    lookFrom.copy(look);
    spinFrom = spin; rockFrom = rock; driftFrom = drift;
    const c = CFG[name];
    spinT = c.spin; rockT = c.rock; driftT = c.drift;
    camTarget(name);
  }

  /** Which shape the page wants now: a celebration, the idle cycle (TV mode, or nobody touching the
      opening screen), or the scroll position: skyline at the top, crown at the ranking, dunes below. */
  function wanted() {
    if (override && time < overrideUntil) return override;
    if (intro) endIntro();
    override = '';
    const doc = document.documentElement;
    const p = Math.min(1, Math.max(0, scrollY / Math.max(1, doc.scrollHeight - innerHeight)));
    if (document.body.classList.contains('tv') || (p < 0.32 && time - lastInput > IDLE)) {
      if (time > cycleNext) {
        cycleIndex = cycleNext ? (cycleIndex + 1) % CYCLE.length : 0;
        cycleNext = time + CYCLE[cycleIndex][1];
      }
      return CYCLE[cycleIndex][0];
    }
    cycleNext = 0;                                                    // someone is using it: follow the scroll, restart the cycle later
    return p < 0.32 ? 'skyline' : p < 0.7 ? 'crown' : 'dunes';
  }

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);   // cubic in-out

  function tick() {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    time += dt;
    const want = wanted();
    if (want !== current && mt > 0.2) goTo(want);
    if (mt < 1) mt = Math.min(1, mt + dt / mdur);
    const e = ease(mt);
    cam.position.lerpVectors(camFrom, camT, e);
    look.lerpVectors(lookFrom, lookT, e);
    spin = spinFrom + (spinT - spinFrom) * e;
    rock = rockFrom + (rockT - rockFrom) * e;
    drift = driftFrom + (driftT - driftFrom) * e;
    cam.position.x += Math.sin(time * 0.06) * 2.6 * drift * zoom;      // a slow pan past the city
    ang += spin * dt;                                                 // turning shapes turn their targets, not the scene,
    const ca = Math.cos(ang), sa = Math.sin(ang);                     // so leaving the crown never has to unwind a spin

    if (mouse.x > -50) {
      ray.setFromCamera(mouse, cam);
      if (ray.ray.intersectPlane(plane, tmpV)) m3t.copy(tmpV);
    }
    m3.lerp(m3t, 0.18);
    const mx = m3.x, my = m3.y, mz = m3.z, force = MOUSE_FORCE * 0.13, Rr = 4.2, R2 = Rr * Rr, t = time;
    const pos = points.geometry.attributes.position.array;
    const col = colorAttr.array;
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      let tx = ta[j], tz = ta[j + 2];
      if (ang !== 0) { const rx = tx * ca + tz * sa; tz = tz * ca - tx * sa; tx = rx; }
      const bx = fa[j] + (tx - fa[j]) * e;
      const by = fa[j + 1] + (ta[j + 1] - fa[j + 1]) * e;
      const bz = fa[j + 2] + (tz - fa[j + 2]) * e;
      cur[j] = bx; cur[j + 1] = by; cur[j + 2] = bz;
      const breath = Math.sin(t * 1.3 + bx * 0.32 + bz * 0.21) * 0.2;
      const dx = bx - mx, dy = by - my, dz = bz - mz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R2 && d2 > 0.0001) {
        const d = Math.sqrt(d2), f = (1 - d / Rr) * (1 - d / Rr) * force;
        ovx[i] += dx / d * f; ovy[i] += dy / d * f; ovz[i] += dz / d * f;
      }
      ovx[i] = (ovx[i] - ox[i] * 0.045) * 0.9;
      ovy[i] = (ovy[i] - oy[i] * 0.045) * 0.9;
      ovz[i] = (ovz[i] - oz[i] * 0.045) * 0.9;
      ox[i] += ovx[i]; oy[i] += ovy[i]; oz[i] += ovz[i];
      pos[j] = bx + ox[i];
      pos[j + 1] = by + breath + oy[i];
      pos[j + 2] = bz + oz[i];
      // shine: a slow shimmer on every grain, and now and then a bright silver glint
      let g = Math.sin(t * gw[i] + gp[i]);
      g = g > 0.99 ? (g - 0.99) * 100 : 0;
      const b = 0.82 + 0.22 * Math.sin(t * tw[i] + tp[i]) + g * 2;
      col[j] = Math.min(1, base[j] * b); col[j + 1] = Math.min(1, base[j + 1] * b); col[j + 2] = Math.min(1, base[j + 2] * b);
    }
    points.geometry.attributes.position.needsUpdate = true;
    colorAttr.needsUpdate = true;
    points.rotation.z = Math.sin(t * 0.55) * rock;
    cam.lookAt(look);
    renderer.render(scene, cam);
    // while the logo stands (outside the opening, which dims more), the board steps back so the logo reads
    const wantDim = !intro && current === 'logo' && mt > 0.55;
    if (wantDim !== dim) { dim = wantDim; document.body.classList.toggle('sand-logo', dim); }
  }

  /* ---------- running only while the board is on screen ---------- */

  const onScreen = () => !document.hidden && !$('view-board').hidden;

  function loop() {
    if (!renderer || failed) return;
    if (onScreen() && !raf) { clock.getDelta(); tick(); }
    else if (!onScreen() && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function webgl() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  function load() {
    if (window.THREE) return Promise.resolve(window.THREE);
    return new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = THREE_URL;
      s.async = true;
      s.onload = () => (window.THREE ? ok(window.THREE) : no(new Error('three.js missing')));
      s.onerror = () => no(new Error('three.js did not load'));
      document.head.appendChild(s);
    });
  }

  function start() {
    if (reducedMotion || failed || loading || renderer || !$('sand')) return;
    if (!webgl()) { failed = true; return; }
    loading = true;
    load().then((T) => {
      THREE = T;
      init();
      document.body.classList.add('sand-on');
      loop();
      setInterval(loop, 700);
      document.addEventListener('visibilitychange', loop);
    }).catch(() => { failed = true; }).finally(() => { loading = false; });
  }

  /** A confirmed guest: every grain jumps a little and settles back. */
  function ripple() {
    if (!forms || reducedMotion) return;
    for (let i = 0; i < N; i++) {
      ovy[i] += 0.16 + R() * 0.3;
      ovx[i] += (R() - 0.5) * 0.24;
      ovz[i] += (R() - 0.5) * 0.24;
    }
  }

  /** A new leader: the sand gathers into the crown for a few seconds. */
  function crown() {
    if (!forms) return;
    override = 'crown';
    overrideUntil = time + 7;
  }

  return { start, ripple, crown };
})();

Sand.start();
