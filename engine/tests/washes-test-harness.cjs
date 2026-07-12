// washes-test-harness.js
//
// Headless Node.js test harness for the Washes watercolor lib,
// extracted from the diagnostic scripts that drove the v0.56-v0.72
// bug-hunting arc.
//
// The lib targets browsers but its core simulation is pure JS arrays
// and math. This harness stubs the DOM/Canvas APIs so the lib can be
// loaded in Node, then injects per-test `_debug_*` helpers via string
// replacement before eval'ing the source. The result: a few seconds
// of numerical inspection instead of staring at rendered output for
// 13 versions.
//
// USAGE:
//   node washes-test-harness.js  /path/to/watercolor-lib.js  [pattern]
//
// PATTERNS:
//   anisotropy     — cardinal vs diagonal advection ratio (v0.69 √2 bug)
//   trace          — single-cell state over many frames  (v0.72 pinpoint)
//   hotspots       — scan grid for cells differing significantly from
//                    their neighbors (v0.71-0.72 verification)
//   cfl            — CFL stability bound for explicit advection
//   mass-balance   — closed/open/gravity edge mode verification (v0.84)
//   all            — run all patterns
//
// EXAMPLE:
//   node washes-test-harness.js ./watercolor-lib.js anisotropy
//
// This file is meant to be copied and adapted — each pattern below
// is a self-contained example of the diagnostic technique it was
// named after.

'use strict';

const fs = require('fs');

// ---------------------------------------------------------------------------
// Mock DOM. Just enough to get window.Washes.create() to run. None of these
// stubs do anything useful visually — they just satisfy the lib's bootstrap
// code that touches document/window/canvas APIs.
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(),
    nodeName: (tag || 'div').toUpperCase(),
    attributes: {},
    children: [],
    childNodes: [],
    style: {},
    dataset: {},
    parentNode: null,
    parentElement: null,
    width: 1024,
    height: 768,
    _listeners: {},
    ownerSVGElement: null,
    classList: {
      toggle() {}, add() {}, remove() {}, contains() { return false; },
    },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this.attributes, n)
        ? this.attributes[n] : null;
    },
    appendChild(c) {
      this.children.push(c);
      this.childNodes.push(c);
      c.parentNode = this;
      c.parentElement = this;
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    },
    replaceChildren() {
      this.children = [];
      this.childNodes = [];
    },
    addEventListener(t, fn) {
      this._listeners[t] = this._listeners[t] || [];
      this._listeners[t].push(fn);
    },
    removeEventListener() {},
    dispatchEvent(ev) {
      (this._listeners[ev.type] || []).forEach((f) => f(ev));
      return true;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 1080, bottom: 900, width: 1080, height: 900, x: 0, y: 0 };
    },
    toDataURL() { return 'data:image/png;base64,F'; },
    toBlob(cb) { setTimeout(() => cb({ size: 1, type: 'image/png' }), 0); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getContext(t) {
      if (t === 'webgl2') return null;
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {}, fillText() {},
        measureText() { return { width: 50 }; },
        save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        fillStyle: '', strokeStyle: '', font: '',
        textBaseline: '', textAlign: '',
        globalAlpha: 1, globalCompositeOperation: 'source-over',
      };
    },
  };
  return e;
}

function installMockDOM() {
  global.document = {
    _body: makeEl('body'),
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
    getElementById: () => null,
    querySelectorAll: () => [],
    documentElement: { style: { setProperty() {} }, dataset: {} },
  };
  global.document.body = global.document._body;
  global.window = {
    innerWidth: 1080,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener() {},
    location: { search: '' },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false }),
  };
  // navigator and performance became read-only getters on global in Node 20+;
  // defineProperty works where direct assignment doesn't.
  Object.defineProperty(global, 'navigator', {
    value: { maxTouchPoints: 0 },
    configurable: true, writable: true,
  });
  Object.defineProperty(global, 'performance', {
    value: { now: () => Date.now() },
    configurable: true, writable: true,
  });
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};
  global.URLSearchParams = URLSearchParams;
  global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  global.Blob = function () {};
  global.DOMParser = function () {
    return { parseFromString: () => ({ querySelector: () => null, querySelectorAll: () => [] }) };
  };
  global.Image = function () {};
  global.CustomEvent = function (t, o) { this.type = t; this.detail = o && o.detail; };
}

// ---------------------------------------------------------------------------
// Load the lib with debug helpers injected. The trick: inject `_debug_*`
// methods into the public API object via string replacement on the source,
// then eval. This avoids modifying the lib file on disk and gives each test
// scoped access to internal state (g, d, u, v, wet, pressure, etc.).
// ---------------------------------------------------------------------------

function loadLibWithHelpers(libPath, extraMethods) {
  let src = fs.readFileSync(libPath, 'utf8');
  // Inject debug helpers right before the `state()` method on the API object.
  src = src.replace('  state() {', extraMethods + '\n  state() {');
  // v0.86 — the packaged lib has ESM `export` statements at the bottom for
  // bundler consumers. `new Function()` rejects those as syntax errors, so
  // strip them before compile. The IIFE assignment to `globalThis.Washes`
  // is what we actually need.
  src = src.replace(/^export .+$/gm, '');
  new Function(src)();
  return global.window.Washes;
}

// ===========================================================================
// PATTERN 1 — Anisotropy detection
// ===========================================================================
// This is the test that found the v0.69 cross-artifact root cause. After 13
// versions of patching the pigment advection code (donor-cell, flux clamp,
// substep CFL, semi-Lagrangian, mass-conserving semi-Lagrangian), the cross
// still appeared. Comparing pigment density at distance d in cardinal vs
// diagonal directions revealed a ratio of √2 — the tell of an L1-vs-L2 norm
// confusion. Root cause: per-axis velocity clamp instead of magnitude clamp.
// ---------------------------------------------------------------------------

function runAnisotropy(libPath) {
  installMockDOM();
  const Washes = loadLibWithHelpers(libPath, `
    _debug_run(n) {
      for (let i = 0; i < n; i++) { movePigment(); transferPigment(); }
    },
    _debug_anisotropy(d) {
      const cx = Math.floor(GW / 2), cy = Math.floor(GH / 2);
      const dd = Math.round(d / Math.SQRT2);
      function get(x, y) {
        return g[0][y * GW + x] + g[1][y * GW + x] + g[2][y * GW + x];
      }
      const card = (get(cx + d, cy) + get(cx - d, cy) + get(cx, cy - d) + get(cx, cy + d)) / 4;
      const diag = (get(cx + dd, cy - dd) + get(cx - dd, cy - dd) + get(cx + dd, cy + dd) + get(cx - dd, cy + dd)) / 4;
      return { card, diag, ratio: diag > 0 ? card / diag : Infinity };
    },
    _debug_paintGrid(amt) {
      for (let i = 0; i < N; i++) g[0][i] = amt;
      setActiveRectFull();
    },`);

  const scenarios = [
    { vel: 40, label: 'velocity=40 (default deluge)' },
    { vel: 10, label: 'velocity=10 (CFL safe)' },
    { vel: 5,  label: 'velocity=5  (well below CFL)' },
  ];

  console.log('\n=== Anisotropy (cardinal/diagonal ratio at d=100) ===');
  console.log('  ratio = 1.0 is isotropic; ~1.4 = √2 = per-axis L1 norm bug');
  for (const sc of scenarios) {
    const wc = Washes.create(makeEl('div'));
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: 324, y: 270, velocity: sc.vel }], 'deluge');
    wc._debug_run(5);
    const a = wc._debug_anisotropy(100);
    console.log(`  ${sc.label.padEnd(32)} card=${a.card.toFixed(3)}  diag=${a.diag.toFixed(3)}  ratio=${a.ratio.toFixed(3)}`);
  }
}

// ===========================================================================
// PATTERN 2 — Per-cell trace over time
// ===========================================================================
// This is the test that finally cracked the v0.72 pinpoint. The earlier v0.70
// and v0.71 fixes (smoothing g/d/wet/pressure at "skipped" cells) only made
// things worse: they created a pressure dip that, after the initial outward
// injection decayed, reversed neighbors' velocity to point INWARD and turned
// the skipped cell into a pigment sink. Visible only by tracing velocities
// across multiple frames — no single-frame snapshot showed it.
// ---------------------------------------------------------------------------

function runTrace(libPath) {
  installMockDOM();
  const Washes = loadLibWithHelpers(libPath, `
    _debug_simStep(n) { for (let i = 0; i < n; i++) simStep(); },
    _debug_cell(x, y) {
      const i = y * GW + x;
      return {
        g: g[0][i] + g[1][i] + g[2][i],
        d: d[0][i] + d[1][i] + d[2][i],
        u: u[i], v: v[i],
        wet: wet[i], pressure: pressure[i],
      };
    },
    _debug_paintGrid(amt) {
      for (let i = 0; i < N; i++) d[0][i] = amt;
      setActiveRectFull();
    },`);

  const wc = Washes.create(makeEl('div'));
  wc._debug_paintGrid(0.5);
  // Epicenter at (324.4, 270.7) — a fractional position that triggered the
  // pinpoint in v0.70-v0.71. Two cells fall inside the d²<0.5 skip region
  // (324, 271) and (325, 271).
  wc.splash([{ x: 324.4, y: 270.7, velocity: 40 }], 'deluge');

  const cells = [[324, 271], [325, 271], [323, 271], [324, 270]];

  function snapshot(label) {
    console.log('\n  ' + label);
    for (const [x, y] of cells) {
      const c = wc._debug_cell(x, y);
      console.log(
        `    (${x},${y}):  g=${c.g.toFixed(3)} d=${c.d.toFixed(3)} ` +
        `u=${c.u.toFixed(3).padStart(7)} v=${c.v.toFixed(3).padStart(7)} ` +
        `wet=${c.wet.toFixed(3)} pres=${c.pressure.toFixed(2)}`
      );
    }
  }

  console.log('\n=== Per-cell trace (splash at (324.4, 270.7)) ===');
  console.log('  Watch the u column for the inward (target=324) cells:');
  console.log('  west (323): u should stay NEGATIVE (outward, away from epicenter)');
  console.log('  east (325): u should stay POSITIVE (outward, away from epicenter)');
  console.log('  Sign reversal = pinpoint bug (pre-v0.72).');
  snapshot('Immediately after splash:');
  wc._debug_simStep(1);  snapshot('After 1 simStep:');
  wc._debug_simStep(9);  snapshot('After 10 simSteps:');
  wc._debug_simStep(20); snapshot('After 30 simSteps:');
}

// ===========================================================================
// PATTERN 3 — Hotspot scan
// ===========================================================================
// Sweep the grid for cells that have substantially more pigment than their
// 4-cardinal neighbors. Used to verify v0.72: no pinpoints near the splash
// epicenter, only the expected corner-accumulation hotspots from mass-
// conserving advection at canvas boundaries. The scan is brute-force O(GW*GH)
// but fast enough for a single test pass.
// ---------------------------------------------------------------------------

function runHotspots(libPath) {
  installMockDOM();
  const Washes = loadLibWithHelpers(libPath, `
    _debug_simStep(n) { for (let i = 0; i < n; i++) simStep(); },
    _debug_findHotspots(threshold) {
      const hotspots = [];
      for (let y = 2; y < GH - 2; y++) {
        for (let x = 2; x < GW - 2; x++) {
          const i = y * GW + x;
          const self = g[0][i] + g[1][i] + g[2][i] + d[0][i] + d[1][i] + d[2][i];
          if (self < 0.005) continue;
          const e = i + 1, w = i - 1, n = i - GW, s = i + GW;
          const avgN = (
            (g[0][e]+g[1][e]+g[2][e]+d[0][e]+d[1][e]+d[2][e]) +
            (g[0][w]+g[1][w]+g[2][w]+d[0][w]+d[1][w]+d[2][w]) +
            (g[0][n]+g[1][n]+g[2][n]+d[0][n]+d[1][n]+d[2][n]) +
            (g[0][s]+g[1][s]+g[2][s]+d[0][s]+d[1][s]+d[2][s])
          ) * 0.25;
          if (self > avgN * threshold && self - avgN > 0.005) {
            hotspots.push({ x, y, self: self.toFixed(4), avg: avgN.toFixed(4) });
          }
        }
      }
      return hotspots;
    },
    _debug_paintGrid(amt) {
      for (let i = 0; i < N; i++) d[0][i] = amt;
      setActiveRectFull();
    },`);

  // A spread of fractional epicenter positions. Pre-v0.72, several of these
  // produced pinpoints near the click site. Post-v0.72, only canvas corners
  // appear (expected mass-conservation boundary accumulation).
  const cases = [
    [324.0, 270.0], [324.1, 270.0], [324.0, 270.1], [324.1, 270.1],
    [324.3, 270.7], [324.4, 270.7], [324.5, 270.5], [324.6, 270.3],
    [324.7, 270.7], [324.8, 270.8], [324.9, 270.9],
    [324.49, 270.51], [324.5, 270.49], [324.45, 270.55],
  ];

  console.log('\n=== Hotspot scan over fractional epicenters ===');
  console.log('  Each row: epicenter coord → hotspots (self/avg ratio > 1.5×).');
  console.log('  Expected (post-v0.72): only canvas corners, no near-epicenter hotspots.');
  for (const [ex, ey] of cases) {
    const wc = Washes.create(makeEl('div'));
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: ex, y: ey, velocity: 40 }], 'deluge');
    wc._debug_simStep(30);
    const hs = wc._debug_findHotspots(1.5);
    const summary = hs.length === 0
      ? 'CLEAN'
      : `${hs.length} hotspot(s): ${hs.slice(0, 8).map((h) => `(${h.x},${h.y})`).join(', ')}${hs.length > 8 ? ', …' : ''}`;
    console.log(`  ec=(${ex}, ${ey})  →  ${summary}`);
  }
}

// ===========================================================================
// PATTERN 4 — CFL bound check
// ===========================================================================
// First-order donor-cell advection is conditionally stable: |u|·Δt + |v|·Δt
// must be ≤ 1 per cell or the cell donates more than it holds, goes negative,
// and Kubelka-Munk renders negative values as brighter-than-paper streaks.
// Useful as an early sanity check when changing velocity scales or timestep.
// ---------------------------------------------------------------------------

function runCFL(libPath) {
  installMockDOM();
  const Washes = loadLibWithHelpers(libPath, `
    _debug_maxCFL(adt) {
      let max = 0;
      for (let i = 0; i < N; i++) {
        const c = (Math.abs(u[i]) + Math.abs(v[i])) * adt;
        if (c > max) max = c;
      }
      return max;
    },
    _debug_paintGrid(amt) {
      for (let i = 0; i < N; i++) g[0][i] = amt;
      setActiveRectFull();
    },`);

  const scenarios = [
    { vel: 5,  adt: 1, label: 'velocity=5  adt=1' },
    { vel: 10, adt: 1, label: 'velocity=10 adt=1' },
    { vel: 40, adt: 1, label: 'velocity=40 adt=1 (default deluge)' },
    { vel: 40, adt: 0.2941, label: 'velocity=40 adt≈0.294 (semilag inner)' },
  ];

  console.log('\n=== CFL bound (|u|+|v|)·adt per cell ===');
  console.log('  Donor-cell stable when max ≤ 1. Semi-Lagrangian has no bound.');
  for (const sc of scenarios) {
    const wc = Washes.create(makeEl('div'));
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: 324, y: 270, velocity: sc.vel }], 'deluge');
    const maxCFL = wc._debug_maxCFL(sc.adt);
    const verdict = maxCFL > 1 ? 'UNSTABLE (donor-cell)' : 'stable';
    console.log(`  ${sc.label.padEnd(40)} max=${maxCFL.toFixed(2)}  ${verdict}`);
  }
}

// ===========================================================================
// PATTERN 5 — Mass balance (verifies boundary-mode invariants, v0.84+)
// ===========================================================================
// Total mass tracking distinguishes the three edge modes numerically. The
// pattern that validates the v0.81-v0.84 boundary work: closed conserves
// mass (modulo evaporation), open drains based on outflow flux, gravity
// drains more with higher Pull, radial drains ~4x faster than directional.
// Used as a regression check that closed mode hasn't been changed by the
// boundary work, and as a numerical sanity check that open/gravity modes
// are doing something measurable.
// ---------------------------------------------------------------------------

function runMassBalance(libPath) {
  installMockDOM();
  const Washes = loadLibWithHelpers(libPath, `
    _debug_simStep(n) { for (let i = 0; i < n; i++) simStep(); },
    _debug_totalMass() {
      let m = 0;
      for (let i = 0; i < N; i++) {
        m += g[0][i] + g[1][i] + g[2][i] + d[0][i] + d[1][i] + d[2][i];
      }
      return m;
    },
    _debug_paintGrid(amt) {
      for (let i = 0; i < N; i++) d[0][i] = amt;
      setActiveRectFull();
    },`);

  const scenarios = [
    { mode: 'closed',  dir: 'down',   str: 0.00, expect: 'evaporation only (~5%)' },
    { mode: 'open',    dir: 'down',   str: 0.00, expect: 'drainage from splash velocity (~7%)' },
    { mode: 'gravity', dir: 'down',   str: 0.05, expect: 'mild downward drainage (~3-4%)' },
    { mode: 'gravity', dir: 'down',   str: 0.10, expect: 'stronger downward drainage (~2-3%)' },
    { mode: 'gravity', dir: 'radial', str: 0.05, expect: 'radial drainage from 4 edges (~9-10%)' },
    { mode: 'gravity', dir: 'radial', str: 0.10, expect: 'aggressive radial drainage (~9-12%)' },
  ];

  console.log('\n=== Mass balance over 100 simSteps (centered splash) ===');
  console.log('  Closed should retain almost all mass; open/gravity should lose measurable fractions.');
  for (const sc of scenarios) {
    const wc = Washes.create(makeEl('div'));
    wc.edgeMode(sc.mode);
    wc.gravityDirection(sc.dir);
    wc.gravityStrength(sc.str);
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: 324, y: 270, velocity: 40 }], 'deluge');
    const m0 = wc._debug_totalMass();
    wc._debug_simStep(100);
    const m100 = wc._debug_totalMass();
    const lossPct = ((m0 - m100) / m0 * 100).toFixed(1);
    const label = `${sc.mode.padEnd(8)} dir=${sc.dir.padEnd(7)} str=${sc.str.toFixed(2)}`;
    console.log(`  ${label}  →  ${lossPct.padStart(5)}% loss   (expect: ${sc.expect})`);
  }

  // Sanity check: closed mode mass loss should be approximately equal to
  // evaporation, not affected by gravity Pull (which only fires in
  // gravity mode anyway).
  console.log('\n  Closed-mode regression: Pull should have no effect in closed mode');
  for (const str of [0.0, 0.10, 0.50]) {
    const wc = Washes.create(makeEl('div'));
    wc.edgeMode('closed');
    wc.gravityStrength(str);  // ignored in closed mode
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: 324, y: 270, velocity: 40 }], 'deluge');
    const m0 = wc._debug_totalMass();
    wc._debug_simStep(100);
    const m100 = wc._debug_totalMass();
    const lossPct = ((m0 - m100) / m0 * 100).toFixed(1);
    console.log(`    closed, Pull=${str.toFixed(2)}: ${lossPct}% loss  (should match across all Pull values)`);
  }
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

const libPath = process.argv[2];
const pattern = process.argv[3] || 'all';

if (!libPath) {
  console.error('usage: node washes-test-harness.js <path-to-watercolor-lib.js> [pattern]');
  console.error('patterns: anisotropy | trace | hotspots | cfl | mass-balance | all');
  process.exit(1);
}
if (!fs.existsSync(libPath)) {
  console.error('lib not found:', libPath);
  process.exit(1);
}

const patterns = {
  anisotropy: runAnisotropy,
  trace: runTrace,
  hotspots: runHotspots,
  cfl: runCFL,
  'mass-balance': runMassBalance,
};

if (pattern === 'all') {
  for (const name of Object.keys(patterns)) patterns[name](libPath);
} else if (patterns[pattern]) {
  patterns[pattern](libPath);
} else {
  console.error('unknown pattern:', pattern);
  console.error('available:', Object.keys(patterns).join(', '));
  process.exit(1);
}
