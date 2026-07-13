// scene.js — <washes-scene>: a react-three-fiber stage for the washes watercolor simulation.
//
// The washes sim runs offscreen on a hidden 1024x682 host; its canvas is mapped
// as a live CanvasTexture onto a segmented plane ("the sheet"). Wet areas of the
// painting physically buckle the sheet (wetness sampled into a coarse field and
// used as vertex displacement). Tilting the sheet feeds a gravity vector back
// into the sim, so pigment literally runs downhill. An autopilot painter works
// the sheet until the user touches it (raycast UV -> strokeToNorm).

import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1';
import * as THREE from 'https://esm.sh/three@0.161.0';
import { Canvas, useFrame, useThree } from 'https://esm.sh/@react-three/fiber@8.16.8?deps=react@18.3.1,react-dom@18.3.1,three@0.161.0';
import { OrbitControls } from 'https://esm.sh/three@0.161.0/examples/jsm/controls/OrbitControls.js';

// Live engine from the repo (API 2.x) — never a re-embedded copy.
const { Washes } = await import(new URL('../engine/src/index.js', import.meta.url).href);
const { initGpuSim } = await import(new URL('../engine/src/washes-gpu-sim.js', import.meta.url).href);

const h = React.createElement;
const { useRef, useEffect, useMemo, useState } = React;

// ---------------------------------------------------------------- constants

const SIM_W = 1024, SIM_H = 682;          // hidden sim host, 3:2
const SHEET_W = 3.15, SHEET_H = 2.1;      // world units, same ratio
const SEG_X = 64, SEG_Y = 44;             // sheet tessellation
const COLS = 29, ROWS = 20;               // wetness sample field

const STOCK_SWATCHES = ['#d8447c', '#eec23d', '#3a87c0'];

const THEMES = {
  lab: {
    bg: '#0b0c0f', fog: [6.2, 13],
    paper: '#f2efe6', paperBack: '#b3af9f',
    floor: '#111319', hemiSky: '#454c70', hemiGround: '#0a0a0c', hemi: 0.55,
    bleed: '#c9c4b4',
    palette: [
      { color: '#5b2bd9', name: 'ultraviolet', granulation: 0.55 },
      { color: '#00a394', name: 'phthalo teal', granulation: 0.4 },
      { color: '#ff3d63', name: 'hot coral', granulation: 0.5 },
    ],
    ambient: 0.22, key: 1.7, rim: '#4b5dff', rimI: 0.9, shadow: 0.5,
  },
  gallery: {
    bg: '#e7e5e0', fog: [6.6, 14],
    paper: '#fbfaf4', paperBack: '#cfccc2',
    floor: '#d8d5ce', hemiSky: '#ffffff', hemiGround: '#b9b6ae', hemi: 0.6,
    bleed: '#dcd8cc',
    palette: null, // stock: quinacridone rose / hansa yellow / cerulean blue
    ambient: 0.4, key: 1.35, rim: '#ffffff', rimI: 0.35, shadow: 0.26,
  },
  atelier: {
    bg: '#d8cdb6', fog: [6.6, 14],
    paper: '#f3ecd9', paperBack: '#c6ba9e',
    floor: '#c7baa0', hemiSky: '#fff4dd', hemiGround: '#a09175', hemi: 0.6,
    bleed: '#cfc5a9',
    palette: [
      { color: '#2c3a63', name: 'indigo', granulation: 0.7 },
      { color: '#bf7e23', name: 'raw ochre', granulation: 0.5 },
      { color: '#49555f', name: "payne's grey", granulation: 0.8 },
    ],
    ambient: 0.35, key: 1.3, rim: '#ffd9a0', rimI: 0.45, shadow: 0.3,
  },
};

// ---------------------------------------------------------------- sim singletons

let _wc = null, _wcB = null;
function makeSim(scale) {
  const hostEl = document.createElement('div');
  hostEl.style.cssText =
    'position:fixed;left:-99999px;top:0;width:' + SIM_W + 'px;height:' + SIM_H + 'px;pointer-events:none;';
  document.body.appendChild(hostEl);
  const wc = Washes.create(hostEl, {
    pointer: false,
    cursorPreview: false,
    scale,
    canvasScale: 1,
  });
  try {
    wc.autoPerf(true);
    wc.run('until-dry');
    wc.edgeFade(3);
    wc.gravityStrength(0);
  } catch (e) { console.warn('washes config', e); }
  return wc;
}
function getSim() {
  if (_wc) return _wc;
  _wc = makeSim(2.8);
  // seed so the very first frame already has paint
  try {
    for (let i = 0; i < 6; i++) {
      _wc.paint(0.22 + i * 0.115, 0.42 + Math.sin(i * 1.7) * 0.14, 0.06, i % 3, 0.45);
    }
    _wc.paint(0.5, 0.5, 0.11, 'water', 0.9);
  } catch (e) { /* seed is cosmetic */ }
  return _wc;
}
// the reverse of the sheet: an independent canvas (coarser grid — it idles
// until painted). Its wetness curls the paper the OPPOSITE way.
function getSimBack() {
  if (_wcB) return _wcB;
  _wcB = makeSim(3.2);
  return _wcB;
}

// ---------------------------------------------------------------- GPU sim toggle
// Manual handle path (since washes 1.13): gpuSimContext() -> initGpuSim()
// -> gpuSim(handle) -> webgl(true). The autoPerf governor is parked while the
// GPU runs (it exists to rescue the CPU loop). A watchdog verifies the GPU
// canvas actually reads back pixels into our texture pipeline — if it comes
// back blank, we revert to the verified CPU path automatically.
const gpu = { on: false, handles: new Map(), unsubs: [] };

function canvasReadsBack(c) {
  try {
    const t = document.createElement('canvas');
    t.width = t.height = 8;
    const x = t.getContext('2d');
    x.drawImage(c, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true; // paper renders opaque
    return false;
  } catch (e) { return true; } // cannot verify -> do not revert
}

function enableGpuFor(sim) {
  const ctx = sim.gpuSimContext();
  if (!ctx) throw new Error('WebGL2 unavailable');
  const handle = initGpuSim(ctx.gl, ctx.GW, ctx.GH);
  sim.gpuSim(handle);
  sim.webgl(true);
  gpu.handles.set(sim, handle);
}
function disableGpuFor(sim) {
  try { sim.gpuSim(null); } catch (e) {}
  try { sim.webgl(false); } catch (e) {}
  const hnd = gpu.handles.get(sim);
  if (hnd) { try { hnd.destroy(); } catch (e) {} gpu.handles.delete(sim); }
}
function setGpuMode(on) {
  const sims = [_wc, _wcB].filter(Boolean);
  if (!sims.length || on === gpu.on) return;
  if (on) {
    try {
      for (const s of sims) { try { s.autoPerf(false); } catch (e) {} enableGpuFor(s); }
      gpu.on = true;
      live.caption = 'gpu sim — webgl2 fluid pipeline engaged';
      // rebuild handles if the grid is ever rebuilt under us
      for (const s of sims) {
        gpu.unsubs.push(s.on('rescale', () => {
          if (!gpu.on) return;
          try { disableGpuFor(s); enableGpuFor(s); } catch (e) { setGpuMode(false); }
        }));
      }
      // watchdog: a WebGL drawing buffer (no preserveDrawingBuffer) is only
      // readable in the same frame it was rendered, so a lone setTimeout
      // sample lands blank almost every time (false revert). Probe inside
      // rAF across ~90 frames; one non-blank frame proves the GPU render
      // feeds the texture pipeline. Revert only if EVERY frame is blank.
      let probes = 0;
      const probe = () => {
        if (!gpu.on || !_wc) return; // user turned it off mid-probe
        if (canvasReadsBack(_wc.canvas)) return; // verified
        if (++probes < 90) { requestAnimationFrame(probe); return; }
        setGpuMode(false);
        live.caption = 'gpu render read back blank — reverted to cpu';
      };
      setTimeout(() => requestAnimationFrame(probe), 1200);
    } catch (e) {
      console.warn('gpu enable failed', e);
      for (const s of sims) { disableGpuFor(s); try { s.autoPerf(true); } catch (e2) {} }
      gpu.on = false;
      live.caption = 'gpu unavailable here — staying on cpu';
    }
  } else {
    gpu.unsubs.forEach((u) => { try { u(); } catch (e) {} });
    gpu.unsubs = [];
    for (const s of sims) { disableGpuFor(s); try { s.autoPerf(true); } catch (e) {} }
    gpu.on = false;
    live.caption = 'cpu sim — the verified reference path';
  }
}

// shared mutable state between the element API, the sheet and the autopilot
const live = {
  lastUser: 0,
  painting: false,
  pour: { active: false, rx: 0, ry: 0 },
  caption: 'warming up the sheet',
  mode: 'auto',
  brush: 2,
  frontInView: true, // which sheet face is toward the camera (drives view-aware rinse)
  forceAct: null,
  gravityLock: false,
  controls: null,
  curlMax: 2.0, // radians; set from the maxBend tweak (degrees)
  paperOpacity: 0.88,
  paperColor: '#f2efe6', // kept in sync with the active theme; multiply-identity fill for the ghost pass
};

// ---------------------------------------------------------------- autopilot

function ri(n) { return Math.floor(Math.random() * n); }

function mkWalker() {
  return {
    x: 0.18 + Math.random() * 0.64, y: 0.18 + Math.random() * 0.64,
    a: Math.random() * Math.PI * 2, w: Math.random() * 100,
    px: null, py: null, acc: 0,
  };
}
function stepWalker(p, dt, speed) {
  p.w += dt;
  p.a += Math.sin(p.w * 0.9) * dt * 2.2 + (Math.random() - 0.5) * dt * 3;
  const nx = p.x + Math.cos(p.a) * speed * dt;
  const ny = p.y + Math.sin(p.a) * speed * dt;
  if (nx < 0.05 || nx > 0.95) p.a = Math.PI - p.a; else p.x = nx;
  if (ny < 0.06 || ny > 0.94) p.a = -p.a; else p.y = ny;
}
function lineN(wc, x0, y0, x1, y1, opts) {
  // v2 line() speaks normalized coords + nradius directly.
  wc.line(x0, y0, x1, y1, {
    pigment: opts.pigment,
    strength: opts.strength,
    nradius: opts.nradius || 0.03,
  });
}

function walkerTick(wc, p, dt, speed, threshold, getOpts) {
  if (p.px === null) { p.px = p.x; p.py = p.y; }
  stepWalker(p, dt, speed);
  if (Math.hypot(p.x - p.px, p.y - p.py) > threshold) {
    try { lineN(wc, p.px, p.py, p.x, p.y, getOpts()); } catch (e) { /* keep loop alive */ }
    p.px = p.x; p.py = p.y;
  }
}

const ACTS = {
  wash(wc) {
    const ws = [mkWalker(), mkWalker()];
    const pigs = [ri(3), ri(3)];
    return {
      dur: 6.5 + Math.random() * 3, caption: 'laying a wet wash',
      tick(dt) {
        ws.forEach((p, i) => walkerTick(wc, p, dt, 0.14, 0.014, () => ({
          pigment: Math.random() < 0.3 ? 'water' : pigs[i],
          nradius: 0.05 + Math.random() * 0.02,
          strength: 0.38,
        })));
      },
    };
  },
  detail(wc) {
    const p = mkWalker();
    const pig = ri(3);
    return {
      dur: 5 + Math.random() * 2, caption: 'drawing into the damp',
      tick(dt) {
        walkerTick(wc, p, dt, 0.3, 0.01, () => ({ pigment: pig, nradius: 0.013, strength: 0.85 }));
      },
    };
  },
  bloom(wc) {
    let acc = 0.5;
    return {
      dur: 4.5, caption: 'water blooms — pigment flees the drop',
      tick(dt) {
        acc += dt;
        if (acc > 0.65) {
          acc = 0;
          const x = 0.15 + Math.random() * 0.7, y = 0.15 + Math.random() * 0.7;
          try { wc.rewet(x, y, 0.1); wc.paint(x, y, 0.055, 'water', 0.85); } catch (e) {}
        }
      },
    };
  },
  splash(wc) {
    // v2: real preset names. ('splash'/'spray' never existed as presets — these
    // calls silently no-op'd inside their try{} for the demo's whole life.)
    const styles = ['deluge', 'bigSplash', 'fineSpritz'];
    const n = 1 + (Math.random() < 0.45 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      try {
        wc.splash(
          [{ x: 0.18 + Math.random() * 0.64, y: 0.18 + Math.random() * 0.64, velocity: 38 + Math.random() * 34 }],
          styles[ri(styles.length)]
        );
      } catch (e) {}
    }
    return { dur: 2.4, caption: 'splash' };
  },
  pour(wc, lv) {
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    lv.gravityLock = true;
    lv.pour = { active: true, rx: dy * 0.5, ry: dx * 0.5 };
    try { wc.rewet(); wc.gravityVector(dx, dy); wc.gravityStrength(0.55); wc.pour(dx, dy, 0.9); } catch (e) {}
    return {
      dur: 3.6, caption: 'tilting the sheet — gravity takes the wash',
      done() {
        try { wc.endPour(); wc.gravityStrength(0); } catch (e) {}
        lv.pour = { active: false, rx: 0, ry: 0 };
        lv.gravityLock = false;
      },
    };
  },
  salt(wc) {
    const p = mkWalker();
    const pig = ri(3);
    try { wc.brushMode('salt'); wc.dryness(0.8); } catch (e) {}
    return {
      dur: 4.2, caption: 'salt texture — granulating',
      tick(dt) {
        walkerTick(wc, p, dt, 0.2, 0.012, () => ({ pigment: pig, nradius: 0.034, strength: 0.6 }));
      },
      done() { try { wc.brushMode('wet'); wc.dryness(0.3); } catch (e) {} },
    };
  },
  dry(wc, lv, wcB) {
    try { wc.dry(); } catch (e) {}
    try { if (wcB) wcB.dry(); } catch (e) {}
    return { dur: 2.2, caption: 'forced dry — hard edges set' };
  },
  rinse(wc, lv, wcB) {
    // rinse the face the viewer is actually looking at
    const sim = lv.frontInView === false && wcB ? wcB : wc;
    const back = sim !== wc;
    lv.gravityLock = true;
    lv.pour = { active: true, rx: 0.55, ry: 0 };
    let flooded = false;
    try { sim.edgeMode('gravity'); sim.gravityDirection('down'); sim.gravityStrength(0.7); sim.flood(0.95); } catch (e) {}
    return {
      dur: 5, caption: back ? 'rinsing the back face — the open edge drains it' : 'rinsing — the open edge drains the sheet',
      tick(dt, t) {
        if (!flooded && t > 2.4) { flooded = true; try { sim.flood(0.4); } catch (e) {} }
      },
      done() {
        try { sim.edgeMode('closed'); sim.gravityStrength(0); } catch (e) {}
        lv.pour = { active: false, rx: 0, ry: 0 };
        lv.gravityLock = false;
      },
    };
  },
  clear(wc, lv, wcB) {
    try { wc.clearPaint(); } catch (e) {}
    try { if (wcB) wcB.clearPaint(); } catch (e) {}
    return { dur: 1, caption: 'a fresh sheet' };
  },
};

class AutoPainter {
  constructor(wc, lv, wcB) { this.wc = wc; this.live = lv; this.wcB = wcB; this.act = null; this.queue = []; }
  force(name) { this._end(); if (ACTS[name]) this._start(name); }
  idle() { if (this.act) this._end(); }
  tick(dt) {
    if (!this.act) this._start(this._next());
    const a = this.act;
    a.t += dt;
    try { if (a.tick) a.tick(dt, a.t); } catch (e) { console.warn('act', a.name, e); }
    if (a.t >= a.dur) this._end();
  }
  _end() {
    if (!this.act) return;
    try { if (this.act.done) this.act.done(); } catch (e) {}
    this.act = null;
  }
  _next() {
    let cov = 0;
    // judge mud by the face the viewer is looking at — rinse targets it too
    const seen = this.live.frontInView === false && this.wcB ? this.wcB : this.wc;
    try { cov = seen.coverage(); } catch (e) {}
    if (cov > 0.62) return 'rinse';
    if (!this.queue.length) {
      this.queue = ['wash', 'detail', 'bloom', 'splash', 'wash', 'pour', 'detail', 'salt', 'bloom', 'dry']
        .sort(() => Math.random() - 0.5);
      // never open on a destructive act
      this.queue = this.queue.filter((n) => n !== 'dry');
      this.queue.splice(3 + ri(4), 0, 'dry');
    }
    return this.queue.shift();
  }
  _start(name) {
    const a = ACTS[name](this.wc, this.live, this.wcB);
    a.name = name; a.t = 0;
    this.act = a;
    this.live.caption = a.caption;
  }
}

// ---------------------------------------------------------------- R3F pieces

function Controls() {
  const { camera, gl } = useThree();
  const ref = useRef();
  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = 2.4;
    c.maxDistance = 8.5;
    c.minPolarAngle = 0.35;
    c.maxPolarAngle = Math.PI - 0.55;
    c.enablePan = false;
    c.target.set(0, -0.1, 0);
    ref.current = c;
    live.controls = c;
    return () => { c.dispose(); if (live.controls === c) live.controls = null; };
  }, [camera, gl]);
  useFrame(() => {
    const c = ref.current;
    if (!c) return;
    if (!live.painting && !c.enabled) c.enabled = true; // safety net
    c.update();
  });
  return null;
}

// signed wetness: front wets bend the sheet back (+), back-canvas wets bend
// it forward (-) — the two faces fight over the fold direction.
function sampleWet(wcF, wcB, tgt) {
  let i = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let w = 0;
      try {
        const sF = wcF.sample(c / (COLS - 1), r / (ROWS - 1));
        w = Math.min(1, sF.wetness * 1.3 + sF.density * 0.08);
      } catch (e) {}
      try {
        const sB = wcB.sample(c / (COLS - 1), r / (ROWS - 1));
        w -= Math.min(1, sB.wetness * 1.3 + sB.density * 0.08);
      } catch (e) {}
      if (!isFinite(w)) w = 0;
      tgt[i++] = w;
    }
  }
}
function bilin(f, u, v) {
  const x = Math.min(Math.max(u, 0), 1) * (COLS - 1);
  const y = Math.min(Math.max(v, 0), 1) * (ROWS - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(COLS - 1, x0 + 1), y1 = Math.min(ROWS - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = f[y0 * COLS + x0] * (1 - fx) + f[y0 * COLS + x1] * fx;
  const b = f[y1 * COLS + x0] * (1 - fx) + f[y1 * COLS + x1] * fx;
  return a * (1 - fy) + b * fy;
}

const DOWN_VIEW = new THREE.Vector3(0, 0, -1);

// --- hygroexpansion curl --------------------------------------------------
// Wet fibers expand on the painted face, giving the sheet a local target
// CURVATURE proportional to wetness, bending AWAY from the brush. Instead of
// axis-aligned strips (grid-like), every vertex integrates curvature along
// its own ray from the sheet center across a blurred wet field: theta
// accumulates kappa*ds and the vertex follows (cos theta, -sin theta). The
// hinge line therefore follows the actual shape of the wet region — a soaked
// corner curls over backward and pulls inward, an even soak rolls the whole
// sheet, and as the sim dries the curl relaxes flat.
const CURL_K = 2.4;    // curvature (rad / world unit) at full wetness
const CURL_STEP = 0.09; // ray march step, world units (field is blurred; coarse is fine)
// max bend angle is runtime-tweakable: live.curlMax (set by the maxBend prop)

function blur3(src, dst, tmp) {
  for (let r = 0; r < ROWS; r++) {
    const row = r * COLS;
    for (let c = 0; c < COLS; c++) {
      const l = src[row + Math.max(0, c - 1)], m = src[row + c], rr = src[row + Math.min(COLS - 1, c + 1)];
      tmp[row + c] = 0.25 * l + 0.5 * m + 0.25 * rr;
    }
  }
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const u2 = tmp[Math.max(0, r - 1) * COLS + c], m = tmp[r * COLS + c], d = tmp[Math.min(ROWS - 1, r + 1) * COLS + c];
      dst[r * COLS + c] = 0.25 * u2 + 0.5 * m + 0.25 * d;
    }
  }
}

function Sheet({ wc, wcB, theme }) {
  const group = useRef();
  const matF = useRef();
  const matB = useRef();
  // composite canvases: own painting + the other side's ink showing through
  const comp = useMemo(() => {
    const make = () => {
      const c = document.createElement('canvas');
      c.width = wc.canvas.width;
      c.height = wc.canvas.height;
      return c;
    };
    return { f: make(), b: make(), g: make() }; // g: scratch for paper-normalizing sim canvases
  }, [wc]);
  const tex = useMemo(() => {
    const t = new THREE.CanvasTexture(comp.f);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [comp]);
  const texB = useMemo(() => {
    const t = new THREE.CanvasTexture(comp.b);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [comp]);
  const geo = useMemo(() => new THREE.PlaneGeometry(SHEET_W, SHEET_H, SEG_X, SEG_Y), []);
  const fields = useMemo(() => ({
    cur: new Float32Array(COLS * ROWS),
    tgt: new Float32Array(COLS * ROWS),
    sm: new Float32Array(COLS * ROWS),
    tmp: new Float32Array(COLS * ROWS),
    frame: 0, grav: 0, gx: 0, gy: 0,
    q: new THREE.Quaternion(), v: new THREE.Vector3(),
    q2: new THREE.Quaternion(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
  }), []);

  // per-vertex rays from the sheet center, precomputed once
  const rays = useMemo(() => {
    const uvA = geo.attributes.uv;
    const n = uvA.count;
    const dx = new Float32Array(n), dy = new Float32Array(n), L = new Float32Array(n);
    const steps = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const px = (uvA.getX(i) - 0.5) * SHEET_W;
      const py = (uvA.getY(i) - 0.5) * SHEET_H;
      const l = Math.hypot(px, py);
      L[i] = l;
      dx[i] = l > 1e-6 ? px / l : 0;
      dy[i] = l > 1e-6 ? py / l : 0;
      steps[i] = Math.max(1, Math.ceil(l / CURL_STEP));
    }
    return { dx, dy, L, steps };
  }, [geo]);

  useFrame((st, rawDt) => {
    const dt = Math.min(rawDt, 0.08);

    // --- workload scheduler: textures on odd frames, geometry on even frames
    // (30 Hz each on a 60 Hz display — invisible through the smoothing), and
    // everything eases to ~5 Hz when both sims have gone idle and the curl
    // field has settled.
    fields.frame++;
    if (fields.frame % 4 === 0) sampleWet(wc, wcB, fields.tgt);
    const k = Math.min(1, dt * 2.2);
    const { cur, tgt, sm, tmp } = fields;
    let delta = 0;
    for (let i = 0; i < cur.length; i++) {
      const d = (tgt[i] - cur[i]) * k;
      cur[i] += d;
      if (d > delta) delta = d; else if (-d > delta) delta = -d;
    }
    if (fields.frame % 30 === 0) {
      try { fields.simIdle = !!(wc.state().isIdle && wcB.state().isIdle); } catch (e) { fields.simIdle = false; }
    }
    const settled = fields.simIdle && !live.painting && delta < 0.0025;
    const doTex = fields.frame % (settled ? 12 : 2) === 1;
    const doGeo = fields.frame % (settled ? 12 : 2) === 0;

    if (matF.current) matF.current.opacity = live.paperOpacity;
    if (matB.current) matB.current.opacity = live.paperOpacity;

    if (doTex) {
      // ink-through-paper: blend the other face's painting in, scaled by
      // how translucent the paper is (thinner sheet -> stronger ghosting).
      // Every sim canvas is first normalized onto a paper-color-filled
      // scratch: the GPU path's WebGL canvas is transparent where unpainted,
      // and transparent pixels multiply to black (the "black pigment on the
      // far face" bug). Paper fill makes blank areas the multiply identity,
      // so the same ghost pass works for both sim backends.
      const thru = Math.min(0.65, Math.max(0.08, (1 - live.paperOpacity) * 2.2 + 0.08));
      const norm = (src) => {
        const g = comp.g;
        const ctx = g.getContext('2d');
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = live.paperColor;
        ctx.fillRect(0, 0, g.width, g.height);
        ctx.drawImage(src, 0, 0, g.width, g.height);
        return g;
      };
      const blend = (dst, selfC, otherC) => {
        const ctx = dst.getContext('2d');
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(norm(selfC), 0, 0, dst.width, dst.height);
        ctx.globalAlpha = thru;
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(norm(otherC), 0, 0, dst.width, dst.height);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      };
      try { blend(comp.f, wc.canvas, wcB.canvas); blend(comp.b, wcB.canvas, wc.canvas); } catch (e) {}
      tex.needsUpdate = true;
      texB.needsUpdate = true;
    }

    // --- hygroexpansion: per-vertex radial curvature marching
    // Anisotropy: localized wetness curls radially (corner flips), but as
    // wetness becomes widespread the bend concentrates around a single grain
    // axis with a lower angle cap — paper rolls into a gentle arch, never a
    // spheroid (it cannot hold Gaussian curvature).
    const t = st.clock.elapsedTime;
    if (doGeo) {
    blur3(cur, sm, tmp);
    let wetCells = 0;
    for (let i = 0; i < sm.length; i++) if (Math.abs(sm[i]) > 0.3) wetCells++;
    const aniso = Math.min(1, Math.max(0, (wetCells / sm.length - 0.22) / 0.4));
    const thCap = live.curlMax * (1 - 0.42 * aniso); // user tweak, eased for a full soak

    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const L = rays.L[i], dx = rays.dx[i], dy = rays.dy[i];
      const axisW = 1 - aniso * (1 - dx * dx); // full soak: only grain-aligned rays bend
      let z = 0, plane = L;
      if (L > 1e-4) {
        const nSteps = rays.steps[i];
        const hs = L / nSteps;
        let th = 0, s = 0;
        plane = 0;
        for (let j = 0; j < nSteps; j++) {
          const mid = s + hs * 0.5;
          // ramp: wetness near the center anchor barely bends the sheet —
          // it cockles locally instead of lifting the whole rim
          let ramp = mid / 0.55;
          if (ramp >= 1) ramp = 1; else ramp = ramp * ramp * (3 - 2 * ramp);
          const wq = bilin(sm, 0.5 + (dx * mid) / SHEET_W, 1 - (0.5 + (dy * mid) / SHEET_H));
          th += wq * CURL_K * axisW * ramp * hs; // signed: back-canvas wetness folds the other way
          if (th > thCap) th = thCap; else if (th < -thCap) th = -thCap;
          z -= Math.sin(th) * hs;          // bend away from the wetter face
          plane += Math.cos(th) * hs;      // flap shortens in-plane as it curls
          s += hs;
        }
      }
      const w = bilin(sm, u, 1 - v);
      const cockle = 0.028 * Math.abs(w);
      const rip = 0.006 * Math.sin(u * 6.5 + t * 0.9) * Math.sin(v * 4.5 - t * 0.6);
      const zz = z + cockle + rip;
      const ok = isFinite(plane) && isFinite(zz);
      pos.setXYZ(i,
        ok ? dx * plane : (u - 0.5) * SHEET_W,
        ok ? dy * plane : (v - 0.5) * SHEET_H,
        ok ? zz : 0);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    st.gl.shadowMap.needsUpdate = true; // shadows re-render only when the sheet moved
    }

    // --- sway (gentle idle breathing; the camera is now orbitable instead)
    const g = group.current;
    if (!g) return;

    // --- which face is toward the camera (view-aware rinse target)
    if (fields.frame % 15 === 0) {
      g.getWorldQuaternion(fields.q2);
      fields.v2.set(0, 0, 1).applyQuaternion(fields.q2); // front-face world normal
      g.getWorldPosition(fields.v3);
      fields.v3.subVectors(st.camera.position, fields.v3); // sheet -> camera
      live.frontInView = fields.v2.dot(fields.v3) >= 0;
    }
    let tx, ty;
    if (live.pour.active) { tx = live.pour.rx; ty = live.pour.ry; }
    else {
      tx = Math.sin(t * 0.31) * 0.035;
      ty = Math.sin(t * 0.21) * 0.05;
    }
    const sk = Math.min(1, dt * (live.pour.active ? 2.6 : 1.6));
    g.rotation.x += (tx - g.rotation.x) * sk;
    g.rotation.y += (ty - g.rotation.y) * sk;

    // --- tilt -> gravity (desk metaphor: facing camera = lying flat = no drift)
    fields.grav += dt;
    if (fields.grav > 0.15 && !live.gravityLock) {
      fields.grav = 0;
      fields.q.copy(g.quaternion).invert();
      fields.v.copy(DOWN_VIEW).applyQuaternion(fields.q);
      const gx = fields.v.x, gy = -fields.v.y;
      const len = Math.hypot(gx, gy);
      if (Math.abs(gx - fields.gx) > 0.008 || Math.abs(gy - fields.gy) > 0.008) {
        fields.gx = gx; fields.gy = gy;
        try {
          if (len > 0.02) {
            wc.gravityVector(gx, gy); wc.gravityStrength(Math.min(0.4, len * 0.3));
            wcB.gravityVector(-gx, gy); wcB.gravityStrength(Math.min(0.4, len * 0.3)); // back view is mirrored in x
          } else { wc.gravityStrength(0); wcB.gravityStrength(0); }
        } catch (e) {}
      }
    }
  });

  // --- painting via raycast UV (each face strokes its own sim)
  const makeHandlers = (sim) => {
    const paintUV = (uvHit, pressure) => {
      if (!uvHit) return;
      const b = live.brush;
      let nr = 0.024, strength = 0.85;
      if (b === 'water') { nr = 0.045; strength = 0.8; }
      else if (b === 'lift') { nr = 0.035; strength = 0.9; }
      nr *= 0.75 + 0.6 * (pressure || 0.5);
      try { sim.stroke(uvHit.x, 1 - uvHit.y, { pigment: b, nradius: nr, strength }); } catch (e) {}
    };
    const onUp = () => {
      live.painting = false;
      if (live.controls) live.controls.enabled = true;
      live.lastUser = performance.now();
      try { sim.penUp(); } catch (err) {}
    };
    return {
      onPointerDown: (e) => {
        e.stopPropagation();
        if (live.controls) live.controls.enabled = false; // brush wins over orbit
        live.lastUser = performance.now();
        live.painting = true;
        try { sim.penUp(); } catch (err) {}
        paintUV(e.uv, e.pressure);
        if (e.target && e.target.setPointerCapture) { try { e.target.setPointerCapture(e.pointerId); } catch (err) {} }
      },
      onPointerMove: (e) => {
        if (!live.painting) return;
        live.lastUser = performance.now();
        paintUV(e.uv, e.pressure);
      },
      onPointerUp: onUp,
      onPointerOver: () => { document.body.style.cursor = 'crosshair'; },
      onPointerOut: () => { document.body.style.cursor = ''; onUp(); },
    };
  };
  const frontHandlers = useMemo(() => makeHandlers(wc), [wc]);
  const backHandlers = useMemo(() => makeHandlers(wcB), [wcB]);

  return h('group', { ref: group },
    h('mesh', Object.assign({
      geometry: geo,
      frustumCulled: false,
      castShadow: true,
    }, frontHandlers),
      h('meshStandardMaterial', { ref: matF, map: tex, roughness: 0.93, metalness: 0, transparent: true, opacity: 0.88 })
    ),
    // back of the sheet: an independent canvas — its wets fold the paper the other way
    h('mesh', Object.assign({ geometry: geo, frustumCulled: false, castShadow: true }, backHandlers),
      h('meshStandardMaterial', { ref: matB, map: texB, roughness: 0.96, metalness: 0, side: THREE.BackSide, transparent: true, opacity: 0.88 })
    )
  );
}

function Ground({ theme }) {
  return h('mesh', { rotation: [-Math.PI / 2, 0, 0], position: [0, -1.4, 0], receiveShadow: true },
    h('planeGeometry', { args: [40, 40] }),
    h('meshStandardMaterial', { color: theme.floor, roughness: 0.96, metalness: 0 })
  );
}

function AutoPilot({ wc, wcB }) {
  const painter = useMemo(() => new AutoPainter(wc, live, wcB), [wc, wcB]);
  useFrame((st, dt) => {
    const now = performance.now();
    if (live.forceAct) {
      painter.force(live.forceAct);
      live.forceAct = null;
      live.lastUser = 0; // hand the wheel back so the act plays out
    }
    const userActive = live.painting || now - live.lastUser < 6000;
    const mode = userActive ? 'user' : 'auto';
    if (mode !== live.mode) {
      live.mode = mode;
      if (mode === 'user') {
        painter.idle();
        live.caption = 'wet-on-wet — water blooms, lift erases';
      }
    }
    if (mode === 'auto') painter.tick(Math.min(dt, 0.08));
  });
  return null;
}

// ---------------------------------------------------------------- app + element

function App({ host }) {
  const wc = useMemo(getSim, []);
  const wcB = useMemo(getSimBack, []);
  const [themeName, setThemeName] = useState('lab');
  const t = THEMES[themeName] || THEMES.lab;

  // theme -> sims (paper color + working pigments, both faces)
  useEffect(() => {
    for (const sim of [wc, wcB]) {
      try {
        sim.paperColor(t.paper);
        live.paperColor = t.paper;
        sim.palette(t.palette
          ? t.palette.map((p) => ({ color: p.color, granulation: p.granulation, name: p.name }))
          : null);
      } catch (e) { console.warn('theme apply', e); }
    }
  }, [themeName, wc, wcB]);

  // imperative API for the host chrome
  useEffect(() => {
    host._api = {
      setTheme: (n) => { if (THEMES[n]) setThemeName(n); },
      setBrush: (b) => { live.brush = b; live.lastUser = performance.now(); },
      action: (n) => { live.forceAct = n; },
      setMaxBend: (deg) => {
        const d = Number(deg);
        if (isFinite(d)) live.curlMax = Math.max(0.02, Math.min(Math.PI * 2, (d * Math.PI) / 180));
      },
      setOpacity: (o) => {
        const v = Number(o);
        if (isFinite(v)) live.paperOpacity = Math.max(0.3, Math.min(1, v));
      },
      setGpu: (on) => { try { setGpuMode(!!on); } catch (e) { console.warn('setGpu', e); } },
    };
    host._ready = true;
  }, [host]);

  // GPU by default: attempt once the sims have settled in; the readback
  // watchdog inside setGpuMode reverts to CPU if the render comes back blank.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        setGpuMode(true);
        if (gpu.on) live.caption = 'gpu sim by default — webgl2 fluid pipeline engaged';
      } catch (e) { console.warn('gpu default', e); }
    }, 700);
    return () => clearTimeout(id);
  }, []);

  // status broadcast for the host chrome
  useEffect(() => {
    const id = setInterval(() => {
      let cov = 0, snap = null, wetPct = 0;
      try {
        cov = wc.coverage();
        snap = wc.state();
        const cells = snap.gridWidth * snap.gridHeight;
        wetPct = cells ? Math.min(100, Math.round((snap.totalWetness / cells) * 100)) : 0;
      } catch (e) {}
      const swatches = t.palette ? t.palette.map((p) => p.color) : STOCK_SWATCHES;
      const names = t.palette ? t.palette.map((p) => p.name) : ['quinacridone rose', 'hansa yellow', 'cerulean blue'];
      host.dispatchEvent(new CustomEvent('wash-status', {
        detail: {
          ready: true,
          mode: live.mode,
          caption: live.caption,
          brush: live.brush,
          coverage: cov,
          wetness: wetPct,
          perf: snap ? String(snap.perfLevel || '') : '',
          theme: themeName,
          swatches, names,
          gpu: gpu.on,
          version: Washes.version || '',
        },
      }));
    }, 350);
    return () => clearInterval(id);
  }, [themeName, host, wc]);

  return h(Canvas, {
    flat: true,
    dpr: [1, 1.5],
    shadows: true,
    gl: { preserveDrawingBuffer: true, antialias: true },
    onCreated: (st) => {
      window.__wdbg = st;
      st.gl.shadowMap.autoUpdate = false; // Sheet requests shadow renders when it deforms
      st.gl.shadowMap.needsUpdate = true;
    },
    camera: { fov: 36, position: [0.9, 0.7, 4.5] },
    style: { position: 'absolute', inset: 0 },
  },
    h('color', { attach: 'background', args: [t.bg] }),
    h('fog', { attach: 'fog', args: [t.bg, t.fog[0], t.fog[1]] }),
    h('hemisphereLight', { color: t.hemiSky, groundColor: t.hemiGround, intensity: t.hemi }),
    h('ambientLight', { intensity: t.ambient }),
    h('directionalLight', {
      position: [2.6, 4, 2.8], intensity: t.key, castShadow: true,
      'shadow-mapSize-width': 1024, 'shadow-mapSize-height': 1024,
      'shadow-camera-left': -3.5, 'shadow-camera-right': 3.5,
      'shadow-camera-top': 3.5, 'shadow-camera-bottom': -3.5,
      'shadow-camera-near': 0.5, 'shadow-camera-far': 14,
      'shadow-bias': -0.0004, 'shadow-normalBias': 0.02,
    }),
    h('directionalLight', { position: [-3, -1.5, -2.5], intensity: t.rimI, color: t.rim }),
    h(Controls, {}),
    h(Sheet, { wc, wcB, theme: t }),
    h(Ground, { theme: t }),
    h(AutoPilot, { wc, wcB })
  );
}

class WashesSceneEl extends HTMLElement {
  connectedCallback() {
    if (this._mounted) return;
    this._mounted = true;
    this.style.display = 'block';
    if (!this.style.width) this.style.width = '100%';
    if (!this.style.height) this.style.height = '100%';
    if (getComputedStyle(this).position === 'static') this.style.position = 'relative';
    const mount = document.createElement('div');
    mount.style.cssText = 'position:absolute;inset:0;';
    this.appendChild(mount);
    this._root = createRoot(mount);
    this._root.render(h(App, { host: this }));
  }
  setTheme(n) { if (this._api) this._api.setTheme(n); }
  setBrush(b) { if (this._api) this._api.setBrush(b); }
  setMaxBend(d) { if (this._api) this._api.setMaxBend(d); }
  setOpacity(o) { if (this._api) this._api.setOpacity(o); }
  setGpu(on) { if (this._api) this._api.setGpu(on); }
  action(n) { if (this._api) this._api.action(n); }
}

if (!customElements.get('washes-scene')) {
  customElements.define('washes-scene', WashesSceneEl);
}
