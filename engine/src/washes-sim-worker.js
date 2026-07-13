// washes-sim-worker.js — the simulation core, hosted in a worker.
//
// ENGINE_REVIEW P1#8: this is the worker-side half of the worker backend.
// It owns its own field arrays and a createSimCore instance, and speaks a
// small message protocol (init / live / step / upload / download / destroy)
// with SimStateArrays crossing as transferables. Runs identically under a
// browser `new Worker(url, { type: "module" })` and Node's worker_threads —
// the port adapter below abstracts the two.
//
// The host-side counterpart (washes-worker-backend.js) wraps this protocol
// in the SimBackend contract.

import { createSimCore } from './washes-sim-core.js';
import { allocState, packState, unpackState, stateTransferList } from './washes-state-codec.js';

// ---- port adapter: browser worker global vs node worker_threads ----
async function getPort() {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function'
      && typeof window === 'undefined') {
    return {
      post: (m, t) => self.postMessage(m, t || []),
      on: (fn) => { self.onmessage = (e) => fn(e.data); },
      close: () => self.close(),
    };
  }
  const { parentPort } = await import('node:worker_threads');
  if (!parentPort) throw new Error('washes-sim-worker: no worker context (run inside a Worker)');
  return {
    post: (m, t) => parentPort.postMessage(m, t || []),
    on: (fn) => parentPort.on('message', fn),
    close: () => parentPort.close(),
  };
}

const port = await getPort();

let core = null;
let fields = null;
let dims = null;
let bindConsts = null;
// The live object is mutated in place by 'live'/'step' messages; the core
// re-reads it at every exported call, so updates apply with step granularity
// — the same visibility the in-process CPU backend has.
let live = null;

function makeFields(N) {
  const F = () => new Float32Array(N);
  return {
    wet: F(), wet_tmp: F(), u: F(), v: F(), u_new: F(), v_new: F(),
    pressure: F(), paperH: F(), mask: F(),
    wetBlur: F(), wetBlurTmp: F(), wetBinary: F(), wetBlurLarge: F(),
    g: [F(), F(), F()], d: [F(), F(), F()], g_tmp: [F(), F(), F()],
  };
}

port.on((msg) => {
  switch (msg.t) {
    case 'init': {
      dims = { GW: msg.GW, GH: msg.GH, N: msg.GW * msg.GH };
      bindConsts = msg.bindings;
      live = msg.live;
      fields = makeFields(dims.N);
      core = createSimCore({
        bindings: () => ({ ...dims, ...bindConsts, ...fields }),
        live: () => live,
        markCanvasActive: () => {},
        // mask stamps report threshold-crossing cells; the worker owns its
        // live mask state, so expand it here (same logic as the host glue)
        commitMaskStamp: (rMinX, rMaxX, rMinY, rMaxY) => {
          live.maskActive = true;
          if (rMinX < live.maskRectMinX) live.maskRectMinX = rMinX;
          if (rMaxX > live.maskRectMaxX) live.maskRectMaxX = rMaxX;
          if (rMinY < live.maskRectMinY) live.maskRectMinY = rMinY;
          if (rMaxY > live.maskRectMaxY) live.maskRectMaxY = rMaxY;
        },
      });
      if (msg.generatePaper) core.generatePaper();
      port.post({ t: 'ready' });
      break;
    }
    case 'live': {
      Object.assign(live, msg.live);
      break;
    }
    case 'step': {
      if (msg.live) Object.assign(live, msg.live);
      const n = msg.n == null ? 1 : msg.n;
      for (let i = 0; i < n; i++) core.simStep(msg.params);
      if (msg.id != null) port.post({ t: 'stepped', id: msg.id, n });
      break;
    }
    case 'stamp': {
      // v1.20 — resolved stamps (see washes-sim-core.js applyStamp). The
      // caller owns rect growth, so mirror the host's paintAt preamble.
      for (const s of msg.stamps) {
        if (s.texture) {
          port.post({ t: 'error', error: 'texture stamps need a brush-field upload protocol (follow-up); send kind pigment/rainbow/water/lift/paper/mask' });
          continue;
        }
        core.expandActiveRect(s.cx, s.cy, s.radius);
        core.applyStamp(s);
      }
      if (msg.id != null) port.post({ t: 'stamped', id: msg.id });
      break;
    }
    case 'upload': {
      unpackState(msg.state, fields);
      // restored content is unknown to the rect tracker — start full and
      // let the next shrink scan tighten (same policy as the CPU adapter)
      core.setActiveRectFull();
      if (msg.id != null) port.post({ t: 'uploaded', id: msg.id });
      break;
    }
    case 'download': {
      const s = packState(fields, allocState(dims.N));
      port.post({ t: 'state', id: msg.id, state: s }, stateTransferList(s));
      break;
    }
    case 'destroy': {
      core = fields = null;
      port.post({ t: 'destroyed' });
      port.close();
      break;
    }
    default:
      port.post({ t: 'error', error: 'unknown message: ' + (msg && msg.t) });
  }
});

port.post({ t: 'booted' });
