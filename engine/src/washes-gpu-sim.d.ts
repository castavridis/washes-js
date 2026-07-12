// ============================================================
// washes-gpu-sim.d.ts
//
// TypeScript declarations for the optional GPU simulation backend.
// Use this alongside the core lib's CPU sim path:
//
//   import { Washes } from 'washes';
//   import { initGpuSim } from 'washes/gpu-sim';
//
//   const wc = Washes.create(host);
//   const ctx = wc.gpuSimContext();             // { gl, GW, GH }
//   const handle = initGpuSim(ctx.gl, ctx.GW, ctx.GH);
//   wc.gpuSim(handle);                          // hand off
//   wc.webgl(true);                             // enable WebGL render
//
// All sim arrays then live on GPU textures; the lib's `paintAt`,
// `splash`, `rewet`, etc. continue to work but are routed through
// the GPU backend transparently.
// ============================================================

/**
 * Brush stamp queued by the lib for the GPU sim to flush at the
 * top of its next step. Coordinates are in grid (not display)
 * pixels. brushType: 0 = pigment, 1 = water, 2 = lift, 3 = mask,
 * 4 = paper. pigmentIdx: 0/1/2 for K-M slots, 3 for rainbow (uses
 * u_rainbowWeights set via {@link GpuSimHandle.setRainbowWeights}).
 */
export interface GpuBrushStamp {
  cx: number;
  cy: number;
  radius: number;
  strength: number;
  brushType: 0 | 1 | 2 | 3 | 4;
  pigmentIdx: 0 | 1 | 2 | 3;
  wetAmount: number;
  pressureAmount: number;
}

/**
 * Simulation parameters supplied per `step()` call. The lib hands
 * these in from its own constants + user-tunable state (advection
 * mode, viscosity, gravity, etc.). End users don't typically build
 * this object directly — it's constructed inside the lib's GPU
 * routing path. Included here for completeness and for users who
 * want to drive the sim manually.
 */
export interface GpuSimParams {
  DT: number;
  wetDiffusion: number;
  viscosity: number;
  drag: number;
  paperTilt: number;
  velClamp: number;
  pressureDecay: number;
  pigmentDiffusion: number;
  evaporationRate: number;
  maxPigment: number;
  edgeEta: number;
  edgeWetActive: number;
  edgeWetOff: number;
  edgeBlurSmall: number;
  edgeBlurLarge: number;
  maskActive: boolean;
  gravityMode: 0 | 1 | 2 | 3;
  gravityBias: [number, number];
  gravityStrength: number;
  edgeOpenLeft: boolean;
  edgeOpenRight: boolean;
  edgeOpenTop: boolean;
  edgeOpenBottom: boolean;
}

/** Float32Array buffers for full-state CPU↔GPU sync. */
export interface GpuSimState {
  /** (u, v, pressure, wet) per cell — N × 4 floats. */
  fluid: Float32Array;
  /** (g0, g1, g2, 0) per cell — N × 4 floats. */
  pigment: Float32Array;
  /** (d0, d1, d2, mask) per cell — N × 4 floats. */
  deposit: Float32Array;
  /** (paperH, 0, 0, 0) per cell — N × 4 floats. */
  paper: Float32Array;
}

/**
 * Handle returned by {@link initGpuSim}. Hand it to
 * `wc.gpuSim(handle)` to route the lib's sim through the GPU.
 * The lib calls these methods internally; you generally don't
 * call them directly except for `destroy()` on teardown.
 */
export interface GpuSimHandle {
  /** Advance the simulation by one step. */
  step(params: GpuSimParams): void;
  /** Queue brush stamps for the next step's apply phase. */
  stampBrush(stamps: GpuBrushStamp[]): void;
  /** Upload CPU arrays into GPU textures. */
  uploadState(state: GpuSimState): void;
  /** Download GPU textures into the provided CPU arrays. */
  downloadState(state: GpuSimState): void;
  /** Get the current pigment texture (read-only handle). */
  getPigmentTexture(): WebGLTexture;
  /** Get the current fluid texture (read-only handle). */
  getFluidTexture(): WebGLTexture;
  /** Get the current deposit texture (read-only handle). */
  getDepositTexture(): WebGLTexture;
  /** Set rainbow brush weights consumed by stamps with pigIdx=3. */
  setRainbowWeights(w0: number, w1: number, w2: number): void;
  /**
   * Set brush-mode parameters consumed by pigment stamps. Mode
   * codes: 0 = wet, 1 = crayon, 2 = dryBrush, 3 = salt, 4 = splatter.
   */
  setBrushMode(
    mode: 0 | 1 | 2 | 3 | 4,
    dryness: number,
    paperReject: number,
    anisotropy: number,
    bristleSkip: number,
    motionDirX: number,
    motionDirY: number,
  ): void;
  /**
   * Upload the active brush mode's noise field (v1.0.1). The texture-brush
   * shader samples this instead of synthesizing procedural noise, so GPU
   * crayon/dryBrush/salt/splatter match the CPU look. `field` is a
   * Float32Array of length GW*GH in [0,1]; w/h are the grid dimensions.
   */
  setBrushTexture(field: Float32Array, w: number, h: number): void;
  /** Release WebGL resources. Call when tearing down the instance. */
  destroy(): void;

  // ─── Debug methods ──────────────────────────────────────────────
  /** Fill the pigment texture with deterministic test data. */
  debugFillPigmentTexture(): void;
  /** Apply queued brush stamps without running other sim phases. */
  debugApplyBrushStampsOnly(): void;
  /** Run only the transfer+evaporate phase. */
  debugApplyTransferOnly(params: GpuSimParams): void;
  /** Run only the wet-diffusion phase. */
  debugApplyWetDiffusionOnly(params: GpuSimParams): void;
  /** Run only the velocity update phase. */
  debugApplyVelocityOnly(params: GpuSimParams): void;
  /** Run only the semi-Lagrangian advection phase. */
  debugApplyAdvectionOnly(params: GpuSimParams): void;
}

/**
 * Initialize the GPU sim backend bound to the provided WebGL2
 * context. The context must have `EXT_color_buffer_float` available;
 * the function throws if it doesn't. `OES_texture_float_linear` is
 * requested but optional — the sim falls back to manual bilinear
 * filtering in the shader when it's missing.
 *
 * @param gl A WebGL2 rendering context (`canvas.getContext('webgl2')`).
 *           Typically obtained via `wc.gpuSimContext().gl`.
 * @param GW Grid width in cells.
 * @param GH Grid height in cells.
 * @returns A handle to be passed to `wc.gpuSim(handle)`.
 */
export function initGpuSim(
  gl: WebGL2RenderingContext,
  GW: number,
  GH: number,
): GpuSimHandle;

/** Version string of the loaded GPU sim build. */
export const version: string;

/** Default export is the namespace `{ initGpuSim, version }`. */
declare const WashesGpuSim: {
  initGpuSim: typeof initGpuSim;
  version: typeof version;
};
export default WashesGpuSim;

// ─── Global augmentation (classic <script> use cases) ────────────────
declare global {
  interface Window {
    WashesGpuSim: typeof WashesGpuSim;
  }
}
