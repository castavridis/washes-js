// cpu-backend.js
//
// Phase 0: a CPU backend that satisfies the SimBackend contract by driving the
// library's existing simulation. It is an *adapter*, deliberately — it does not
// relocate the ~9k-line sim core. The lib keeps the sim; the adapter exposes it
// through the interface so create() can pick a backend and the GPU path can be
// swapped in behind the same shape. The physical extraction (moving the sim
// functions into a standalone module) becomes a safe, incremental follow-up once
// every caller goes through this interface.
//
// The adapter depends only on a small `host` hook object, so it's testable in
// isolation and decoupled from whether those hooks are public API or internal:
//
//   host.step(params)          run one sim step (lib's internal simStep)
//   host.stamp(stamp)          apply one BrushStamp (maps to paintAt)
//   host.readState(out)        pack lib arrays into SimStateArrays (_packGpuState)
//   host.writeState(state)     unpack SimStateArrays into lib arrays
//   host.gridSize              { GW, GH }
//   host.destroy()             optional teardown
//
// In production these hooks are one-liners over code that already exists
// (simStep, paintAt, _packGpuState). In tests they're backed by the lib's
// _debug_* instrumentation, which is how we prove the adapter is a faithful
// pass-through rather than a reimplementation.

/** @typedef {import('./sim-backend').SimBackend} SimBackend */
/** @typedef {import('./sim-backend').BrushStamp} BrushStamp */
/** @typedef {import('./sim-backend').SimParams} SimParams */
/** @typedef {import('./sim-backend').SimStateArrays} SimStateArrays */

/**
 * @param {{
 *   step: (params: SimParams) => void,
 *   stamp: (stamp: BrushStamp) => void,
 *   readState: (out: SimStateArrays) => void,
 *   writeState: (state: SimStateArrays) => void,
 *   gridSize: { GW: number, GH: number },
 *   destroy?: () => void,
 * }} host
 * @returns {SimBackend}
 */
export function createCpuBackend(host) {
  /** @type {BrushStamp[]} */
  let queued = [];
  let destroyed = false;

  return {
    capabilities: {
      gpu: false,
      zeroCopyRender: false,
      textureBrushes: true, // CPU has all v0.98 texture modes
      ink: true,
      maxStampsPerStep: Infinity, // no per-step cap on the CPU
    },

    step(params) {
      if (destroyed) return;
      // Stamps are applied immediately before the physics step, matching the
      // lib's existing order (deposits, then advection/diffusion/evaporation).
      if (queued.length) {
        for (let i = 0; i < queued.length; i++) host.stamp(queued[i]);
        queued.length = 0;
      }
      host.step(params);
    },

    stampBrush(stamps) {
      if (destroyed || !stamps || !stamps.length) return;
      // No cap on CPU: just accumulate. (The batcher only matters for the GPU.)
      for (let i = 0; i < stamps.length; i++) queued.push(stamps[i]);
    },

    uploadState(state) {
      if (destroyed) return;
      host.writeState(state);
    },

    downloadState(out) {
      if (destroyed) return;
      host.readState(out);
    },

    getTextures() {
      return null; // CPU renders from arrays; no GL textures to sample
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      queued.length = 0;
      if (host.destroy) host.destroy();
    },
  };
}
