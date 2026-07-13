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
}

export interface SimCore {
  /** Re-snapshot bindings. MUST be called after the host rebuilds arrays/dims. */
  refreshBindings(): void;
  /** Active-region bounding box (REUSED object — read, don't retain). */
  rectBounds(): { minX: number; maxX: number; minY: number; maxY: number };
  lastAdvectionSubsteps(): number;

  simStep(params?: unknown): void;
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
