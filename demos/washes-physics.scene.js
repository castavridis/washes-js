// physics-scene.js — <washes-physics>: matter.js rigid bodies painting a washes sheet.
//
// The sheet hangs upright like paper clipped to an easel: a full-bleed washes
// canvas fills a framed rect, matter.js bodies live in the same pixel space,
// and everything that rolls, falls or collides paints. Bodies carry a pigment
// load that depletes as they trail; pools along the bottom edge re-ink them.
// Collisions fire velocity-scaled splashes. Washes gravity points down at a
// fraction of physics gravity, so fresh paint literally drips down the sheet.
//
// Three scenes: PLINKO (runners rain through pegs, pools recycle them back to
// the top), SANDBOX (mixed rigid bodies, drag-to-throw), PENDULUM (loaded
// brush-weights on ropes smearing arcs through loose runners).
//
// GPU: tries the WebGL2 fluid pipeline at startup (manual handle workflow:
// gpuSimContext() -> initGpuSim() -> gpuSim(handle) -> webgl(true)),
// with the same readback watchdog as the Lab — reverts to CPU if the render
// comes back blank.

import * as MatterNS from 'https://esm.sh/matter-js@0.20.0';
const Matter = MatterNS.default || MatterNS;
// Live engine from the repo (API 2.x) — never a re-embedded copy.
const { Washes } = await import(new URL('../engine/src/index.js', import.meta.url).href);
const { initGpuSim } = await import(new URL('../engine/src/washes-gpu-sim.js', import.meta.url).href);
const { Engine, Bodies, Body, Composite, Events, Mouse, MouseConstraint, Vector } = Matter;

// ---------------------------------------------------------------- constants

const MARGIN = { l: 30, r: 30, t: 118, b: 132 };   // chrome frame around the sheet
const STOCK = {
  colors: ['#d8447c', '#eec23d', '#3a87c0'],
  names: ['quinacridone rose', 'hansa yellow', 'cerulean blue'],
};

const THEMES = {
  lab: {
    paper: '#f2efe6', ink: '#23211c',
    palette: [
      { color: '#5b2bd9', name: 'ultraviolet', granulation: 0.55 },
      { color: '#00a394', name: 'phthalo teal', granulation: 0.4 },
      { color: '#ff3d63', name: 'hot coral', granulation: 0.5 },
    ],
  },
  gallery: { paper: '#fbfaf4', ink: '#1a1914', palette: null },
  atelier: {
    paper: '#f3ecd9', ink: '#2b2117',
    palette: [
      { color: '#2c3a63', name: 'indigo', granulation: 0.7 },
      { color: '#bf7e23', name: 'raw ochre', granulation: 0.5 },
      { color: '#49555f', name: "payne's grey", granulation: 0.8 },
    ],
  },
};

const DEFAULTS = {
  gravity: 1, bounce: 0.62, friction: 0.04, airDrag: 0.0025,
  bodyScale: 1, maxBodies: 18, shapeMix: 'mixed',
  trailStrength: 0.5, pigmentLoad: 1.2, waterShare: 0.2,
  splashScale: 1, splashStyle: 'fineSpritz', dryness: 0.3,  // was 'splash' — a preset that never existed, so collision splashes NEVER fired; first live behavior, QA the feel
  pegSpacing: 96, pendulums: 2, autopilot: true,
};

function rnd(a, b) { return a + Math.random() * (b - a); }
function ri(n) { return Math.floor(Math.random() * n); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function canvasReadsBack(c) {
  try {
    const t = document.createElement('canvas');
    t.width = t.height = 8;
    const x = t.getContext('2d');
    x.drawImage(c, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
    return false;
  } catch (e) { return true; } // cannot verify -> do not revert
}

// ---------------------------------------------------------------- element

class WashesPhysicsEl extends HTMLElement {
  connectedCallback() {
    if (this._mounted) return;
    this._mounted = true;
    this.style.display = 'block';
    if (!this.style.width) this.style.width = '100%';
    if (!this.style.height) this.style.height = '100%';
    if (getComputedStyle(this).position === 'static') this.style.position = 'relative';

    // washes host: the framed sheet
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:' + MARGIN.l + 'px;right:' + MARGIN.r +
      'px;top:' + MARGIN.t + 'px;bottom:' + MARGIN.b +
      'px;pointer-events:none;box-shadow:0 16px 50px rgba(15,13,9,0.32);';
    this.appendChild(host);
    this._host = host;

    // overlay: bodies, pegs, ropes, pools — and all pointer input
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;display:block;cursor:grab;';
    this.appendChild(cv);
    this._cv = cv;

    this._params = Object.assign({}, DEFAULTS);
    this._themeName = 'lab';
    this._live = {
      lastUser: 0, dragging: false, caption: 'pigment runners — drop, roll, bleed',
      mode: 'auto', scene: 'plinko',
    };
    this._gpu = { on: false, handle: null, unsub: null };
    this._lastSplash = 0;
    this._lastAutoDry = performance.now();
    this._auto = { next: 0 };

    this._init();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    clearInterval(this._statusId);
    clearTimeout(this._resizeT);
    if (this._ro) this._ro.disconnect();
    this._gpuOff();
    try { if (this._wc) this._wc.destroy(); } catch (e) {}
  }

  // ---------------------------------------------------------------- setup

  _sheet() {
    const w = this.clientWidth, h = this.clientHeight;
    return { x: MARGIN.l, y: MARGIN.t, w: Math.max(50, w - MARGIN.l - MARGIN.r), h: Math.max(50, h - MARGIN.t - MARGIN.b) };
  }

  _init() {
    const wc = Washes.create(this._host, { pointer: false, cursorPreview: false, scale: 2.6, canvasScale: 1 });
    this._wc = wc;
    try {
      wc.autoPerf(true);
      wc.run('until-dry');
      wc.edgeFade(2);
      wc.gravityDirection('down');
      wc.gravityStrength(0.18 * this._params.gravity);
      wc.dryness(this._params.dryness);
    } catch (e) { console.warn('washes config', e); }
    this._applyTheme();

    const engine = Engine.create();
    engine.gravity.y = this._params.gravity;
    this._engine = engine;

    Events.on(engine, 'collisionStart', (e) => this._onCollisions(e));

    this._buildScene('plinko');
    this._mouse();

    // render loop
    let last = performance.now(), acc = 0;
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      let dt = (now - last) / 1000; last = now;
      dt = Math.min(dt, 0.05);
      acc += dt;
      let n = 0;
      while (acc > 1 / 60 && n < 3) { Engine.update(engine, 1000 / 60); acc -= 1 / 60; n++; }
      if (n > 0) this._afterStep(dt);
      this._autopilot(now);
      this._draw();
    };
    this._raf = requestAnimationFrame(loop);

    // status broadcast
    this._statusId = setInterval(() => this._status(), 350);

    // resize -> rebuild statics (debounced)
    this._ro = new ResizeObserver(() => {
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => this._buildScene(this._live.scene, true), 350);
    });
    this._ro.observe(this);

    // GPU by default: attempt once the sim has settled in, watchdog reverts
    setTimeout(() => this._gpuOn(true), 700);
  }

  _applyTheme() {
    const t = THEMES[this._themeName] || THEMES.lab;
    try {
      this._wc.paperColor(t.paper);
      this._wc.palette(t.palette
        ? t.palette.map((p) => ({ color: p.color, granulation: p.granulation, name: p.name }))
        : null);
    } catch (e) { console.warn('theme apply', e); }
  }

  _swatches() {
    const t = THEMES[this._themeName] || THEMES.lab;
    return t.palette
      ? { colors: t.palette.map((p) => p.color), names: t.palette.map((p) => p.name) }
      : STOCK;
  }

  // ---------------------------------------------------------------- gpu

  _gpuOn(isAuto) {
    const wc = this._wc;
    if (!wc || this._gpu.on) return;
    try {
      const ctx = wc.gpuSimContext();
      if (!ctx) throw new Error('WebGL2 unavailable');
      const handle = initGpuSim(ctx.gl, ctx.GW, ctx.GH);
      try { wc.autoPerf(false); } catch (e) {}
      wc.gpuSim(handle);
      wc.webgl(true);
      this._gpu.on = true;
      this._gpu.handle = handle;
      this._live.caption = isAuto
        ? 'gpu sim by default — webgl2 fluid pipeline engaged'
        : 'gpu sim — webgl2 fluid pipeline engaged';
      try {
        this._gpu.unsub = wc.on('rescale', () => {
          if (!this._gpu.on) return;
          try {
            this._gpuOff();
            this._gpuOn(false);
          } catch (e) { this._gpuOff(); try { wc.autoPerf(true); } catch (e2) {} }
        });
      } catch (e) {}
      // watchdog: a WebGL drawing buffer (no preserveDrawingBuffer) is only
      // readable in the same frame it was rendered — a lone setTimeout sample
      // reads blank almost every time (false revert). Probe inside rAF across
      // ~90 frames; one non-blank frame verifies the GPU render. Revert only
      // if EVERY frame is blank.
      let probes = 0;
      const probe = () => {
        if (!this._gpu.on) return; // turned off mid-probe
        if (canvasReadsBack(wc.canvas)) return; // verified
        if (++probes < 90) { requestAnimationFrame(probe); return; }
        this._gpuOff();
        try { wc.autoPerf(true); } catch (e) {}
        this._live.caption = 'gpu render read back blank — reverted to cpu';
      };
      setTimeout(() => requestAnimationFrame(probe), 1200);
    } catch (e) {
      console.warn('gpu enable failed', e);
      this._gpuOff();
      try { wc.autoPerf(true); } catch (e2) {}
      this._live.caption = 'gpu unavailable here — staying on cpu';
    }
  }

  _gpuOff() {
    const wc = this._wc;
    if (this._gpu.unsub) { try { this._gpu.unsub(); } catch (e) {} this._gpu.unsub = null; }
    if (wc) {
      try { wc.gpuSim(null); } catch (e) {}
      try { wc.webgl(false); } catch (e) {}
    }
    if (this._gpu.handle) { try { this._gpu.handle.destroy(); } catch (e) {} this._gpu.handle = null; }
    this._gpu.on = false;
  }

  // ---------------------------------------------------------------- scenes

  _buildScene(name, keepCaption) {
    const engine = this._engine;
    Composite.clear(engine.world, false, true);
    if (this._mc) Composite.add(engine.world, this._mc);
    this._bodies = [];
    this._pegs = [];
    this._pendula = [];
    this._wells = [];
    this._live.scene = name;
    const p = this._params;
    const s = this._sheet();

    // walls just outside the sheet edges
    const T = 90;
    const walls = [
      Bodies.rectangle(s.x + s.w / 2, s.y - T / 2, s.w + T * 2, T, { isStatic: true, label: 'wall' }),
      Bodies.rectangle(s.x + s.w / 2, s.y + s.h + T / 2, s.w + T * 2, T, { isStatic: true, label: 'wall' }),
      Bodies.rectangle(s.x - T / 2, s.y + s.h / 2, T, s.h + T * 2, { isStatic: true, label: 'wall' }),
      Bodies.rectangle(s.x + s.w + T / 2, s.y + s.h / 2, T, s.h + T * 2, { isStatic: true, label: 'wall' }),
    ];
    walls.forEach((w) => { w.restitution = 0.5; });
    Composite.add(engine.world, walls);

    // pigment pools along the bottom (sensor regions, drawn in the overlay)
    const wellW = Math.min(120, s.w / 5), wellH = 22;
    for (let i = 0; i < 3; i++) {
      this._wells.push({
        x: s.x + s.w * (0.5 + (i - 1) * 0.27) - wellW / 2,
        y: s.y + s.h - wellH - 10,
        w: wellW, h: wellH, pig: i,
      });
    }

    if (name === 'plinko') {
      const sp = clamp(p.pegSpacing, 64, 160);
      const y0 = s.y + 100, y1 = s.y + s.h - 110;
      let row = 0;
      for (let y = y0; y < y1; y += sp * 0.82, row++) {
        const off = (row % 2) * sp / 2;
        for (let x = s.x + sp / 2 + off; x < s.x + s.w - sp / 4; x += sp) {
          const peg = Bodies.circle(x, y, 7, { isStatic: true, label: 'peg', restitution: 0.55 });
          this._pegs.push(peg);
        }
      }
      Composite.add(engine.world, this._pegs);
      const n = clamp(p.maxBodies, 2, 80);
      for (let i = 0; i < n; i++) this._spawnRunner(true);
    } else if (name === 'sandbox') {
      const n = clamp(p.maxBodies, 2, 80);
      for (let i = 0; i < n; i++) this._spawnShape();
    } else if (name === 'pendulum') {
      const n = clamp(Math.round(p.pendulums), 1, 4);
      for (let i = 0; i < n; i++) {
        const ax = s.x + s.w * (i + 1) / (n + 1);
        const ay = s.y + 4;
        const len = s.h * 0.62;
        const head = Bodies.circle(ax + rnd(-60, 60), ay + len, 28 * p.bodyScale, {
          restitution: p.bounce, friction: p.friction, frictionAir: p.airDrag * 0.6,
          density: 0.004, label: 'brush',
        });
        head.plugin = { pig: i % 3, load: 1, px: head.position.x, py: head.position.y, kind: 'brush', water: false, acc: 0, wellAt: 0 };
        const rope = Matter.Constraint.create({
          pointA: { x: ax, y: ay }, bodyB: head, length: len, stiffness: 0.9, damping: 0.02,
        });
        this._pendula.push({ anchor: { x: ax, y: ay }, head, rope });
        this._bodies.push(head);
        Composite.add(engine.world, [head, rope]);
      }
      const loose = Math.min(8, clamp(p.maxBodies, 2, 80));
      for (let i = 0; i < loose; i++) this._spawnRunner(false);
    }

    if (!keepCaption) {
      this._live.caption = name === 'plinko' ? 'plinko — runners rain through the pegs'
        : name === 'sandbox' ? 'sandbox — drag a body and throw it'
        : 'pendulum — loaded brushes swing on ropes';
    }
  }

  _mkPlugin(pig, water) {
    return { pig, load: 1, px: 0, py: 0, kind: 'runner', water: !!water, acc: 0, wellAt: 0 };
  }

  _spawnRunner(fromTop, atX) {
    const p = this._params, s = this._sheet();
    const r = rnd(10, 16) * p.bodyScale;
    const water = Math.random() < p.waterShare;
    const x = atX !== undefined ? atX : rnd(s.x + r * 2, s.x + s.w - r * 2);
    const y = fromTop ? s.y + r + 4 : s.y + s.h - r - 50;
    const b = Bodies.circle(x, y, r, {
      restitution: p.bounce, friction: p.friction, frictionAir: p.airDrag, label: 'runner',
    });
    b.plugin = this._mkPlugin(ri(3), water);
    b.plugin.px = x; b.plugin.py = y;
    Body.setVelocity(b, { x: rnd(-1.5, 1.5), y: 0 });
    this._bodies.push(b);
    Composite.add(this._engine.world, b);
    return b;
  }

  _spawnShape(atX, atY) {
    const p = this._params, s = this._sheet();
    const x = atX !== undefined ? atX : rnd(s.x + 40, s.x + s.w - 40);
    const y = atY !== undefined ? atY : rnd(s.y + 30, s.y + s.h * 0.5);
    const water = Math.random() < p.waterShare;
    const opts = { restitution: p.bounce, friction: p.friction, frictionAir: p.airDrag, label: 'runner' };
    const mix = p.shapeMix;
    const kind = mix === 'circles' ? 0 : mix === 'angular' ? 1 + ri(2) : ri(3);
    let b;
    if (kind === 0) b = Bodies.circle(x, y, rnd(11, 22) * p.bodyScale, opts);
    else if (kind === 1) b = Bodies.rectangle(x, y, rnd(26, 44) * p.bodyScale, rnd(20, 36) * p.bodyScale, opts);
    else b = Bodies.polygon(x, y, 3 + ri(4), rnd(15, 25) * p.bodyScale, opts);
    b.plugin = this._mkPlugin(ri(3), water);
    b.plugin.px = x; b.plugin.py = y;
    this._bodies.push(b);
    Composite.add(this._engine.world, b);
    return b;
  }

  // ---------------------------------------------------------------- painting

  _gridScale() {
    try {
      const s = this._sheet();
      return { gw: this._wc.grid.width, gh: this._wc.grid.height, s };
    } catch (e) { return null; }
  }

  _afterStep(dt) {
    const g = this._gridScale();
    if (!g) return;
    const { gw, gh, s } = g;
    const p = this._params;
    const wc = this._wc;
    // v2 line() speaks normalized coords — sheet px -> 0..1.
    const toNX = (v) => clamp((v - s.x) / s.w, 0, 1);
    const toNY = (v) => clamp((v - s.y) / s.h, 0, 1);

    for (const b of this._bodies) {
      const pl = b.plugin;
      const { x, y } = b.position;
      const dist = Math.hypot(x - pl.px, y - pl.py);

      // brush heads slowly re-soak on their own
      if (pl.kind === 'brush') pl.load = Math.min(1, pl.load + dt * 0.12);

      if (dist > 2) {
        if (pl.water || pl.load > 0.02) {
          const sp = Math.hypot(b.velocity.x, b.velocity.y);
          const r = b.circleRadius || (b.bounds.max.x - b.bounds.min.x + b.bounds.max.y - b.bounds.min.y) / 4;
          const radius = Math.max(1.2, r * (pl.kind === 'brush' ? 0.75 : 0.55) * (gw / s.w));
          const strength = pl.water
            ? 0.5
            : p.trailStrength * (0.25 + 0.75 * Math.min(1, sp / 14)) * (0.3 + 0.7 * pl.load);
          try {
            wc.line(toNX(pl.px), toNY(pl.py), toNX(x), toNY(y), {
              pigment: pl.water ? 'water' : pl.pig, strength, radius,
            });
          } catch (e) {}
          if (!pl.water && pl.kind !== 'brush') pl.load = Math.max(0, pl.load - dist / (900 * p.pigmentLoad));
        }
        pl.px = x; pl.py = y;
      }

      // water bodies bloom: pulse a rewet under them
      if (pl.water) {
        pl.acc += dt;
        if (pl.acc > 0.55) {
          pl.acc = 0;
          try { wc.rewet(clamp((x - s.x) / s.w, 0, 1), clamp((y - s.y) / s.h, 0, 1), 0.06); } catch (e) {}
        }
      }

      // pools: re-ink (and in plinko, recycle to the top)
      const now = performance.now();
      if (pl.kind !== 'brush' && now - pl.wellAt > 900) {
        for (const w of this._wells) {
          if (x > w.x - 6 && x < w.x + w.w + 6 && y > w.y - 14) {
            pl.wellAt = now;
            if (!pl.water) { pl.pig = w.pig; pl.load = 1; }
            if (this._live.scene === 'plinko') {
              const r = b.circleRadius || 12;
              Body.setPosition(b, { x: rnd(s.x + r * 2, s.x + s.w - r * 2), y: s.y + r + 4 });
              Body.setVelocity(b, { x: rnd(-1.5, 1.5), y: 0 });
              Body.setAngularVelocity(b, 0);
              pl.px = b.position.x; pl.py = b.position.y;
            }
            break;
          }
        }
      }

      // safety: escaped bodies come back
      if (y > this.clientHeight + 120 || x < -120 || x > this.clientWidth + 120) {
        Body.setPosition(b, { x: s.x + s.w / 2, y: s.y + 40 });
        Body.setVelocity(b, { x: 0, y: 0 });
        pl.px = b.position.x; pl.py = b.position.y;
      }
    }
  }

  _onCollisions(e) {
    const now = performance.now();
    if (now - this._lastSplash < 160) return;
    const p = this._params, s = this._sheet();
    for (const pair of e.pairs) {
      const a = pair.bodyA, b = pair.bodyB;
      const rel = Vector.magnitude(Vector.sub(a.velocity, b.velocity));
      const isPeg = a.label === 'peg' || b.label === 'peg';
      if (rel < (isPeg ? 6 : 4.5)) continue;
      const src = [a, b].find((x) => x.plugin && (x.plugin.water || x.plugin.load > 0.05));
      if (!src) continue;
      const pt = (pair.collision && pair.collision.supports && pair.collision.supports[0]) || src.position;
      const hx = pt.x - s.x, hy = pt.y - s.y;
      if (hx < 0 || hy < 0 || hx > s.w || hy > s.h) continue;
      const vel = clamp(rel * (isPeg ? 3 : 5) * p.splashScale, 14, 85);
      if (vel < 15 || p.splashScale === 0) continue;
      try {
        // v2 splash epicenters are normalized. (The old pigment opt was never
        // read by any engine version — dropped.)
        this._wc.splash([{ x: hx / s.w, y: hy / s.h, velocity: vel }], p.splashStyle);
      } catch (err) {}
      src.plugin.load = Math.max(0, src.plugin.load * 0.88);
      this._lastSplash = now;
      if (rel > 9 && this._live.mode === 'auto') this._live.caption = 'impact — pigment leaps from the hit';
      break;
    }
  }

  // ---------------------------------------------------------------- input

  _mouse() {
    const mouse = Mouse.create(this._cv);
    this._matterMouse = mouse;
    const mc = MouseConstraint.create(this._engine, {
      mouse, constraint: { stiffness: 0.12, damping: 0.08 },
    });
    this._mc = mc;
    Composite.add(this._engine.world, mc);

    Events.on(mc, 'startdrag', () => {
      this._live.dragging = true;
      this._live.lastUser = performance.now();
      this._cv.style.cursor = 'grabbing';
      this._live.caption = 'your hand — throw it';
    });
    Events.on(mc, 'enddrag', () => {
      this._live.dragging = false;
      this._live.lastUser = performance.now();
      this._cv.style.cursor = 'grab';
    });

    // click (no drag) -> scene-specific spawn/shove
    let downAt = 0, downX = 0, downY = 0, hadBody = false;
    this._cv.addEventListener('pointerdown', (e) => {
      downAt = performance.now(); downX = e.clientX; downY = e.clientY;
      hadBody = !!mc.body;
      this._live.lastUser = downAt;
    });
    this._cv.addEventListener('pointermove', () => {
      if (this._live.dragging) this._live.lastUser = performance.now();
    });
    this._cv.addEventListener('pointerup', (e) => {
      const now = performance.now();
      this._live.lastUser = now;
      if (hadBody || mc.body || now - downAt > 350) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 7) return;
      const rect = this.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const s = this._sheet();
      if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return;
      const scene = this._live.scene;
      if (scene === 'plinko') {
        this._dropOne(x);
        this._live.caption = 'a runner, dropped where you pointed';
      } else if (scene === 'sandbox') {
        if (this._bodies.length < clamp(this._params.maxBodies, 2, 80)) this._spawnShape(x, Math.max(y, s.y + 26));
        else this._flingRandom();
        this._live.caption = 'fresh body on the sheet';
      } else {
        let best = null, bd = 1e9;
        for (const pd of this._pendula) {
          const d = Math.hypot(pd.head.position.x - x, pd.head.position.y - y);
          if (d < bd) { bd = d; best = pd; }
        }
        if (best) {
          const dx = x - best.head.position.x, dy = y - best.head.position.y;
          const m = Math.max(1, Math.hypot(dx, dy));
          Body.setVelocity(best.head, { x: dx / m * 16, y: dy / m * 16 });
          this._live.caption = 'shoving the brush toward your click';
        }
      }
    });
  }

  _dropOne(atX) {
    const p = this._params;
    if (this._bodies.length >= clamp(p.maxBodies, 2, 80)) {
      // recycle the stalest runner instead
      const b = this._bodies.find((x) => x.plugin.kind === 'runner') || this._bodies[0];
      const s = this._sheet();
      const r = b.circleRadius || 12;
      Body.setPosition(b, { x: atX !== undefined ? atX : rnd(s.x + r * 2, s.x + s.w - r * 2), y: s.y + r + 4 });
      Body.setVelocity(b, { x: rnd(-1.5, 1.5), y: 0 });
      b.plugin.px = b.position.x; b.plugin.py = b.position.y;
      if (!b.plugin.water) b.plugin.load = 1;
      return b;
    }
    return this._spawnRunner(true, atX);
  }

  _flingRandom() {
    const dyn = this._bodies.filter((b) => !b.isStatic);
    if (!dyn.length) return;
    const b = dyn[ri(dyn.length)];
    Body.setVelocity(b, { x: rnd(-14, 14), y: rnd(-16, -5) });
  }

  // ---------------------------------------------------------------- autopilot

  _autopilot(now) {
    const userActive = this._live.dragging || now - this._live.lastUser < 6000;
    const mode = userActive ? 'user' : 'auto';
    if (mode !== this._live.mode) {
      this._live.mode = mode;
      if (mode === 'user') this._live.caption = 'your sheet — rest 6 s to hand back';
    }
    if (mode !== 'auto' || !this._params.autopilot) return;
    if (now < this._auto.next) return;
    this._auto.next = now + rnd(1300, 3400);

    // mud guard: when the sheet is mostly ink, rinse it down the open edge
    let cov = 0;
    try { cov = this._wc.coverage(); } catch (e) {}
    if (cov > 0.68) { this._rinse(); return; }

    const scene = this._live.scene;
    const r = Math.random();
    if (now - this._lastAutoDry > 55000 && r < 0.18) {
      this._lastAutoDry = now;
      try { this._wc.dry(); } catch (e) {}
      this._live.caption = 'letting the sheet set — hard edges form';
      return;
    }
    if (scene === 'plinko') {
      if (r < 0.8) {
        const n = 1 + ri(2);
        for (let i = 0; i < n; i++) this._dropOne();
        this._live.caption = 'releasing runners through the pegs';
      } else {
        this._gust();
        this._live.caption = 'a gust across the pegfield';
      }
    } else if (scene === 'sandbox') {
      if (r < 0.55) { this._flingRandom(); this._live.caption = 'flicking a runner across the sheet'; }
      else if (r < 0.8 && this._bodies.length < clamp(this._params.maxBodies, 2, 80)) {
        this._spawnShape(); this._live.caption = 'another body joins the pile';
      } else { this._gust(); this._live.caption = 'shaking the easel'; }
    } else {
      const pd = this._pendula[ri(Math.max(1, this._pendula.length))];
      if (pd) {
        Body.setVelocity(pd.head, { x: rnd(-13, 13), y: rnd(-6, 2) });
        this._live.caption = 'the loaded brush swings';
      }
    }
  }

  _rinse() {
    if (this._rinsing) return;
    this._rinsing = true;
    const wc = this._wc;
    this._live.caption = 'rinsing — the open bottom edge drains the sheet';
    try { wc.edgeMode('gravity'); wc.gravityDirection('down'); wc.gravityStrength(0.7); wc.flood(0.95); } catch (e) {}
    setTimeout(() => { try { wc.flood(0.4); } catch (e) {} }, 2400);
    setTimeout(() => {
      try { wc.edgeMode('closed'); wc.gravityStrength(0.18 * this._params.gravity); } catch (e) {}
      this._rinsing = false;
    }, 5200);
  }

  _gust() {
    for (const b of this._bodies) {
      if (b.plugin.kind === 'brush') continue;
      Body.setVelocity(b, {
        x: b.velocity.x + rnd(-7, 7),
        y: b.velocity.y - rnd(0, 6),
      });
    }
  }

  // ---------------------------------------------------------------- drawing

  _draw() {
    const cv = this._cv;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.clientWidth, H = this.clientHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      if (this._matterMouse) this._matterMouse.pixelRatio = dpr;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const theme = THEMES[this._themeName] || THEMES.lab;
    const ink = theme.ink;
    const sw = this._swatches().colors;

    // pegs
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.28;
    for (const peg of this._pegs) {
      ctx.beginPath();
      ctx.arc(peg.position.x, peg.position.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // pools
    for (const w of this._wells) {
      ctx.beginPath();
      const r = w.h / 2;
      ctx.roundRect(w.x, w.y, w.w, w.h, r);
      ctx.fillStyle = sw[w.pig] || '#888';
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ropes
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.4;
    for (const pd of this._pendula) {
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(pd.anchor.x, pd.anchor.y);
      ctx.lineTo(pd.head.position.x, pd.head.position.y);
      ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(pd.anchor.x, pd.anchor.y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // bodies
    for (const b of this._bodies) {
      const pl = b.plugin;
      ctx.beginPath();
      if (b.circleRadius) {
        ctx.arc(b.position.x, b.position.y, b.circleRadius, 0, Math.PI * 2);
      } else {
        const v = b.vertices;
        ctx.moveTo(v[0].x, v[0].y);
        for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y);
        ctx.closePath();
      }
      if (pl.water) {
        ctx.fillStyle = 'rgba(140,170,205,0.18)';
        ctx.fill();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else {
        const col = sw[pl.pig] || '#888';
        ctx.globalAlpha = 0.22 + 0.68 * pl.load;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // rotation tick on circles so spin reads
      if (b.circleRadius && !pl.water) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(b.position.x, b.position.y);
        ctx.lineTo(b.position.x + Math.cos(b.angle) * b.circleRadius * 0.8,
                   b.position.y + Math.sin(b.angle) * b.circleRadius * 0.8);
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  // ---------------------------------------------------------------- status + API

  _status() {
    let cov = 0, wetPct = 0, perf = '';
    try {
      cov = this._wc.coverage();
      const snap = this._wc.state();
      const cells = snap.gridWidth * snap.gridHeight;
      wetPct = cells ? Math.min(100, Math.round((snap.totalWetness / cells) * 100)) : 0;
      perf = String(snap.perfLevel || '');
    } catch (e) {}
    const sw = this._swatches();
    this.dispatchEvent(new CustomEvent('phys-status', {
      detail: {
        ready: true,
        mode: this._live.mode,
        scene: this._live.scene,
        caption: this._live.caption,
        bodies: this._bodies ? this._bodies.length : 0,
        coverage: cov,
        wetness: wetPct,
        perf,
        gpu: this._gpu.on,
        theme: this._themeName,
        swatches: sw.colors,
        names: sw.names,
        version: Washes.version || '',
      },
    }));
  }

  setScene(name) {
    if (['plinko', 'sandbox', 'pendulum'].indexOf(name) === -1) return;
    this._buildScene(name);
  }

  setTheme(name) {
    if (!THEMES[name]) return;
    this._themeName = name;
    this._applyTheme();
  }

  reInk(i) {
    if (!this._bodies) return;
    for (const b of this._bodies) {
      if (b.plugin.water) continue;
      b.plugin.pig = i;
      b.plugin.load = 1;
    }
    const names = this._swatches().names;
    this._live.caption = 'every runner re-inked in ' + (names[i] || 'pigment ' + i);
    this._live.lastUser = performance.now();
  }

  action(n) {
    const wc = this._wc;
    this._live.lastUser = 0; // let the act show under autopilot captioning
    if (n === 'drop') {
      const sc = this._live.scene;
      if (sc === 'pendulum') {
        for (const pd of this._pendula) Body.setVelocity(pd.head, { x: rnd(-14, 14), y: rnd(-4, 2) });
        this._live.caption = 'all brushes shoved at once';
      } else if (sc === 'sandbox') { this._spawnOrFling(); }
      else { this._dropOne(); this._live.caption = 'one runner, released'; }
    } else if (n === 'rain') {
      let i = 0;
      const id = setInterval(() => {
        if (++i > 7) { clearInterval(id); return; }
        if (this._live.scene === 'sandbox') this._spawnOrFling();
        else if (this._live.scene === 'plinko') this._dropOne();
        else this._flingRandom();
      }, 130);
      this._live.caption = 'rain — a burst of runners';
    } else if (n === 'shake') {
      this._gust();
      for (const pd of this._pendula || []) Body.setVelocity(pd.head, { x: rnd(-12, 12), y: rnd(-8, 0) });
      this._live.caption = 'shaking the easel';
    } else if (n === 'rinse') {
      this._rinse();
    } else if (n === 'dry') {
      try { wc.dry(); } catch (e) {}
      this._live.caption = 'forced dry — hard edges set';
    } else if (n === 'clear') {
      try { wc.clearPaint(); } catch (e) {}
      this._live.caption = 'a fresh sheet';
    }
  }

  _spawnOrFling() {
    if (this._bodies.length < clamp(this._params.maxBodies, 2, 80)) {
      this._spawnShape();
      this._live.caption = 'another body joins the pile';
    } else {
      this._flingRandom();
      this._live.caption = 'flicking a runner across the sheet';
    }
  }

  setGpu(on) {
    if (on) this._gpuOn(false);
    else {
      this._gpuOff();
      try { this._wc.autoPerf(true); } catch (e) {}
      this._live.caption = 'cpu sim — the verified reference path';
    }
  }

  params(patch) {
    if (!patch) return;
    const prev = Object.assign({}, this._params);
    Object.assign(this._params, patch);
    const p = this._params;
    const engine = this._engine;
    if (!engine) return;
    engine.gravity.y = p.gravity;
    try { this._wc.gravityStrength(0.18 * p.gravity); } catch (e) {}
    try { this._wc.dryness(p.dryness); } catch (e) {}
    // live-update material params on existing bodies
    if (p.bounce !== prev.bounce || p.friction !== prev.friction || p.airDrag !== prev.airDrag) {
      for (const b of this._bodies || []) {
        b.restitution = p.bounce;
        b.friction = p.friction;
        b.frictionAir = b.plugin && b.plugin.kind === 'brush' ? p.airDrag * 0.6 : p.airDrag;
      }
    }
    // structural changes rebuild the active scene
    const scene = this._live.scene;
    if ((p.pegSpacing !== prev.pegSpacing && scene === 'plinko') ||
        (p.pendulums !== prev.pendulums && scene === 'pendulum') ||
        p.bodyScale !== prev.bodyScale) {
      this._buildScene(scene, true);
      return;
    }
    // body count tops up / trims without a rebuild
    if (p.maxBodies !== prev.maxBodies && scene !== 'pendulum') {
      const want = clamp(p.maxBodies, 2, 80);
      while (this._bodies.length > want) {
        const b = this._bodies.pop();
        Composite.remove(engine.world, b);
      }
      while (this._bodies.length < want) {
        if (scene === 'plinko') this._spawnRunner(true); else this._spawnShape();
      }
    }
  }
}

if (!customElements.get('washes-physics')) {
  customElements.define('washes-physics', WashesPhysicsEl);
}
