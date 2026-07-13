// washes-sim-core.d.ts — types for the graduated simulation core (v1.18).
//
// The ownership contract (see washes-sim-core.js header): the HOST owns all
// state — field arrays, grid dims, tunables — and may reallocate/reassign
// them freely. The core snapshots bindings (call refreshBindings() after any
// rebuild) and re-reads the runtime-mutable set via env.live() at every
// exported call.

/** Rebuild-refreshed bindings: arrays, dims, and SCALE-derived constants. */
export interface SimCoreBindings {
  GW: number; GH: number; N: number;
  inv_s: number; inv_s2: number; s_scale: number;
  wet: Float32Array; wet_tmp: Float32Array;
  u: Float32Array; v: Float32Array;
  u_new: Float32Array; v_new: Float32Array;
  pressure: Float32Array; paperH: Float32Array; mask: Float32Array;
  g: [Float32Array, Float32Array, Float32Array];
  d: [Float32Array, Float32Array, Float32Array];
  g_tmp: [Float32Array, Float32Array, Float32Array];
  wetBlur: Float32Array; wetBlurTmp: Float32Array;
  wetBinary: Float32Array; wetBlurLarge: Float32Array;
  WET_DIFFUSION: number; PIGMENT_DIFFUSION: number;
  EDGE_KERNEL: number; EDGE_KERNEL_LARGE: number;
  MASK_THRESHOLD: number;
}

/** Pigment record as the transfer pass reads it. */
export interface SimCorePigment {
  K: [number, number, number];
  S: [number, number, number];
  density: number;
  staining: number;
  granulation: number;
}

/** Runtime-mutable state, re-read at every exported call. */
export interface SimCoreLive {
  evaporationRate: number;
  dryingPaused: boolean;
  edgeDarkeningEnabled: boolean;
  advectionMode: 'semilag' | 'substep' | 'standard' | 'clamp';
  maskActive: boolean;
  maskRectMinX: number; maskRectMinY: number;
  maskRectMaxX: number; maskRectMaxY: number;
  edgeOpenLeft: boolean; edgeOpenRight: boolean;
  edgeOpenTop: boolean; edgeOpenBottom: boolean;
  gravityDir: string; gravityStrength: number;
  gravityBiasX: number; gravityBiasY: number;
  edgeMode: string;
  fadeEnabled: boolean;
  dVel: [Float32Array, Float32Array, Float32Array] | null;
  VEL_CLAMP: number;
  PIGMENTS: SimCorePigment[];
}

export interface SimCoreEnv {
  bindings(): SimCoreBindings;
  live(): SimCoreLive;
  /** Wake hook — invoked where the closure original called markCanvasActive. */
  markCanvasActive?(): void;
  /** Mask stamps report the cells that crossed the threshold; the host owns
   *  the mask-rect bookkeeping (v1.20). */
  commitMaskStamp?(minX: number, maxX: number, minY: number, maxY: number): void;
}

/** A fully RESOLVED brush stamp (v1.20 — migration Phase 1). The caller
 *  resolves everything UI-flavored: pigment identity to a channel or
 *  weights, load sliders to gains, brush mode to a texture descriptor.
 *  Callers also own expandActiveRect + the wake hook. */
export type ResolvedStamp =
  | { kind: 'mask'; cx: number; cy: number; radius: number; strength: number }
  | { kind: 'lift'; cx: number; cy: number; radius: number; strength: number }
  | { kind: 'water'; cx: number; cy: number; radius: number; strength: number;
      wetGain: number; presGain: number; liftGain: number }
  | { kind: 'paper'; cx: number; cy: number; radius: number; strength: number;
      wetGain: number }
  | { kind: 'rainbow'; cx: number; cy: number; radius: number; strength: number;
      weights: [number, number, number]; depositMult: number;
      wetGain: number; presGain: number }
  | { kind: 'pigment'; cx: number; cy: number; radius: number; strength: number;
      channel: number; depositMult: number; wetGain: number; presGain: number;
      texture: {
        field: Float32Array | null;
        /** Worker wire form (v1.21): field stays null and `mode` names a
         *  brush field previously sent via uploadBrushField(). Ignored by
         *  the core itself — the worker substitutes the cached array. */
        mode?: string;
        baseThresh: number; bandHalf: number; anisoK: number;
        paperWeight: number; bristleK: number;
        motionX: number; motionY: number;
      } | null };

export interface SimCore {
  /** Re-snapshot bindings. MUST be called after the host rebuilds arrays/dims. */
  refreshBindings(): void;
  /** Active-region bounding box (REUSED object — read, don't retain). */
  rectBounds(): { minX: number; maxX: number; minY: number; maxY: number };
  lastAdvectionSubsteps(): number;

  simStep(params?: unknown): void;
  /** Apply one fully resolved brush stamp (v1.20). */
  applyStamp(stamp: ResolvedStamp): void;
  movePigment(): void;
  transferPigment(): void;
  diffuseWet(): void;
  evaporate(): void;
  updateVelocity(): void;
  applyEdgeDarkening(): void;
  drainBoundaries(adt: number): void;
  generatePaper(): void;
  smoothNoise(x: number, y: number): number;

  expandActiveRect(centerX: number, centerY: number, radius: number): void;
  setActiveRectFull(): void;
  setActiveRectEmpty(): void;
  activeRectIsEmpty(): boolean;
  shrinkActiveRect(): void;

  readonly MAX_PIGMENT: number;
  readonly DT: number;
  readonly VISCOSITY: number;
  readonly DRAG: number;
  readonly PAPER_TILT: number;
  readonly EDGE_ETA: number;
  readonly EDGE_WET_ACTIVE: number;
  readonly EDGE_WET_OFF: number;
  readonly ACTIVE_THRESHOLD: number;
}

export function createSimCore(env: SimCoreEnv): SimCore;
