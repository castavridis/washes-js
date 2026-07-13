// washes-test-harness.cjs
//
// Headless Node.js test harness for the Washes watercolor lib, extracted
// from the diagnostic scripts that drove the v0.56-v0.72 bug-hunting arc.
//
// The lib targets browsers but its core simulation is pure JS arrays and
// math. This harness stubs the DOM/Canvas APIs (tests/dom-shim.cjs) so the
// lib can be loaded in Node, then injects per-test `_debug_*` helpers via
// string replacement before eval'ing the source.
//
// v2 (engine-review P0): the patterns now ASSERT, not just print.
//   - Math.random is seeded (mulberry32) so every run is reproducible;
//     paper noise, splash jitter, and granulation are deterministic.
//   - Each pattern checks its documented expectations with tolerance
//     bands; any failure makes the process exit non-zero (CI-able).
//   - New `equivalence` pattern: drives scripted scenarios and compares
//     per-field statistics against tests/equivalence-goldens.json.
//     `--golden=write` records goldens; `--golden=check` (default when
//     the file exists) fails on drift beyond ~1e-9 relative. Regenerate
//     goldens ONLY for a change that intentionally alters simulation
//     behavior, and say so in the commit message.
//
// USAGE:
//   node washes-test-harness.cjs /path/to/washes.js [pattern] [--seed=N] [--golden=write|check]
//
// PATTERNS:
//   anisotropy     — cardinal vs diagonal advection ratio (v0.69 √2 bug)
//   trace          — single-cell state over many frames  (v0.72 pinpoint)
//   hotspots       — scan grid for cells differing significantly from
//                    their neighbors (v0.71-0.72 verification)
//   cfl            — CFL stability bound for explicit advection
//   mass-balance   — closed/open/gravity edge mode verification (v0.84)
//   equivalence    — golden field-statistics regression over scripted
//                    scenarios (engine-review P0)
//   active-rect    — active-region tracking behavior (tighten/empty)
//   all            — run all patterns

'use strict';

const fs = require('fs');
const path = require('path');
const { makeEl, installMockDOM, seedMathRandom, mulberry32 } = require('./dom-shim.cjs');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  } else positional.push(a);
}
const libPath = positional[0];
const pattern = positional[1] || 'all';
const SEED = flags.seed ? (Number(flags.seed) >>> 0) : 0xDEADBEEF;
const GOLDEN_PATH = path.join(__dirname, 'equivalence-goldens.json');

// ---------------------------------------------------------------------------
// Assertion plumbing. Failures are loud, counted, and turn the exit code.
// ---------------------------------------------------------------------------

let CHECKS = 0;
let FAILURES = 0;

function check(cond, msg) {
  CHECKS++;
  if (!cond) {
    FAILURES++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
  return cond;
}

function checkRange(val, lo, hi, msg) {
  return check(
    Number.isFinite(val) && val >= lo && val <= hi,
    `${msg} — got ${val}, expected [${lo} .. ${hi}]`
  );
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

// Shared injection snippets used by several patterns.
const INJECT_SIMSTEP = `
    _debug_simStep(n) { for (let i = 0; i < n; i++) simStep(); },`;
const INJECT_GRID = `
    _debug_grid() { return { GW, GH, N }; },`;
const INJECT_RECT = `
    _debug_rect() {
      return { minX: activeMinX, maxX: activeMaxX, minY: activeMinY, maxY: activeMaxY,
               empty: activeMaxX < activeMinX || activeMaxY < activeMinY };
    },`;

// ===========================================================================
// PATTERN 1 — Anisotropy detection
// ===========================================================================
// This is the test that found the v0.69 cross-artifact root cause. After 13
// versions of patching the pigment advection code, comparing pigment density
// at distance d in cardinal vs diagonal directions revealed a ratio of √2 —
// the tell of an L1-vs-L2 norm confusion (per-axis velocity clamp).
// Assertion: default (semilag) advection stays isotropic at every velocity.
// ---------------------------------------------------------------------------

function runAnisotropy(libPath) {
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
    check(a.card > 0, `anisotropy ${sc.label}: cardinal pigment present`);
    checkRange(a.ratio, 0.8, 1.2, `anisotropy ${sc.label}: isotropy ratio`);
  }
}

// ===========================================================================
// PATTERN 2 — Per-cell trace over time
// ===========================================================================
// The test that cracked the v0.72 pinpoint: a pressure dip could reverse
// neighbors' velocity to point INWARD, turning a skipped cell into a pigment
// sink — visible only across multiple frames. Assertions: the west neighbor's
// u stays non-positive and the east neighbor's u stays non-negative (outward
// flow away from the epicenter), and no field goes NaN.
// ---------------------------------------------------------------------------

function runTrace(libPath) {
  const Washes = loadLibWithHelpers(libPath, `${INJECT_SIMSTEP}
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
  // pinpoint in v0.70-v0.71.
  wc.splash([{ x: 324.4, y: 270.7, velocity: 40 }], 'deluge');

  const cells = [[324, 271], [325, 271], [323, 271], [324, 270]];
  const EPS = 1e-6;

  function snapshot(label) {
    console.log('\n  ' + label);
    for (const [x, y] of cells) {
      const c = wc._debug_cell(x, y);
      console.log(
        `    (${x},${y}):  g=${c.g.toFixed(3)} d=${c.d.toFixed(3)} ` +
        `u=${c.u.toFixed(3).padStart(7)} v=${c.v.toFixed(3).padStart(7)} ` +
        `wet=${c.wet.toFixed(3)} pres=${c.pressure.toFixed(2)}`
      );
      for (const k of ['g', 'd', 'u', 'v', 'wet', 'pressure']) {
        check(Number.isFinite(c[k]), `trace ${label} (${x},${y}): ${k} is finite`);
      }
    }
    const west = wc._debug_cell(323, 271);
    const east = wc._debug_cell(325, 271);
    check(west.u <= EPS, `trace ${label}: west cell u stays outward (≤0), got ${west.u}`);
    check(east.u >= -EPS, `trace ${label}: east cell u stays outward (≥0), got ${east.u}`);
  }

  console.log('\n=== Per-cell trace (splash at (324.4, 270.7)) ===');
  console.log('  Sign reversal on the flank cells = pinpoint bug (pre-v0.72).');
  snapshot('Immediately after splash:');
  wc._debug_simStep(1);  snapshot('After 1 simStep:');
  wc._debug_simStep(9);  snapshot('After 10 simSteps:');
  wc._debug_simStep(20); snapshot('After 30 simSteps:');
}

// ===========================================================================
// PATTERN 3 — Hotspot scan
// ===========================================================================
// Sweep the grid for cells with substantially more pigment than their
// 4-cardinal neighbors. Post-v0.72 expectation: only canvas-corner
// accumulation from mass-conserving advection at boundaries — nothing near
// the splash epicenter. Assertions encode exactly that.
// ---------------------------------------------------------------------------

function runHotspots(libPath) {
  const Washes = loadLibWithHelpers(libPath, `${INJECT_SIMSTEP}${INJECT_GRID}
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

  const cases = [
    [324.0, 270.0], [324.1, 270.0], [324.0, 270.1], [324.1, 270.1],
    [324.3, 270.7], [324.4, 270.7], [324.5, 270.5], [324.6, 270.3],
    [324.7, 270.7], [324.8, 270.8], [324.9, 270.9],
    [324.49, 270.51], [324.5, 270.49], [324.45, 270.55],
  ];

  console.log('\n=== Hotspot scan over fractional epicenters ===');
  console.log('  Expected (post-v0.72): only canvas corners, no near-epicenter hotspots.');
  for (const [ex, ey] of cases) {
    const wc = Washes.create(makeEl('div'));
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: ex, y: ey, velocity: 40 }], 'deluge');
    wc._debug_simStep(30);
    const { GW, GH } = wc._debug_grid();
    const hs = wc._debug_findHotspots(1.5);
    const summary = hs.length === 0
      ? 'CLEAN'
      : `${hs.length} hotspot(s): ${hs.slice(0, 8).map((h) => `(${h.x},${h.y})`).join(', ')}${hs.length > 8 ? ', …' : ''}`;
    console.log(`  ec=(${ex}, ${ey})  →  ${summary}`);
    const nearEpicenter = hs.filter((h) => Math.abs(h.x - ex) < 30 && Math.abs(h.y - ey) < 30);
    check(nearEpicenter.length === 0,
      `hotspots ec=(${ex},${ey}): no near-epicenter pinpoints (found ${nearEpicenter.length})`);
    check(hs.length <= 6, `hotspots ec=(${ex},${ey}): at most corner accumulation (found ${hs.length})`);
    for (const h of hs) {
      const nearCorner =
        (h.x <= 6 || h.x >= GW - 7) && (h.y <= 6 || h.y >= GH - 7);
      check(nearCorner, `hotspots ec=(${ex},${ey}): (${h.x},${h.y}) is at a canvas corner`);
    }
  }
}

// ===========================================================================
// PATTERN 4 — CFL bound check
// ===========================================================================
// First-order donor-cell advection is conditionally stable: (|u|+|v|)·Δt ≤ 1
// per cell. Assertions: the bound grows monotonically with splash velocity,
// and the default-deluge case genuinely exceeds 1 at the semilag inner
// timestep — the documented reason the default advection is semi-Lagrangian.
// ---------------------------------------------------------------------------

function runCFL(libPath) {
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
  const results = [];
  for (const sc of scenarios) {
    const wc = Washes.create(makeEl('div'));
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: 324, y: 270, velocity: sc.vel }], 'deluge');
    const maxCFL = wc._debug_maxCFL(sc.adt);
    results.push(maxCFL);
    const verdict = maxCFL > 1 ? 'UNSTABLE (donor-cell)' : 'stable';
    console.log(`  ${sc.label.padEnd(40)} max=${maxCFL.toFixed(2)}  ${verdict}`);
    check(Number.isFinite(maxCFL), `cfl ${sc.label}: bound is finite`);
  }
  check(results[0] <= results[1] && results[1] <= results[2],
    `cfl: bound grows with velocity (${results.slice(0, 3).map((r) => r.toFixed(2)).join(' ≤ ')})`);
  check(results[3] > 1,
    `cfl: default deluge exceeds donor-cell stability at semilag adt (got ${results[3].toFixed(2)}) — the reason semilag is the default`);
}

// ===========================================================================
// PATTERN 5 — Mass balance (verifies boundary-mode invariants, v0.84+)
// ===========================================================================
// Closed conserves mass (modulo evaporation), open drains based on outflow
// flux, gravity drains directionally, radial drains from all 4 edges.
// Assertion bands are derived from the documented expectations; the closed-
// mode Pull-invariance is checked exactly (seeded runs are deterministic).
// ---------------------------------------------------------------------------

function runMassBalance(libPath) {
  const Washes = loadLibWithHelpers(libPath, `${INJECT_SIMSTEP}
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
    { mode: 'closed',  dir: 'down',   str: 0.00, band: [3, 8],   expect: 'evaporation only (~5%)' },
    { mode: 'open',    dir: 'down',   str: 0.00, band: [4.5, 11], expect: 'drainage from splash velocity (~7%)' },
    { mode: 'gravity', dir: 'down',   str: 0.05, band: [1.5, 6],  expect: 'mild downward drainage (~3-4%)' },
    { mode: 'gravity', dir: 'down',   str: 0.10, band: [1, 5],    expect: 'stronger downward drainage (~2-3%)' },
    { mode: 'gravity', dir: 'radial', str: 0.05, band: [6, 14],   expect: 'radial drainage from 4 edges (~9-10%)' },
    { mode: 'gravity', dir: 'radial', str: 0.10, band: [6, 14],   expect: 'aggressive radial drainage (~9-12%)' },
  ];

  console.log('\n=== Mass balance over 100 simSteps (centered splash) ===');
  const losses = {};
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
    const lossPct = (m0 - m100) / m0 * 100;
    const key = `${sc.mode}/${sc.dir}/${sc.str}`;
    losses[key] = lossPct;
    const label = `${sc.mode.padEnd(8)} dir=${sc.dir.padEnd(7)} str=${sc.str.toFixed(2)}`;
    console.log(`  ${label}  →  ${lossPct.toFixed(1).padStart(5)}% loss   (expect: ${sc.expect})`);
    checkRange(lossPct, sc.band[0], sc.band[1], `mass-balance ${label}: loss %`);
  }
  check(losses['open/down/0'] > losses['closed/down/0'],
    'mass-balance: open drains more than closed');
  check(losses['gravity/radial/0.05'] > losses['gravity/down/0.05'],
    'mass-balance: radial drains more than directional at equal Pull');

  console.log('\n  Closed-mode regression: Pull should have no effect in closed mode');
  const closedLosses = [];
  for (const str of [0.0, 0.10, 0.50]) {
    const wc = Washes.create(makeEl('div'));
    wc.edgeMode('closed');
    wc.gravityStrength(str);  // ignored in closed mode
    wc._debug_paintGrid(0.5);
    wc.splash([{ x: 324, y: 270, velocity: 40 }], 'deluge');
    const m0 = wc._debug_totalMass();
    wc._debug_simStep(100);
    const m100 = wc._debug_totalMass();
    const lossPct = (m0 - m100) / m0 * 100;
    closedLosses.push(lossPct);
    console.log(`    closed, Pull=${str.toFixed(2)}: ${lossPct.toFixed(1)}% loss`);
  }
  const spread = Math.max(...closedLosses) - Math.min(...closedLosses);
  check(spread <= 0.15,
    `mass-balance: closed-mode loss invariant under Pull (spread ${spread.toFixed(3)}pp)`);
}

// ===========================================================================
// PATTERN 6 — Equivalence goldens (engine-review P0)
// ===========================================================================
// Drives scripted scenarios and records per-field statistics (sum, min, max,
// nonzero count, centroid) at checkpoints. A perf refactor that claims to be
// behavior-preserving must reproduce these to ~1e-9 relative. Scenarios are
// chosen to exercise the paths the P0 work touches: full-rect processing,
// rect growth across the grid, masked cells, open-edge drainage, and the
// fade-enabled evaporation branch.
// ---------------------------------------------------------------------------

const FIELD_KEYS = ['wet', 'u', 'v', 'pressure', 'g0', 'g1', 'g2', 'd0', 'd1', 'd2'];
const STAT_KEYS = ['sum', 'min', 'max', 'nz', 'cx', 'cy'];

function buildEquivalenceScenarios(Washes) {
  // Each scenario: fresh instance, seeded RNG, returns a list of checkpoints.
  function makeInstance() {
    return Washes.create(makeEl('div'));
  }
  return [
    {
      name: 'center-splash-dry',
      run(cp) {
        const wc = makeInstance();
        wc._debug_paintGrid(0.3);
        wc.splash([{ x: 324, y: 270, velocity: 25 }], 'deluge');
        wc._debug_simStep(60);  cp('after-60', wc);
        wc._debug_simStep(240); cp('after-300', wc);
      },
    },
    {
      name: 'two-corner-strokes',
      run(cp) {
        const wc = makeInstance();
        const { GW, GH } = wc._debug_grid();
        for (let s = 0; s < 8; s++) {
          // NOTE: pigment is typed optional but the deposit path indexes
          // g[pigmentIdx] unguarded — omit it and paintAt throws. (P2 item.)
          wc.paintAt(40 + s * 3, 40 + s * 2, 10, s % 3, 0.6);
          wc.paintAt(GW - 40 - s * 3, GH - 40 - s * 2, 10, (s + 1) % 3, 0.6);
        }
        wc._debug_simStep(80); cp('after-80', wc);
      },
    },
    {
      name: 'masked-splash',
      run(cp) {
        const wc = makeInstance();
        const { GW, GH } = wc._debug_grid();
        const mx0 = (GW / 2 - 40) | 0, mx1 = (GW / 2 + 40) | 0;
        const my0 = (GH / 2 - 30) | 0, my1 = (GH / 2 + 30) | 0;
        wc._debug_maskBlock(mx0, my0, mx1, my1);
        wc.splash([{ x: GW / 2 - 60, y: GH / 2, velocity: 25 }], 'deluge');
        wc._debug_simStep(60); cp('after-60', wc);
      },
    },
    {
      name: 'open-edge-drain',
      run(cp) {
        const wc = makeInstance();
        wc.edgeMode('open');
        wc._debug_paintGrid(0.3);
        wc.splash([{ x: 324, y: 270, velocity: 40 }], 'deluge');
        wc._debug_simStep(100); cp('after-100', wc);
      },
    },
    {
      name: 'fade-enabled-steps',
      run(cp) {
        const wc = makeInstance();
        wc.fadePainting(1500);
        wc.splash([{ x: 200, y: 200, velocity: 20 }], 'deluge');
        wc._debug_simStep(80); cp('after-80', wc);
      },
    },
  ];
}

const EQUIV_INJECT = `${INJECT_SIMSTEP}${INJECT_GRID}${INJECT_RECT}
    _debug_paintGrid(amt) {
      for (let i = 0; i < N; i++) d[0][i] = amt;
      setActiveRectFull();
    },
    _debug_maskBlock(x0, y0, x1, y1) {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) mask[y * GW + x] = 1;
      maskActive = true;
      maskRectMinX = x0; maskRectMaxX = x1;
      maskRectMinY = y0; maskRectMaxY = y1;
    },
    _debug_fieldStats() {
      function stats(a) {
        let sum = 0, min = Infinity, max = -Infinity, nz = 0, cx = 0, cy = 0;
        for (let i = 0; i < N; i++) {
          const val = a[i];
          sum += val;
          if (val < min) min = val;
          if (val > max) max = val;
          if (val !== 0) { nz++; cx += (i % GW) * val; cy += ((i / GW) | 0) * val; }
        }
        return { sum, min, max, nz, cx, cy };
      }
      return {
        wet: stats(wet), u: stats(u), v: stats(v), pressure: stats(pressure),
        g0: stats(g[0]), g1: stats(g[1]), g2: stats(g[2]),
        d0: stats(d[0]), d1: stats(d[1]), d2: stats(d[2]),
      };
    },`;

function runEquivalence(libPath) {
  const mode = flags.golden || (fs.existsSync(GOLDEN_PATH) ? 'check' : 'none');
  if (mode === 'none') {
    console.error('\n=== Equivalence ===');
    console.error('  No goldens found. Run with --golden=write on a known-good engine first.');
    FAILURES++;
    return;
  }

  const Washes = loadLibWithHelpers(libPath, EQUIV_INJECT);
  const scenarios = buildEquivalenceScenarios(Washes);
  const results = {};

  scenarios.forEach((sc, idx) => {
    // Reseed per scenario so scenario order never matters.
    Math.random = mulberry32(SEED + idx * 7919);
    const checkpoints = {};
    sc.run((label, wc) => { checkpoints[label] = wc._debug_fieldStats(); });
    results[sc.name] = checkpoints;
  });

  if (mode === 'write') {
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify({ seed: SEED, results }, null, 1));
    console.log(`\n=== Equivalence ===\n  goldens written to ${path.basename(GOLDEN_PATH)} (seed ${SEED})`);
    return;
  }

  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  console.log('\n=== Equivalence vs goldens ===');
  if (!check(golden.seed === SEED,
    `equivalence: golden seed ${golden.seed} matches run seed ${SEED} (pass --seed=${golden.seed})`)) return;

  const REL_TOL = 1e-9;
  for (const sc of scenarios) {
    const gold = golden.results[sc.name];
    if (!check(!!gold, `equivalence ${sc.name}: scenario present in goldens`)) continue;
    let worst = 0, worstAt = '';
    for (const cpName of Object.keys(gold)) {
      const got = results[sc.name][cpName];
      if (!check(!!got, `equivalence ${sc.name}/${cpName}: checkpoint produced`)) continue;
      const goldCp = gold[cpName];
      for (const f of FIELD_KEYS) {
        for (const s of STAT_KEYS) {
          const a = got[f][s], b = goldCp[f][s];
          const dev = Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
          if (dev > worst) { worst = dev; worstAt = `${cpName}.${f}.${s} (got ${a}, golden ${b})`; }
        }
      }
    }
    const ok = worst <= REL_TOL;
    console.log(`  ${sc.name.padEnd(22)} max rel dev ${worst.toExponential(2)}  ${ok ? 'EXACT' : 'DRIFT at ' + worstAt}`);
    check(ok, `equivalence ${sc.name}: fields match goldens (worst ${worst.toExponential(2)} at ${worstAt})`);
  }
}

// ===========================================================================
// PATTERN 7 — Active-rect behavior
// ===========================================================================
// Documents/verifies the active-region tracking contract: the rect grows to
// cover paint, and (once shrink is wired into simStep) tightens as content
// settles and empties after a full dry-down. Before the shrink wiring lands,
// run this pattern to see the rect never tightening — it is included in
// `all` only from the commit that wires shrink.
// ---------------------------------------------------------------------------

function runActiveRect(libPath) {
  const Washes = loadLibWithHelpers(libPath, EQUIV_INJECT);
  console.log('\n=== Active-rect behavior ===');

  const wc = Washes.create(makeEl('div'));
  const { GW, GH } = wc._debug_grid();
  check(wc._debug_rect().empty, 'active-rect: starts empty');

  // A small localized splash grows the rect around it, not the whole grid.
  wc.splash([{ x: 150, y: 150, velocity: 15 }], 'deluge');
  const r1 = wc._debug_rect();
  console.log(`  after splash: [${r1.minX}..${r1.maxX}]×[${r1.minY}..${r1.maxY}] of ${GW}×${GH}`);
  check(!r1.empty, 'active-rect: covers the splash');
  check(r1.maxX < GW - 1 || r1.maxY < GH - 1, 'active-rect: localized paint does not claim the whole grid');

  // Run well past full dry-down; with shrink wired the rect must tighten to
  // empty (no suspended pigment, no positive pressure anywhere).
  wc._debug_simStep(2400);
  const r2 = wc._debug_rect();
  console.log(`  after 2400 steps (fully dry): ${r2.empty ? 'EMPTY' : `[${r2.minX}..${r2.maxX}]×[${r2.minY}..${r2.maxY}]`}`);
  check(r2.empty, 'active-rect: empties after full dry-down (shrink wired)');
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

if (!libPath) {
  console.error('usage: node washes-test-harness.cjs <path-to-washes.js> [pattern] [--seed=N] [--golden=write|check]');
  console.error('patterns: anisotropy | trace | hotspots | cfl | mass-balance | equivalence | active-rect | all');
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
  equivalence: runEquivalence,
  'active-rect': runActiveRect,
};

// active-rect asserts post-shrink-wiring behavior; it joins `all` in the
// commit that wires shrinkActiveRect into simStep.
const ALL = ['anisotropy', 'trace', 'hotspots', 'cfl', 'mass-balance', 'equivalence'];

function runPattern(name) {
  installMockDOM();
  const restore = seedMathRandom(SEED);
  try {
    patterns[name](libPath);
  } finally {
    restore();
  }
}

if (pattern === 'all') {
  for (const name of ALL) runPattern(name);
} else if (patterns[pattern]) {
  runPattern(pattern);
} else {
  console.error('unknown pattern:', pattern);
  console.error('available:', Object.keys(patterns).join(', '));
  process.exit(1);
}

console.log(`\n${'='.repeat(60)}`);
if (FAILURES > 0) {
  console.error(`RESULT: ${FAILURES} failure(s) in ${CHECKS} checks`);
  process.exitCode = 1;
} else {
  console.log(`RESULT: all ${CHECKS} checks passed`);
}
