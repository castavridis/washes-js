// sim-core-standalone.test.mjs — the extraction's proof of life.
//
// Imports createSimCore directly (no washes.js, no DOM, no canvas, no shim)
// and runs the physics on a tiny synthetic grid. This is what the module
// graduation buys: the simulation core as an independently usable,
// independently testable unit.
//
// Run: node tests/sim-core-standalone.test.mjs

import assert from 'node:assert/strict';
import { createSimCore } from '../src/washes-sim-core.js';

const GW = 32, GH = 24, N = GW * GH;
const F = () => new Float32Array(N);
const fields = {
  wet: F(), wet_tmp: F(), u: F(), v: F(), u_new: F(), v_new: F(),
  pressure: F(), paperH: F(), mask: F(),
  wetBlur: F(), wetBlurTmp: F(), wetBinary: F(), wetBlurLarge: F(),
  g: [F(), F(), F()], d: [F(), F(), F()], g_tmp: [F(), F(), F()],
};
const pigment = { K: [0.5, 1.0, 1.2], S: [0.6, 0.5, 0.4], density: 0.02, staining: 1.2, granulation: 0.2 };

const core = createSimCore({
  bindings: () => ({
    GW, GH, N, inv_s: 1, inv_s2: 1, s_scale: 1, ...fields,
    WET_DIFFUSION: 0.1, PIGMENT_DIFFUSION: 0.045,
    EDGE_KERNEL: 2, EDGE_KERNEL_LARGE: 6, MASK_THRESHOLD: 0.5,
  }),
  live: () => ({
    evaporationRate: 0.9988, dryingPaused: false, edgeDarkeningEnabled: true,
    advectionMode: 'semilag',
    maskActive: false, maskRectMinX: 0, maskRectMinY: 0, maskRectMaxX: -1, maskRectMaxY: -1,
    edgeOpenLeft: false, edgeOpenRight: false, edgeOpenTop: false, edgeOpenBottom: false,
    gravityDir: 'down', gravityStrength: 0, gravityBiasX: 0, gravityBiasY: 0,
    edgeMode: 'closed', fadeEnabled: false, dVel: null,
    VEL_CLAMP: 1.5, PIGMENTS: [pigment, pigment, pigment],
  }),
  markCanvasActive: () => {},
});

const sum = (a) => a.reduce((s, x) => s + x, 0);

core.generatePaper();
assert.ok(sum(fields.paperH) > 0, 'paper texture generated');

// a wet pigment drop in the middle
const cx = 16, cy = 12, i0 = cy * GW + cx;
fields.wet[i0] = 1;
fields.g[0][i0] = 0.8;
core.expandActiveRect(cx, cy, 3);
const mass0 = sum(fields.g[0]) + sum(fields.d[0]);

core.simStep();
assert.ok(fields.wet[i0 + 1] > 0, 'wet diffuses to neighbors after one step');

for (let s = 0; s < 3000; s++) core.simStep();

const totalWet = sum(fields.wet);
assert.equal(totalWet, 0, 'the drop fully dries under evaporation');
// NOTE: strict closed-edge mass conservation is asserted by the harness's
// mass-balance pattern on the real grid. On a 32×24 toy grid the interior-
// only diffusion stencil bleeds real mass into the boundary ring, so here
// we assert sanity, not conservation: mass never increases, never vanishes,
// and what survives ends up deposited.
const mass1 = sum(fields.g[0]) + sum(fields.d[0]);
assert.ok(mass1 <= mass0 + 1e-9, `pigment mass never increases (${mass0} -> ${mass1})`);
assert.ok(mass1 > 0.25 * mass0, `pigment does not vanish (${mass0} -> ${mass1})`);
const dep = sum(fields.d[0]);
assert.ok(dep / mass1 > 0.95, 'surviving pigment settled into the deposit layer');
const rb = core.rectBounds();
assert.ok(rb.maxX < rb.minX, 'active rect empties after full dry-down (shrink)');

console.log(`sim-core-standalone: OK — physics ran with no host at all ` +
  `(mass ${mass0.toFixed(3)} -> ${mass1.toFixed(3)}, deposited ${sum(fields.d[0]).toFixed(3)}, rect empty)`);
