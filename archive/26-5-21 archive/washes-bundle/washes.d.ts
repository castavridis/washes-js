// washes.d.ts
//
// TypeScript declarations for the Washes watercolor simulation library.
//
// The runtime is plain JavaScript (no compilation step). These declarations
// describe the public API surface as it exists at the JS level. Internal
// helpers, debug methods (`_debug_*`), and private state are intentionally
// omitted.
//
// Authored against lib v0.85. When the lib adds new public methods, add
// them here. Methods removed from the lib should be removed here too —
// keep this file in sync with the actual API.

// =============================================================================
// Core types
// =============================================================================

/** Pigment slot index. 0 = quinacridone rose, 1 = hansa yellow, 2 = cerulean blue. */
export type PigmentIndex = 0 | 1 | 2;

/**
 * Named brushes that aren't tied to a pigment slot.
 *
 * - `'water'`: clear water; reactivates dry pigment and helps it spread.
 * - `'lift'`: removes pigment from cells it touches.
 * - `'rainbow'`: time-varying rainbow color from a phase-shifted palette.
 * - `'mask'`: paints into the freeze-mask layer (cells that flow skips).
 */
export type NamedBrush = 'water' | 'lift' | 'rainbow' | 'mask';

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
 * - `'closed'`: walls reflect (mass conserved).
 * - `'open'`: all edges drain; no ambient bias.
 * - `'gravity'`: edges open in the direction of gravity, with active bias.
 */
export type EdgeMode = 'closed' | 'open' | 'gravity';

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

// =============================================================================
// Splash / brush input shapes
// =============================================================================

/**
 * One epicenter for a splash. Coordinates are in display pixels relative to
 * the canvas host element. Velocity controls outward radial speed.
 */
export interface SplashEpicenter {
  x: number;
  y: number;
  /** Outward radial velocity at the epicenter. Default ~40. */
  velocity?: number;
}

/**
 * Options for a single splash call. Anything not specified falls back to the
 * library's current configuration (radius, pressure, etc.).
 */
export interface SplashOptions {
  /** Outer ring radius in display pixels. */
  radius?: number;
  /** Peak pressure at the epicenter. Drives the initial outward push. */
  pressure?: number;
  /** Per-frame pressure decay multiplier. Range (0, 1]. Default ~0.94. */
  liftRate?: number;
  /** Angular offset for ray patterns, radians. */
  angleOffset?: number;
  /** Random jitter on epicenter position, 0..1. */
  jitter?: number;
  /** Number of rays in the splash pattern. 1 = pure circular. */
  rays?: number;
  /** Pigment used by this splash. Default = active brush pigment. */
  pigment?: PigmentOption;
}

/** Style of splash. Different presets shape the radial profile differently. */
export type SplashStyle = 'deluge' | 'splash' | 'spray';

// =============================================================================
// SVG / image / text rendering
// =============================================================================

/**
 * Options for `traceSVG`. The lib parses the SVG, decomposes it into
 * pen-stroke paths, and animates drawing them onto the canvas.
 */
export interface TraceSVGOptions {
  /** Pigment to use for paths without a recognized fill/stroke color. */
  pigment?: PigmentOption;
  /** Display-pixel brush size while tracing. */
  brushSize?: number;
  /** Stroke speed in display pixels per second. */
  speed?: number;
  /** Recognize chroma-key and pigment-hex colors as direct pigment assignments. Default true. */
  triggerColors?: boolean;
  /** Mirror the trace horizontally. */
  flipX?: boolean;
  /** Mirror the trace vertically. */
  flipY?: boolean;
  /** Multiplicative scale for the SVG path coordinates. */
  scale?: number;
  /** Translation in display pixels. */
  translateX?: number;
  translateY?: number;
  /** Called once when the trace completes. */
  onComplete?: () => void;
}

/** Options for `paintImage`. Source can be a URL, a data URL, or an HTMLImageElement. */
export interface PaintImageOptions {
  pigment?: PigmentOption;
  brushSize?: number;
  /** 0..1 threshold for which pixels become pigment. */
  threshold?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Reverse light/dark mapping. */
  invert?: boolean;
  scale?: number;
  translateX?: number;
  translateY?: number;
  onComplete?: () => void;
}

/** Options for `paintText`. */
export interface PaintTextOptions {
  pigment?: PigmentOption;
  brushSize?: number;
  fontSize?: number;
  fontFamily?: string;
  x?: number;
  y?: number;
  onComplete?: () => void;
}

// =============================================================================
// Animation, visualization, time-wash
// =============================================================================

export type AnimationName = 'off' | 'breathe' | 'drift' | 'pulse' | string;
export interface AnimationOptions {
  speed?: number;
  amplitude?: number;
}

export type VisualizationName = 'off' | 'velocity' | 'pressure' | 'wet' | 'mask' | string;
export interface VisualizationOptions {
  opacity?: number;
}

// =============================================================================
// Sketch / obliterate / fade
// =============================================================================

export interface SketchModeOptions {
  enabled?: boolean;
  strength?: number;
  paperContrast?: number;
}

export interface ObliterateOptions {
  /** Duration of the obliterate animation, ms. */
  duration?: number;
  /** Easing function: 'linear' | 'ease-out' | 'cubic' or a custom (t: number) => number. */
  easing?: string | ((t: number) => number);
  onComplete?: () => void;
}

// =============================================================================
// Performance metrics
// =============================================================================

export interface PerfMetrics {
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  activeCells: number;
  activeCellsPct: number;
  heapDeltaMB: number;
  longAnimationFrames: number;
  perPhaseMs: {
    diffuse: number;
    edge: number;
    velocity: number;
    advection: number;
    transfer: number;
    render: number;
  };
}

// =============================================================================
// Serializable preset (state subset; not a snapshot of pigment fields)
// =============================================================================

/**
 * Serializable subset of the lib's configuration. Round-trippable via
 * `getPreset()` and `applyPreset()`. Used for "save my current settings"
 * UX. Does NOT capture pigment fields — for that, use the canvas as an
 * image or call `state()` (which returns Float32Arrays not suitable for JSON).
 */
export interface Preset {
  pigment?: PigmentOption;
  brushSize?: number;
  paperWetness?: string;
  evaporation?: number;
  edgeMode?: EdgeMode;
  gravityDirection?: GravityDirection;
  gravityStrength?: number;
  velocityClamp?: number;
  gouacheMode?: GouacheMode;
  advectionMode?: AdvectionMode;
  maskTint?: boolean;
  webgl?: boolean;
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
  /** Pixels per simulation cell. Higher = lower-res, faster. Default = 1.75. URL `?scale=` also accepted. */
  scale?: number;
  /** Canvas DPI scale factor. Default = window.devicePixelRatio. */
  canvasScale?: number;
  /** Force mobile-mode heuristics (palm rejection, etc.). Default auto-detected via `matchMedia('(pointer: coarse)')`. */
  mobile?: boolean;
  /** Show floating cursor preview circle. Default true on desktop. */
  cursorPreview?: boolean;
  /** Initial gouache mode. Default `false`. Pass `'auto'` for paper-darkness-driven LERP. */
  gouacheMode?: GouacheMode;
  /** Continuous flow during paint strokes. Default true. */
  continuousFlow?: boolean;
  /** Disable pointer event handling entirely. Useful for programmatic control. Default true. */
  pointer?: boolean;
}

// =============================================================================
// Returned instance
// =============================================================================

/**
 * Most setters return `this` to support chained calls. Getters return the
 * current value. The `(v?: T)` pattern throughout — pass nothing to read,
 * pass a value to set.
 */
export interface WashesInstance {
  // -----------------------------------------------------------------------
  // Painting input
  // -----------------------------------------------------------------------

  /** Inject a splash at one or more epicenters. */
  splash(epicenters: SplashEpicenter[], style?: SplashStyle, opts?: SplashOptions): WashesInstance;

  /**
   * Programmatic paint stamp at grid coordinates (not display coordinates).
   * Use `toGrid(displayX, displayY)` to convert if you have display coords.
   */
  paintAt(gx: number, gy: number, gridRadius: number, pigment?: PigmentOption, strength?: number): WashesInstance;

  /** Stamp text using the active brush. */
  paintText(text: string, opts?: PaintTextOptions): Promise<void>;

  /** Stamp an image using the active brush (light/dark map to pigment density). */
  paintImage(source: string | HTMLImageElement, opts?: PaintImageOptions): Promise<void>;

  /** Trace an SVG, drawing each path with the active brush over time. */
  traceSVG(svgText: string, opts?: TraceSVGOptions): Promise<void>;
  /** Cancel any in-flight SVG trace. */
  cancelSVGTrace(): WashesInstance;

  // -----------------------------------------------------------------------
  // Brush state
  // -----------------------------------------------------------------------

  /** Current brush diameter in display pixels. Default 28. */
  brushSize(v?: number): number;

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

  /** Paint load: how much pigment is delivered per stamp. 0..1. */
  paintLoad(v?: number): number;

  /** Water load: how much water is delivered per stamp. 0..1. */
  waterLoad(v?: number): number;

  /** Brush pressure: epicenter intensity multiplier. */
  pressure(v?: number): number;

  /** Flow rate: how quickly pigment spreads after stamping. */
  flow(v?: number): number;

  /** Use pointer pressure (stylus) to modulate flow. Default true if supported. */
  usePointerPressure(v?: boolean): boolean;

  /** Whether dragging produces continuous flow or per-stamp dots. Default true. */
  continuousFlow(v?: boolean): boolean;

  // -----------------------------------------------------------------------
  // Paper state
  // -----------------------------------------------------------------------

  /** Set paper wetness preset (changes evaporation rate among other things). */
  paperWetness(preset?: string): string;
  /** List available wetness presets. */
  paperWetnessPresets(): string[];

  /** Direct evaporation rate. Higher = wash dries faster. */
  evaporation(value?: number): number;

  /** Pause/resume the drying simulation. */
  pauseDrying(v?: boolean): boolean;

  /** Set paper color in 0..1 RGB. */
  paperColor(r: number, g: number, b: number): WashesInstance;

  /** Read the current rainbow brush color (for hover-state UI). */
  rainbowColor(): { r: number; g: number; b: number };

  // -----------------------------------------------------------------------
  // Edge boundaries (v0.81-v0.84)
  // -----------------------------------------------------------------------

  /** Edge boundary mode: closed, open, or gravity. */
  edgeMode(v?: EdgeMode): EdgeMode;

  /** Gravity direction (8-compass plus 'radial'). Ignored in `closed` mode. */
  gravityDirection(v?: GravityDirection): GravityDirection;

  /** Gravity bias strength. 0 = no pull; ~0.10 = strong tilt; ~1.0 = max. */
  gravityStrength(v?: number): number;

  /**
   * Per-cell velocity magnitude cap. Auto-computed from `scale` by default
   * (so display speed is resolution-invariant). Pass `null` to restore the
   * auto-computed default.
   *
   * Note: values above ~1.7 require semi-Lagrangian advection mode; donor-
   * cell modes will produce the cardinal-cross artifact above that bound.
   */
  velocityClamp(v?: number | null): number;

  // -----------------------------------------------------------------------
  // Rendering / display
  // -----------------------------------------------------------------------

  /** Toggle gouache rendering mode. */
  gouacheMode(v?: GouacheMode): GouacheMode;
  /** Current LERP amount in 'auto' gouache mode. 0 = full watercolor, 1 = full gouache. */
  gouacheLerpAmount(): number;

  /** Advection scheme. */
  advectionMode(v?: AdvectionMode): AdvectionMode;
  /** Substeps used by the most recent movePigment call. */
  advectionLastSubsteps(): number;

  /** Whether edge darkening is applied. Default true. */
  edgeDarkening(v?: boolean): boolean;

  /** Show the amber tint over masked cells. Default true. */
  maskTint(v?: boolean): boolean;

  /** Toggle WebGL rendering. Falls back to CPU if WebGL2 isn't supported. */
  webgl(v?: boolean): boolean;
  /** Whether WebGL2 was available at init. */
  webglAvailable(): boolean;
  /** Debug: tint visible cells green so you can see the active region. */
  webglDebugTint(v?: boolean): boolean;

  /** Background transparent (canvas paper rendered transparent). */
  transparent(v?: boolean): boolean;

  /** Paper color/texture fade applied each frame to existing painted area. */
  fadePainting(v?: number): number;
  /** Half-life of the fade-out (ms). */
  fadeHalfLife(ms?: number): number;
  /** Auto-fade the background between strokes. */
  autoDryBackground(v?: boolean): boolean;

  /** Canvas resolution: display pixels per sim cell. Triggers a rescale event. */
  scale(v?: number): number;
  /** Canvas DPI scale factor. */
  canvasScale(v?: number): number;

  /** Convert display coordinates to sim grid coordinates. */
  toGrid(displayX: number, displayY: number): { gx: number; gy: number };

  // -----------------------------------------------------------------------
  // Mask
  // -----------------------------------------------------------------------

  /** Clear the freeze mask. */
  removeMask(): WashesInstance;

  // -----------------------------------------------------------------------
  // Composition modes
  // -----------------------------------------------------------------------

  /** Sketch mode (paper-contrasting line drawing overlay). */
  sketchMode(opts?: SketchModeOptions): SketchModeOptions;

  /** Obliterate animation: progressively destroys the painting. */
  obliterate(opts?: ObliterateOptions): Promise<void>;

  // -----------------------------------------------------------------------
  // Background animation / visualization
  // -----------------------------------------------------------------------

  /** Set a named time-driven background wash. */
  setBackground(name: string): WashesInstance;
  isBackgroundRunning(): boolean;

  /** Toggle an animation mode (breathe, drift, pulse, etc.). */
  setAnimation(name: AnimationName, opts?: AnimationOptions): WashesInstance;
  getAnimation(): AnimationName;

  /** Toggle a debug visualization (velocity vectors, pressure heat, etc.). */
  setVisualization(name: VisualizationName, opts?: VisualizationOptions): WashesInstance;
  getVisualization(): VisualizationName;

  // -----------------------------------------------------------------------
  // Mobile / input
  // -----------------------------------------------------------------------

  /** Force mobile-mode heuristics. */
  mobile(v?: boolean): boolean;
  /** Was mobile auto-detected at init? */
  mobileDetected(): boolean;

  /** Show floating cursor preview circle. */
  cursorPreview(v?: boolean): boolean;

  // -----------------------------------------------------------------------
  // Performance
  // -----------------------------------------------------------------------

  /** Start/stop perf instrumentation. */
  perf(v?: boolean): boolean;
  /** Current perf snapshot. */
  perfMetrics(): PerfMetrics;

  // -----------------------------------------------------------------------
  // UI helpers
  // -----------------------------------------------------------------------

  /** Build pigment swatch DOM elements into the given root. */
  buildPigmentSwatches(rootEl: HTMLElement): void;

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /** Export the current canvas as a PNG blob. */
  exportPNG(opts?: { width?: number; height?: number; transparent?: boolean }): Promise<Blob>;

  // -----------------------------------------------------------------------
  // Preset / state
  // -----------------------------------------------------------------------

  /** Serializable subset of the current configuration. */
  getPreset(): Preset;
  /** Apply a previously-saved preset. */
  applyPreset(preset: Preset): WashesInstance;

  /** Internal state object for debugging. Shape is intentionally unspecified. */
  state(): Record<string, unknown>;

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
 * `window.Washes` global. The lib doesn't expose a `class Washes`; instead
 * it exposes a `create()` factory function on this object.
 */
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
   */
  create(target: HTMLElement, options?: CreateOptions): WashesInstance;

  /** Library version, e.g. "0.85.0". */
  readonly version: string;
}

/** Default export: the WashesStatic namespace. */
declare const Washes: WashesStatic;
export { Washes };
export default Washes;

// =============================================================================
// Global augmentation — the lib also attaches `window.Washes` for use in
// no-bundler / classic-script contexts. TypeScript users who pull the lib
// via a script tag rather than `import` can rely on this global.
// =============================================================================

declare global {
  interface Window {
    Washes: WashesStatic;
  }
}
