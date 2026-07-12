// ============================================================
// Washes — entry point barrel.
//
// Re-exports the watercolor library's full public API from one
// place so consumers can do:
//
//   import { Washes, Watercolor } from 'washes';
//   import Washes from 'washes';
//
// The GPU sim backend is a separate optional entry point —
// import it explicitly when you want GPU sim:
//
//   import { initGpuSim } from 'washes/gpu-sim';
//
// Why split? The core lib (washes.js) runs fine without the
// GPU sim — the CPU path is the default and always works. The
// GPU sim is a ~78 KB additional payload that's only useful
// when you call `wc.gpuSim(handle)` to activate it. Splitting
// lets bundlers tree-shake it out when not needed.
// ============================================================

export { Washes, Watercolor } from './washes.js';
export { default } from './washes.js';
