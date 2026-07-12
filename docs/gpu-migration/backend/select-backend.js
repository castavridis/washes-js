// select-backend.js
//
// Phase 3: pick a backend at create() time. GPU becomes the default ONLY when
// (a) WebGL2 + the float-color-buffer extensions the sim needs are present, and
// (b) the GPU path has reached parity for the features this instance will use.
//
// (b) is the honest gate: until Phase 1 parity lands for a given feature, an
// instance that needs it (e.g. texture brushes, ink) must stay on the CPU even
// where WebGL2 exists. This is what lets the default flip incrementally instead
// of all at once. `parityOk` is supplied by the integrator and tightened as
// features are validated against the CPU oracle (see MIGRATION.md, Phase 1).

/** @typedef {import('./sim-backend').BackendChoice} BackendChoice */

/**
 * Detect a usable WebGL2 context with float render targets.
 * @param {() => (WebGL2RenderingContext|null)} getGL  lazily create/borrow a GL2 context
 * @returns {{ ok: boolean, reason: string }}
 */
export function detectGpu(getGL) {
  if (typeof WebGL2RenderingContext === 'undefined') {
    return { ok: false, reason: 'WebGL2 not in this environment' };
  }
  let gl;
  try {
    gl = getGL();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'GL context creation threw: ' + msg };
  }
  if (!gl) return { ok: false, reason: 'no WebGL2 context' };
  // The sim ping-pongs float textures; without color-buffer-float the FBOs
  // are not renderable and the whole pipeline silently produces black.
  if (!gl.getExtension('EXT_color_buffer_float')) {
    return { ok: false, reason: 'EXT_color_buffer_float unavailable' };
  }
  return { ok: true, reason: 'WebGL2 + float color buffers present' };
}

/**
 * @param {object} opts
 * @param {boolean} [opts.preferGpu=true]   caller preference (e.g. a `webgl(false)` user override)
 * @param {() => (WebGL2RenderingContext|null)} opts.getGL
 * @param {(caps: {textureBrushes:boolean, ink:boolean}) => boolean} [opts.parityOk]
 *        returns true if the GPU path is validated for the features this
 *        instance needs. Defaults to "nothing is parity-validated yet" so the
 *        GPU is never silently chosen before Phase 1 sign-off.
 * @param {{textureBrushes:boolean, ink:boolean}} [opts.needs]  features this instance will use
 * @returns {BackendChoice}
 */
export function selectBackend(opts) {
  const preferGpu = opts.preferGpu !== false;
  const needs = opts.needs || { textureBrushes: false, ink: false };
  const parityOk = opts.parityOk || (() => false);

  if (!preferGpu) return { kind: 'cpu', reason: 'caller requested CPU' };

  const gpu = detectGpu(opts.getGL);
  if (!gpu.ok) return { kind: 'cpu', reason: 'CPU fallback: ' + gpu.reason };

  if (!parityOk(needs)) {
    return {
      kind: 'cpu',
      reason: 'CPU: GPU parity not yet signed off for required features',
    };
  }
  return { kind: 'gpu', reason: gpu.reason };
}
