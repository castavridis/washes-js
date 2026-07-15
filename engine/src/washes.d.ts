// washes.d.ts
//
// TypeScript declarations for the Washes watercolor simulation library.
//
// The runtime is plain JavaScript (no compilation step). These declarations
// describe the public API surface as it exists at the JS level. Internal
// helpers, debug methods (`_debug_*`), and private state are intentionally
// omitted.
//
// When the lib adds new public methods, add them here; methods removed from
// the lib should be removed here too. tests/api-surface.test.mjs enforces
// this mechanically — it reflects over a live instance and fails on any
// drift in either direction.

// =============================================================================
// Core types
// =============================================================================

/** A painting snapshot from saveState() (v1.22). */
export interface WashesStateSnapshot {
  format: 'washes-state@1';
  GW: number;
  GH: number;
  /** (u, v, pressure, wet) interleaved, length GW*GH*4 */
  fluid: Float32Array;
  /** (g0, g1, g2, 0) interleaved */
  pigment: Float32Array;
  /** (d0, d1, d2, mask) interleaved */
  deposit: Float32Array;
  /** (paperHeight, 0, 0, 0) interleaved */
  paper: Float32Array;
}

/** Pigment slot index. 0 = quinacridone rose, 1 = hansa yellow, 2 = cerulean blue. */
export type PigmentIndex = 0 | 1 | 2;

/**
 * Named brushes that aren't tied to a pigment slot.
 *
 * - `'water'`: clear water; reactivates dry pigment and helps it spread.
 * - `'lift'`: removes pigment from cells it touches.
 * - `'rainbow'`: time-varying rainbow color from a phase-shifted palette.
 * - `'mask'`: paints into the freeze-mask layer (cells that flow skips).
 * - `'paper'`: erase brush; clears deposited + suspended pigment in the
 *   footprint and adds wetness for a wash effect. (v0.32)
 * - `'ink'`: single-channel ink layer that renders as a darkening multiplier
 *   on top of K-M pigment. Default load: dense + low-bleed. (v0.97)
 */
export type NamedBrush = 'water' | 'lift' | 'rainbow' | 'mask' | 'paper' | 'ink';

/**
 * Anything pigment-shaped that the lib will accept. Numbers select a pigment
 * slot; strings select a slot by name OR select a special brush. The slot
 * names match the pigment palette in the docs.
 */
export type PigmentOption =
  | PigmentIndex
  | 'rose' | 'yellow' | 'blue'
  | 'quinacridone-rose' | 'hansa-yellow' | 'cerulean-blue'
  | NamedBrush;

/** Advection scheme used by `movePigment()`. */
export type AdvectionMode = 'standard' | 'clamp' | 'substep' | 'semilag';

/**
 * Edge boundary behavior. See the Open Boundaries section in the docs.
 *
 * - `'closed'`: walls reflect (mass conserved); no gravity bias applied.
 * - `'closed-gravity'`: walls reflect (no drainage), but gravity bias IS
 *   applied. Pigment piles at downwind edges; pair with `edgeFade()` to
 *   hide the buildup visually. (v0.88)
 * - `'open'`: all edges drain; no ambient bias.
 * - `'gravity'`: edges open in the direction of gravity, with active bias.
 */
export type EdgeMode = 'closed' | 'closed-gravity' | 'open' | 'gravity';

/**
 * Direction of the gravity velocity bias. 8-compass plus `'radial'`,
 * which per-cell points outward from canvas center.
 */
export type GravityDirection =
  | 'up' | 'up-right' | 'right' | 'down-right'
  | 'down' | 'down-left' | 'left' | 'up-left'
  | 'radial';

/**
 * Gouache rendering mode.
 *
 * - `false`: pure watercolor (translucent pigments).
 * - `true`: opaque gouache pigments.
 * - `'auto'`: LERP between watercolor and gouache based on paper darkness.
 */
export type GouacheMode = boolean | 'auto';

/**
 * Brush mode — first-class brush behavior alongside pigment selection.
 * Composes with K-M pigments (rose/yellow/blue); ink/water/lift/mask/paper
 * brushes ignore the mode. (v0.98)
 *
 * - `'wet'`: default — normal pigment deposition.
 * - `'crayon'` (alias `'dry'`): paper-tooth rejection + bristle skip +
 *   motion-direction anisotropy. Streaky, textured look.
 * - `'dryBrush'`: similar to crayon but tuned for low-load broken color.
 * - `'salt'`: granular dispersion as if salt were sprinkled into a wash.
 * - `'splatter'`: scattered offset deposits — flicked-brush feel.
 */
export type BrushMode = 'wet' | 'crayon' | 'dryBrush' | 'salt' | 'splatter';

/**
 * Named quality presets. Each bundles `scale`, `advectionMode`, and a
 * couple of feature toggles into a single setting. (v0.89)
 */
export type QualityPreset = 'auto' | 'high' | 'medium' | 'low' | 'minimum';

/**
 * v0.89 — static device hint for {@link CreateOptions.qualityHint}. The only
 * accepted value, `'auto-mobile'`, raises the starting cell scale on
 * coarse-pointer devices (one-shot: initial SCALE only, no runtime
 * adaptation). Explicit `scale` always wins.
 */
export type QualityHint = 'auto-mobile';

/** Intensity tier passed to `obliterate({ intensity })`. */
export type ObliterateIntensity = 'gentle' | 'normal' | 'extreme';

/** Mode for `obliterate()` — how the painting gets destroyed. */
export type ObliterateMode = 'water' | 'pigment' | 'paper';

/**
 * Color accepted by `wetnessHeatmap()`. Either a CSS-style hex string
 * (`'#rgb'` or `'#rrggbb'`) or an `[r, g, b]` triple of 0..255 ints.
 */
export type HeatmapColor = string | [number, number, number];

// =============================================================================
// Splash / brush input shapes
// =============================================================================

/**
 * One epicenter for a splash. Coordinates are GRID cells (the v1 space;
 * {@link WashesInstance.splashNorm} takes the 0..1 form). Per-point
 * overrides win over the preset's values.
 */
export interface SplashEpicenter {
  x: number;
  y: number;
  /** Splash-zone radius in display pixels (scaled by canvasScale). Default: the preset's. */
  radius?: number;
  /** Outward radial velocity at the epicenter. Default: the preset's. */
  velocity?: number;
  /** Peak pressure injection at the epicenter. Default: the preset's. */
  pressure?: number;
}

/**
 * v1.25 — one epicenter for {@link WashesInstance.splashNorm}: `x`/`y` are
 * 0..1 fractions of the canvas; `radius` is a fraction of the smaller side
 * (the convention every other `*Norm` radius uses). velocity/pressure are
 * preset units, same as {@link SplashEpicenter}.
 */
export interface SplashEpicenterNorm {
  x: number;
  y: number;
  radius?: number;
  velocity?: number;
  pressure?: number;
}

/** Options for a single splash call (third positional argument). */
export interface SplashOptions {
  /** Radians to rotate each radial velocity vector around its epicenter. Default 0. (v0.58) */
  angleOffset?: number;
  /** Multiplier on velocity + pressure injection; pass 1/N when distributing an N-frame splash. Default 1. (v0.58) */
  strengthMult?: number;
  /** Skip the deposited→suspended lift and wet saturation — for the follow-up frames of a distributed splash. Default false. (v0.58) */
  skipLift?: boolean;
  /** 0..1 per-cell angular jitter of the radial field; smears the donor-cell cardinal bias within one frame. Default 0. (v0.59) */
  jitterAmount?: number;
  /** Replace each epicenter with N copies ring-arranged around it, each at full strength. Default 1. (v0.61) */
  rayCount?: number;
  /** Ring radius for ray placement, as a fraction of the splash's own radius. Default 0.05. (v0.61) */
  rayOffsetFraction?: number;
}

/** Style of splash. Different presets shape the radial profile differently. */
export type SplashStyle = 'default' | 'bigSplash' | 'fineSpritz' | 'deluge';

// =============================================================================
// SVG / image / text rendering
// =============================================================================

/**
 * Options for `traceSVG`. The lib parses the SVG, decomposes it into
 * pen-stroke paths, and animates drawing them onto the canvas.
 */
export interface TraceSVGOptions {
  /** Pigment to use for paths without a recognized fill/stroke color. Default: current pigment. */
  pigment?: PigmentOption;
  /** Display-pixel brush size while tracing. Default: current brushSize. */
  brushSize?: number;
  /** 0..1 stamp strength. Default: current pressure. */
  strength?: number;
  /** Recognize chroma-key and pigment-hex colors as direct pigment assignments. Default true. */
  triggerColors?: boolean;
  /** v0.41 backwards-compat alias for {@link TraceSVGOptions.triggerColors}. */
  colorMap?: boolean;
  /** Decompose arbitrary element colors into a rose+yellow+blue mix (subtractive color theory). Default false. */
  approximateColor?: boolean;
  /** Mirror the trace horizontally. */
  flipX?: boolean;
  /** Mirror the trace vertically. */
  flipY?: boolean;
  /** Paint every point synchronously in one frame — no animation. */
  instant?: boolean;
  /** v0.90 — `animate: false` is the user-facing alias for `instant: true`. */
  animate?: boolean;
  /** Spread the animated trace over roughly this many milliseconds. */
  durationMs?: number;
  /** Easing curve for durationMs-based traces. Default 'linear'. */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'penStroke';
  /** Pause this many ms at each path boundary during animated traces. Default 0. */
  perStrokePauseMs?: number;
  /** Stamp closed shapes' fills (not just outlines). Default true. */
  fillShapes?: boolean;
  /** Fills paint all at once even during animated traces. Default true. */
  fillInstant?: boolean;
  /** v0.53 — GRID-coordinate rect to aspect-fit the SVG into, instead of the default 70% centered fit. */
  bounds?: { x: number; y: number; w: number; h: number };
}

/**
 * Options for `paintImage`. Source can be a URL, a data URL, an
 * HTMLImageElement, or a File/Blob. (v2.1.1 — this interface previously
 * declared fields the runtime never read; it now matches the
 * implementation exactly.)
 */
export interface PaintImageOptions {
  /** Pigment for pixels the color decomposition skips. Default: current pigment. */
  pigment?: PigmentOption;
  /** Display-pixel brush size while stamping (drives sample spacing). Default: current brushSize. */
  brushSize?: number;
  /** Base stamp strength, 0..1. Default: current pressure. */
  strength?: number;
  /** 0..1 alpha below which a pixel is skipped. Default 0.05. */
  alphaThreshold?: number;
  /** Sample-spacing multiplier — <1 denser, >1 sparser. Default 1. */
  density?: number;
  /** Hard cap on total stamps; spacing widens to stay under it. Default 20000. */
  maxStamps?: number;
  /** Mirror horizontally. Default false. */
  flipX?: boolean;
  /** Mirror vertically. Default false. */
  flipY?: boolean;
}

/**
 * Options for `paintText`. x/y are the CENTER of the text in grid cells;
 * fontSize is in grid cells (raster pixels map 1:1 to cells). v1.9.2 —
 * pigment accepts names ("rose"|"yellow"|"blue"|…) or indices.
 */
export interface PigmentSpec {
  /** Color identity as hex or CSS string; K/S derived from it. */
  color?: string;
  /** Explicit Kubelka-Munk coefficients (overrides color). */
  K?: [number, number, number];
  S?: [number, number, number];
  density?: number;
  staining?: number;
  /** 0..1; higher = more scattering / granular settling. */
  granulation?: number;
  name?: string;
}

/** Resolved pigment record returned by `pigments()`. */
export interface PigmentRecord {
  name: string;
  color: string | null;
  K: [number, number, number];
  S: [number, number, number];
  density: number;
  staining: number;
  granulation: number;
}

export interface PaintTextOptions {
  pigment?: PigmentOption;
  fontSize?: number;
  /** Raster sampling stride in px; smaller = denser stamps. Default 4. */
  sampleStep?: number;
  /** Per-stamp paint strength. Default 0.4. */
  strength?: number;
  x?: number;
  y?: number;
}

// =============================================================================
// Animation, visualization, time-wash
// =============================================================================

export type AnimationName = 'off' | 'breathe' | 'drift' | 'pulse' | string;
export interface AnimationOptions {
  /** Clear the previous animation's state before starting. Default true. (v2.0.0 — the declared speed/amplitude options were fiction; `replace` is the only option the runtime reads.) */
  replace?: boolean;
}

export type VisualizationName = 'off' | 'velocity' | 'pressure' | 'wet' | 'mask' | string;
export interface VisualizationOptions {
  /** Clear the previous visualization's state before starting. Default true. (v2.0.0 — the declared opacity option was fiction; `replace` is the only option the runtime reads.) */
  replace?: boolean;
}

// =============================================================================
// Sketch / obliterate / fade
// =============================================================================

export interface SketchModeOptions {
  /** Fine-tip brush size in display pixels. Default 7. */
  brushSize?: number;
  /** Per-stamp pigment density. Default 1.6 (denser than normal). */
  paintLoad?: number;
  /** Per-stamp water deposition. Default 0.25 (minimal moisture). */
  waterLoad?: number;
  /** Stamp strength. Default 0.95 (firm strokes). */
  pressure?: number;
  /** Wetness preset for the paper. Default `'boneDry'` (no bleed). */
  paperWetness?: string;
}

export interface ObliterateOptions {
  /** Destruction mode. `'water'` rinses; `'pigment'` covers in color; `'paper'` erases to paper. Default `'water'`. */
  mode?: ObliterateMode;
  /** Duration of the obliterate animation in ms. Default 500. */
  durationMs?: number;
  /** Epicenter X in grid coordinates. Default = grid center. */
  x?: number;
  /** Epicenter Y in grid coordinates. Default = grid center. */
  y?: number;
  /** Fraction of the shorter grid dimension used as the dab radius. Default 0.7. */
  radiusFraction?: number;
  /** Strength tier. `'gentle'` / `'normal'` / `'extreme'`. Default `'normal'`. */
  intensity?: ObliterateIntensity;
  /** Pigment used in `'pigment'` mode. Default = active brush pigment. */
  pigment?: PigmentOption;
}

/**
 * Options for `wetnessHeatmap()` when passed in object form. Equivalent
 * to the (enabled, low, high) positional form. (v0.86)
 */
export interface WetnessHeatmapOptions {
  enabled: boolean;
  low?: HeatmapColor;
  high?: HeatmapColor;
}

/**
 * Options for `pause()`. (v0.90)
 *
 * When `acceptInput` is true, the sim is frozen (no flow / evaporation /
 * animation) but the user can still deposit pigment via pointer or
 * `splash` / `paintAt` / `traceSVG` — deposits sit inert until `resume()`.
 */
export interface PauseOptions {
  acceptInput?: boolean;
}

/**
 * Return value of `paused()`. `false` when running; otherwise an object
 * describing the pause state. Lets callers write both
 * `if (wc.paused()) …` and `wc.paused()?.acceptInput`.
 */
export type PausedState = false | { acceptInput: boolean };

// =============================================================================
// Performance metrics
// =============================================================================

export interface PerfMetrics {
  /** Whether perf instrumentation is currently recording. */
  enabled: boolean;
  /** Frames per second averaged over the ring buffer. */
  fps: number;
  /** 50th / 95th / 99th percentile frame time in ms. */
  framep50: number;
  framep95: number;
  framep99: number;
  /** Mean ms spent in the simulation step. */
  sim: number;
  /** Mean ms spent in the render step. */
  render: number;
  /** Mean ms spent in "extras" (animation step, visualization step, SVG trace). */
  extra: number;
  /** Mean ms spent in the post-render "wash" phase (time-wash, fade, etc.). */
  wash: number;
  /**
   * Cells with content above threshold — what people intuitively mean by
   * "active." Added in v0.48 to disambiguate from `activeRectCells`.
   */
  activeCells: number;
  /** Bounding-box area the sim iterates over per step. */
  activeRectCells: number;
  /** Total grid cell count (GW * GH). */
  totalCells: number;
  /** `activeCells / totalCells` as a percentage (0..100). */
  activePct: number;
  /** `activeRectCells / totalCells` as a percentage (0..100). */
  activeRectPct: number;
  /** Suspended-pigment mass across the entire grid. (v0.49) */
  pigmentSuspended: number;
  /** Deposited-pigment mass across the entire grid. (v0.49) */
  pigmentDeposited: number;
  /** `pigmentSuspended + pigmentDeposited`. (v0.49) */
  pigmentTotal: number;
  /** JS heap delta in MB since perf was activated. `null` if perf.memory isn't available (non-Chromium). */
  heapDeltaMB: number | null;
  /** Long Animation Frame count if PerformanceObserver supports it; `null` otherwise. */
  longAnimationFrames: number | null;
}

// =============================================================================
// Serializable preset (state subset; not a snapshot of pigment fields)
// =============================================================================

/**
 * Serializable subset of the lib's configuration. Round-trippable via
 * `getPreset()` and `applyPreset()`. Used for "save my current settings"
 * UX — JSON-stringifiable, suitable for `localStorage` or shareable URLs.
 *
 * Does NOT capture the painted artwork (`d[]` / `g[]` arrays — that's
 * *content*, not settings), cursor state, system-dependent toggles
 * (WebGL, mobile mode), or debug instrumentation (perf overlay). For the
 * painted artwork, use the canvas as an image; `state()` returns
 * Float32Arrays which aren't JSON-suitable.
 *
 * Versioned via `version: 1`. Forward-compat: unknown fields are
 * preserved through round-trip and ignored by older readers.
 */
export interface Preset {
  /** Format version. Currently 1. */
  version?: number;
  // Brush
  pigment?: PigmentOption;
  brushSize?: number;
  pressure?: number;
  flow?: number;
  paintLoad?: number;
  waterLoad?: number;
  // Paper / sim
  paperColor?: { r: number; g: number; b: number };
  evaporation?: number;
  gouacheMode?: GouacheMode;
  edgeDarkening?: boolean;
  pauseDrying?: boolean;
  transparent?: boolean;
  continuousFlow?: boolean;
  // Fade
  fadePainting?: boolean;
  fadeHalfLifeMs?: number;
  // Animation / visualization
  animationMode?: AnimationName;
  visualizationMode?: VisualizationName;
  // Sim physics
  advectionMode?: AdvectionMode;
  // Forward-compat: unknown keys are preserved through round-trip.
  [key: string]: unknown;
}

// =============================================================================
// Constructor options
// =============================================================================

/**
 * Options passed to `Washes.create()`. All are optional — sensible defaults
 * are computed from the target element's size and the user's viewport.
 */
export interface CreateOptions {
  /** v1.10 — initial custom pigment palette (exactly 3 entries). */
  pigments?: PigmentSpec[];
  /** v1.12 — start in transparent-canvas mode (paper-thin areas show the page behind). */
  transparent?: boolean;
  /**
   * v2.3 — opaque canvas mode: the display context is created with
   * `{ alpha: false }`, so the compositor treats the layer as fully opaque
   * (no per-frame alpha blending against the page). The engine paints its
   * own `paperColor` backdrop under the pigment. Mutually exclusive with
   * `transparent`; while opaque, `transparent(true)` and `background()`
   * are refused with a console warning. Default `false`.
   */
  opaque?: boolean;
  /**
   * v1.4 — explicit host size in CSS pixels, overriding measurement. Use for
   * headless/test hosts or hosts created before layout. Without this, a host
   * that measures ~0 at create() gets the minimum grid and is rebuilt
   * automatically when it gains real size.
   */
  size?: { width: number; height: number };
  /** Pixels per simulation cell. Higher = lower-res, faster. Default = 1.75. URL `?scale=` also accepted. */
  scale?: number;
  /** Canvas DPI scale factor. Default = window.devicePixelRatio. */
  canvasScale?: number;
  /** Force mobile-mode heuristics (palm rejection, etc.). Default auto-detected via `matchMedia('(pointer: coarse)')`. */
  mobile?: boolean;
  /** v0.89 — pre-resolve the starting cell scale from a static device signal. See {@link QualityHint}. */
  qualityHint?: QualityHint;
  /** Show floating cursor preview circle. Default true on desktop. */
  cursorPreview?: boolean;
  /** Initial gouache mode. Default `false`. Pass `'auto'` for paper-darkness-driven LERP. */
  gouacheMode?: GouacheMode;
  /** Continuous flow during paint strokes. Default true. */
  continuousFlow?: boolean;
  /** Disable pointer event handling entirely. Useful for programmatic control. Default true. */
  pointer?: boolean;
  /** Initial paper color. Default = cream (≈ 0.98, 0.97, 0.92). Set later via {@link WashesInstance.paperColor}. */
  paperColor?: { r: number; g: number; b: number };
  /** Start with drying paused. Default false. Toggle later via {@link WashesInstance.drying}. */
  pauseDrying?: boolean;
  /**
   * v1.23 — seed for the instance's PRNG (mulberry32), used everywhere the
   * host draws randomness: splash epicenters and jitter, auto-paint
   * strategies, animations, paper regeneration timing. The sim core is
   * already deterministic, so two instances created with the same seed and
   * size replay identically. Folded to a uint32 (`seed >>> 0`); non-finite
   * values throw. Omit for `Math.random` (the pre-1.23 behavior).
   */
  seed?: number;
}

// =============================================================================
// Returned instance
// =============================================================================

/**
 * Most setters return `this` to support chained calls. Getters return the
 * current value. The `(v?: T)` pattern throughout — pass nothing to read,
 * pass a value to set.
 */
/** Options for {@link WashesInstance.strokeTo} / {@link WashesInstance.line}. (v1.2) */
export interface StrokeOptions {
  pigment?: PigmentOption;
  strength?: number;
  /** Dab radius in grid units (default 6). */
  radius?: number;
  /** Normalized dab radius (fraction of the smaller side); overrides `radius` in `*Norm` calls. */
  nradius?: number;
  /** Distance between dab centers in grid units (default `radius * 0.5`). */
  spacing?: number;
}

/** A 3-channel pigment reading. (v1.2) */
export interface PigmentSample {
  r: number;
  g: number;
  b: number;
}

/** Result of {@link WashesInstance.sample}. (v1.2) */
export interface SampleResult {
  x: number;
  y: number;
  /** Water amount at the cell, ~0..1. */
  wetness: number;
  /** Freeze-mask value at the cell, 0..1 (>0 = frozen). */
  mask: number;
  /** Fluid velocity at the cell. */
  velocity: { x: number; y: number };
  /** Suspended (mobile) pigment. */
  suspended: PigmentSample;
  /** Deposited (settled) pigment. */
  deposited: PigmentSample;
  /** suspended + deposited. */
  pigment: PigmentSample;
  /** 0..1 ink density (mean of pigment channels, normalized to MAX_PIGMENT). */
  density: number;
}

/** Per-frame callback for {@link WashesInstance.onFrame}. (v1.2) */
export type FrameCallback = (dtMs: number, elapsedMs: number, instance: WashesInstance) => void;

/** Unsubscribe handle returned by {@link WashesInstance.onFrame}. (v1.2) */
export type Unsubscribe = () => void;

/**
 * v1.24 — the full typed event map for {@link WashesInstance.on} /
 * {@link WashesInstance.once}: event name → detail payload. All-lowercase,
 * no exceptions (the API 2.0 casing decision). Events marked *mirror* also
 * fire as DOM CustomEvents on the host element with the same detail —
 * since 2.0.0 under exactly these lowercase names (v1 spelled two of them
 * `rescaled` / `paletteChange`; DOM events can't be shimmed by compat1,
 * so those listeners migrate by hand).
 */
export interface WashesEventMap {
  /** The sim settled (auto-idle). */
  idle: { totalWetness: number };
  /** The sim woke from idle. */
  active: Record<string, never>;
  /** Settled with essentially no wetness left; fires once per wet episode. */
  dry: { totalWetness: number };
  /** The grid was rebuilt — host remeasure, `scale()`, or a governor shift. Mirror: `rescale` (v2.0.0 — was `rescaled`). */
  rescale: { scale: number; gridWidth: number; gridHeight: number };
  /** The auto performance governor shifted resolution. */
  perflevel: { level: PerfLevel; scale: number; gridWidth: number; gridHeight: number };
  /** `palette()` changed the pigment set. Mirror: `palettechange` (v2.0.0 — was camelCase `paletteChange`). */
  palettechange: { custom: boolean };
  /** Gouache mode toggled or its auto-LERP recomputed. Mirror: `gouachechange`. */
  gouachechange: { enabled: GouacheMode; lerpAmount: number };
  /** The floating cursor preview was enabled/disabled. Mirror: `cursorpreviewchange`. */
  cursorpreviewchange: { enabled: boolean };
  /** `applyPreset()` finished. Mirror: `presetapplied`. */
  presetapplied: { preset: Preset };
  /** `dry()` force-dried the whole sheet. Mirror: `driedinstantly`. */
  driedinstantly: Record<string, never>;
  /**
   * v2.2 — fires once, on the first frame after the boot render: the paper
   * exists, the canvas has pixels, input is live. On `create()` that's the
   * first RAF tick after it returns (subscribe in the same task);
   * `createAsync()` resolves on it. Mirror: DOM `ready` on the target.
   */
  ready: Record<string, never>;
}

/** v1.4 — lifecycle event names accepted by {@link WashesInstance.on}. */
export type WashesEventName = keyof WashesEventMap;

/** v1.5 — governor levels (approximate cell count relative to base; renamed from high/medium/low in v1.8). */
export type PerfLevel = 'full' | 'half' | 'quarter';

/** v1.25 — run-state policies for {@link WashesInstance.run} (API 2.0 §2). */
export type RunPolicy = 'auto' | 'until-dry' | 'always';

/** v1.4 — report returned by {@link WashesInstance.diagnose}. */
export interface DiagnoseReport {
  renderer: 'gpu' | 'cpu';
  gridWidth: number;
  gridHeight: number;
  displayWidth: number;
  displayHeight: number;
  hostWidth: number;
  hostHeight: number;
  hostDegenerate: boolean;
  autoPerf: boolean;
  perfLevel: PerfLevel;
  isIdle: boolean;
  totalWetness: number;
}

export interface WashesInstance {
  // -----------------------------------------------------------------------
  // Direct surface access
  // -----------------------------------------------------------------------

  /** The host element passed to `Washes.create()`. */
  readonly target: HTMLElement;
  /** The `<canvas>` element the lib appended into `target`. */
  readonly canvas: HTMLCanvasElement;
  /**
   * The explicit cell-space home (API 2.0 §1) — normalized is THE space of
   * the primary names; code that genuinely thinks in grid cells lives
   * here. `width`/`height` are live read-only dims (they change on
   * rescale — don't cache).
   */
  readonly grid: {
    readonly width: number;
    readonly height: number;
    /** Paint a dab at grid coords with a grid-cell radius (v1's paintAt, exactly). */
    paint(gx: number, gy: number, gridRadius: number, pigment?: PigmentOption, strength?: number): WashesInstance;
    /** v2.1.0 — the verb family for cell-thinking pieces (v1's grid-space stir/rewet/dry/sample, exactly). */
    stir(gx: number, gy: number, vx: number, vy: number, gridRadius?: number): WashesInstance;
    /** v2.1.0 */
    rewet(gx: number, gy: number, gridRadius?: number): WashesInstance;
    /** v2.1.0 */
    dry(gx: number, gy: number, gridRadius?: number): WashesInstance;
    /** v2.1.0 */
    sample(gx: number, gy: number): SampleResult;
    toNorm(gx: number, gy: number): { nx: number; ny: number };
    fromNorm(nx: number, ny: number): { gx: number; gy: number };
    size(): { gridWidth: number; gridHeight: number };
    /** v2.0.0 — display-px → grid bridge (v1's toGrid, with honest key names). */
    fromDisplay(displayX: number, displayY: number): { gx: number; gy: number };
    /** v2.0.0 — grid → display-px bridge (v1's toClient). */
    toDisplay(gx: number, gy: number): { x: number; y: number };
  };

  // -----------------------------------------------------------------------
  // Painting input
  // -----------------------------------------------------------------------

  /**
   * Inject a splash at one or more epicenters. v2.0.0 — epicenters are
   * NORMALIZED: `x`/`y` in 0..1 across the canvas, per-point `radius` a
   * fraction of the smaller side (grid-epicenter callers live on
   * `compat1`, which keeps the v1 units exactly).
   */
  splash(epicenters: SplashEpicenterNorm[], style?: SplashStyle, opts?: SplashOptions): WashesInstance;
  /** Named preset (or nothing for `'default'`) with pigment-density-sampled random epicenters. The second argument is ignored in this form — `opts` is always positional third. */
  splash(style?: SplashStyle, ignored?: null, opts?: SplashOptions): WashesInstance;
  /** Object form: explicit coords and/or preset in one argument. */
  splash(spec: { coords?: SplashEpicenterNorm[]; preset?: SplashStyle }, ignored?: null, opts?: SplashOptions): WashesInstance;

  /** List of named splash presets (e.g. `'default'`, `'bigSplash'`, `'fineSpritz'`). */
  splashPresets(): string[];

  /** Soak the entire canvas in water — reactivates any deposited pigment. */
  rewet(): WashesInstance;
  /** Re-wet a circular region (normalized coords; `nradius` a fraction of the smaller side, default 0.03); lifts deposited pigment back into suspension. */
  rewet(nx: number, ny: number, nradius?: number): WashesInstance;

  /** Force-evaporate all wetness. Pigment stays where it is. */
  dry(): WashesInstance;
  /** Dry a circular region (normalized coords); settles suspended → deposited and zeroes the fluid. */
  dry(nx: number, ny: number, nradius?: number): WashesInstance;

  /** Clear the canvas and reset all sim fields to defaults. */
  reset(): WashesInstance;

  /**
   * Paint a dab at normalized coordinates: `nx`/`ny` in 0..1 across the
   * canvas, `nradius` as a fraction of the smaller side (default 0.03).
   * `pigment` defaults to the current brush ink, `strength` to 0.5.
   * (v2.0.0 — this is the one paint verb; grid cells live in
   * {@link WashesInstance.grid}.paint.)
   */
  paint(nx: number, ny: number, nradius?: number, pigment?: PigmentOption, strength?: number): WashesInstance;

  /**
   * Inject velocity into the fluid within a radius, wetting the region so
   * the velocity actually transports pigment — motion / gesture input can
   * *stir* an existing wash. Normalized coords; `nradius` a fraction of
   * the smaller side (default 0.03); `vx`/`vy` pass through unchanged.
   */
  stir(nx: number, ny: number, vx: number, vy: number, nradius?: number): WashesInstance;

  /**
   * Continuous stroke: lays overlapping dabs from the previous point to
   * (`nx`,`ny`), so callers don't hand-roll the interpolation. The first
   * call after {@link WashesInstance.penUp}, {@link WashesInstance.reset}
   * or {@link WashesInstance.clearPaint} just stamps the start point.
   * `opts.nradius` overrides `opts.radius`. (v2.0.0 — was strokeToNorm.)
   */
  stroke(nx: number, ny: number, opts?: StrokeOptions): WashesInstance;
  /** One-call line segment between two normalized points. */
  line(nx0: number, ny0: number, nx1: number, ny1: number, opts?: StrokeOptions): WashesInstance;
  /** Lift the stroke pen so the next {@link WashesInstance.strokeTo} starts a fresh line. (v1.2) */
  penUp(): WashesInstance;

  /**
   * Clear pigment, wetness and motion but KEEP configuration and the freeze
   * mask — the regenerating-loop counterpart to {@link WashesInstance.reset}
   * (which also wipes the mask). (v1.2)
   */
  clearPaint(): WashesInstance;

  /**
   * Register a per-frame callback, invoked after each simulated/rendered frame
   * with `(dtMs, elapsedMs, instance)`. Returns an unsubscribe function.
   * Callbacks are wrapped so a throw won't kill the render loop. (v1.2)
   */
  onFrame(cb: FrameCallback): Unsubscribe;

  /** Read the simulation state at a normalized point. (v2.0.0 — was sampleNorm; the cell under any grid coordinate is reachable via grid.toNorm.) */
  sample(nx: number, ny: number): SampleResult;
  /** Fraction (0..1) of cells whose ink density exceeds `threshold` (default 0.04). (v1.2) */
  coverage(threshold?: number): number;

  /** Stamp text using the active brush. */
  /** Stamp text as wet pigment. Returns the number of stamps painted (synchronous). */
  paintText(text: string, opts?: PaintTextOptions): number;

  /**
   * Stamp a raster image as a watercolor reproduction — each sampled pixel
   * decomposes into a rose+yellow+blue mix (subtractive color theory, same
   * as traceSVG's `approximateColor`). Resolves to the number of stamps
   * painted (0 for a tainted canvas or undecodable source). (v0.49; v2.1.1
   * corrects this declaration — it said `Promise<void>` and omitted
   * File/Blob sources.)
   */
  paintImage(source: string | HTMLImageElement | Blob, opts?: PaintImageOptions): Promise<number>;

  /** Trace an SVG, drawing each path with the active brush over time. Returns the total point count synchronously (0 when nothing parsed); the animation itself runs over subsequent frames unless `instant`/`animate: false`. */
  traceSVG(svgText: string, opts?: TraceSVGOptions): number;
  /** Cancel any in-flight SVG trace. */
  cancelSVGTrace(): WashesInstance;

  // -----------------------------------------------------------------------
  // Brush state
  // -----------------------------------------------------------------------

  /**
   * Brush size as a fraction of the smaller display side — the radius
   * convention every other v2 radius uses. (v2.0.0 — v1 spoke display-px
   * DIAMETER; that channel lives on compat1, and {@link
   * WashesInstance.displayRect} bridges for hosts doing DOM math.)
   */
  brushSize(): number;
  brushSize(fraction: number): WashesInstance;

  /**
   * Active pigment (or named brush) for subsequent paint operations.
   *
   * - Called with no arg → returns the current pigment.
   * - Called with a pigment → sets it and returns the instance (chainable).
   */
  pigment(): PigmentOption;
  pigment(v: PigmentOption): WashesInstance;

  /** Read-only list of available pigment indices. */
  pigments(): PigmentIndex[];

  /** Paint load: how much pigment is delivered per stamp. 0..1. Getter with no arg; chains when set. */
  paintLoad(): number;
  paintLoad(v: number): WashesInstance;

  /** Water load: how much water is delivered per stamp. 0..1. Getter with no arg; chains when set. */
  waterLoad(): number;
  waterLoad(v: number): WashesInstance;

  /** Brush pressure: epicenter intensity multiplier. */
  pressure(): number;
  pressure(v: number): WashesInstance;

  /** Flow rate: how quickly pigment spreads after stamping. */
  flow(): number;
  flow(v: number): WashesInstance;

  /** Use pointer pressure (stylus) to modulate flow. Default true if supported. */
  usePointerPressure(): boolean;
  usePointerPressure(v: boolean): WashesInstance;

  /** Whether dragging produces continuous flow or per-stamp dots. Default true. */
  continuousFlow(): boolean;
  continuousFlow(v: boolean): WashesInstance;

  // -----------------------------------------------------------------------
  // Paper state
  // -----------------------------------------------------------------------

  /** Set paper wetness preset (changes evaporation rate among other things). */
  paperWetness(): string | null;
  paperWetness(preset: string): WashesInstance;
  /** List available wetness presets. */
  paperWetnessPresets(): string[];

  /** Direct evaporation rate. Higher = wash dries faster. */
  evaporation(): number;
  evaporation(value: number): WashesInstance;

  /**
   * v1.25 — `pauseDrying` renamed to say what it does (API 2.0 §2):
   * `drying(false)` pauses evaporation/drying, `drying(true)` resumes it,
   * zero-arg reads whether drying is running. Chains (the v2 setter
   * convention). `pauseDrying` lives on compat1 since 2.0.
   */
  drying(): boolean;
  drying(v: boolean): WashesInstance;

  /**
   * v1.25 — ONE run-state policy (API 2.0 §2), replacing the
   * `keepSimulating`/`runUntilDry` pair (both on compat1 since 2.0;
   * `pause()` stays the one true freeze). `'auto'` idles when settled
   * (the default), `'until-dry'` steps until bone dry then idles,
   * `'always'` never idles. Writes the same internal flags as the v1
   * controls, so the two surfaces cannot disagree.
   */
  run(): RunPolicy;
  run(policy: RunPolicy): WashesInstance;

  /**
   * v1.4 — subscribe to lifecycle events. Returns an unsubscribe function.
   * v1.24 — fully typed via {@link WashesEventMap}, which also gained the
   * events that previously fired only as DOM CustomEvents.
   */
  on<K extends WashesEventName>(name: K, cb: (detail: WashesEventMap[K]) => void): Unsubscribe;

  /**
   * v1.24 — Promise form of {@link WashesInstance.on} for one-shot
   * listening: resolves with the detail of the next `name` event, then
   * unsubscribes. Never rejects — an event that never fires is a promise
   * that never settles.
   */
  once<K extends WashesEventName>(name: K): Promise<WashesEventMap[K]>;

  /**
   * v1.5 — auto performance throttler. When enabled, the engine watches
   * frame cost while the sim is active and shifts grid resolution between
   * three levels, PRESERVING the painting across every shift (fields are
   * resampled, not wiped). Downshift is interval-driven (sustained >~26ms rAF gaps = missed vsync,
   * 3s cooldown); upshift is BUSY-TIME driven (sustained <~9ms of actual
   * work per frame, 5s cooldown) — rAF intervals are vsync-pinned on
   * healthy displays, so they cannot signal headroom. While the sim is
   * IDLE at a reduced level, the governor climbs back toward full on a
   * ~1s dwell per step (v1.9.1) — idle is the cheapest time to restore
   * resolution, and the next stroke simply re-downshifts if it must. Disabling restores the
   * original resolution, also preserving. Listen via on('perflevel').
   */
  autoPerf(): boolean;
  autoPerf(v: boolean): WashesInstance;

  /** v1.5 — current governor level. */
  perfLevel(): PerfLevel;

  /**
   * v1.4 — rebuild the grid at the host's current size. v2.0.0 —
   * PRESERVES the painting (resampled into the new grid) unless
   * `{ wipe: true }`; chains. (v1 always wiped — that behavior lives on
   * compat1.)
   */
  remeasure(opts?: { wipe?: boolean }): WashesInstance;

  /** v1.4 — one-call health report for "why is my canvas blank". */
  diagnose(): DiagnoseReport;

  /**
   * v1.4 — watercolor verbs. Dried pigment is immobile until *lifted* back
   * into suspension; *flood* soaks the whole sheet; *blot* dabs water and
   * floating pigment away; *pour* tips the basin (gravity + open edges) and
   * endPour() restores what it changed. v2.0.0 — lift/blot take normalized
   * 0..1 coords and a radius as a fraction of the smaller side (default
   * 0.03), like every other verb.
   */
  lift(nx: number, ny: number, nradius?: number, fraction?: number): this;
  flood(level?: number): this;
  blot(nx: number, ny: number, nradius?: number, strength?: number): this;
  pour(dx: number, dy: number, strength?: number): this;
  endPour(): this;

  // ─── GPU sim integration ───────────────────────────────────────────
  /**
   * Get the WebGL2 context + grid dimensions the lib uses for its
   * render canvas, suitable for handing to `initGpuSim` from the
   * `washes/gpu-sim` subpath. Returns `null` if WebGL2 is unavailable
   * on this device.
   */
  gpuSimContext(): { gl: WebGL2RenderingContext; GW: number; GH: number } | null;

  /**
   * Activate GPU-backed simulation. Pass a handle returned by
   * {@link initGpuSim} from the `washes/gpu-sim` module. After this
   * call, every `paintAt`, `splash`, `rewet`, etc. routes through
   * the GPU sim instead of the CPU loop. Pass `null` to disable
   * and revert to CPU sim.
   *
   * Typical usage:
   * ```ts
   * import { initGpuSim } from 'washes/gpu-sim';
   * const ctx = wc.gpuSimContext();
   * if (ctx) {
   *   const handle = initGpuSim(ctx.gl, ctx.GW, ctx.GH);
   *   wc.gpuSim(handle);
   *   wc.webgl(true);
   * }
   * ```
   */
  gpuSim(handle: object | null): WashesInstance;

  /** Read the current paper color (0..1 RGB). */
  paperColor(): { r: number; g: number; b: number };
  /**
   * Set paper color from a CSS/hex string: `'#fdf3ee'`, `'#fff'`,
   * `'rgb(253,243,238)'`, or a named color where a DOM is available.
   * Throws on an unparseable string (no more silent black). (v1.1)
   */
  paperColor(css: string): WashesInstance;
  /** Set paper color in 0..1 RGB. Throws on non-finite values. (v1.1) */
  paperColor(r: number, g: number, b: number): WashesInstance;

  /** Read the current rainbow brush color (for hover-state UI). */
  rainbowColor(): { r: number; g: number; b: number };

  // -----------------------------------------------------------------------
  // Edge boundaries (v0.81-v0.88)
  // -----------------------------------------------------------------------

  /** Edge boundary mode: closed, closed-gravity, open, or gravity. */
  edgeMode(): EdgeMode;
  edgeMode(v: EdgeMode): WashesInstance;

  /** Read gravity direction (a compass name, or `{x,y}` if an angle/vector was set). */
  gravityDirection(): GravityDirection | { x: number; y: number };
  /**
   * Set gravity direction. Accepts a compass name, an **angle in degrees**
   * (0 = right, 90 = down), or an `{x, y}` **vector** (normalized internally)
   * for arbitrary-direction gravity. (v1.1)
   */
  gravityDirection(v: GravityDirection | number | { x: number; y: number }): WashesInstance;

  /** Read the current gravity vector (or null). */
  gravityVector(): { x: number; y: number } | null;
  /** Set an arbitrary gravity vector (normalized internally). Pair with {@link WashesInstance.gravityStrength}. (v1.1) */
  gravityVector(x: number, y: number): WashesInstance;

  /** Read gravity bias strength. */
  gravityStrength(): number;
  /**
   * Set gravity bias strength. 0 = no pull; ~0.10 = strong tilt; ~1.0 = max.
   * A positive value now "just works": in the default closed-edge mode it
   * auto-promotes to `closed-gravity` so the bias applies. (v1.1)
   */
  gravityStrength(v: number): WashesInstance;

  /**
   * Smoothstep alpha falloff in the last N grid cells at each edge.
   * 0 disables. Independent of edge mode — composes with any of them.
   *
   * Primary use case: pair with `'closed-gravity'` mode to get gravity
   * dynamics without the visible edge buildup that closed-mode would
   * otherwise show. The pigment is still mathematically present at the
   * edge; the render just makes it transparent. (v0.88)
   */
  edgeFade(): number;
  edgeFade(v: number): WashesInstance;

  /**
   * Per-cell velocity magnitude cap. Auto-computed from `scale` by default
   * (so display speed is resolution-invariant). Pass `null` to restore the
   * auto-computed default.
   *
   * Note: values above ~1.7 require semi-Lagrangian advection mode; donor-
   * cell modes will produce the cardinal-cross artifact above that bound.
   */
  velocityClamp(): number;
  velocityClamp(v: number | null): WashesInstance;

  // -----------------------------------------------------------------------
  // Rendering / display
  // -----------------------------------------------------------------------

  /** Toggle gouache rendering mode. */
  /**
   * v1.10 — redefine the three working pigments. Each entry is a color
   * (hex/CSS, K/S derived) or explicit { K, S }. `palette(null)` restores
   * the stock palette; `palette()` returns the current resolved records.
   * The 3-channel simulation is unchanged — indices 0/1/2 and the names
   * rose/yellow/blue now map to your inks. Forces a full recomposite; not a
   * per-frame call.
   */
  palette(list: PigmentSpec[] | null): WashesInstance;
  palette(): PigmentRecord[];
  // (overloads: pass a list/null to set → instance; call empty to read → records)

  gouacheMode(): GouacheMode;
  gouacheMode(v: GouacheMode): WashesInstance;
  /** Current LERP amount in 'auto' gouache mode. 0 = full watercolor, 1 = full gouache. */
  gouacheLerpAmount(): number;

  /** Advection scheme. */
  advectionMode(): AdvectionMode;
  advectionMode(v: AdvectionMode): WashesInstance;
  /** Substeps used by the most recent movePigment call. */
  advectionLastSubsteps(): number;

  /** Whether edge darkening is applied. Default true. */
  edgeDarkening(): boolean;
  edgeDarkening(v: boolean): WashesInstance;

  /** Show the amber tint over masked cells. Default true. */
  maskTint(): boolean;
  maskTint(v: boolean): WashesInstance;

  /**
   * Wetness heatmap overlay. Visualizes the per-cell wet field as a
   * two-color gradient on top of the painting. Cells below mask
   * threshold render transparent so dry areas show through unchanged.
   * Colors accept `'#rgb'`, `'#rrggbb'`, or `[r, g, b]` 0..255 arrays. (v0.86)
   *
   * - `wetnessHeatmap()` — returns current enabled state.
   * - `wetnessHeatmap(true)` / `wetnessHeatmap(false)` — toggle.
   * - `wetnessHeatmap(true, '#fcf3a7', '#296fa7')` — toggle + recolor.
   * - `wetnessHeatmap({ enabled: true, low: '#abc', high: '#def' })` — object form.
   */
  wetnessHeatmap(): boolean;
  wetnessHeatmap(enabled: boolean, low?: HeatmapColor, high?: HeatmapColor): WashesInstance;
  wetnessHeatmap(opts: WetnessHeatmapOptions): WashesInstance;

  /** Toggle WebGL rendering. Falls back to CPU if WebGL2 isn't supported. */
  webgl(): boolean;
  webgl(v: boolean): WashesInstance;
  /** Whether WebGL2 was available at init. */
  webglAvailable(): boolean;
  /**
   * GPU/WebGL isolation toggles (debug tier). Each renders or simulates a
   * single stage in isolation so browser QA can pinpoint which GPU pass
   * diverges from the CPU reference; all are plain boolean getter/setters
   * and no-ops until the corresponding GPU path is enabled.
   */
  webglSmokeTest(): boolean;
  webglSmokeTest(v: boolean): WashesInstance;
  webglGpuTextureTest(): boolean;
  webglGpuTextureTest(v: boolean): WashesInstance;
  webglGpuWetTextureTest(): boolean;
  webglGpuWetTextureTest(v: boolean): WashesInstance;
  webglGpuVelocityTextureTest(): boolean;
  webglGpuVelocityTextureTest(v: boolean): WashesInstance;
  gpuSimBrushOnlyTest(): boolean;
  gpuSimBrushOnlyTest(v: boolean): WashesInstance;
  gpuSimAdvectionOnlyTest(): boolean;
  gpuSimAdvectionOnlyTest(v: boolean): WashesInstance;
  gpuSimVelocityOnlyTest(): boolean;
  gpuSimVelocityOnlyTest(v: boolean): WashesInstance;
  gpuSimWetDiffusionOnlyTest(): boolean;
  gpuSimWetDiffusionOnlyTest(v: boolean): WashesInstance;
  gpuSimTransferOnlyTest(): boolean;
  gpuSimTransferOnlyTest(v: boolean): WashesInstance;
  /** Debug: tint visible cells green so you can see the active region. */
  webglDebugTint(): boolean;
  webglDebugTint(v: boolean): WashesInstance;

  /** Background transparent (canvas paper rendered transparent). */
  transparent(): boolean;
  transparent(v: boolean): WashesInstance;

  /**
   * Host-element CSS background. Accepts any valid CSS background value:
   * a solid color, `linear-gradient(...)`, `radial-gradient(...)`,
   * `url(...)`, or any combination. Auto-enables transparent canvas mode
   * so the background shows through pigment-less areas. Pass `null` or
   * `''` to clear. (v0.89)
   *
   * The painting itself is unaffected — pigment is still composited via
   * Kubelka-Munk against the lib's internal paper color. The background
   * only shows in regions where alpha is below the full-opacity threshold.
   */
  background(): string;
  background(value: string | null): WashesInstance;

  /** Read whether per-frame fade is enabled. */
  fadePainting(): boolean;
  /**
   * Enable/disable per-frame fade. `true`/`false` toggles; a **positive number**
   * enables fade AND sets its half-life in ms; `0` disables. (v1.1)
   */
  fadePainting(v: boolean | number): WashesInstance;
  /** Half-life of the fade-out (ms). */
  fadeHalfLife(): number;
  fadeHalfLife(ms: number): WashesInstance;
  /** Auto-fade the background between strokes. */
  autoDryBackground(): boolean;
  autoDryBackground(v: boolean): WashesInstance;

  /** Canvas resolution: display pixels per sim cell. Triggers a rescale event. */
  /** v2.0.0 — PRESERVES the painting (resampled into the new grid) unless { wipe: true }. (v1 wiped unless { preserve: true } — that behavior lives on compat1.) */
  scale(): number;
  scale(v: number, opts?: { wipe?: boolean }): WashesInstance;
  /** Canvas DPI scale factor. */
  canvasScale(): number;
  canvasScale(v: number): WashesInstance;

  /**
   * Quality preset — bundles `scale`, `advectionMode`, and a couple of
   * feature toggles. Calling with no arg returns the most-recently-applied
   * preset name, or `null` if `quality()` has never been called. (v0.89)
   *
   * v1.6 — `quality('auto')` hands the knob to the {@link autoPerf}
   * governor: resolution shifts between levels under load, preserving the
   * painting. Any manual preset takes control back (disabling the governor
   * first). The getter reports 'auto' whenever the governor is enabled,
   * however it was turned on.
   *
   * - `'high'` — scale 1.5, semi-Lagrangian advection. Best on desktop.
   * - `'medium'` — scale 2.0, semi-Lagrangian. Library default-ish.
   * - `'low'` — scale 2.75, semi-Lagrangian, heatmap forced off.
   * - `'minimum'` — scale 3.5, donor-cell advection, no heatmap, no cursor.
   *   WARNING: brings back the cardinal-cross artifact (donor-cell mode);
   *   only use when frame budget is genuinely critical.
   *
   * Triggers a rescale + reallocation — expect a frame-or-two pause.
   * Doesn't touch settings outside the preset's scope (gravity, edge mode,
   * mask state, etc.).
   */
  quality(): QualityPreset | null;
  quality(preset: QualityPreset): WashesInstance;

  /**
   * The live CSS rectangle of the display canvas — exactly the space
   * {@link WashesInstance.maskRect} coordinates are measured against, plus
   * the device pixel ratio. Saves reaching into the DOM. (v1.1)
   */
  displayRect(): { x: number; y: number; width: number; height: number; dpr: number };

  // -----------------------------------------------------------------------
  // Mask
  // -----------------------------------------------------------------------

  /** Clear the freeze mask. */
  removeMask(): WashesInstance;

  /**
   * Freeze cells inside a rounded rectangle: `nx, ny, nw, nh` in 0..1
   * across the canvas; `radii` follows the `roundRect()` spec (a number
   * for uniform corners or an array). Frozen cells ignore paint, flow and
   * drying until unmasked. (v2.0.0 — was maskNorm; the display-px
   * maskRect/unmaskRect pair lives on compat1.)
   */
  mask(nx: number, ny: number, nw: number, nh: number, radii?: number | number[]): WashesInstance;
  /** Inverse of {@link WashesInstance.mask}: clears mask cells inside the rectangle. */
  unmask(nx: number, ny: number, nw: number, nh: number, radii?: number | number[]): WashesInstance;

  /**
   * v1.11 — freeze cells inside an SVG path. `d` is path data; coordinates are
   * a 0..1 viewBox mapped to the grid by default (resolution-independent).
   * opts.viewBox=[w,h] uses your own units; opts.grid=true treats d as grid
   * cells; opts.invert flips inside/outside. Even-odd fill.
   */
  maskPath(d: string, opts?: { viewBox?: [number, number]; grid?: boolean; invert?: boolean }): WashesInstance;
  /**
   * v1.11 — freeze cells where an already-loaded image is opaque (alpha ≥
   * threshold, default 0.5). src is any drawImage-able source; URL/File
   * loading is the host's responsibility. opts.invert flips.
   */
  maskImage(src: CanvasImageSource, opts?: { threshold?: number; invert?: boolean }): WashesInstance;
  /** v1.11 — flip every cell's masked state. */
  maskInvert(): WashesInstance;

  // -----------------------------------------------------------------------
  // Brush modes (v0.98)
  // -----------------------------------------------------------------------

  /**
   * First-class brush behavior alongside pigment selection. Composes with
   * K-M pigments (rose/yellow/blue) — ink/water/lift/mask/paper brushes
   * ignore it. `'dry'` is a legacy alias for `'crayon'`.
   */
  brushMode(): BrushMode;
  brushMode(v: BrushMode): WashesInstance;

  /**
   * Composite "dryness" slider. 0..1. Drives the per-knob defaults below
   * unless they're set individually.
   */
  dryness(): number;
  dryness(v: number): WashesInstance;

  /** Paper-tooth rejection strength. 0..1. Default 0.65. */
  dryPaperReject(): number;
  dryPaperReject(v: number): WashesInstance;
  /** Motion-direction streak strength. 0..1. Default 0.6. */
  dryAnisotropy(): number;
  dryAnisotropy(v: number): WashesInstance;
  /** Fine random per-cell skip variance. 0..1. Default 0.5. */
  dryBrushSkip(): number;
  dryBrushSkip(v: number): WashesInstance;

  // -----------------------------------------------------------------------
  // Composition modes
  // -----------------------------------------------------------------------

  /**
   * Apply a bundle of brush + paper settings tuned for crisp fine-line
   * drawings (felt-tip pen aesthetic). Pure setter — no separate mode
   * flag. Any settings can be overridden afterward via the individual
   * setter methods. Chainable: `wc.sketchMode().traceSVG(svg)`. (v0.30)
   */
  sketchMode(opts?: SketchModeOptions): WashesInstance;

  /**
   * Visually destroy the current drawing. Three modes:
   *
   * - `'water'` — splash water onto the canvas, lifting all deposited
   *   pigment back into suspension. Best for "rinse" feel.
   * - `'pigment'` — paint several large opaque dabs over the sketch in
   *   the configured color. Best for "cover up" feel.
   * - `'paper'` — paint several large dabs with the paper brush,
   *   clearing the sketch back to paper color. Best for "erase" feel. (v0.32)
   *
   * Returns a Promise that resolves after `opts.durationMs` (default 500).
   * (v0.30)
   */
  obliterate(opts?: ObliterateOptions): Promise<void>;

  // -----------------------------------------------------------------------
  // Background animation / visualization
  // -----------------------------------------------------------------------

  /**
   * v2.0.0 — the time-driven ambient background wash, as a getter/setter
   * pair (was setBackground; it couldn't unify into `background(v?)` —
   * that name means the CSS backdrop). The getter returns the running
   * wash's name, or `null` when idle.
   */
  backgroundAnimation(): string | null;
  backgroundAnimation(name: string): WashesInstance;
  /** Whether a background wash is still running (they end on their own). */
  backgroundAnimationRunning(): boolean;

  /** Animation mode (breathe, drift, pulse, etc.). Pass `null` to stop. (v2.0.0 — was setAnimation/getAnimation.) */
  animation(): AnimationName;
  animation(name: AnimationName | null, opts?: AnimationOptions): WashesInstance;

  /** Debug visualization (velocity vectors, pressure heat, etc.). Pass `null` to stop. (v2.0.0 — was setVisualization/getVisualization.) */
  visualization(): VisualizationName;
  visualization(name: VisualizationName | null, opts?: VisualizationOptions): WashesInstance;

  // -----------------------------------------------------------------------
  // Mobile / input
  // -----------------------------------------------------------------------

  /** Force mobile-mode heuristics. */
  mobile(): boolean;
  mobile(v: boolean): WashesInstance;
  /** Was mobile auto-detected at init? */
  mobileDetected(): boolean;

  /** Show floating cursor preview circle. */
  cursorPreview(): boolean;
  cursorPreview(v: boolean): WashesInstance;

  // -----------------------------------------------------------------------
  // Performance
  // -----------------------------------------------------------------------

  /** Start/stop perf instrumentation. */
  perf(): boolean;
  perf(v: boolean): WashesInstance;
  /** Current perf snapshot. */
  perfMetrics(): PerfMetrics;

  // -----------------------------------------------------------------------
  // UI helpers
  // -----------------------------------------------------------------------

  /** Build pigment swatch DOM elements into the given root. */
  buildPigmentSwatches(rootEl: HTMLElement): void;

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /**
   * Export the current canvas. By default returns a data URL string;
   * pass `asBlob: true` to receive a `Promise<Blob>` instead (more
   * reliable for large canvases where data URLs may exceed browser
   * limits).
   *
   * When `transparent` is omitted, defaults to the current `transparent()`
   * setting. When `transparent: false` (or unspecified and the canvas
   * isn't transparent), the lib composites the paper color underneath
   * before encoding so the resulting image is self-contained.
   */
  /**
   * Export the current canvas. By default returns a data URL string; pass
   * `asBlob: true` for a `Promise<Blob>` (more reliable for large
   * canvases). `mimeType`/`quality` select the encoder — it does JPEG
   * too, which is why 2.0 renamed v1's `exportPNG` (on compat1) to this.
   */
  exportImage(opts: { asBlob: true; transparent?: boolean; mimeType?: string; quality?: number }): Promise<Blob>;
  exportImage(opts?: {
    /** Force transparent background. Default: follows `transparent()` setting. */
    transparent?: boolean;
    /** Return `Promise<Blob>` instead of a data URL string. (v0.64) */
    asBlob?: boolean;
    /** MIME type. Default `'image/png'`. */
    mimeType?: string;
    /** Encoder quality, 0..1, for lossy formats like `'image/jpeg'`. */
    quality?: number;
  }): string;

  // -----------------------------------------------------------------------
  // Preset / state
  // -----------------------------------------------------------------------

  /** Serializable subset of the current configuration. */
  getPreset(): Preset;
  /** Apply a previously-saved preset. */
  applyPreset(preset: Preset): WashesInstance;

  /**
   * v1.22 — snapshot the PAINTING itself (fluid, pigment, deposit, paper as
   * interleaved Float32Arrays; the same SimStateArrays codec the GPU and
   * worker seams use). Round-trips bit-exactly through loadState().
   * Settings are a separate concern — pair with getPreset() for a full
   * document. IndexedDB stores the arrays natively; postMessage transfers
   * them; string encodings are the host's business.
   */
  saveState(): WashesStateSnapshot;
  /**
   * v1.22 — restore a saveState() snapshot. Grid dims must match the live
   * instance (throws otherwise — resample-on-load is future work). Rebuilds
   * mask bookkeeping, wakes the sim, resyncs the GPU path when active.
   */
  loadState(snapshot: WashesStateSnapshot): WashesInstance;

  /**
   * Lightweight state snapshot for debugging or UI display. NOT a full
   * serialization — use `getPreset()` for settings round-trip and the
   * canvas image for content.
   */
  state(): {
    /** v1.5 — whether the auto performance governor is enabled. */
    autoPerf: boolean;
    /** v1.5 — current governor level. */
    perfLevel: PerfLevel;
    /** v1.4 — true when the sim has settled and stopped stepping. */
    isIdle: boolean;
    /** v1.4 — sum of cell wetness (maintained at idle checks). */
    totalWetness: number;
    /** v1.4 — sum of suspended pigment across channels. */
    totalSuspended: number;
    gridWidth: number;
    gridHeight: number;
    displayWidth: number;
    displayHeight: number;
    brushSize: number;
    pigment: number;
    canvasScale: number;
    animationMode: AnimationName;
    visualizationMode: VisualizationName;
    backgroundRunning: boolean;
    edgeDarkening: boolean;
    fadePainting: boolean;
    pauseDrying: boolean;
    gouacheMode: GouacheMode;
  };

  // -----------------------------------------------------------------------
  // Pause / resume (v0.90)
  // -----------------------------------------------------------------------

  /**
   * Freeze the simulation. Stops sim step, fade, time-wash, and animation
   * steps. The rAF loop continues so input can still produce renders
   * (when `acceptInput` is true) and so `resume()` takes effect on the
   * next frame.
   *
   * Pointer events are ignored when paused without `acceptInput`. With
   * `acceptInput: true`, the user (or programmatic calls to `splash` /
   * `paintAt` / `traceSVG`) can deposit new pigment; each deposit
   * triggers a one-shot render so the user sees their stroke immediately,
   * but the deposit sits inert until `resume()`.
   */
  pause(opts?: PauseOptions): WashesInstance;

  /**
   * Resume from pause. Adjusts wall-clock timers for in-flight animations
   * (e.g. SVG traces) so easing continues from where it was rather than
   * jumping ahead by the pause duration.
   */
  resume(): WashesInstance;

  /**
   * Pause state inspector. Returns `false` when running; otherwise
   * `{ acceptInput }`. Designed so callers can write both
   * `if (wc.paused()) …` and `wc.paused()?.acceptInput`.
   */
  paused(): PausedState;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Tear down event listeners and free resources. */
  destroy(): void;
}

// =============================================================================
// Static API
// =============================================================================

/**
 * The Washes constructor namespace, as imported from `'washes'` or as the
 * `window.Washes` / `window.Watercolor` global. The lib doesn't expose a
 * `class Washes`; instead it exposes a `create()` factory function on
 * this object.
 *
 * `Watercolor` is the long-standing internal name; `Washes` is the
 * user-facing brand alias added in v0.53. Both globals refer to the same
 * factory.
 */
/**
 * v2.0.0 — what {@link WashesStatic.compat1} returns: the complete v1
 * surface (143 members) over the same instance. Deliberately loose — the
 * authoritative member list is `tests/v1-surface.snapshot.json`, enforced
 * by the compat reflection test. Write NEW code against
 * {@link WashesInstance}; this type exists so old call sites keep
 * compiling while they migrate.
 */
export interface WashesV1Compat {
  [member: string]: any;
}

export interface WashesStatic {
  /**
   * Create a Washes instance attached to the given DOM element. The element
   * is treated as a host: a canvas is appended into it and sized to fill.
   *
   * @example
   * import { Washes } from 'washes';
   * const wc = Washes.create(document.getElementById('app')!, {
   *   gouacheMode: 'auto',
   * });
   * wc.splash([{ x: 200, y: 200, velocity: 40 }], 'deluge');
   *
   * // v0.98 brush modes compose with K-M pigments:
   * wc.pigment('blue').brushMode('crayon').dryness(0.8);
   */
  create(target: HTMLElement, options?: CreateOptions): WashesInstance;

  /**
   * v1.4 — headless instance for tests/CI: fixed size, CPU renderer, no
   * pointer wiring, detached host. Defaults to 480x360.
   *
   * v1.15 — runs in BARE Node: when no `document` exists, a minimal
   * internal environment is installed on globalThis first (only in that
   * case — browsers and jsdom-style embedders are untouched). No shim
   * required by the caller anymore.
   */
  createHeadless(options?: CreateOptions & { width?: number; height?: number }): WashesInstance;

  /**
   * v2.2 — the loader. `create()` is synchronous — paper generation is ~80%
   * of its cost, and at hero sizes it blocks the host page long enough
   * (~1s at 1080p) that nothing a host shows can even paint. createAsync
   * yields a frame first (so a veil can paint), generates the paper in
   * time-sliced chunks (bit-identical rows), and resolves after the first
   * rendered frame. A built-in paper-toned veil covers the target until
   * ready; pass `loader: false` to bring your own and listen for the
   * `'ready'` event instead. Browser-oriented — it needs a ticking
   * `requestAnimationFrame` (`createHeadless` stays synchronous for tests).
   */
  createAsync(targetEl: HTMLElement, options?: CreateOptions & { loader?: boolean }): Promise<WashesInstance>;

  /**
   * v2.0.0 — wrap a v2 instance in the complete v1 surface: old names,
   * old units (grid/px coordinates, px brush diameters), value-returning
   * setters. Every call runs the exact v1 code path, so behavior is
   * bit-identical to 1.x. Warns once per v1-only member name with its
   * migration hint (`{ warn: false }` silences). Lives until 3.0.
   */
  compat1(instance: WashesInstance, opts?: { warn?: boolean }): WashesV1Compat;

  /** v1.4 — the public surface tiered: start at core; tuning has defaults; debug diagnoses. */
  readonly tiers: Record<'core' | 'tuning' | 'debug', (keyof WashesInstance)[]>;

  /** The valid brush-mode names, available without an instance. (v1.2) */
  readonly brushModes: BrushMode[];

  /**
   * Runtime version string, e.g. `'0.98.0'`. Useful as a console
   * sanity check after loading the file — if your demo errors out
   * with "wc.someV098Method is not a function", confirm
   * `Washes.version` first; if it's not what you expect, the browser
   * is loading an older cached or co-located copy of the lib.
   */
  readonly version: string;
}

/** Default export: the WashesStatic namespace. */
declare const Washes: WashesStatic;
/** Long-standing alias for {@link Washes}. Same factory, different name. */
declare const Watercolor: WashesStatic;
export { Washes, Watercolor };
export default Washes;

// =============================================================================
// Global augmentation — the lib attaches both `window.Washes` and
// `window.Watercolor` for use in no-bundler / classic-script contexts.
// TypeScript users who pull the lib via a script tag rather than `import`
// can rely on these globals.
// =============================================================================

declare global {
  interface Window {
    Washes: WashesStatic;
    Watercolor: WashesStatic;
  }
}
