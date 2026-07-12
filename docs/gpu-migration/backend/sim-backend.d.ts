// sim-backend.d.ts
//
// Phase 0 deliverable: the formalized backend seam.
//
// Today the GPU module already exposes a de-facto backend contract
// (step / stampBrush / uploadState / downloadState / get*Texture / destroy).
// This file promotes that shape to a first-class, typed interface that BOTH
// a CPU backend and a GPU backend implement. The Washes lib keeps owning the
// canvas, pointer events, brush state, public API and render loop; it talks to
// whichever `SimBackend` it was given.
//
// This also closes the "build story" cross-cutting item: SimBackend,
// BrushStamp and SimParams become first-class typed exports rather than
// shapes that only exist inside a hand-converted module.

/** One queued brush stamp. Mirrors the GPU module's BrushStamp, plus the
 *  two v0.98 fields the GPU path was missing (see MIGRATION.md, Phase 1). */
export interface BrushStamp {
  cx: number;
  cy: number;
  radius: number;
  strength: number;
  /** 0=pigment, 1=water, 2=lift, 3=mask, 4=paper */
  brushType: number;
  pigmentIdx: number;
  wetAmount: number;
  pressureAmount: number;
  /** Phase 1: explicit paint load, replacing the strength-folding hack. */
  paintAmount?: number;
  /** Phase 1: texture brush mode for the stamp ('wet' | 'crayon' | ...). */
  textureMode?: string;
}

/** Flattened per-step simulation parameters (uniform bundle on the GPU side). */
export interface SimParams {
  DT: number;
  viscosity: number;
  drag: number;
  velClamp: number;
  pressureDecay: number;
  wetDiffusion: number;
  pigmentDiffusion: number;
  evaporationRate: number;
  maxPigment: number;
  gravityMode: number; // 0=none, 1=fixed, 2=radial, 3=radial-in
  gravityBias: [number, number];
  gravityStrength: number;
  edgeOpen: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  edgeDarkeningEnabled: boolean;
  dryingPaused: boolean;
}

/** CPU-side state arrays (the transfer format across the seam). */
export interface SimStateArrays {
  /** (u, v, pressure, wet) interleaved, length GW*GH*4 */
  fluid: Float32Array;
  /** (g0, g1, g2, 0) interleaved */
  pigment: Float32Array;
  /** (d0, d1, d2, mask) interleaved */
  deposit: Float32Array;
  /** (paperHeight, 0, 0, 0) interleaved */
  paper: Float32Array;
}

export interface BackendCapabilities {
  /** Does this backend run the sim on the GPU? */
  gpu: boolean;
  /** Can it render straight from its own textures with no readback? */
  zeroCopyRender: boolean;
  /** Texture brush modes implemented (Phase 1 gates these on the GPU path). */
  textureBrushes: boolean;
  /** Ink pigment channel implemented. */
  ink: boolean;
  /** Max brush stamps accepted per step (Infinity on CPU; 32 on GPU today). */
  maxStampsPerStep: number;
}

/** The contract both CPU and GPU backends satisfy. */
export interface SimBackend {
  readonly capabilities: BackendCapabilities;

  /** Run one full simulation step with the given params. */
  step(params: SimParams): void;

  /** Queue brush stamps to be applied on the next step. Implementations that
   *  cap stamps per step (GPU) must accept any count and internally batch
   *  (see stamp-batcher.js); callers should not pre-truncate. */
  stampBrush(stamps: BrushStamp[]): void;

  /** Seed backend state from CPU arrays (CPU→GPU on first GPU frame, or
   *  restore-after-context-loss). */
  uploadState(state: SimStateArrays): void;

  /** Read backend state into CPU arrays. Expensive on the GPU (readPixels);
   *  use only for exportPNG, CPU-only effects, the context-loss shadow, and
   *  the parity oracle — never in the steady-state frame loop. */
  downloadState(out: SimStateArrays): void;

  /** Direct-sample handles for zero-copy render. Returns null on CPU. */
  getTextures(): {
    fluid: WebGLTexture;
    pigment: WebGLTexture;
    deposit: WebGLTexture;
  } | null;

  /** Free all resources (GL textures / FBOs, or just drop array refs). */
  destroy(): void;
}

/** Result of capability detection + selection (select-backend.js). */
export interface BackendChoice {
  kind: 'cpu' | 'gpu';
  reason: string;
}
