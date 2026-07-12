// cpu-backend.test.mjs
//
// Phase 0 verification: prove the CPU backend ADAPTER drives the real v0.98
// simulation identically to driving the instance directly. If the adapter is a
// faithful seam (not a reimplementation), two deterministic instances — one
// driven through the adapter, one driven by the same raw calls — must end in
// bit-identical state.
//
// Loads the real lib with _debug_* hooks injected (same technique as the
// regression harness), with Math.random seeded so both instances are identical.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createCpuBackend } from '../backend/cpu-backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Self-contained: defaults to the vendored v0.98 lib shipped beside this test.
// Point WASHES_LIB at your own build to test against it instead.
const LIB = process.env.WASHES_LIB || resolve(__dirname, '../vendor/washes.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL ' + msg); } }

// --- deterministic PRNG (mulberry32) installed over Math.random ---
let _seed = 1;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function reseed(s) { _seed = s; Math.random = mulberry32(s); }

// --- minimal DOM mock (trimmed from washes-test-harness.cjs) ---
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), attributes: {}, children: [], childNodes: [],
    style: {}, dataset: {}, parentNode: null, parentElement: null, width: 1024, height: 768,
    _listeners: {}, ownerSVGElement: null,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    replaceChildren() { this.children = []; this.childNodes = []; },
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    removeEventListener() {}, dispatchEvent() { return true; },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 1080, bottom: 900, width: 1080, height: 900, x: 0, y: 0 }; },
    toDataURL() { return 'data:image/png;base64,F'; }, toBlob(cb) { setTimeout(() => cb({ size: 1 }), 0); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getContext(t) {
      if (t === 'webgl2') return null;
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {}, fillText() {},
        measureText() { return { width: 50 }; }, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        imageSmoothingEnabled: true, fillStyle: '', strokeStyle: '', font: '', globalAlpha: 1,
      };
    },
  };
}
function installMockDOM() {
  global.document = {
    createElement: (t) => makeEl(t), createElementNS: (ns, t) => makeEl(t),
    getElementById: () => null, querySelectorAll: () => [],
    documentElement: { style: { setProperty() {} }, dataset: {} },
  };
  global.document.body = makeEl('body');
  global.window = {
    innerWidth: 1080, innerHeight: 900, devicePixelRatio: 1, addEventListener() {},
    location: { search: '' }, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false }),
  };
  Object.defineProperty(global, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true, writable: true });
  Object.defineProperty(global, 'performance', { value: { now: () => 0 }, configurable: true, writable: true });
  global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};
  global.URLSearchParams = URLSearchParams;
  global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  global.Blob = function () {}; global.Image = function () {};
  global.DOMParser = function () { return { parseFromString: () => ({ querySelector: () => null, querySelectorAll: () => [] }) }; };
  global.CustomEvent = function (t, o) { this.type = t; this.detail = o && o.detail; };
}

const DEBUG_HOOKS = `
    _debug_simStep(n) { for (let i = 0; i < n; i++) simStep(); },
    _debug_cell(x, y) { const i = y * GW + x; return { g: g[0][i]+g[1][i]+g[2][i], d: d[0][i]+d[1][i]+d[2][i], u: u[i], v: v[i], wet: wet[i], pressure: pressure[i] }; },
    _debug_sum() { let s = 0; for (let i = 0; i < N; i++) s += g[0][i]+g[1][i]+g[2][i]+d[0][i]+d[1][i]+d[2][i]; return s; },
    _debug_dims() { return { GW: GW, GH: GH, N: N }; },
    _debug_pack() {
      const f = new Float32Array(N*4), pg = new Float32Array(N*4), dp = new Float32Array(N*4), pp = new Float32Array(N*4);
      for (let i = 0; i < N; i++) { const i4 = i*4;
        f[i4]=u[i]; f[i4+1]=v[i]; f[i4+2]=pressure[i]; f[i4+3]=wet[i];
        pg[i4]=g[0][i]; pg[i4+1]=g[1][i]; pg[i4+2]=g[2][i];
        dp[i4]=d[0][i]; dp[i4+1]=d[1][i]; dp[i4+2]=d[2][i]; dp[i4+3]=mask[i];
        pp[i4]=paperH[i];
      }
      return { fluid: f, pigment: pg, deposit: dp, paper: pp };
    },`;

function loadLib() {
  let src = readFileSync(LIB, 'utf8');
  src = src.replace('  state() {', DEBUG_HOOKS + '\n  state() {');
  src = src.replace(/^export .+$/gm, '');
  new Function(src)();
  return global.window.Washes;
}

// --- build a SimBackend host over a debug-instrumented instance ---
function hostFor(inst) {
  return {
    step: () => inst._debug_simStep(1),
    stamp: (s) => inst.paintAt(s.cx, s.cy, s.radius, s.pigmentIdx, s.strength),
    readState: (out) => {
      const p = inst._debug_pack();
      out.fluid.set(p.fluid); out.pigment.set(p.pigment);
      out.deposit.set(p.deposit); out.paper.set(p.paper);
    },
    writeState: () => {}, // not exercised in this equivalence test
    gridSize: (() => { const dq = inst._debug_dims(); return { GW: dq.GW, GH: dq.GH }; })(),
    destroy: () => inst.destroy(),
  };
}

installMockDOM();
const Washes = loadLib();
const SEED = 12345;

// Identical stamps to apply in both runs.
const stamps = [
  { cx: 300, cy: 240, radius: 14, strength: 0.8, brushType: 0, pigmentIdx: 0, wetAmount: 1, pressureAmount: 0.5 },
  { cx: 340, cy: 270, radius: 18, strength: 0.6, brushType: 0, pigmentIdx: 1, wetAmount: 1, pressureAmount: 0.5 },
  { cx: 320, cy: 300, radius: 10, strength: 0.9, brushType: 0, pigmentIdx: 2, wetAmount: 1, pressureAmount: 0.5 },
];
const STEPS = 25;

// Run A: through the adapter.
reseed(SEED);
const instA = Washes.create(makeEl('div'));
const backend = createCpuBackend(hostFor(instA));
reseed(SEED);
backend.stampBrush(stamps);
for (let i = 0; i < STEPS; i++) backend.step({});

// Run B: drive the raw instance directly with the same calls.
reseed(SEED);
const instB = Washes.create(makeEl('div'));
reseed(SEED);
for (const s of stamps) instB.paintAt(s.cx, s.cy, s.radius, s.pigmentIdx, s.strength);
instB._debug_simStep(STEPS);

// --- capability contract ---
ok(backend.capabilities.gpu === false, 'CPU backend reports gpu=false');
ok(backend.capabilities.maxStampsPerStep === Infinity, 'CPU has no per-step stamp cap');
ok(typeof backend.step === 'function' && typeof backend.stampBrush === 'function'
   && typeof backend.uploadState === 'function' && typeof backend.downloadState === 'function'
   && typeof backend.getTextures === 'function' && typeof backend.destroy === 'function',
   'CPU backend satisfies the full SimBackend method set');
ok(backend.getTextures() === null, 'CPU getTextures() is null (no GL textures)');

// --- equivalence: adapter-driven == directly-driven, cell for cell ---
const probes = [[300, 240], [340, 270], [320, 300], [200, 200], [400, 350], [324, 270]];
let maxDiff = 0;
for (const [x, y] of probes) {
  const a = instA._debug_cell(x, y), b = instB._debug_cell(x, y);
  for (const k of ['g', 'd', 'u', 'v', 'wet', 'pressure']) {
    maxDiff = Math.max(maxDiff, Math.abs(a[k] - b[k]));
  }
}
ok(maxDiff === 0, `adapter-driven state is bit-identical to direct (max probe diff ${maxDiff})`);
ok(instA._debug_sum() === instB._debug_sum(), 'total pigment+deposit mass identical');

// --- downloadState actually moves real data ---
const dims = instA._debug_dims();
const out = {
  fluid: new Float32Array(dims.N * 4), pigment: new Float32Array(dims.N * 4),
  deposit: new Float32Array(dims.N * 4), paper: new Float32Array(dims.N * 4),
};
backend.downloadState(out);
let pigSum = 0; for (let i = 0; i < out.pigment.length; i++) pigSum += out.pigment[i];
ok(pigSum > 0, `downloadState returns real painted pigment (sum ${pigSum.toFixed(3)})`);

// --- destroy is idempotent / safe ---
backend.destroy(); backend.destroy();
ok(true, 'destroy() is safe to call twice');

console.log(`\ncpu-backend (Phase 0 seam): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
