// worker-backend.test.mjs — the worker backend's parity oracle.
//
// Runs the SAME simulation twice: once on an in-process createSimCore, once
// inside a real node:worker_threads worker via the worker backend — and
// asserts the resulting state is BIT-EXACT. This is only possible because
// the extracted core is fully deterministic (zero Math.random on any path,
// paper generation included — it's hash-noise).
//
// Run: node tests/worker-backend.test.mjs

import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createSimCore } from '../src/washes-sim-core.js';
import { allocState, packState } from '../src/washes-state-codec.js';
import { createWorkerBackend, wrapWorkerPort } from '../src/washes-worker-backend.js';

const GW = 96, GH = 72, N = GW * GH;
const STEPS = 120;

const BINDINGS = {
  inv_s: 1, inv_s2: 1, s_scale: 1,
  WET_DIFFUSION: 0.1, PIGMENT_DIFFUSION: 0.045,
  EDGE_KERNEL: 3, EDGE_KERNEL_LARGE: 10, MASK_THRESHOLD: 0.5,
};
const pigment = { K: [0.5, 1.0, 1.2], S: [0.6, 0.5, 0.4], density: 0.02, staining: 1.2, granulation: 0.2 };
const LIVE = {
  evaporationRate: 0.9988, dryingPaused: false, edgeDarkeningEnabled: true,
  advectionMode: 'semilag',
  maskActive: false, maskRectMinX: 0, maskRectMinY: 0, maskRectMaxX: -1, maskRectMaxY: -1,
  edgeOpenLeft: false, edgeOpenRight: false, edgeOpenTop: false, edgeOpenBottom: false,
  gravityDir: 'down', gravityStrength: 0.03, gravityBiasX: 0, gravityBiasY: 0.02,
  edgeMode: 'closed-gravity', fadeEnabled: false, dVel: null,
  VEL_CLAMP: 1.5, PIGMENTS: [pigment, pigment, pigment],
};

// ---- local reference run ----
const F = () => new Float32Array(N);
const fields = {
  wet: F(), wet_tmp: F(), u: F(), v: F(), u_new: F(), v_new: F(),
  pressure: F(), paperH: F(), mask: F(),
  wetBlur: F(), wetBlurTmp: F(), wetBinary: F(), wetBlurLarge: F(),
  g: [F(), F(), F()], d: [F(), F(), F()], g_tmp: [F(), F(), F()],
};
const local = createSimCore({
  bindings: () => ({ GW, GH, N, ...BINDINGS, ...fields }),
  live: () => LIVE,
  markCanvasActive: () => {},
});
local.generatePaper();
// a wet, moving pigment blob — exercises diffusion, advection, gravity,
// edge darkening, transfer, evaporation
for (let dy = -3; dy <= 3; dy++) {
  for (let dx = -3; dx <= 3; dx++) {
    const i = (36 + dy) * GW + (48 + dx);
    fields.wet[i] = 0.9;
    fields.g[0][i] = 0.5;
    fields.g[2][i] = 0.2;
    fields.u[i] = 0.4;
    fields.pressure[i] = 2.0;
  }
}
// snapshot the shared starting state BEFORE stepping
const start = packState(fields, allocState(N));

// mirror the upload policy on the local side so both runs begin identically
local.setActiveRectFull();
for (let s = 0; s < STEPS; s++) local.simStep();
const localEnd = packState(fields, allocState(N));

// ---- worker run ----
const worker = new Worker(new URL('../src/washes-sim-worker.js', import.meta.url));
const backend = createWorkerBackend(wrapWorkerPort(worker), {
  GW, GH, bindings: BINDINGS, live: LIVE,
});
await backend.ready;
await backend.uploadState(start);
await backend.stepN(STEPS);
const workerEnd = allocState(N);
await backend.downloadState(workerEnd);

// ---- bit-exact comparison ----
let worstPlane = null;
for (const plane of ['fluid', 'pigment', 'deposit', 'paper']) {
  const A = Buffer.from(localEnd[plane].buffer);
  const B = Buffer.from(workerEnd[plane].buffer);
  if (Buffer.compare(A, B) !== 0) {
    let i = 0;
    while (i < localEnd[plane].length && localEnd[plane][i] === workerEnd[plane][i]) i++;
    worstPlane = `${plane}[${i}]: local ${localEnd[plane][i]} vs worker ${workerEnd[plane][i]}`;
    break;
  }
}
assert.equal(worstPlane, null, `worker state diverged at ${worstPlane}`);

// the run did real physics (didn't compare two empty grids)
const sum = (a) => a.reduce((s, x) => s + x, 0);
assert.ok(sum(workerEnd.deposit) > 0.5, 'pigment deposited during the run');
assert.ok(sum(workerEnd.fluid) !== 0, 'fluid state evolved');

// contract edges
assert.throws(() => backend.stampBrush([]), /Phase 1/, 'stampBrush fails loud with guidance');
backend.destroy();
await new Promise((res) => worker.on('exit', res));

console.log(`worker-backend: OK — ${STEPS} steps on a ${GW}×${GH} grid are BIT-EXACT ` +
  `between the in-process core and the worker-hosted core ` +
  `(deposited ${sum(workerEnd.deposit).toFixed(3)})`);
