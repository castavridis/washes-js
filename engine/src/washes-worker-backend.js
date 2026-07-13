// washes-worker-backend.js — SimBackend over a worker-hosted sim core.
//
// ENGINE_REVIEW P1#8, host side. Implements the SimBackend contract
// (docs/gpu-migration/backend/sim-backend.d.ts) against a worker running
// washes-sim-worker.js. The sim leaves the calling thread entirely; state
// crosses as transferable SimStateArrays.
//
// Contract notes, stated honestly:
//   - step() is FIRE-AND-FORGET (capabilities.async = true): it posts the
//     step and returns; results exist in the worker until downloaded. Use
//     flush() as a barrier. The in-process CPU adapter remains the backend
//     for hosts that need synchronous stepping.
//   - stampBrush() throws: brush deposit math still lives in the host
//     (washes.js paintAt), not in the extracted core — routing stamps is
//     the migration plan's Phase 1. Interactive painting stays on the CPU
//     backend until then; batch/offline users paint into a state array and
//     uploadState().
//   - uploadState/downloadState return Promises here (the transfer is
//     inherently async).

import { allocState, stateTransferList } from './washes-state-codec.js';

/** Normalize a browser Worker or node worker_threads Worker to {post, on}. */
export function wrapWorkerPort(worker) {
  if (typeof worker.on === 'function') {
    return {
      post: (m, t) => worker.postMessage(m, t || []),
      on: (fn) => worker.on('message', fn),
    };
  }
  return {
    post: (m, t) => worker.postMessage(m, t || []),
    on: (fn) => { worker.onmessage = (e) => fn(e.data); },
  };
}

/**
 * @param port  a wrapWorkerPort() result
 * @param opts  { GW, GH, bindings, live, generatePaper? }
 *              bindings: the SimCoreBindings constants (WET_DIFFUSION …
 *              MASK_THRESHOLD, inv_s, inv_s2, s_scale) — arrays and dims
 *              are worker-owned. live: the initial SimCoreLive snapshot.
 */
export function createWorkerBackend(port, opts) {
  const N = opts.GW * opts.GH;
  let destroyed = false;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, kind, out?}

  let readyResolve;
  const ready = new Promise((res) => { readyResolve = res; });

  port.on((msg) => {
    if (msg.t === 'ready') { readyResolve(); return; }
    if (msg.t === 'booted') return;
    if (msg.t === 'error') { console.warn('washes worker:', msg.error); return; }
    const p = msg.id != null ? pending.get(msg.id) : null;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.t === 'state' && p.out) {
      p.out.fluid.set(msg.state.fluid);
      p.out.pigment.set(msg.state.pigment);
      p.out.deposit.set(msg.state.deposit);
      p.out.paper.set(msg.state.paper);
    }
    p.resolve(msg);
  });

  function request(message, out) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, out });
      port.post({ ...message, id });
    });
  }

  port.post({
    t: 'init',
    GW: opts.GW, GH: opts.GH,
    bindings: opts.bindings,
    live: opts.live,
    generatePaper: !!opts.generatePaper,
  });

  return {
    capabilities: {
      gpu: false,
      zeroCopyRender: false,
      textureBrushes: false,
      ink: true,
      maxStampsPerStep: 0,
      async: true,
    },
    ready,

    /** Fire-and-forget: post one step (optionally with a live update). */
    step(params, liveUpdate) {
      if (destroyed) return;
      port.post({ t: 'step', n: 1, params, live: liveUpdate });
    },

    /** Post n steps and resolve when the worker has finished them. */
    stepN(n, params, liveUpdate) {
      if (destroyed) return Promise.resolve();
      return request({ t: 'step', n, params, live: liveUpdate });
    },

    /** Barrier: resolves once every previously posted message is processed. */
    flush() {
      if (destroyed) return Promise.resolve();
      return request({ t: 'step', n: 0 });
    },

    /**
     * v1.20 — accepts RESOLVED stamps (the washes-sim-core applyStamp
     * shape: kind + grid coords + pre-resolved gains/weights), which the
     * worker applies with the identical deposit math. Texture-mode stamps
     * are the one remaining gap: their noise field is a grid-sized host
     * array that needs a brush-field upload protocol (follow-up) — the
     * worker rejects them with that guidance.
     */
    stampBrush(stamps) {
      if (destroyed || !stamps || !stamps.length) return;
      for (const s of stamps) {
        if (!s.kind) {
          throw new Error(
            'washes worker backend: expected RESOLVED stamps ({kind, cx, cy, radius, ' +
            'strength, …} — see washes-sim-core applyStamp). Raw pointer stamps are ' +
            'resolved by the host paintAt; build the resolved form instead.'
          );
        }
        if (s.texture) {
          throw new Error(
            'washes worker backend: texture-mode stamps are not routed yet ' +
            '(their noise field needs a brush-field upload protocol).'
          );
        }
      }
      port.post({ t: 'stamp', stamps });
    },

    uploadState(state) {
      if (destroyed) return Promise.resolve();
      return request({ t: 'upload', state });
    },

    downloadState(out) {
      if (destroyed) return Promise.resolve(out);
      return request({ t: 'download' }, out || allocState(N)).then(() => out);
    },

    getTextures() { return null; },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      port.post({ t: 'destroy' });
      for (const p of pending.values()) p.resolve({ t: 'destroyed' });
      pending.clear();
    },
  };
}
