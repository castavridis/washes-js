// texture-parity.test.mjs
//
// Proves the brush-texture-deposit.js reference matches the REAL CPU lib's
// per-cell texture deposit, mode by mode. Method: paint one stamp in 'wet'
// mode and an identical stamp in a textured mode on two paper-identical
// instances; the per-cell ratio g_textured / g_wet IS the CPU's deposit
// factor (everything else in the deposit is identical). Compare that observed
// factor to the reference's prediction from the same noise field + paperH.
//
// If this passes, the GLSL in brush_stamp.frag — a transliteration of the
// reference — reproduces the CPU look (modulo float precision).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { modeConstants, textureMul } from './brush-texture-deposit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = process.env.WASHES_LIB || resolve(__dirname, '../src/washes.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  FAIL ' + m); } }

// deterministic PRNG so both instances generate identical paper + fields
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function reseed(s) { Math.random = mulberry32(s); }

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), attributes: {}, children: [], childNodes: [], style: {}, dataset: {},
    parentNode: null, parentElement: null, width: 1024, height: 768, _listeners: {}, ownerSVGElement: null,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute(n, v) { this.attributes[n] = String(v); }, getAttribute(n) { return this.attributes[n] ?? null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    replaceChildren() { this.children = []; }, addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }, removeEventListener() {},
    dispatchEvent() { return true; }, setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 1080, bottom: 900, width: 1080, height: 900, x: 0, y: 0 }; },
    toDataURL() { return 'data:image/png;base64,F'; }, toBlob(cb) { setTimeout(() => cb({ size: 1 }), 0); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getContext(t) { if (t === 'webgl2') return null; return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {}, fillText() {}, measureText() { return { width: 50 }; }, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, fillStyle: '', strokeStyle: '', font: '', globalAlpha: 1 }; },
  };
}
function installMockDOM() {
  global.document = { createElement: t => makeEl(t), createElementNS: (n, t) => makeEl(t), getElementById: () => null, querySelectorAll: () => [], documentElement: { style: { setProperty() {} }, dataset: {} } };
  global.document.body = makeEl('body');
  global.window = { innerWidth: 1080, innerHeight: 900, devicePixelRatio: 1, addEventListener() {}, location: { search: '' }, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, matchMedia: () => ({ matches: false }) };
  Object.defineProperty(global, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true, writable: true });
  Object.defineProperty(global, 'performance', { value: { now: () => 0 }, configurable: true, writable: true });
  global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};
  global.URLSearchParams = URLSearchParams; global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  global.Blob = function () {}; global.Image = function () {};
  global.DOMParser = function () { return { parseFromString: () => ({ querySelector: () => null, querySelectorAll: () => [] }) }; };
  global.CustomEvent = function (t, o) { this.type = t; this.detail = o && o.detail; };
}

const HOOKS = `
    _debug_field(mode, x, y) {
      _ensureTextureNoise(mode);
      const f = (mode === 'crayon' || mode === 'dry') ? crayonNoise
              : mode === 'dryBrush' ? dryBrushNoise
              : mode === 'salt' ? saltNoise : splatterNoise;
      return f ? f[y * GW + x] : 0;
    },
    _debug_paperH(x, y) { return paperH[y * GW + x]; },
    _debug_g0(x, y) { return g[0][y * GW + x]; },
    _debug_dims() { return { GW: GW, GH: GH, N: N }; },`;

function loadLib() {
  let src = readFileSync(LIB, 'utf8');
  src = src.replace('  state() {', HOOKS + '\n  state() {');
  src = src.replace(/^export .+$/gm, '');
  new Function(src)();
  return global.window.Washes;
}

installMockDOM();
const Washes = loadLib();

const SEED = 9090;
const GX = 300, GY = 240, R = 22, PIG = 0, S = 0.9;
const DRYNESS = 0.7, PAPER_REJECT = 0.65, ANISO = 0.6, BRISTLE = 0.5;
const bristleK = DRYNESS * BRISTLE;

function freshInstance() {
  reseed(SEED);
  const wc = Washes.compat1(Washes.create(makeEl('div')), { warn: false });
  return wc;
}

const modes = ['crayon', 'dryBrush', 'salt', 'splatter'];

for (const mode of modes) {
  // Wet reference paint.
  const wcWet = freshInstance();
  wcWet.brushMode('wet');
  wcWet.paintAt(GX, GY, R, PIG, S);

  // Textured paint, identical otherwise.
  const wcTex = freshInstance();
  wcTex.dryness(DRYNESS); wcTex.dryPaperReject(PAPER_REJECT);
  wcTex.dryAnisotropy(ANISO); wcTex.dryBrushSkip(BRISTLE);
  wcTex.brushMode(mode);
  wcTex.paintAt(GX, GY, R, PIG, S);

  const c = modeConstants(mode, DRYNESS, PAPER_REJECT);
  const consts = { baseThresh: c.baseThresh, bandHalf: c.bandHalf, paperWeight: c.paperWeight, bristleK, anisoNudge: 0 };

  const GW = wcTex._debug_dims().GW;
  let nCells = 0, maxErr = 0, minObs = 1, maxObs = 0;
  for (let y = GY - R; y <= GY + R; y++) {
    for (let x = GX - R; x <= GX + R; x++) {
      const gw = wcWet._debug_g0(x, y);
      if (gw <= 1e-6) continue;               // outside footprint
      const gt = wcTex._debug_g0(x, y);
      const observed = gt / gw;               // = CPU deposit factor
      const fn = wcTex._debug_field(mode, x, y);
      const ph = wcTex._debug_paperH(x, y);
      const predicted = textureMul(fn, ph, y * GW + x, consts);
      maxErr = Math.max(maxErr, Math.abs(observed - predicted));
      minObs = Math.min(minObs, observed);
      maxObs = Math.max(maxObs, observed);
      nCells++;
    }
  }
  ok(nCells > 50, `${mode}: enough cells sampled (${nCells})`);
  ok(maxErr < 1e-4, `${mode}: reference matches CPU per-cell (max err ${maxErr.toExponential(2)})`);
  // Sanity: real speckle = a wide spread between near-floor rejection
  // (~0.098 at these params) and full deposit (~1.0), not a uniform dim.
  ok(minObs < 0.2 && maxObs > 0.9,
     `${mode}: produces speckle (range ${minObs.toFixed(2)}..${maxObs.toFixed(2)})`);
}

console.log(`\ntexture-parity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
