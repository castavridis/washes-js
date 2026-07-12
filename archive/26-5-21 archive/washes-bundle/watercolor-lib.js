// ============================================================
// Watercolor Library v1.0
// ============================================================
// Factory-style library for embedding multiple independent
// watercolor simulations in a single page. Based on:
//   Curtis, Anderson, Seims, Fleischer & Salesin (1997).
//   "Computer-Generated Watercolor." SIGGRAPH '97.
// Implementation history: see watercolor-v0.26.2.html for the
// single-instance version with full UI.
//
// Usage:
//   const inst = Watercolor.create(targetEl, options);
//   inst.setBackground('sunset');
//   inst.splash('bigSplash');
//   inst.destroy();
//
// Each create() call mounts a fresh <canvas> inside targetEl
// and gives back an instance handle with the full Watercolor
// API (less features deferred to v2: WebGL render, text/SVG
// painting, cursor API, perf overlay).
//
// State isolation is via closure semantics — every variable
// declared inside create() is unique to that invocation, so
// the existing sim functions Just Work without any instance-
// passing rewrite. The sim core is the same code that ships
// in watercolor-v0.26.2.html.
// ============================================================

(function () {
"use strict";

function createInstance(targetEl, options) {
options = options || {};

// ----- Canvas + render-canvas setup, per instance -----
// The display canvas mounts inside targetEl. Its size is
// determined by targetEl's bounding rect at creation time;
// resizing the target later requires calling instance.resize().
const canvas = document.createElement('canvas');
canvas.style.cssText =
  'display:block;position:absolute;inset:0;width:100%;height:100%;' +
  'touch-action:none;';
targetEl.appendChild(canvas);

// Stub elements for UI references that the original code expects
// to exist. In library mode these don't get displayed; the stubs
// keep code that reads/writes them from throwing.
const _stubElement = {
  value: '', textContent: '', hidden: true, disabled: false,
  ariaPressed: 'false',
  classList: { toggle(){}, add(){}, remove(){}, contains(){ return false; } },
  style: new Proxy({}, { set(){ return true; }, get(){ return ''; } }),
  dataset: {},
  addEventListener(){}, removeEventListener(){},
  setAttribute(){}, getAttribute(){ return null; },
  appendChild(){}, removeChild(){}, replaceChildren(){},
  click(){}, focus(){}, blur(){},
  children: [], parentNode: null, parentElement: null,
  width: 56, height: 56,
  getContext(){ return null; },
  getBoundingClientRect(){
    const r = targetEl.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
             width: r.width, height: r.height, x: r.left, y: r.top };
  },
};

// Per-instance state for things that the original code reads from
// the global window/document. We provide shims so original code
// can call them without modification.
const instanceWindow = {
  get innerWidth()  { return targetEl.getBoundingClientRect().width; },
  get innerHeight() { return targetEl.getBoundingClientRect().height; },
  devicePixelRatio: window.devicePixelRatio || 1,
};
function getById(id) {
  if (id === 'canvas') return canvas;
  return _stubElement;
}

// Backwards-compat alias used throughout the sim code. The original
// code says `window.innerWidth` etc. — we shadow with our instance
// versions to size the grid to the target element.
const _innerWidth  = () => instanceWindow.innerWidth;
const _innerHeight = () => instanceWindow.innerHeight;

"use strict";

// ============================================================
// PIGMENT DATA — from Figure 5 of Curtis et al. 1997
// K, S coefficients given per RGB channel; rho = density,
// omega = staining power, gamma = granulation.
// ============================================================
const PIGMENTS = [
  {
    name: 'Quinacridone Rose',
    K: [0.22, 1.47, 0.57],
    S: [0.05, 0.003, 0.03],
    density: 0.02, staining: 5.5, granulation: 0.81
  },
  {
    name: 'Hansa Yellow',
    K: [0.06, 0.21, 1.78],
    S: [0.50, 0.88, 0.009],
    density: 0.06, staining: 1.0, granulation: 0.08
  },
  {
    name: 'Cerulean Blue',
    K: [1.52, 0.32, 0.25],
    S: [0.06, 0.26, 0.40],
    // Note: Figure 5 of the paper lists Cerulean Blue with staining ω=1.0
    // and granulation γ=0.31. That's physically authentic — real cerulean
    // is famously a non-staining "lifting" pigment that walks out to the
    // edges of a wash, leaving a ring. For visual consistency with
    // Quinacridone Rose (ω=5.5, γ=0.81), we raise both here so deposited
    // blue stays where it lands rather than migrating. K, S, density
    // unchanged, so the color and overall deposition rate match the
    // paper's Cerulean. If you want an authentic *staining* blue
    // instead, the paper's French Ultramarine (ω=3.1, γ=0.91) is a
    // drop-in candidate.
    density: 0.01, staining: 5.0, granulation: 0.75
  }
];

// A sentinel for the water brush — selectable like a pigment, but adds
// only water + pressure + a localized lift of deposited pigment. Kept
// out of the PIGMENTS array so KM compositing and swatch loops aren't
// forced to special-case a non-pigment entry.
const WATER_INDEX = -1;
// A sentinel for the lift (subtract) brush — removes pigment from the
// paper at touched cells, leaving water and pressure alone. The water
// brush already lifts in the sense of re-suspending d → g, but it
// doesn't reduce the total pigment on the page; this one does.
const LIFT_INDEX  = -2;
// A sentinel for the rainbow brush — deposits a time-varying mixture
// of all three pigments. The deposit weights cycle rose → yellow →
// blue → rose with one stop every RAINBOW_STOP_MS, so a continuous
// stroke smears through the full pigment cycle. See rainbowWeights().
const RAINBOW_INDEX = -3;
const RAINBOW_PERIOD_MS = 2250;
const RAINBOW_STOP_MS   = 750;
// A sentinel for the masking-fluid brush (v0.13). Real-world masking
// fluid is liquid latex that paints on, dries to a rubbery film, and
// resists water/pigment until rubbed off. Painting reveals the paper
// underneath. In this sim we model it as a binary-ish layer:
//   • paintAt with this index deposits mask into a `mask[]` array.
//   • Cells where mask[i] > MASK_THRESHOLD are FROZEN — every sim
//     pass (paint, flow, evaporation, fade) skips them, preserving
//     whatever state was there when the mask landed.
//   • Render shows masked cells with a pale-yellow tint so the user
//     can see what they've reserved.
//   • A "Remove mask" button zeroes the array, revealing the frozen
//     state — pristine paper if mask was painted first, or whatever
//     pigment was there if it was painted over.
// maskActive is set whenever mask is deposited and cleared when the
// array is zeroed. Hot loops check maskActive first so the per-cell
// mask read is skipped entirely when no mask exists.
const MASK_INDEX = -4;
const MASK_THRESHOLD = 0.1;          // cell considered masked above this
// v0.13.1 — visual ramp constants. The mask render no longer uses a
// hard threshold; instead the on-canvas tint scales smoothly with the
// per-cell mask value, giving soft edges where a brush stamp's falloff
// produced smaller mask deposits. MASK_VISUAL_FULL is the mask value
// at which the tint reaches its peak intensity, MASK_TINT_PEAK.
// The freeze decision in the sim is still binary (above THRESHOLD or
// not) — but THRESHOLD and the visual ramp's start are the same value,
// so every visible tint corresponds to an actually-frozen cell. No
// "tinted but not frozen" zone, no visual lie.
const MASK_VISUAL_FULL = 0.6;
const MASK_TINT_PEAK = 0.30;         // max yellow blend over underlying
// mask[] and maskActive declared after N is initialized — see the
// state-arrays block below.
// Shared output array to avoid per-call allocation. Read after each
// updateRainbowWeights call.
const rainbowW = [0, 0, 0];
function updateRainbowWeights(t_ms) {
  // Three linear segments: rose→yellow, yellow→blue, blue→rose.
  // The wraparound (blue→rose) closes the loop so a continuous stroke
  // doesn't have a discontinuity at the cycle boundary.
  const t = t_ms % RAINBOW_PERIOD_MS;
  if (t < RAINBOW_STOP_MS) {
    const f = t / RAINBOW_STOP_MS;
    rainbowW[0] = 1 - f; rainbowW[1] = f; rainbowW[2] = 0;
  } else if (t < 2 * RAINBOW_STOP_MS) {
    const f = (t - RAINBOW_STOP_MS) / RAINBOW_STOP_MS;
    rainbowW[0] = 0; rainbowW[1] = 1 - f; rainbowW[2] = f;
  } else {
    const f = (t - 2 * RAINBOW_STOP_MS) / RAINBOW_STOP_MS;
    rainbowW[0] = f; rainbowW[1] = 0; rainbowW[2] = 1 - f;
  }
}
let currentPigment = 0;
let brushSize = 28; // diameter in display pixels
// v0.22 — brush-load multipliers. paintLoadMult scales the pigment
// deposit strength for pigment + rainbow brushes (default 1.0 keeps the
// historical 0.34/0.38 baselines). waterLoadMult scales how much wet,
// pressure, and lift the water brush deposits per dab (default 1.0
// keeps the original 0.55/0.18/0.18 values). Both are exposed as
// sliders in the controls panel and as Watercolor.paintLoad() /
// Watercolor.waterLoad() in the API.
let paintLoadMult = 1.0;
let waterLoadMult = 1.0;

// v0.28 — Brush dynamics state. Previously hardcoded in pointer
// handlers; now exposed so callers can tune feel without touching
// internals. All three apply equally to mouse, pen, and SVG tracing.
//
// _brushPressure — base strength (0..1) for each stamp. Was 0.7
//   hardcoded in pointer events and 0.45 hardcoded in cursors.
//   Lower = lighter dabs; higher = more saturated dabs.
//
// _brushFlow — stamp spacing along a drag path, as a fraction of
//   brush radius. Was 0.4 hardcoded in applyPendingPaint. Smaller =
//   more stamps per inch (smoother continuous stroke); larger =
//   fewer stamps (dabbed/dotted look).
//
// _usePointerPressure — when true, multiplies _brushPressure by the
//   PointerEvent.pressure value (stylus pressure on iPad/Wacom).
//   Default false because most mouse events report 0.5 by default
//   and would dim every stroke.
let _brushPressure = 0.7;
let _brushFlow = 0.4;
let _usePointerPressure = false;

// ============================================================
// GRID — sized to fit the viewport. SCALE display pixels per cell.
// Computed once at module load; window resize is not handled (would
// require reallocating every Float32Array below).
//
// SCALE is the QUALITY KNOB. Changing it adjusts resolution + all
// scale-dependent constants together so the painting behavior stays
// visually consistent — just sharper or chunkier:
//   SCALE=1    →  native resolution, ~4x sim cost vs SCALE=2
//   SCALE=1.5  →  middle ground, ~1.78x sim cost vs SCALE=2
//   SCALE=2    →  half-resolution, the v0.7-0.8 baseline (REFERENCE)
//   SCALE=3    →  coarse middle ground
//   SCALE=4    →  fast, original v0.6 default
//   SCALE=6+   →  very coarse, useful on low-power devices
//
// SCALE_REF is the reference where the simulation constants were
// hand-tuned (v0.8 baseline). Everything else derives from it via the
// ratio `s = SCALE / SCALE_REF`:
//   - Diffusion coefficients scale as 1/s² (with stability cap at 0.20)
//   - Edge kernel sizes scale as 1/s (rounded, min 1)
//   - Paper texture frequency scales as s
//   - VEL_CLAMP scales as 1/s (with stability cap at 1.5)
// Intentionally NOT scaled (would require ~1/s³ scaling, complex with
// other interactions; second-order visual impact accepted at non-ref SCALE):
//   - DT, DRAG, VISCOSITY, PAPER_TILT — velocity-update internals
//   - EDGE_ETA — edge darkening intensity (per-step)
//   - Evaporation rate, pressure decay — per-step rates
//
// Non-integer SCALE is allowed; DISPLAY_W/H are rounded to keep
// canvas dimensions integer.
//
// CANVAS_OVERSCAN extends the simulated region past the visible viewport
// (see #canvas CSS — inset: -2.5vh -2.5vw). The hidden margin absorbs
// the edge-of-grid artifacts of the sim so the visible area only shows
// the interior. 1.05 ↔ 2.5% past each side, matching the CSS.
// ============================================================
// SCALE can be set via the ?scale= URL query parameter. The UI slider
// at the bottom of the page reads it and writes it (via page reload —
// changing SCALE requires reallocating every Float32Array below, so a
// reload is the cleanest way to get a fresh sim at a new resolution).
const _urlScale = parseFloat(options.scale);
let SCALE = (isFinite(_urlScale) && _urlScale >= 1 && _urlScale <= 6) ? _urlScale : 1.75;
const SCALE_REF = 2;                   // reference scale where constants were tuned
let s_scale = SCALE / SCALE_REF;       // dimensionless ratio
let inv_s = 1 / s_scale;
let inv_s2 = inv_s * inv_s;
const CANVAS_OVERSCAN = 1.05;
let GW = Math.max(120, Math.floor(_innerWidth()  * CANVAS_OVERSCAN / SCALE));
let GH = Math.max(80,  Math.floor(_innerHeight() * CANVAS_OVERSCAN / SCALE));
let N = GW * GH;
let DISPLAY_W = Math.round(GW * SCALE);
let DISPLAY_H = Math.round(GH * SCALE);

// v2 — Canvas scale factor for proportional brush sizes.
// Animation/visualization/splash presets were tuned for a typical
// standalone canvas (~1200px wide). When the host element is much
// smaller (e.g. 320px in an embedded card), the same gridRadius
// covers proportionally more of the canvas and strokes look huge.
// Auto-computing a downscale factor based on display width keeps
// stroke widths visually consistent across canvas sizes. Capped at
// 1.0 so large canvases use the original tuning unchanged.
const REFERENCE_DISPLAY_W = 1200;
let _canvasScale = Math.min(1.0, DISPLAY_W / REFERENCE_DISPLAY_W);
// Callers can override the auto-computed value through options.canvasScale
// passed to Watercolor.create() — applied below after options is parsed.
if (typeof options.canvasScale === 'number' && options.canvasScale > 0) {
  _canvasScale = options.canvasScale;
}

// ============================================================
// STATE ARRAYS (flat Float32Arrays for speed)
// ============================================================
let wet      = new Float32Array(N); // water amount per cell, 0..1
let wetBlur  = new Float32Array(N);
let wetBlurTmp = new Float32Array(N);
let u        = new Float32Array(N); // x-velocity
let v        = new Float32Array(N); // y-velocity
let u_new    = new Float32Array(N);
let v_new    = new Float32Array(N);
let pressure = new Float32Array(N);
let paperH   = new Float32Array(N); // paper height field, 0..1

// 3 pigments × 2 layers (suspended in water, deposited on paper)
let g = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
let d = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
let g_tmp = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
// Masking fluid layer (v0.13) — one float per cell, 0 = clean, 1 = fully
// masked. Cells above MASK_THRESHOLD are frozen by every sim function.
// See the MASK_INDEX block above for the full design rationale.
let mask = new Float32Array(N);
let maskActive = false;
// v0.19 — mask rect bounds (mirror of activeRect for the mask layer).
// Tracks the bounding box of cells with mask[i] > MASK_THRESHOLD. Every
// sim phase that needs to skip masked cells can use these bounds to
// skip the per-cell mask[i] memory load entirely outside the rect —
// only doing the check inside the small rect where the mask actually
// lives. For a typical localized mask (a moon, a tree silhouette),
// that's a 5-10× speedup on the mask-check overhead, scaling with
// (1 - maskRectArea / activeRectArea).
//
// Updated by:
//   • paintAt MASK_INDEX branch — expands the rect when new mask cells
//     cross the threshold
//   • removeMask() — clears the rect along with the mask array
//
// Never actively shrunk during normal operation. A periodic shrink
// would mirror activeRect's, but masks are typically painted once and
// then left alone, so the rect stays right-sized after the first paint.
let maskRectMinX = GW, maskRectMinY = GH, maskRectMaxX = -1, maskRectMaxY = -1;

function maskRectIsEmpty() {
  return maskRectMaxX < maskRectMinX || maskRectMaxY < maskRectMinY;
}

function clearMaskRect() {
  maskRectMinX = GW; maskRectMinY = GH;
  maskRectMaxX = -1; maskRectMaxY = -1;
}

// Inline test helper for the hot path. Returns true if cell (x, y) is
// even potentially masked — i.e. inside the mask rect. Caller still
// needs to check mask[i] > MASK_THRESHOLD for the actual value, but
// can skip that load entirely when this returns false.
function cellInMaskRect(x, y) {
  return x >= maskRectMinX && x <= maskRectMaxX &&
         y >= maskRectMinY && y <= maskRectMaxY;
}

// v0.19 — hot-path mask check used in all sim phases. Combines the
// global maskActive flag with the rect bounds and the per-cell mask
// value into a single inline expression that the JIT can flatten and
// hoist. CRITICAL: most cells in a typical frame are NOT inside the
// mask rect, so the rect-bounds compare short-circuits before the
// mask[i] memory load — which is the whole point.
//
// Inlining: V8/JSC both inline small monomorphic functions; this
// callsite gets the same codegen as if the expression were repeated
// inline at each callsite, but with a single source of truth.
function isMaskedAt(x, y, i) {
  return maskActive &&
         x >= maskRectMinX && x <= maskRectMaxX &&
         y >= maskRectMinY && y <= maskRectMaxY &&
         mask[i] > MASK_THRESHOLD;
}
// Wet diffusion temp buffer — used by diffuseWet() to read previous-step
// values while writing this-step values into wet[].
let wet_tmp = new Float32Array(N);

// ============================================================
// IDLE-SKIP STATE — declared early so paintAt / resetSim / rewet can
// reference markCanvasActive at init without hitting a TDZ on the
// let bindings below. The actual idle-decision logic lives next to
// the loop further down; this block is just storage + the wake helper.
// ============================================================
let framesSincePaint = 9999;          // start "settled" — first paint wakes
let framesSinceIdleCheck = 0;
let framesSinceBars = 999;            // start large so first frame updates bars
let simIsIdle = false;                // start active so initial state renders
let lastTotalWet = 0;
let lastTotalSuspended = 0;
function markCanvasActive() {
  framesSincePaint = 0;
  simIsIdle = false;
}

// ============================================================
// ACTIVE REGION TRACKING (v1.0)
// ============================================================
// Bounding rectangle of "where dynamics matter" — i.e., cells where
// suspended pigment (g > 0) or pressure (> 0) exists. Outside this
// rect, wet is uniform, no pigment, no flow — the per-step passes
// would produce no change, so we skip the empty paper entirely.
//
// This is the biggest single perf win since v0.7's fused passes:
// typical paintings cover 10-40% of canvas, so simStep does 60-90%
// less per-cell work.
//
// Tracking:
//   expandActiveRect — paintAt calls this on every brush stamp,
//     growing the rect to cover the stamp + ACTIVE_MARGIN cells.
//     The margin absorbs diffusion + advection spread between scans.
//   shrinkActiveRect — runs every ACTIVE_SHRINK_INTERVAL frames in
//     the main loop. Scans the current rect for cells above the
//     activity threshold and tightens to that bounding box + margin.
//     Lets the rect tighten as pigment dries / fades / lifts.
//
// Empty rect (activeMaxX < activeMinX, i.e. -1): simStep functions
// early-return. This is the initial state (resetSim leaves uniform
// wet but no pigment/pressure) and the post-dry state.
let activeMinX = 0, activeMaxX = -1;  // -1 marker = empty
let activeMinY = 0, activeMaxY = -1;
let framesSinceShrink = 0;
const ACTIVE_SHRINK_INTERVAL = 30;    // frames between shrink scans
const ACTIVE_MARGIN = 24;             // cells of padding around tracked content
const ACTIVE_THRESHOLD = 0.001;       // pigment/pressure threshold for "active"

function activeRectIsEmpty() {
  return activeMaxX < activeMinX || activeMaxY < activeMinY;
}

function setActiveRectFull() {
  activeMinX = 0; activeMaxX = GW - 1;
  activeMinY = 0; activeMaxY = GH - 1;
}

function setActiveRectEmpty() {
  activeMinX = 0; activeMaxX = -1;
  activeMinY = 0; activeMaxY = -1;
}

function expandActiveRect(centerX, centerY, radius) {
  const lx = Math.max(0, Math.floor(centerX - radius - ACTIVE_MARGIN));
  const rx = Math.min(GW - 1, Math.ceil(centerX + radius + ACTIVE_MARGIN));
  const ty = Math.max(0, Math.floor(centerY - radius - ACTIVE_MARGIN));
  const by = Math.min(GH - 1, Math.ceil(centerY + radius + ACTIVE_MARGIN));
  if (activeRectIsEmpty()) {
    activeMinX = lx; activeMaxX = rx;
    activeMinY = ty; activeMaxY = by;
  } else {
    if (lx < activeMinX) activeMinX = lx;
    if (rx > activeMaxX) activeMaxX = rx;
    if (ty < activeMinY) activeMinY = ty;
    if (by > activeMaxY) activeMaxY = by;
  }
}

function shrinkActiveRect() {
  if (activeRectIsEmpty()) return;
  const g0 = g[0], g1 = g[1], g2 = g[2];
  const thr = ACTIVE_THRESHOLD;
  let newMinX = activeMaxX + 1, newMaxX = activeMinX - 1;
  let newMinY = activeMaxY + 1, newMaxY = activeMinY - 1;
  for (let y = activeMinY; y <= activeMaxY; y++) {
    const yo = y * GW;
    for (let x = activeMinX; x <= activeMaxX; x++) {
      const i = yo + x;
      if (g0[i] > thr || g1[i] > thr || g2[i] > thr || pressure[i] > thr) {
        if (x < newMinX) newMinX = x;
        if (x > newMaxX) newMaxX = x;
        if (y < newMinY) newMinY = y;
        if (y > newMaxY) newMaxY = y;
      }
    }
  }
  if (newMaxX < newMinX) {
    setActiveRectEmpty();
    return;
  }
  activeMinX = Math.max(0, newMinX - ACTIVE_MARGIN);
  activeMaxX = Math.min(GW - 1, newMaxX + ACTIVE_MARGIN);
  activeMinY = Math.max(0, newMinY - ACTIVE_MARGIN);
  activeMaxY = Math.min(GH - 1, newMaxY + ACTIVE_MARGIN);
}

// ============================================================
// PAPER GENERATION — multi-octave hash noise, scaled 0..1
// ============================================================
function hash2(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + 1.0) * 43758.5453;
  return s - Math.floor(s);
}
function smoothNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix,        fy = y - iy;
  const a = hash2(ix,     iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix,     iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a * (1 - ux) * (1 - uy)
       + b * ux       * (1 - uy)
       + c * (1 - ux) * uy
       + d * ux       * uy;
}
// 1.0 = full noise range (~0.08 .. 0.97); 0.5 halves the variation around mean (~0.29 .. 0.73).
// Lower values produce subtler granulation and less distinct low spots on the paper.
const TEXTURE_AMPLITUDE = 0.5;

function generatePaper() {
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      // SCALE-derived: freq scales as `s` to keep texture feature size
      // in display pixels constant. At SCALE_REF (s=1) → 12.0 (v0.8
      // baseline). Dominant feature wavelength ≈ SCALE/freq display px.
      let h = 0, amp = 0.5, freq = 12.0 * s_scale;
      for (let o = 0; o < 4; o++) {
        h += amp * smoothNoise(x * freq + 17, y * freq + 53);
        amp *= 0.55;
        freq *= 2.1;
      }
      // High-frequency fiber speckle
      h += (hash2(x, y) - 0.5) * 0.04;
      // Normalize roughly into 0..1
      h = Math.max(0, Math.min(1, h));
      // Compress range around the mean to reduce distinctness of low spots
      h = 0.5 + (h - 0.5) * TEXTURE_AMPLITUDE;
      paperH[y * GW + x] = h;
    }
  }
}

// ============================================================
// BOX BLUR — separable, used for FlowOutward distance approximation
// ============================================================
function boxBlur(src, dst, radius) {
  const inv = 1 / (2 * radius + 1);
  const r = radius;
  const gw = GW, gh = GH;
  const tmp = wetBlurTmp;

  // ---- HORIZONTAL PASS: src -> wetBlurTmp ----
  // Each row's inner loop is split into three regions so the clamps
  // can be hoisted out of the hot middle iteration. Middle covers the
  // vast majority of cells — the edges are only `radius` wide each.
  for (let y = 0; y < gh; y++) {
    const yo = y * gw;
    let sum = 0;
    // Initialize the window: -r..+r, clamped to row bounds
    for (let xx = -r; xx <= r; xx++) {
      const ix = xx < 0 ? 0 : xx > gw - 1 ? gw - 1 : xx;
      sum += src[yo + ix];
    }
    // Left region: x < r, "sub" side clamps to 0
    let x = 0;
    const leftEnd = r < gw ? r : gw;
    while (x < leftEnd) {
      tmp[yo + x] = sum * inv;
      const addX = x + r + 1;
      sum += src[yo + (addX > gw - 1 ? gw - 1 : addX)];
      sum -= src[yo]; // sub clamps to 0
      x++;
    }
    // Middle: both indices in bounds — no clamps
    const midEnd = gw - r - 1 > 0 ? gw - r - 1 : 0;
    while (x < midEnd) {
      tmp[yo + x] = sum * inv;
      sum += src[yo + x + r + 1] - src[yo + x - r];
      x++;
    }
    // Right region: "add" side clamps to gw - 1
    const lastIdx = yo + gw - 1;
    while (x < gw) {
      tmp[yo + x] = sum * inv;
      const subX = x - r;
      sum += src[lastIdx] - src[yo + (subX < 0 ? 0 : subX)];
      x++;
    }
  }

  // ---- VERTICAL PASS: wetBlurTmp -> dst ----
  // Same 3-region split. Note this pass strides by gw between reads,
  // so it's less cache-friendly than the horizontal pass; the clamp
  // elimination is the cheap win we can take here without restructuring
  // memory layout.
  for (let x = 0; x < gw; x++) {
    let sum = 0;
    for (let yy = -r; yy <= r; yy++) {
      const iy = yy < 0 ? 0 : yy > gh - 1 ? gh - 1 : yy;
      sum += tmp[iy * gw + x];
    }
    let y = 0;
    const topEnd = r < gh ? r : gh;
    while (y < topEnd) {
      dst[y * gw + x] = sum * inv;
      const addY = y + r + 1;
      sum += tmp[(addY > gh - 1 ? gh - 1 : addY) * gw + x];
      sum -= tmp[x]; // sub clamps to row 0
      y++;
    }
    const midEnd = gh - r - 1 > 0 ? gh - r - 1 : 0;
    while (y < midEnd) {
      dst[y * gw + x] = sum * inv;
      sum += tmp[(y + r + 1) * gw + x] - tmp[(y - r) * gw + x];
      y++;
    }
    const lastRowOff = (gh - 1) * gw;
    while (y < gh) {
      dst[y * gw + x] = sum * inv;
      const subY = y - r;
      sum += tmp[lastRowOff + x] - tmp[(subY < 0 ? 0 : subY) * gw + x];
      y++;
    }
  }
}

// ============================================================
// EDGE DARKENING (FlowOutward, §4.3.3)
// p -= eta * (1 - M') * M, where M is the *binary* wet mask and M' its blur.
// We blur a binarized version so that uniformly wet areas don't spuriously
// drain pressure — only real boundaries between wet and dry should reduce p.
// We additionally blur with a much LARGER kernel to detect whether the
// wet region is big or just a small isolated patch (like a fresh
// brushstroke on dry paper). Small patches dry too fast for full
// contact-line migration to develop, so we attenuate edge darkening
// there — keeps pigment near the brush contact instead of pooling at
// the patch perimeter as a ring.
// SCALE-derived: 1/s scaling keeps display-pixel kernel extent constant.
// Running-sum box blur is O(N) regardless of kernel size, so these can
// scale freely without performance impact.
let EDGE_KERNEL = Math.max(1, Math.round(4 * inv_s));
let EDGE_KERNEL_LARGE = Math.max(1, Math.round(20 * inv_s));
const EDGE_ETA = 0.045;
// EDGE_WET_ACTIVE / EDGE_WET_OFF define a smooth ramp on edge darkening
// intensity as cells dry. Above EDGE_WET_ACTIVE, full strength. Below
// EDGE_WET_OFF, off entirely. Linear ramp between. Without this, the
// moving wet/dry boundary fires edge darkening at every position it
// passes through during the long late drying phase, laying down a
// trail of pigment as visible concentric "tide lines" inside what
// should be a uniform dry wash. Real contact-line migration only
// happens while there's enough water left to sustain the outward
// replenishing flow — once a cell is mostly dry, the mechanism quietly
// switches off and pigment locks in place where it last was. This
// ramp models that timing.
const EDGE_WET_ACTIVE = 0.40;
const EDGE_WET_OFF    = 0.10;
// MAX_PIGMENT caps how much pigment any single cell can hold. The paper
// caps both g and d at 1 inside §4.5 (TransferPigment), but paintAt,
// advection convergence, and the evaporation dump-to-deposited all
// previously bypassed that cap — letting endpoint cells accumulate
// unbounded pigment, which then read as near-black after KM compositing.
const MAX_PIGMENT = 1.0;
let wetBinary = new Float32Array(N);
let wetBlurLarge = new Float32Array(N);
function applyEdgeDarkening() {
  for (let i = 0; i < N; i++) wetBinary[i] = wet[i] > 0.04 ? 1 : 0;
  boxBlur(wetBinary, wetBlur, EDGE_KERNEL);
  boxBlur(wetBinary, wetBlurLarge, EDGE_KERNEL_LARGE);
  if (activeRectIsEmpty()) return;
  const activeRange = EDGE_WET_ACTIVE - EDGE_WET_OFF;
  const y0 = Math.max(0, activeMinY);
  const y1 = Math.min(GH - 1, activeMaxY);
  const x0 = Math.max(0, activeMinX);
  const x1 = Math.min(GW - 1, activeMaxX);
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    const rowMaybeMasked = maskActive &&
                           y >= maskRectMinY && y <= maskRectMaxY;
    for (let x = x0; x <= x1; x++) {
      const i = yo + x;
      // Masked cells: edges shouldn't darken into the mask boundary —
      // no pressure changes at frozen cells.
      if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
          mask[i] > MASK_THRESHOLD) continue;
      if (wet[i] > 0.04) {
        const deficit = 1 - wetBlur[i];          // 0 in interior, → 1 near boundary
        if (deficit > 0) {
          const w = wet[i];
          // Smooth fade: 1 above EDGE_WET_ACTIVE, 0 below EDGE_WET_OFF, linear between.
          const activation = w >= EDGE_WET_ACTIVE ? 1
                           : w <= EDGE_WET_OFF    ? 0
                           : (w - EDGE_WET_OFF) / activeRange;
          // wetBlurLarge ≈ 1 in big wet regions, ≈ 0.1 in small wet patches.
          // The product attenuates edge darkening in small islands so a
          // fresh stroke on dry paper doesn't lose all its pigment to a ring.
          pressure[i] -= EDGE_ETA * deficit * wetBlurLarge[i] * w * activation;
        }
      }
    }
  }
}

// ============================================================
// VELOCITY UPDATE (simplified shallow water, §4.3.1)
// ============================================================
const DT       = 0.42;
const VISCOSITY = 0.10;
const DRAG     = 0.014;
const PAPER_TILT = 0.06;   // reduced from 0.32 — paper height is now pixel-fine,
                           // so its gradient is essentially noise; keep its
                           // contribution to velocity small to avoid jitter
// SCALE-derived: 1/s scaling makes max display-pixel velocity invariant.
// Capped at 1.5 — the upwind advection in movePigment has a CFL bound
// VEL_CLAMP * (DT * 0.7) * 2 < 1, so VEL_CLAMP must stay below ~1.7.
// Cap engages at SCALE < ~1.33 (e.g. at SCALE=1, ideal is 2.0).
let VEL_CLAMP  = Math.min(1.5, 1.0 * inv_s);

function updateVelocity() {
  if (activeRectIsEmpty()) {
    // No active dynamics anywhere: pressure is already ≈ 0 outside the
    // (empty) rect by definition. Skip entirely.
    return;
  }
  const y0 = Math.max(1, activeMinY);
  const y1 = Math.min(GH - 2, activeMaxY);
  const x0 = Math.max(1, activeMinX);
  const x1 = Math.min(GW - 2, activeMaxX);
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    const rowMaybeMasked = maskActive &&
                           y >= maskRectMinY && y <= maskRectMaxY;
    for (let x = x0; x <= x1; x++) {
      const i = yo + x;
      // Masked cells have no flow — treat them like dry walls.
      if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
          mask[i] > MASK_THRESHOLD) {
        u_new[i] = 0; v_new[i] = 0; continue;
      }
      if (wet[i] < 0.04) { u_new[i] = 0; v_new[i] = 0; continue; }
      // pressure gradient
      const dpdx = pressure[i + 1] - pressure[i - 1];
      const dpdy = pressure[i + GW] - pressure[i - GW];
      // paper slope (gradient of height field)
      const dhdx = paperH[i + 1] - paperH[i - 1];
      const dhdy = paperH[i + GW] - paperH[i - GW];
      // viscous diffusion (laplacian)
      const lapU = u[i - 1] + u[i + 1] + u[i - GW] + u[i + GW] - 4 * u[i];
      const lapV = v[i - 1] + v[i + 1] + v[i - GW] + v[i + GW] - 4 * v[i];

      let nu = u[i] + DT * (-dpdx * 0.5 - dhdx * PAPER_TILT + VISCOSITY * lapU - DRAG * u[i]);
      let nv = v[i] + DT * (-dpdy * 0.5 - dhdy * PAPER_TILT + VISCOSITY * lapV - DRAG * v[i]);
      if (nu >  VEL_CLAMP) nu =  VEL_CLAMP; else if (nu < -VEL_CLAMP) nu = -VEL_CLAMP;
      if (nv >  VEL_CLAMP) nv =  VEL_CLAMP; else if (nv < -VEL_CLAMP) nv = -VEL_CLAMP;
      u_new[i] = nu; v_new[i] = nv;
    }
  }
  // Copy u_new/v_new back to u/v, restricted to the rect. Float32Array's
  // set(subarray, offset) is a fast memcpy under the hood. Cells outside
  // the rect retain their previous u/v values (which are ≈ 0 since the
  // shrink scan tracks pressure too).
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    const start = yo + x0;
    const end = yo + x1 + 1;
    u.set(u_new.subarray(start, end), start);
    v.set(v_new.subarray(start, end), start);
  }
  // v0.10 — pressure decay restricted to active rect. Pressure is only
  // injected by paintAt (which always grows the rect to cover the stamp)
  // and only consumed by updateVelocity + applyEdgeDarkening (both rect-
  // restricted). Cells outside the rect have pressure ≈ 0 from initial
  // state; multiplying them by 0.94 was burning N writes per simStep for
  // no behavioral effect.
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    for (let x = x0; x <= x1; x++) pressure[yo + x] *= 0.94;
  }
}

// ============================================================
// MOVE PIGMENT (upwind advection + small diffusion)
// ============================================================
// SCALE-derived: 1/s² scaling preserves display-pixel diffusion rate.
// Capped at 0.20 (below 0.25 stability bound for explicit 4-neighbor
// Laplacian) — the cap engages at very small SCALE values.
let PIGMENT_DIFFUSION = Math.min(0.20, 0.045 * inv_s2);

function movePigment() {
  if (activeRectIsEmpty()) return;
  for (let k = 0; k < 3; k++) g_tmp[k].set(g[k]);

  const y0 = Math.max(1, activeMinY);
  const y1 = Math.min(GH - 2, activeMaxY);
  const x0 = Math.max(1, activeMinX);
  const x1 = Math.min(GW - 2, activeMaxX);
  // v0.19 — mask rect optimization. Compute these once outside the
  // outer loop; the row check uses them per-row, and the column check
  // per-cell. When the active rect doesn't overlap the mask rect at
  // all, mayBeMasked is false for every row and the per-cell mask[i]
  // load is skipped entirely.
  const maskedRectActive = maskActive;
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    const rowMaybeMasked = maskedRectActive &&
                           y >= maskRectMinY && y <= maskRectMaxY;
    for (let x = x0; x <= x1; x++) {
      const i = yo + x;
      // Masked cells freeze pigment in place — neither source nor sink
      // for advective flux. Skip them; their g_tmp[k][i] starts equal
      // to g[k][i] (from the .set above), so the copyback preserves
      // the frozen state intact.
      if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
          mask[i] > MASK_THRESHOLD) continue;
      if (wet[i] < 0.04) continue;
      const ux = u[i], vy = v[i];
      const adt = DT * 0.7;

      for (let k = 0; k < 3; k++) {
        const gk = g[k][i];
        if (gk < 0.0008) continue;
        let outFlux = 0;
        if (ux > 0) {
          const f = ux * gk * adt;
          g_tmp[k][i + 1] += f; outFlux += f;
        } else if (ux < 0) {
          const f = -ux * gk * adt;
          g_tmp[k][i - 1] += f; outFlux += f;
        }
        if (vy > 0) {
          const f = vy * gk * adt;
          g_tmp[k][i + GW] += f; outFlux += f;
        } else if (vy < 0) {
          const f = -vy * gk * adt;
          g_tmp[k][i - GW] += f; outFlux += f;
        }
        g_tmp[k][i] -= outFlux;
      }
    }
  }
  for (let k = 0; k < 3; k++) {
    const arr = g[k];
    const src = g_tmp[k];
    for (let i = 0; i < N; i++) {
      const vv = src[i];
      arr[i] = vv > MAX_PIGMENT ? MAX_PIGMENT : vv;
    }
  }

  // Isotropic diffusion (smooths sharp pixel artifacts, gives soft wet-in-wet feel)
  // Fused single pass: all 3 pigments handled inline per cell, so we
  // pay the loop overhead and the wet[i] check once instead of 3x.
  // Same Laplacian math as before, applied to each pigment.
  const tmp0 = g_tmp[0], tmp1 = g_tmp[1], tmp2 = g_tmp[2];
  const arr0 = g[0], arr1 = g[1], arr2 = g[2];
  tmp0.set(arr0); tmp1.set(arr1); tmp2.set(arr2);
  const PD = PIGMENT_DIFFUSION;
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    const rowMaybeMasked = maskActive &&
                           y >= maskRectMinY && y <= maskRectMaxY;
    for (let x = x0; x <= x1; x++) {
      const i = yo + x;
      // Masked cells: no pigment movement out, and tmp[i] is already
      // equal to arr[i] from the .set, so leaving arr[i] alone keeps
      // the frozen value. Skipping also stops neighbor pigment from
      // "leaking into" the masked cell because the masked cell isn't
      // written to.
      if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
          mask[i] > MASK_THRESHOLD) continue;
      if (wet[i] < 0.04) continue;
      const im1 = i - 1, ip1 = i + 1, im_g = i - GW, ip_g = i + GW;
      const c0 = tmp0[i], c1 = tmp1[i], c2 = tmp2[i];
      arr0[i] = c0 + PD * (tmp0[im1] + tmp0[ip1] + tmp0[im_g] + tmp0[ip_g] - 4 * c0);
      arr1[i] = c1 + PD * (tmp1[im1] + tmp1[ip1] + tmp1[im_g] + tmp1[ip_g] - 4 * c1);
      arr2[i] = c2 + PD * (tmp2[im1] + tmp2[ip1] + tmp2[im_g] + tmp2[ip_g] - 4 * c2);
    }
  }
}

// ============================================================
// TRANSFER PIGMENT (§4.5) — adsorption / desorption with granulation γ
// ============================================================
function transferPigment() {
  if (activeRectIsEmpty()) return;
  // Fused single pass: 3 pigments handled inline per cell.
  // The pigment-specific constants are hoisted to locals so V8 can keep
  // them in registers across the inner loop instead of refetching from
  // the PIGMENTS array on every iteration.
  const p0 = PIGMENTS[0], p1 = PIGMENTS[1], p2 = PIGMENTS[2];
  const den0 = p0.density, sta0 = p0.staining, gra0 = p0.granulation;
  const den1 = p1.density, sta1 = p1.staining, gra1 = p1.granulation;
  const den2 = p2.density, sta2 = p2.staining, gra2 = p2.granulation;
  const g0 = g[0], g1 = g[1], g2 = g[2];
  const d0 = d[0], d1 = d[1], d2 = d[2];
  const y0 = Math.max(0, activeMinY);
  const y1 = Math.min(GH - 1, activeMaxY);
  const x0 = Math.max(0, activeMinX);
  const x1 = Math.min(GW - 1, activeMaxX);
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    const rowMaybeMasked = maskActive &&
                           y >= maskRectMinY && y <= maskRectMaxY;
    for (let x = x0; x <= x1; x++) {
      const i = yo + x;
      // Masked cells: no g↔d transfer. Frozen.
      if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
          mask[i] > MASK_THRESHOLD) continue;
      if (wet[i] < 0.04) continue;
      const h = paperH[i];
      const hg0 = 1 - h * gra0, hg1 = 1 - h * gra1, hg2 = 1 - h * gra2;
      const hu0 = 1 + (h - 1) * gra0, hu1 = 1 + (h - 1) * gra1, hu2 = 1 + (h - 1) * gra2;

      // pigment 0
      let gi = g0[i], di = d0[i];
      let down = gi * hg0 * den0;
      let up   = di * hu0 * den0 / sta0;
      if (down < 0) down = 0;
      if (up   < 0) up   = 0;
      if (di + down > 1) down = 1 - di > 0 ? 1 - di : 0;
      if (gi + up   > 1) up   = 1 - gi > 0 ? 1 - gi : 0;
      d0[i] = di + down - up;
      g0[i] = gi + up   - down;

      // pigment 1
      gi = g1[i]; di = d1[i];
      down = gi * hg1 * den1;
      up   = di * hu1 * den1 / sta1;
      if (down < 0) down = 0;
      if (up   < 0) up   = 0;
      if (di + down > 1) down = 1 - di > 0 ? 1 - di : 0;
      if (gi + up   > 1) up   = 1 - gi > 0 ? 1 - gi : 0;
      d1[i] = di + down - up;
      g1[i] = gi + up   - down;

      // pigment 2
      gi = g2[i]; di = d2[i];
      down = gi * hg2 * den2;
      up   = di * hu2 * den2 / sta2;
      if (down < 0) down = 0;
      if (up   < 0) up   = 0;
      if (di + down > 1) down = 1 - di > 0 ? 1 - di : 0;
      if (gi + up   > 1) up   = 1 - gi > 0 ? 1 - gi : 0;
      d2[i] = di + down - up;
      g2[i] = gi + up   - down;
    }
  }
}

// ============================================================
// EVAPORATION — water slowly leaves the paper
// When a cell goes dry, any suspended pigment locks in as deposited.
// ============================================================
// v0.19 — tunable evaporation rate. Each sim step multiplies wet[i] by
// evaporationRate. The default 0.9988 is the original Curtis-style
// value (water half-life ~578 sim steps ≈ ~9.5 seconds at 60fps).
// The Evaporation slider scales this toward 1.0 (slower) or away from
// it (faster). Faster evaporation cuts the active rect sooner, which
// reclaims sim cost — useful for heavy animations/visualizations at
// the cost of less wet-on-wet bleed and softer edges.
//
// Slider value `mult` (1×..50×) maps to: rate = pow(0.9988, mult).
// At mult=1 we get the original 0.9988; at mult=10 we get ~0.988
// (half-life ~58 steps); at mult=50 we get ~0.94 (half-life ~11 steps).
let evaporationRate = 0.9988;

function evaporate() {
  // v0.19 — mask-rect optimization. Branch ONCE on whether any mask
  // exists at all, then either run a fast path with no mask logic, or
  // a path that checks each cell against the (typically tiny) mask
  // rect. The old code did `maskActive && mask[i] > MASK_THRESHOLD`
  // on every one of N cells (whole grid, not active rect), even when
  // a mask only covered a small region.
  if (!maskActive) {
    for (let i = 0; i < N; i++) {
      let w = wet[i] * evaporationRate;
      if (w < 0.025) {
        for (let k = 0; k < 3; k++) {
          let nd = d[k][i] + g[k][i];
          if (nd > MAX_PIGMENT) nd = MAX_PIGMENT;
          d[k][i] = nd;
          g[k][i] = 0;
        }
        w = 0;
        u[i] = 0; v[i] = 0;
      }
      wet[i] = w;
    }
  } else {
    // Mask exists. Two-region pass: cells inside the mask rect get the
    // per-cell check; cells outside skip directly to the fast path.
    // This is the v0.19 win — mask checks are restricted to a small
    // sub-area instead of running across the whole grid.
    for (let y = 0; y < GH; y++) {
      const rowMaybeMasked = (y >= maskRectMinY && y <= maskRectMaxY);
      const yo = y * GW;
      for (let x = 0; x < GW; x++) {
        const i = yo + x;
        if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD) continue;
        let w = wet[i] * evaporationRate;
        if (w < 0.025) {
          for (let k = 0; k < 3; k++) {
            let nd = d[k][i] + g[k][i];
            if (nd > MAX_PIGMENT) nd = MAX_PIGMENT;
            d[k][i] = nd;
            g[k][i] = 0;
          }
          w = 0;
          u[i] = 0; v[i] = 0;
        }
        wet[i] = w;
      }
    }
  }
}

// ============================================================
// SIM STEP
// Two toggles (see UI wiring below) gate the relevant sub-steps:
//   edgeDarkeningEnabled — when off, the §4.3.3 outward-flow pressure
//     reduction is skipped entirely. Useful for isolating which marks
//     come from edge darkening vs. natural diffusion/advection.
//   dryingPaused         — when on, evaporation is skipped, so the
//     canvas holds its current wetness indefinitely (whatever that
//     happens to be — fully wet, partially dry, or anywhere between).
// ============================================================
let edgeDarkeningEnabled = true;
let dryingPaused = false;

// ============================================================
// WET DIFFUSION (added v0.8) — water spreads to adjacent cells
// over time, modeling capillary action through paper fibers.
// ============================================================
// Without this, paintAt's wet bump stays confined to the brush
// footprint, so on dry paper each brush stamp creates an island
// of wet trapped inside dry surroundings. Pigment can move within
// the island but can't cross the wet→dry boundary, so brush stamps
// show as hard-edged stamps. With wet diffusion, the wet itself
// expands outward, creating a soft halo ahead of the pigment so
// dry-paper strokes get the same soft falloff as wet-on-wet strokes.
//
// Standard Laplacian diffusion: each cell exchanges with its 4
// neighbors based on the local gradient. Conserves total wet
// (in the interior); boundary cells are skipped. Coefficient 0.10
// is tuned so that a 0.45-wet brush center transfers 0.045 to each
// neighbor per step, just clearing the wet >= 0.04 threshold so
// the rest of the sim picks up those cells as active. Stability
// bound for an explicit 4-neighbor scheme is 0.25; we're well under.
// SCALE-derived: same scaling as PIGMENT_DIFFUSION. At SCALE_REF (s=1)
// gives 0.10, the v0.8 baseline tuned so a 0.45 wet brush stamp
// transfers ~0.045 to neighbors per step — just clearing the wet >= 0.04
// threshold needed for the rest of the sim to flow pigment into them.
let WET_DIFFUSION = Math.min(0.20, 0.10 * inv_s2);

function diffuseWet() {
  if (activeRectIsEmpty()) return;
  wet_tmp.set(wet);
  const k = WET_DIFFUSION;
  const y0 = Math.max(1, activeMinY);
  const y1 = Math.min(GH - 2, activeMaxY);
  const x0 = Math.max(1, activeMinX);
  const x1 = Math.min(GW - 2, activeMaxX);
  for (let y = y0; y <= y1; y++) {
    const yo = y * GW;
    const rowMaybeMasked = maskActive &&
                           y >= maskRectMinY && y <= maskRectMaxY;
    for (let x = x0; x <= x1; x++) {
      const i = yo + x;
      // Masked cells are frozen — wet can't diffuse into or out of them.
      if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
          mask[i] > MASK_THRESHOLD) continue;
      // Skip cells with no wet anywhere in the 5-cell stencil — the
      // Laplacian is zero, no change would result. This is the common
      // case in unpainted areas.
      const c  = wet_tmp[i];
      const wa = wet_tmp[i - 1],  wb = wet_tmp[i + 1];
      const wc = wet_tmp[i - GW], wd = wet_tmp[i + GW];
      if (c < 1e-6 && wa < 1e-6 && wb < 1e-6 && wc < 1e-6 && wd < 1e-6) continue;
      wet[i] = c + k * (wa + wb + wc + wd - 4 * c);
    }
  }
}

function simStep() {
  // v0.10 — top-level early return when nothing is active. Each sub-step
  // already early-returns on empty rect, but the function-call overhead
  // for 5 dispatched calls × 2 simSteps × 60 fps adds up at idle. This
  // one check skips them all. evaporate is intentionally NOT gated:
  // global drying continues even with no active region so the "wet
  // canvas" surface dries down over time as expected.
  if (activeRectIsEmpty()) {
    if (!dryingPaused) evaporate();
    return;
  }
  diffuseWet();
  if (edgeDarkeningEnabled) applyEdgeDarkening();
  updateVelocity();
  movePigment();
  transferPigment();
  if (!dryingPaused) evaporate();
}

// ============================================================
// KUBELKA–MUNK COMPOSITING (§5)
// Returns reflectance R of a layer of given thickness x with
// weighted K and S, composited over a paper background of
// reflectance Rbg, for a single wavelength channel.
// ============================================================
function kmReflect(K, S, x, Rbg) {
  if (S < 1e-5) S = 1e-5;
  const a = 1 + K / S;
  const b = Math.sqrt(Math.max(0, a * a - 1));
  let bSx = b * S * x;
  if (bSx > 12) bSx = 12; // prevents sinh/cosh overflow; visually equivalent
  const sh = Math.sinh(bSx);
  const ch = Math.cosh(bSx);
  const denom = a * sh + b * ch;
  if (denom < 1e-9) return 0;
  const Rlayer = sh / denom;
  const Tlayer = b  / denom;
  let R = Rlayer + (Tlayer * Tlayer * Rbg) / (1 - Rlayer * Rbg);
  if (R < 0) R = 0; else if (R > 1) R = 1;
  return R;
}

// ============================================================
// RENDER — KM compositing per cell, then upscale to display canvas
// ============================================================
const renderCanvas = document.createElement('canvas');
renderCanvas.width  = GW;
renderCanvas.height = GH;
const renderCtx = renderCanvas.getContext('2d');
let imgData = renderCtx.createImageData(GW, GH);

// canvas is declared at the top of the factory (per-instance,
// mounted inside targetEl). Size it here and create the 2D context
// the render path uses.
canvas.width  = DISPLAY_W;
canvas.height = DISPLAY_H;
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';

// Paper base colors per channel (warm cream). Mutable so the paper
// picker UI can change them at runtime — every site that uses them
// (the render loop's KM substrate, the swatch canvases, the cursor
// color computation) re-reads on demand, so a reassignment plus a
// swatch rebuild is all that's needed to recolor the paper.
let PAPER_R_BASE = 0.985;
let PAPER_G_BASE = 0.965;
let PAPER_B_BASE = 0.918;

// render(forceFull=false) — write RGBA pixels to imgData, then push to
// renderCanvas and scale to the display canvas.
//
// v0.10 localization: when the active rect is non-empty and forceFull
// is false, the per-cell KM/alpha loop iterates only over the active
// rect. Cells outside the rect have frozen state (active rect tracks
// all dynamics by definition), so the imgData bytes left over from
// when they WERE rendered still match their current sim state.
//
// putImageData transfers the full imgData buffer each call regardless
// — its cost is a memcpy, dwarfed by the per-cell KM math we just
// avoided. The scale to the display canvas is GPU work, also fixed.
//
// forceFull is set by callers that change something which affects
// pixels outside the active rect — currently just paper color change.
// The "Transparent" toggle only changes body CSS, not canvas pixels.
function render(forceFull) {
  const data = imgData.data;
  const P0 = PIGMENTS[0], P1 = PIGMENTS[1], P2 = PIGMENTS[2];

  // Alpha fade-in for the lowest pigment amounts. Cells with xt above
  // this threshold render fully opaque (so painted regions look exactly
  // the way they would over an opaque cream canvas — KM math unchanged);
  // cells with xt = 0 go fully transparent (body color shows through);
  // a thin transition band gives anti-aliased edges instead of a hard cut.
  const ALPHA_FULL_AT = 0.012;
  const ALPHA_SCALE = 255 / ALPHA_FULL_AT;

  // Determine iteration bounds. Empty rect + !forceFull = skip the per-cell
  // loop entirely; imgData is already correct for the frozen state, so
  // pushing it again would just waste a memcpy + draw.
  let yStart, yEnd, xStart, xEnd, isFull;
  if (forceFull) {
    yStart = 0; yEnd = GH - 1;
    xStart = 0; xEnd = GW - 1;
    isFull = true;
  } else if (activeRectIsEmpty()) {
    return;
  } else {
    yStart = Math.max(0, activeMinY);
    yEnd   = Math.min(GH - 1, activeMaxY);
    xStart = Math.max(0, activeMinX);
    xEnd   = Math.min(GW - 1, activeMaxX);
    isFull = (yStart === 0 && yEnd === GH - 1 && xStart === 0 && xEnd === GW - 1);
  }

  // Hoist the array refs once. The original loop accessed g[k][i] via
  // two-level lookup; localized or not, the cached refs help.
  const g0 = g[0], g1 = g[1], g2 = g[2];
  const d0 = d[0], d1 = d[1], d2 = d[2];

  for (let y = yStart; y <= yEnd; y++) {
    const yo = y * GW;
    // v0.19 — mask rect optimization. Outside the mask rect's row
    // range, the mask tint branch can be skipped entirely without
    // even loading mask[i] for cells in this row.
    const rowMaybeMasked = maskActive &&
                           y >= maskRectMinY && y <= maskRectMaxY;
    for (let x = xStart; x <= xEnd; x++) {
      const i = yo + x;

      const x0 = g0[i] + d0[i];
      const x1 = g1[i] + d1[i];
      const x2 = g2[i] + d2[i];
      const xt = x0 + x1 + x2;
      const ph = paperH[i];

      // Paper texture: subtle warm variation
      const tex = (ph - 0.5) * 0.06;
      const PR = PAPER_R_BASE + tex;
      const PG = PAPER_G_BASE + tex;
      const PB = PAPER_B_BASE + tex;

      let R, G, B;

      if (xt < 0.004) {
        // Just paper (with possible dampness sheen)
        const dampSheen = wet[i] * 0.018;
        R = PR + dampSheen;
        G = PG + dampSheen;
        B = PB + dampSheen * 1.2;
      } else {
        const inv = 1 / xt;
        const w0 = x0 * inv, w1 = x1 * inv, w2 = x2 * inv;
        // Weighted K and S
        const Kr = P0.K[0]*w0 + P1.K[0]*w1 + P2.K[0]*w2;
        const Kg = P0.K[1]*w0 + P1.K[1]*w1 + P2.K[1]*w2;
        const Kb = P0.K[2]*w0 + P1.K[2]*w1 + P2.K[2]*w2;
        const Sr = P0.S[0]*w0 + P1.S[0]*w1 + P2.S[0]*w2;
        const Sg = P0.S[1]*w0 + P1.S[1]*w1 + P2.S[1]*w2;
        const Sb = P0.S[2]*w0 + P1.S[2]*w1 + P2.S[2]*w2;

        const thickness = xt < 4 ? xt : 4;

        R = kmReflect(Kr, Sr, thickness, PR);
        G = kmReflect(Kg, Sg, thickness, PG);
        B = kmReflect(Kb, Sb, thickness, PB);
      }

      // Alpha: pigment thickness determines opacity in the body-bg-shows-
      // through scheme. Saturated cells are fully opaque, sparse cells
      // anti-alias against the page background.
      let alpha = xt >= ALPHA_FULL_AT ? 255 : (xt * ALPHA_SCALE);

      // v0.13.1 — translucent diffused masking-fluid tint. Computed AFTER
      // the normal KM/paper render so the user sees through the mask to
      // whatever pigment + paper is underneath, with a warm yellow shift.
      //
      // The blend amount ramps continuously with mask[i]: very lightly
      // masked cells (just over threshold) get a faint hint; fully masked
      // cells get the strongest tint, capped at MASK_TINT_PEAK so even
      // dense mask never fully obscures the pigment beneath. Soft edges
      // fall out of the brush stamp's natural falloff — neighboring cells
      // have smoothly varying mask values, and the visual scales with them.
      if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
          mask[i] > MASK_THRESHOLD) {
        const maskVis = Math.min(1,
          (mask[i] - MASK_THRESHOLD) / (MASK_VISUAL_FULL - MASK_THRESHOLD));
        const tb = maskVis * MASK_TINT_PEAK;
        // Pale warm yellow (masking-fluid amber). Same hue as the swatch.
        R = R * (1 - tb) + 0.96 * tb;
        G = G * (1 - tb) + 0.86 * tb;
        B = B * (1 - tb) + 0.42 * tb;
        // Boost alpha so masked-but-unpainted cells stay visible — but
        // cap below 255 so the mask itself reads as slightly translucent
        // (body bg shows through faintly when in transparent-canvas mode).
        const maskAlpha = maskVis * 215;
        if (maskAlpha > alpha) alpha = maskAlpha;
      }

      const j = i * 4;
      data[j]     = R * 255;
      data[j + 1] = G * 255;
      data[j + 2] = B * 255;
      data[j + 3] = alpha;
    }
  }

  // Push to renderCanvas. dirtyRect form of putImageData transfers only
  // the active sub-region — useful when localized, no-op when full.
  if (isFull) {
    renderCtx.putImageData(imgData, 0, 0);
  } else {
    const dw = xEnd - xStart + 1;
    const dh = yEnd - yStart + 1;
    renderCtx.putImageData(imgData, 0, 0, xStart, yStart, dw, dh);
  }
  // Clear the display canvas so transparent regions of the new frame
  // don't blend over stale pixels from the previous frame.
  ctx.clearRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.drawImage(renderCanvas, 0, 0, DISPLAY_W, DISPLAY_H);
}

// ============================================================
// PAINT BRUSH
// ============================================================
function paintAt(gx, gy, gridRadius, pigmentIdx, strength) {
  // v2 — Scale gridRadius by the canvas-size factor so brushes from
  // animations/visualizations stay visually proportional on small
  // canvases. _canvasScale is 1.0 for canvases ≥ REFERENCE_DISPLAY_W.
  gridRadius *= _canvasScale;
  markCanvasActive();  // wake the sim if it was idle
  expandActiveRect(gx, gy, gridRadius);  // grow active region to cover this stamp
  const r = gridRadius;
  const r2 = r * r;
  const minX = Math.max(0, Math.floor(gx - r));
  const maxX = Math.min(GW - 1, Math.ceil(gx + r));
  const minY = Math.max(0, Math.floor(gy - r));
  const maxY = Math.min(GH - 1, Math.ceil(gy + r));

  // Masking fluid (v0.13). Deposits mask into the mask[] array.
  // Doesn't add wet, doesn't add pressure — masking fluid is a passive
  // resist applied on top of the paper. Once any cell crosses
  // MASK_THRESHOLD, maskActive is set so sim functions know to test.
  if (pigmentIdx === MASK_INDEX) {
    let anyAboveThreshold = false;
    // v0.19 — track bounds of cells that cross the threshold for the
    // mask-rect optimization. minX/maxX etc. local to this branch are
    // the brush footprint (paintAt arg); we accumulate which of those
    // actually became masked into the global maskRect.
    let rMinX = GW, rMaxX = -1, rMinY = GH, rMaxY = -1;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - gx, dy = py - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = py * GW + px;
        const falloff = 1 - Math.sqrt(d2) / r;
        // Accumulate mask deposit, capped at 1. Strength scales how
        // quickly a single stamp builds — at strength=0.5, two dabs at
        // the brush center push above threshold.
        const m = mask[i] + falloff * strength;
        mask[i] = m > 1 ? 1 : m;
        if (mask[i] > MASK_THRESHOLD) {
          anyAboveThreshold = true;
          if (px < rMinX) rMinX = px;
          if (px > rMaxX) rMaxX = px;
          if (py < rMinY) rMinY = py;
          if (py > rMaxY) rMaxY = py;
        }
      }
    }
    if (anyAboveThreshold) {
      maskActive = true;
      // Expand the global mask rect to include the freshly-masked cells.
      if (rMinX < maskRectMinX) maskRectMinX = rMinX;
      if (rMaxX > maskRectMaxX) maskRectMaxX = rMaxX;
      if (rMinY < maskRectMinY) maskRectMinY = rMinY;
      if (rMaxY > maskRectMaxY) maskRectMaxY = rMaxY;
    }
    return;
  }

  // Water brush: no pigment added. Adds water + pressure (drives bleed)
  // and lifts a fraction of deposited pigment back into suspension at
  // each touched cell — same desorption shortcut the global re-wet
  // button uses, but localized. This lets a clean wet brush re-mobilize
  // dry pigment for blending, softening edges, or washing out.
  if (pigmentIdx === WATER_INDEX) {
    // v0.22 — water-load multiplier. Scales all three water-brush
    // deposits together (wet, pressure, lift) so the user can dial
    // "wetter" or "drier" water with a single control. The lift
    // amount has to be clamped to 1.0 because it's a fraction (you
    // can't lift more than 100% of what's there); the wet+pressure
    // values clamp via the existing per-cell maxima.
    const wetGain  = 0.55 * waterLoadMult;
    const presGain = 0.18 * waterLoadMult;
    const liftGain = Math.min(1.0, 0.18 * waterLoadMult);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - gx, dy = py - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = py * GW + px;
        // Masked cells resist water — masking fluid is hydrophobic.
        if (maskActive && mask[i] > MASK_THRESHOLD) continue;
        const falloff = 1 - Math.sqrt(d2) / r;
        const f2 = falloff * falloff;
        const ww = wet[i] + wetGain * falloff;
        wet[i] = ww > 1 ? 1 : ww;
        pressure[i] += presGain * f2;
        // Localized lift of deposited pigment. Per-frame fraction is
        // gentler than the global re-wet (which is one-shot at 0.30);
        // here the user can hold/drag to escalate.
        const liftFrac = liftGain * f2;
        if (liftFrac > 0) {
          for (let k = 0; k < 3; k++) {
            const dval = d[k][i];
            if (dval < 0.001) continue;
            const lift = dval * liftFrac;
            d[k][i] = dval - lift;
            const nv = g[k][i] + lift;
            g[k][i] = nv > MAX_PIGMENT ? MAX_PIGMENT : nv;
          }
        }
      }
    }
    return;
  }

  // Lift brush: removes pigment (both suspended g and deposited d) from
  // each touched cell. Leaves wet and pressure alone — that way a drag
  // doesn't create dry islands or drive flow; the cell's surroundings
  // stay intact and only the pigment in the touched area fades. Drag
  // and the subtraction compounds: at the brush center (f²=1) a single
  // dab keeps 1 − 0.22 = 78%, five dabs keep 28%, ten dabs keep 8%.
  if (pigmentIdx === LIFT_INDEX) {
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - gx, dy = py - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = py * GW + px;
        // Masked cells keep their pigment frozen — lift can't reach it.
        if (maskActive && mask[i] > MASK_THRESHOLD) continue;
        const falloff = 1 - Math.sqrt(d2) / r;
        const f2 = falloff * falloff;
        const subFrac = 0.22 * f2;
        if (subFrac <= 0) continue;
        const keep = 1 - subFrac;
        for (let k = 0; k < 3; k++) {
          g[k][i] *= keep;
          d[k][i] *= keep;
        }
      }
    }
    return;
  }

  // Rainbow brush — same dynamics as a regular pigment brush, but the
  // strength is split across all three g[] arrays weighted by the
  // current cycle position. Weights are computed once per paintAt call
  // (not per cell), so every cell in this stamp gets the same color
  // mix; the color cycles between stamps over time.
  if (pigmentIdx === RAINBOW_INDEX) {
    updateRainbowWeights(performance.now());
    const w0 = rainbowW[0], w1 = rainbowW[1], w2 = rainbowW[2];
    const g0 = g[0], g1 = g[1], g2 = g[2];
    // v0.22.2 — hoist water-load-scaled gains outside the inner loop.
    // Previously these multiplications ran per-cell; now they're
    // computed once per paintAt call. Equivalent math, fewer ops in
    // the stamp's hot path.
    const wetGain  = 0.45 * waterLoadMult;
    const presGain = 0.18 * waterLoadMult;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - gx, dy = py - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = py * GW + px;
        // Masked cells reject pigment.
        if (maskActive && mask[i] > MASK_THRESHOLD) continue;
        const falloff = 1 - Math.sqrt(d2) / r;
        const f2 = falloff * falloff;
        const add = strength * f2;
        // Per-pigment deposit, weighted. Each pigment is independently
        // clamped to MAX_PIGMENT — a saturated cell of one pigment
        // doesn't block deposits of the other two.
        let na = g0[i] + add * w0; if (na > MAX_PIGMENT) na = MAX_PIGMENT; g0[i] = na;
            na = g1[i] + add * w1; if (na > MAX_PIGMENT) na = MAX_PIGMENT; g1[i] = na;
            na = g2[i] + add * w2; if (na > MAX_PIGMENT) na = MAX_PIGMENT; g2[i] = na;
        // wet + pressure scale with waterLoadMult — see hoisted gains
        // above. The per-cell wet cap at 1.0 still applies; pressure
        // has no cap so it directly drives stronger flow.
        const ww = wet[i] + wetGain * falloff;
        wet[i] = ww > 1 ? 1 : ww;
        pressure[i] += presGain * f2;
      }
    }
    return;
  }

  const arr = g[pigmentIdx];
  // v0.22.2 — hoist water-load-scaled gains outside the inner loop,
  // matching the rainbow + water branches above.
  const pigWetGain  = 0.45 * waterLoadMult;
  const pigPresGain = 0.18 * waterLoadMult;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const dx = px - gx, dy = py - gy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const i = py * GW + px;
      // Masked cells reject pigment — that's the whole point of mask.
      if (maskActive && mask[i] > MASK_THRESHOLD) continue;
      const falloff = 1 - Math.sqrt(d2) / r;
      const f2 = falloff * falloff;
      let na = arr[i] + strength * f2;
      if (na > MAX_PIGMENT) na = MAX_PIGMENT;
      arr[i] = na;
      // wet + pressure scale with waterLoadMult — see hoisted gains above.
      const ww = wet[i] + pigWetGain * falloff;
      wet[i] = ww > 1 ? 1 : ww;
      pressure[i] += pigPresGain * f2;
    }
  }
}

// ============================================================
// INITIAL STATE — wet canvas + two splotches close but separate
// ============================================================
function placeInitialSplotch(cx, cy, radius, pigmentIdx) {
  const r2 = radius * radius;
  for (let py = Math.max(0, cy - radius); py <= Math.min(GH - 1, cy + radius); py++) {
    for (let px = Math.max(0, cx - radius); px <= Math.min(GW - 1, cx + radius); px++) {
      const dx = px - cx, dy = py - cy;
      const dd = dx * dx + dy * dy;
      if (dd > r2) continue;
      const i = py * GW + px;
      const falloff = 1 - Math.sqrt(dd) / radius;
      const ff = falloff * falloff;
      g[pigmentIdx][i] += 0.62 * ff;
      wet[i] = Math.max(wet[i], 0.92);
      pressure[i] += 0.08 * ff;
    }
  }
}

function resetSim() {
  markCanvasActive();
  for (let i = 0; i < N; i++) {
    // The whole canvas is uniformly wet — this is the "wet" canvas
    wet[i] = 0.62;
    u[i] = 0; v[i] = 0; pressure[i] = 0;
    g[0][i] = g[1][i] = g[2][i] = 0;
    d[0][i] = d[1][i] = d[2][i] = 0;
    mask[i] = 0;
  }
  maskActive = false;
  clearMaskRect();
  // Uniform wet + zero pigment + zero pressure = no dynamics anywhere.
  // Empty active rect → simStep functions early-return until paintAt grows it.
  setActiveRectEmpty();
  // v0.10 — clear cached imgData and display canvas. With localized render,
  // the imgData buffer retains pixels from cells that were last rendered
  // while inside the active rect. Without this clear, putImageData on the
  // next localized render would push those stale pixels back onto
  // renderCanvas, where they'd remain visible outside the new active rect.
  // The display canvas needs clearing too — drawImage doesn't repaint the
  // pixels we're not putting imgData into.
  imgData.data.fill(0);
  renderCtx.clearRect(0, 0, GW, GH);
  ctx.clearRect(0, 0, DISPLAY_W, DISPLAY_H);
  // Canvas starts blank. placeInitialSplotch() remains available for
  // library users who want to seed pigment programmatically at startup.
}

// rebuildScale — live resolution change. Reallocates every state array
// at the new grid size, re-derives the scale-dependent constants, and
// resizes the canvases. Called by the Resolution slider on `change`.
// The rAF loop is single-threaded with the event handler, so this runs
// safely between frames; the next loop tick picks up the new state.
function rebuildScale(newScale) {
  SCALE = newScale;
  s_scale = SCALE / SCALE_REF;
  inv_s = 1 / s_scale;
  inv_s2 = inv_s * inv_s;

  GW = Math.max(120, Math.floor(_innerWidth()  * CANVAS_OVERSCAN / SCALE));
  GH = Math.max(80,  Math.floor(_innerHeight() * CANVAS_OVERSCAN / SCALE));
  N = GW * GH;
  DISPLAY_W = Math.round(GW * SCALE);
  DISPLAY_H = Math.round(GH * SCALE);
  // v2 — re-compute canvas-scale factor for the new display size.
  _canvasScale = Math.min(1.0, DISPLAY_W / REFERENCE_DISPLAY_W);
  if (typeof options.canvasScale === 'number' && options.canvasScale > 0) {
    _canvasScale = options.canvasScale;
  }

  // Re-derive the scale-dependent constants. These mirror the inline
  // initializations at the top of the script — keep the formulas in sync.
  PIGMENT_DIFFUSION = Math.min(0.20, 0.045 * inv_s2);
  WET_DIFFUSION     = Math.min(0.20, 0.10 * inv_s2);
  EDGE_KERNEL       = Math.max(1, Math.round(4 * inv_s));
  EDGE_KERNEL_LARGE = Math.max(1, Math.round(20 * inv_s));
  VEL_CLAMP         = Math.min(1.5, 1.0 * inv_s);

  // Reallocate every state array at the new size. JS GC will collect
  // the old ones once nothing references them; closures inside functions
  // resolve identifiers at call time so they'll pick up the new arrays.
  wet      = new Float32Array(N);
  wet_tmp  = new Float32Array(N);
  wetBlur  = new Float32Array(N);
  wetBlurLarge = new Float32Array(N);
  wetBlurTmp = new Float32Array(N);
  wetBinary = new Float32Array(N);
  u        = new Float32Array(N);
  v        = new Float32Array(N);
  u_new    = new Float32Array(N);
  v_new    = new Float32Array(N);
  pressure = new Float32Array(N);
  paperH   = new Float32Array(N);
  g     = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  d     = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  g_tmp = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  mask  = new Float32Array(N);
  maskActive = false;
  clearMaskRect();

  // Resize the render and display canvases, then reallocate imgData.
  renderCanvas.width  = GW;
  renderCanvas.height = GH;
  imgData = renderCtx.createImageData(GW, GH);
  canvas.width  = DISPLAY_W;
  canvas.height = DISPLAY_H;

  // v0.20 — also resize the GPU canvas and textures if WebGL is active.
  // gpuOnResize is a no-op when WebGL hasn't been initialized.
  if (typeof gpuOnResize === 'function') gpuOnResize();

  // Any paint event queued at the old grid coordinates is stale; clear
  // it. _lastGX/Y referenced the old grid too — reset to 0.
  if (typeof _pendingPaintX !== 'undefined') {
    _pendingPaintX = null; _pendingPaintY = null;
    _lastGX = 0; _lastGY = 0;
  }

  // Regenerate paper texture at the new resolution and reset state.
  generatePaper();
  resetSim();
  // Force a render so the new canvas is visible immediately, even if
  // the sim is currently idle.
  render();
  // v2 — dispatch a 'rescaled' event so the host UI can react
  // (e.g. rebuild pigment swatches that depend on the new paper).
  targetEl.dispatchEvent(new CustomEvent('rescaled', {
    detail: { scale: SCALE, gridWidth: GW, gridHeight: GH }
  }));
}

// Re-wet: raise water saturation back to a high baseline everywhere, and
// lift a fraction of deposited pigment back into suspension so dried
// strokes become mobile again. The §4.5 desorption rate is too slow to
// feel responsive on its own, so we shortcut by moving 30% of d → g.
const REWET_LEVEL = 0.85;
const REWET_LIFT  = 0.30;
function rewet() {
  markCanvasActive();
  // d→g transfer happens wherever d>0 — could be anywhere on the canvas.
  // Set rect full and let the next periodic shrink scan tighten it back
  // to the actual bounding box of newly-suspended pigment.
  setActiveRectFull();
  for (let i = 0; i < N; i++) {
    // Masked cells: stay frozen. Mask is waterproof; re-wet washes
    // around them.
    if (maskActive && mask[i] > MASK_THRESHOLD) continue;
    if (wet[i] < REWET_LEVEL) wet[i] = REWET_LEVEL;
    for (let k = 0; k < 3; k++) {
      const dval = d[k][i];
      if (dval < 0.001) continue;
      const lift = dval * REWET_LIFT;
      d[k][i] = dval - lift;
      const nv = g[k][i] + lift;
      g[k][i] = nv > MAX_PIGMENT ? MAX_PIGMENT : nv;
    }
  }
}

// v0.24 — Splash: a dramatic re-wet that creates real pigment dispersal.
// v0.25 — extended with presets ('bigSplash' / 'fineSpritz' / 'default')
//         and explicit-coordinate support for choreographed splashes.
//
// Where re-wet quietly soaks the canvas and gently lifts pigment, splash
// is an *event*: it picks several epicenters (biased toward where the
// densest pigment lives — unless explicit coords are passed), saturates
// the wet field, lifts most of the deposited pigment back into suspension,
// and injects outward-radial velocity + a pressure spike from each
// epicenter. The sim's existing advection + diffusion takes over from
// there and runs the dispersal forward over ~2 seconds.
//
// Why this works visually: re-wet doesn't make pigment *move* — it just
// makes pigment *mobile*. Splash adds the missing ingredient: a real
// flow field. Pigment that was sitting still now has somewhere to go,
// pushed outward from each epicenter, mixing with neighboring colors,
// pooling at edges, behaving like real watercolor under a splash.

// Preset definitions. Each preset bundles the parameter space into one
// name so callers don't have to think about radius/velocity/pressure
// independently. The "default" preset is the v0.24 baseline; "bigSplash"
// pumps everything up for whole-canvas chaos; "fineSpritz" goes the
// other way — many small concentrated bursts, like flicking water onto
// the painting from a brush.
const SPLASH_PRESETS = {
  default: {
    lift:        0.80,   // fraction of deposited → suspended
    wetLevel:    1.0,    // saturate the wet field
    velocity:    0.85,   // peak radial velocity at epicenter
    pressure:    0.45,   // peak pressure bump at epicenter
    radiusPx:    180,    // splash zone radius in display pixels
    epiMin:      3,
    epiMax:      7,
  },
  bigSplash: {
    lift:        0.85,
    wetLevel:    1.0,
    velocity:    1.10,
    pressure:    0.55,
    radiusPx:    280,
    epiMin:      4,
    epiMax:      8,
  },
  fineSpritz: {
    lift:        0.50,   // less violent — pigment stays largely in place
    wetLevel:    0.85,   // doesn't fully saturate; "spritz" not "soak"
    velocity:    0.50,
    pressure:    0.25,
    radiusPx:    80,     // small concentrated bursts
    epiMin:      8,
    epiMax:      15,
  },
};

// splash(opts?) — three calling forms:
//
//   splash()                          → default preset, random epicenters
//   splash('bigSplash')               → named preset, random epicenters
//   splash([{x, y}, ...])             → explicit coords, default preset
//   splash([{x, y}, ...], 'fineSpritz')  → explicit coords + preset
//   splash({coords: [...], preset: 'big...'})  → object form
//
// Per-point overrides: an epicenter may include `radius`, `velocity`,
// `pressure`, `lift` to override the preset values for just that point.
// Useful for choreographed splashes where one epicenter should be
// dramatic and another subtle.
function splash(arg1, arg2) {
  // -- Resolve calling form into a normalized {coords, preset} object.
  let coords = null;       // null = use random epicenters
  let presetName = 'default';

  if (typeof arg1 === 'string') {
    presetName = arg1;
  } else if (Array.isArray(arg1)) {
    coords = arg1;
    if (typeof arg2 === 'string') presetName = arg2;
  } else if (arg1 && typeof arg1 === 'object') {
    if (Array.isArray(arg1.coords)) coords = arg1.coords;
    if (typeof arg1.preset === 'string') presetName = arg1.preset;
  }

  const preset = SPLASH_PRESETS[presetName];
  if (!preset) {
    throw new Error('Watercolor.splash: unknown preset "' + presetName +
      '". Valid: ' + Object.keys(SPLASH_PRESETS).join(', '));
  }

  markCanvasActive();
  setActiveRectFull();

  // -- 1. Lift deposited → suspended, saturate wet.
  for (let i = 0; i < N; i++) {
    if (maskActive && mask[i] > MASK_THRESHOLD) continue;
    if (wet[i] < preset.wetLevel) wet[i] = preset.wetLevel;
    for (let k = 0; k < 3; k++) {
      const dval = d[k][i];
      if (dval < 0.001) continue;
      const lift = dval * preset.lift;
      d[k][i] = dval - lift;
      const nv = g[k][i] + lift;
      g[k][i] = nv > MAX_PIGMENT ? MAX_PIGMENT : nv;
    }
  }

  // -- 2. Pick epicenters. If caller passed coords, use those; otherwise
  //       rejection-sample from current pigment density.
  let epicenters;
  if (coords) {
    // Use exactly the points the caller specified, preserving any
    // per-point radius/velocity/pressure/lift overrides.
    epicenters = coords.map((pt) => ({
      x:        pt.x,
      y:        pt.y,
      radius:   pt.radius   ?? null,
      velocity: pt.velocity ?? null,
      pressure: pt.pressure ?? null,
      lift:     pt.lift     ?? null,
    }));
  } else {
    // Auto-pick. Same rejection-sampling logic as v0.24.
    const g0 = g[0], g1 = g[1], g2 = g[2];
    let maxPigment = 0;
    for (let i = 0; i < N; i++) {
      const p = g0[i] + g1[i] + g2[i];
      if (p > maxPigment) maxPigment = p;
    }
    const hasPigment = maxPigment > 0.05;

    const range = preset.epiMax - preset.epiMin;
    const numEpicenters = preset.epiMin + Math.floor(Math.random() * (range + 1));
    epicenters = [];
    for (let ec = 0; ec < numEpicenters; ec++) {
      let cx, cy;
      if (hasPigment) {
        let found = false;
        for (let tries = 0; tries < 200; tries++) {
          const i = Math.floor(Math.random() * N);
          const p = (g0[i] + g1[i] + g2[i]) / maxPigment;
          if (Math.random() < p) {
            cx = i % GW;
            cy = Math.floor(i / GW);
            found = true;
            break;
          }
        }
        if (!found) {
          cx = Math.floor(Math.random() * GW);
          cy = Math.floor(Math.random() * GH);
        }
      } else {
        cx = Math.floor(Math.random() * GW);
        cy = Math.floor(Math.random() * GH);
      }
      epicenters.push({ x: cx, y: cy, radius: null, velocity: null,
                        pressure: null, lift: null });
    }
  }

  // -- 3. Inject outward-radial velocity + pressure from each epicenter.
  //       Each epicenter resolves its own radius/velocity/pressure: per-
  //       point overrides win, otherwise fall back to the preset.
  const rect = canvas.getBoundingClientRect();
  const pxToGrid = GW / rect.width;

  for (const ec of epicenters) {
    const ecx = ec.x, ecy = ec.y;
    // Per-point overrides; if not set, use the preset's values.
    // v2 — scale radiusPx by canvas-size factor so splash zones stay
    // visually proportional on small canvases (matches paintAt scaling).
    const radiusPx = (ec.radius   != null ? ec.radius   : preset.radiusPx) * _canvasScale;
    const velMag   = ec.velocity != null ? ec.velocity : preset.velocity;
    const presMag  = ec.pressure != null ? ec.pressure : preset.pressure;
    const radiusGrid = radiusPx * pxToGrid;
    const r2 = radiusGrid * radiusGrid;
    const minX = Math.max(0, Math.floor(ecx - radiusGrid));
    const maxX = Math.min(GW - 1, Math.ceil(ecx + radiusGrid));
    const minY = Math.max(0, Math.floor(ecy - radiusGrid));
    const maxY = Math.min(GH - 1, Math.ceil(ecy + radiusGrid));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - ecx, dy = py - ecy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2 || d2 < 0.5) continue;
        const i = py * GW + px;
        if (maskActive && mask[i] > MASK_THRESHOLD) continue;
        const dist = Math.sqrt(d2);
        const falloff = 1 - dist / radiusGrid;
        const f2 = falloff * falloff;
        const inv = 1 / dist;
        const ux = dx * inv;
        const uy = dy * inv;
        u[i] += ux * velMag * f2;
        v[i] += uy * velMag * f2;
        pressure[i] += presMag * f2;
      }
    }
  }
}

function splashPresets() { return Object.keys(SPLASH_PRESETS); }

// Instant-dry: the inverse of rewet. Applies evaporate's dry-out rule
// unconditionally to every cell — all suspended pigment settles to
// deposited, water and flow zero out. After this, all cells are below
// the simulation's wet-threshold so the sim will idle out within a
// frame. We render explicitly so the damp-sheen disappears from
// unpainted cells immediately, without needing to wake the sim for 60
// grace frames just to flush a visual that won't change again.
//
// v2 lib note: in v0.26.2 this also called updateBars() to refresh the
// dryness/pigment indicator at the bottom of the panel. That UI is now
// a host concern — the wiring polls state() every 250ms. We dispatch a
// 'driedinstantly' event so a host that wants an immediate update
// (without waiting for the next poll) can listen.
function dryPaper() {
  for (let i = 0; i < N; i++) {
    // Masked cells: frozen. Dry button can't reach them.
    if (maskActive && mask[i] > MASK_THRESHOLD) continue;
    // Settle suspended → deposited (same rule evaporate uses)
    for (let k = 0; k < 3; k++) {
      let nd = d[k][i] + g[k][i];
      if (nd > MAX_PIGMENT) nd = MAX_PIGMENT;
      d[k][i] = nd;
      g[k][i] = 0;
    }
    wet[i] = 0;
    u[i] = 0; v[i] = 0;
    pressure[i] = 0;
  }
  // No wet, no suspended pigment, no pressure → no dynamics anywhere.
  setActiveRectEmpty();
  render();
  targetEl.dispatchEvent(new CustomEvent('driedinstantly'));
}

// Clear all masking-fluid in one pass. Real-world masking fluid is
// rubbed off when the painting dries — this is the digital equivalent.
// The frozen state under the mask is revealed (paper if mask was the
// first thing painted, or pigment if mask was painted over wet paint).
// Forces a full re-render because previously-masked cells need their
// pixels rewritten from the underlying state, and they may sit outside
// the current active rect.
function removeMask() {
  if (!maskActive) return;
  for (let i = 0; i < N; i++) mask[i] = 0;
  maskActive = false;
  clearMaskRect();
  // Force-full re-render: ex-masked cells reveal whatever was frozen
  // underneath, which the active-rect-localized render wouldn't catch
  // if those cells sit outside the rect.
  render(true);
}

// ANIMATION PRESETS — autonomous painting loops (v0.11)
// ============================================================
// Selectable via the Animation dropdown. Each mode is a self-contained
// step function called from the rAF loop; all modes share the user-
// facing paintAt path, so they can't bypass or desync from the sim.
//
// Modes:
//   'off'   — no animation
//   'ai'    — original AI painter (weighted stroke strategies; one
//             stroke at a time on a PLAN → STROKE → REST loop)
//   'rainy' — pool of up to RAIN_MAX_DROPS concurrent drops falling
//             from above; cool palette with occasional water lifts
//
// Adding a new preset: define a state variable + a `*Step` function,
// add a dispatch arm to animationStep(), and add an <option> to the
// dropdown. The dispatcher routes by string so additions stay local.

let animationMode = 'off';

// ----- AI PAINTER preset ------------------------------------------------
// Simple state machine: PLAN → STROKE → REST → PLAN.
// Each stroke picks a weighted strategy that constrains brush size,
// stroke length in grid cells, frame duration, and tool/pigment. The
// path is a quadratic Bezier with a perpendicular control-point offset
// so strokes have some natural curve.

let aiState = null;
// Average pigment per cell — updated each frame by updateBars.
// Shared with the AI planner so it can switch behavior based on canvas
// saturation without re-computing the sum.
let currentAvgPigment = 0;
// Above this saturation, the AI stops adding pigment and exclusively
// uses the water brush ('soften' strategy) — pushing existing paint
// around rather than piling more on a saturated canvas.
const AI_WATER_THRESHOLD = 0.75;

const AI_STRATEGIES = [
  // brushPx is display pixels (clamped to MAX_BRUSH at plan time).
  // dist is a fraction of min(GW, GH) → stroke length in grid cells.
  // dur is frame count for the whole stroke. pigment: null = random pigment.
  { name: 'mark',   weight: 3.0, brushPx: [ 20,  60], dist: [0.10, 0.35], dur: [25, 55], strength: 0.34, pigment: null         },
  { name: 'wash',   weight: 2.0, brushPx: [ 80, 200], dist: [0.20, 0.50], dur: [40, 80], strength: 0.30, pigment: null         },
  { name: 'detail', weight: 1.6, brushPx: [  8,  22], dist: [0.00, 0.05], dur: [ 8, 20], strength: 0.40, pigment: null         },
  { name: 'soften', weight: 1.0, brushPx: [ 40, 100], dist: [0.05, 0.25], dur: [25, 45], strength: 0.30, pigment: WATER_INDEX  },
  { name: 'lift',   weight: 0.6, brushPx: [ 30,  70], dist: [0.00, 0.10], dur: [15, 30], strength: 0.30, pigment: LIFT_INDEX   },
];
// Pre-cached soften strategy so we don't .find() it on every stroke
// once the canvas is saturated.
const AI_SOFTEN_STRATEGY = AI_STRATEGIES.find(s => s.name === 'soften');

function aiPickWeighted(items) {
  let total = 0;
  for (const it of items) total += it.weight;
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function aiGridRadius(brushPx) {
  // Same conversion the user's pointer handlers use, so AI strokes
  // and user strokes use identical brush footprints.
  const rect = canvas.getBoundingClientRect();
  return (brushPx / 2) * (GW / rect.width);
}

function aiPlanStroke() {
  // Saturated canvas → exclusively water brush. Dynamic: if pigment
  // later drops below threshold (lift brush, reset), AI returns to
  // normal weighted strategy selection.
  const strat = currentAvgPigment >= AI_WATER_THRESHOLD
    ? AI_SOFTEN_STRATEGY
    : aiPickWeighted(AI_STRATEGIES);

  // Brush size in display px, clamped to the slider's viewport max
  const bpMin = Math.min(strat.brushPx[0], MAX_BRUSH);
  const bpMax = Math.min(strat.brushPx[1], MAX_BRUSH);
  const brushPx = bpMin + Math.random() * (bpMax - bpMin);

  // Stroke endpoints in grid coordinates
  const minDim = Math.min(GW, GH);
  const distF = strat.dist[0] + Math.random() * (strat.dist[1] - strat.dist[0]);
  const distGrid = distF * minDim;

  // Bias the start point toward the canvas interior so strokes don't
  // always sail out off the edge
  const margin = 0.12;
  const sx = margin * GW + Math.random() * (1 - 2 * margin) * GW;
  const sy = margin * GH + Math.random() * (1 - 2 * margin) * GH;

  // Random direction; clamp the end inside canvas
  const angle = Math.random() * Math.PI * 2;
  let ex = sx + Math.cos(angle) * distGrid;
  let ey = sy + Math.sin(angle) * distGrid;
  ex = Math.max(0, Math.min(GW - 1, ex));
  ey = Math.max(0, Math.min(GH - 1, ey));

  // Perpendicular control-point offset → curved Bezier path
  const dx = ex - sx, dy = ey - sy;
  const curve = (Math.random() - 0.5) * 0.35;
  const cx = (sx + ex) / 2 + (-dy) * curve;
  const cy = (sy + ey) / 2 + ( dx) * curve;

  const duration = Math.floor(
    strat.dur[0] + Math.random() * (strat.dur[1] - strat.dur[0])
  );

  const pigment = strat.pigment !== null
    ? strat.pigment
    : Math.floor(Math.random() * PIGMENTS.length);

  return {
    phase: 'stroke',
    progress: 0,
    duration,
    sx, sy, cx, cy, ex, ey,
    pigment, brushPx,
    strength: strat.strength,
  };
}

function aiStep() {
  if (animationMode !== 'ai') return;
  if (!aiState) { aiState = aiPlanStroke(); return; }

  if (aiState.phase === 'stroke') {
    aiState.progress++;
    if (aiState.progress > aiState.duration) {
      // ~18% of strokes are followed by a long pause so the canvas has
      // time to dry between bursts of activity; the rest are short rests.
      const longRest = Math.random() < 0.18;
      aiState = {
        phase: 'rest',
        framesLeft: longRest
          ? 120 + Math.floor(Math.random() * 240)
          : 8   + Math.floor(Math.random() *  60),
      };
      return;
    }
    const t = aiState.progress / aiState.duration;
    const u = 1 - t;
    const x = u*u*aiState.sx + 2*u*t*aiState.cx + t*t*aiState.ex;
    const y = u*u*aiState.sy + 2*u*t*aiState.cy + t*t*aiState.ey;
    paintAt(x, y, aiGridRadius(aiState.brushPx), aiState.pigment, aiState.strength);
  } else if (aiState.phase === 'rest') {
    aiState.framesLeft--;
    if (aiState.framesLeft <= 0) aiState = null;
  }
}

// ----- RAINY preset -----------------------------------------------------
// A pool of independent "drops" that spawn just above the canvas, fall
// downward with a slight horizontal drift, and paint along the way. The
// preset uses paintAt the same way the user's pointer does, so every
// drop participates in the watercolor sim — wet bleed, edge darkening,
// granulation all apply per drop.
//
// Tuning notes:
//   • RAIN_MAX_DROPS caps concurrency so the active rect stays bounded
//     and the canvas doesn't saturate instantly. 12 feels like steady
//     rain without obliterating the surface.
//   • Per-frame spawn probability is RAIN_SPAWN_PER_SEC / 60, capped by
//     the max. The math is loose — a Bernoulli trial per frame, not a
//     true Poisson — which is fine for visual density.
//   • Palette is cool: cerulean dominates, water-brush drops produce
//     lift highlights, occasional rose breaks the monotony. The cool
//     bias reads as a rainy mood whatever paper color is selected.
//   • Drops drift slightly horizontally (vx) and fall fast (vy), with
//     randomness so they don't all march in lockstep.

const RAIN_MAX_DROPS = 12;
const RAIN_SPAWN_PER_SEC = 30;   // average new drops per second (capped by MAX)

// Each entry: [pigmentConstant, weight, [strengthLo, strengthHi], [brushPxLo, brushPxHi]]
const RAIN_DROP_TYPES = [
  // pigmentConstant uses the same indexing paintAt accepts:
  // 0/1/2 are real pigments; WATER_INDEX is the water brush.
  // The cerulean index (2) and rose index (0) are hard-coded — they map to the
  // PIGMENTS array defined at the top of the script.
  [2,            0.60, [0.18, 0.30], [10, 22]],   // cerulean — dominant
  [WATER_INDEX,  0.30, [0.15, 0.28], [10, 20]],   // water — lifts existing paint
  [0,            0.10, [0.10, 0.20], [ 8, 14]],   // rose — occasional warmth
];

let rainDrops = [];

function rainSpawnDrop() {
  // Weighted pick. Sum once and walk; cheap enough at 3 entries.
  let total = 0;
  for (const t of RAIN_DROP_TYPES) total += t[1];
  let r = Math.random() * total;
  let chosen = RAIN_DROP_TYPES[0];
  for (const t of RAIN_DROP_TYPES) {
    r -= t[1];
    if (r <= 0) { chosen = t; break; }
  }
  const [pigment, , [sLo, sHi], [bLo, bHi]] = chosen;
  return {
    // Start above the top edge so the drop fades in via the falling
    // motion rather than popping into existence at y=0.
    x: Math.random() * GW,
    y: -10 - Math.random() * 20,
    vx: (Math.random() - 0.5) * 0.6,            // slight horizontal drift
    vy: 4.0 + Math.random() * 5.0,              // grid cells per frame
    brushPx: bLo + Math.random() * (bHi - bLo),
    pigment,
    strength: sLo + Math.random() * (sHi - sLo),
  };
}

function rainStep() {
  // Spawn up to MAX with per-frame Bernoulli probability. The while-loop
  // can spawn multiple per frame if probability is high; with
  // RAIN_SPAWN_PER_SEC=30 at 60fps it averages 0.5 spawn-attempts/frame.
  const spawnProb = RAIN_SPAWN_PER_SEC / 60;
  while (rainDrops.length < RAIN_MAX_DROPS && Math.random() < spawnProb) {
    rainDrops.push(rainSpawnDrop());
  }

  // Cache the px→grid conversion once per frame. paintAt uses grid
  // coordinates; the slider/UI works in display pixels.
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;

  // Step each drop. Walk backward so splice doesn't disturb indices.
  for (let i = rainDrops.length - 1; i >= 0; i--) {
    const d = rainDrops[i];
    d.x += d.vx;
    d.y += d.vy;

    // Cull drops that have run off the canvas (mostly through the
    // bottom; sideways too, in case the drift carried them off).
    if (d.y > GH + 10 || d.x < -10 || d.x > GW + 10) {
      rainDrops.splice(i, 1);
      continue;
    }

    // Paint only when the drop is actually on-canvas. The above-canvas
    // segment is a "spawn delay" so drops appear to fall in from off-screen.
    if (d.y >= 0 && d.y < GH) {
      paintAt(d.x, d.y, d.brushPx * pxToGridRadius, d.pigment, d.strength);
    }
  }
}

// ----- SUNNY preset -----------------------------------------------------
// Calm, slow horizontal sweeps in the upper portion of the canvas. Reads
// as soft sunlight rather than literal sunbeams — large brush, warm
// palette (yellow primary, rose accent), low strength so accumulated
// strokes wash rather than stack into a solid mark. Spawn interval is
// deliberately long; sunny is the quietest preset.
const SUNNY_MAX = 2;
const SUNNY_SPAWN_INTERVAL_MIN = 150;
const SUNNY_SPAWN_INTERVAL_RAND = 120;

let sunnyStrokes = [];
let sunnySpawnTimer = 30;  // small initial delay so the first stroke isn't instant

function sunnySpawn() {
  // Bezier sweep across canvas, biased toward the top third. Direction
  // alternates randomly so strokes don't all go the same way.
  const direction = Math.random() < 0.5 ? 1 : -1;
  const sx = direction > 0 ? -GW * 0.1 : GW * 1.1;
  const ex = direction > 0 ? GW * 1.1 : -GW * 0.1;
  const sy = GH * (0.05 + Math.random() * 0.35);
  const ey = sy + (Math.random() - 0.5) * GH * 0.15;
  const cx = (sx + ex) / 2;
  const cy = (sy + ey) / 2 + (Math.random() - 0.5) * GH * 0.25;
  return {
    progress: 0,
    duration: 80 + Math.floor(Math.random() * 80),
    sx, sy, cx, cy, ex, ey,
    pigment: Math.random() < 0.75 ? 1 : 0,        // 75% yellow, 25% rose
    strength: 0.16 + Math.random() * 0.10,
    brushPx: 80 + Math.random() * 100,
  };
}

function sunnyStep() {
  sunnySpawnTimer--;
  if (sunnySpawnTimer <= 0 && sunnyStrokes.length < SUNNY_MAX) {
    sunnyStrokes.push(sunnySpawn());
    sunnySpawnTimer = SUNNY_SPAWN_INTERVAL_MIN + Math.floor(Math.random() * SUNNY_SPAWN_INTERVAL_RAND);
  }
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  for (let i = sunnyStrokes.length - 1; i >= 0; i--) {
    const s = sunnyStrokes[i];
    s.progress++;
    if (s.progress > s.duration) { sunnyStrokes.splice(i, 1); continue; }
    const t = s.progress / s.duration;
    const u = 1 - t;
    const x = u*u*s.sx + 2*u*t*s.cx + t*t*s.ex;
    const y = u*u*s.sy + 2*u*t*s.cy + t*t*s.ey;
    paintAt(x, y, s.brushPx * pxToGridRadius, s.pigment, s.strength);
  }
}

// ----- WINDY preset -----------------------------------------------------
// Many fast horizontal streaks. The wind has a dominant direction that
// occasionally gusts the other way — a small probability per frame of
// flipping windDirection produces irregular shifts rather than the
// strict left/right alternation you'd get with a sine wave.
const WINDY_MAX = 8;
const WINDY_GUST_PROB = 0.0008;

let windyStreaks = [];
let windDirection = 1;

function windySpawn() {
  // Spawn just off the upwind edge so streaks "blow in"
  return {
    x: windDirection > 0 ? -10 - Math.random() * 30 : GW + 10 + Math.random() * 30,
    y: Math.random() * GH,
    vx: windDirection * (5 + Math.random() * 6),
    vy: (Math.random() - 0.5) * 0.3,
    brushPx: 6 + Math.random() * 14,
    // Cool-air cerulean dominates, occasional warm yellow streak. Water
    // adds variation by lifting deposited paint (visible only where the
    // canvas already has pigment, but that's the point — wind erodes).
    pigment: (() => {
      const r = Math.random();
      if (r < 0.70) return 2;            // cerulean
      if (r < 0.85) return WATER_INDEX;  // water lift
      return 1;                          // yellow
    })(),
    strength: 0.10 + Math.random() * 0.10,
    life: 200,
  };
}

function windyStep() {
  if (Math.random() < WINDY_GUST_PROB) windDirection *= -1;
  while (windyStreaks.length < WINDY_MAX && Math.random() < 0.35) {
    windyStreaks.push(windySpawn());
  }
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  for (let i = windyStreaks.length - 1; i >= 0; i--) {
    const s = windyStreaks[i];
    s.x += s.vx;
    s.y += s.vy;
    s.life--;
    if (s.life <= 0 || s.x < -20 || s.x > GW + 20) { windyStreaks.splice(i, 1); continue; }
    if (s.y >= 0 && s.y < GH) {
      paintAt(s.x, s.y, s.brushPx * pxToGridRadius, s.pigment, s.strength);
    }
  }
}

// ----- THUNDERSTORM preset ---------------------------------------------
// Heavy rain (faster, more drops than the rainy preset) plus periodic
// lightning. Lightning is a single-frame burst of small paintAt calls
// along a jagged vertical path — not a separate visual primitive,
// just dense small strokes in bright yellow that read as a bolt
// against the dark/wet canvas.
const STORM_MAX_DROPS = 18;
const STORM_SPAWN_PER_SEC = 60;
const STORM_LIGHTNING_MIN_COOLDOWN = 90;     // frames; ~1.5 sec min between flashes
const STORM_LIGHTNING_RAND_COOLDOWN = 360;   // additional random delay

let stormDrops = [];
let stormLightningCooldown = 120;            // initial delay before first flash

function stormSpawnDrop() {
  const r = Math.random();
  let pigment;
  if (r < 0.65) pigment = 2;              // cerulean — dominant
  else if (r < 0.85) pigment = WATER_INDEX; // water lift
  else pigment = 0;                       // rose
  return {
    x: Math.random() * GW,
    y: -10 - Math.random() * 30,
    vx: (Math.random() - 0.5) * 1.0,    // more turbulent than rainy
    vy: 6 + Math.random() * 6,          // harder rain
    brushPx: 10 + Math.random() * 18,
    pigment,
    strength: 0.20 + Math.random() * 0.20,
  };
}

function stormFlashLightning() {
  // Build a jagged vertical path top → bottom; paint many small dabs
  // along each segment so the bolt reads as a continuous stroke. Yellow
  // at high strength against the wet, cool canvas pops cleanly.
  const segments = 6 + Math.floor(Math.random() * 5);
  const startX = GW * 0.15 + Math.random() * GW * 0.7;
  const jitter = GW * 0.04;
  let cx = startX;
  let cy = -2;
  const segDY = GH / segments;
  for (let s = 0; s < segments; s++) {
    const nx = cx + (Math.random() - 0.5) * jitter * 2;
    const ny = cy + segDY * (0.8 + Math.random() * 0.4);
    // Walk the segment with small steps — denser steps for a more
    // solid-looking bolt.
    const stepsPer = 8;
    for (let i = 0; i < stepsPer; i++) {
      const t = i / stepsPer;
      const px = cx + (nx - cx) * t;
      const py = cy + (ny - cy) * t;
      if (py >= 0 && py < GH) {
        // Small brush, very high strength so the bolt stays bright
        // even after the rain washes over it.
        paintAt(px, py, 1.5, 1, 0.65);
      }
    }
    cx = nx;
    cy = ny;
  }
}

function thunderstormStep() {
  // Rain phase
  const spawnProb = STORM_SPAWN_PER_SEC / 60;
  while (stormDrops.length < STORM_MAX_DROPS && Math.random() < spawnProb) {
    stormDrops.push(stormSpawnDrop());
  }
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  for (let i = stormDrops.length - 1; i >= 0; i--) {
    const d = stormDrops[i];
    d.x += d.vx;
    d.y += d.vy;
    if (d.y > GH + 10 || d.x < -10 || d.x > GW + 10) { stormDrops.splice(i, 1); continue; }
    if (d.y >= 0 && d.y < GH) {
      paintAt(d.x, d.y, d.brushPx * pxToGridRadius, d.pigment, d.strength);
    }
  }
  // Lightning phase — fires on cooldown, then resets timer to a randomized
  // delay. Random cooldown spread makes flashes feel natural rather than
  // metronomic.
  stormLightningCooldown--;
  if (stormLightningCooldown <= 0) {
    stormFlashLightning();
    stormLightningCooldown = STORM_LIGHTNING_MIN_COOLDOWN
                           + Math.floor(Math.random() * STORM_LIGHTNING_RAND_COOLDOWN);
  }
}

// ----- PARTLY CLOUDY preset --------------------------------------------
// A few large slow soft "clouds" drift horizontally across the upper
// half of the canvas. Each cloud paints multiple small dabs per frame
// spread around its center, giving an irregular puffy footprint.
// Water-brush dabs dominate so existing pigment gets lifted (reading as
// brighter highlights); a minority of cerulean dabs adds shadow.
const CLOUD_MAX = 3;

let clouds = [];
let cloudSpawnTimer = 60;

function cloudSpawn() {
  const direction = Math.random() < 0.5 ? 1 : -1;
  return {
    x: direction > 0 ? -GW * 0.15 : GW * 1.15,
    y: GH * (0.10 + Math.random() * 0.40),
    vx: direction * (0.4 + Math.random() * 0.5),
    halfWidth: GW * (0.10 + Math.random() * 0.10),    // half-extent for dab spread
    halfHeight: GH * (0.04 + Math.random() * 0.04),
    brushPx: 70 + Math.random() * 60,
    life: 600,
  };
}

function cloudsStep() {
  cloudSpawnTimer--;
  if (cloudSpawnTimer <= 0 && clouds.length < CLOUD_MAX) {
    clouds.push(cloudSpawn());
    cloudSpawnTimer = 180 + Math.floor(Math.random() * 240);
  }
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  for (let i = clouds.length - 1; i >= 0; i--) {
    const c = clouds[i];
    c.x += c.vx;
    c.life--;
    if (c.life <= 0 || c.x < -GW * 0.25 || c.x > GW * 1.25) { clouds.splice(i, 1); continue; }
    // 2-3 dabs per frame, scattered within the cloud's footprint, so
    // each cloud lays down a wide soft band rather than a thin trail.
    const dabs = 2 + Math.floor(Math.random() * 2);
    for (let j = 0; j < dabs; j++) {
      const ox = (Math.random() - 0.5) * 2 * c.halfWidth;
      const oy = (Math.random() - 0.5) * 2 * c.halfHeight;
      // Mostly water (lifts to highlight), occasional cerulean for shadow.
      const pig = Math.random() < 0.75 ? WATER_INDEX : 2;
      paintAt(c.x + ox, c.y + oy, c.brushPx * pxToGridRadius, pig, 0.07);
    }
  }
}

// ----- SNOWING preset (v0.12.3 — wash + lift) -------------------------
// Two-phase preset:
//   Phase 1 (first ~0.5 sec): cerulean wash painted across the canvas,
//     same dab pattern as the time-of-day washes. Builds a blue sky
//     for the snow to fall against.
//   Phase 2 (after wash, ongoing): water-brush drops fall and flutter,
//     each one LIFTING the deposited cerulean back into suspension.
//     The cells where flakes land become less dense in pigment — paper
//     color shows through more, reading as white-ish snow trails.
//
// The water brush also adds wet + pressure, which keeps the canvas
// saturated and lets the lifted pigment bleed/spread naturally. The
// granulation coefficient of cerulean (γ=0.75) makes the residual
// pigment settle into paper crevices, giving the white trails a soft
// textured edge instead of a hard line.
//
// 90% of drops are pure water (lift), 10% are small cerulean dabs at
// low strength — these refresh the sky as flakes deplete it, keeping
// the contrast alive over long sessions.

const SNOW_WASH_FRAMES = 30;            // ~0.5 sec wash before flakes start
const SNOW_WASH_DABS_PER_FRAME = 8;
const SNOW_WASH_STRENGTH = 0.20;        // moderate blue, dense enough to lift visibly
const SNOW_MAX_DROPS = 16;
const SNOW_SPAWN_PER_SEC = 30;

// State held in a single object so a mode switch can clear it via
// snowState = null. lazy-init on the first step after mode start.
let snowState = null;

function snowingInit() {
  snowState = { washFrame: 0, drops: [] };
}

function snowSpawnFlake() {
  return {
    x: Math.random() * GW,
    y: -10 - Math.random() * 30,
    vy: 0.9 + Math.random() * 1.3,
    flutterPhase: Math.random() * Math.PI * 2,
    flutterAmp: 0.3 + Math.random() * 0.5,
    flutterFreq: 0.04 + Math.random() * 0.04,
    brushPx: 6 + Math.random() * 10,
    // 90% water (lifts cerulean → reveals paper-cream "white"),
    // 10% tiny cerulean replenish dabs so the sky doesn't deplete.
    pigment: Math.random() < 0.90 ? WATER_INDEX : 2,
    strength: 0.10 + Math.random() * 0.10,    // only used by cerulean dabs
  };
}

function snowingStep() {
  if (!snowState) snowingInit();
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;

  // Phase 1: blue wash. Pure-cerulean dabs scattered across the canvas
  // at uniform strength — a flat blue sky. Reuses the same dab pattern
  // and tuning as the time-of-day day preset.
  if (snowState.washFrame < SNOW_WASH_FRAMES) {
    for (let i = 0; i < SNOW_WASH_DABS_PER_FRAME; i++) {
      const x = Math.random() * GW;
      const y = Math.random() * GH;
      const brushPx = 70 + Math.random() * 80;
      paintAt(x, y, brushPx * pxToGridRadius, 2, SNOW_WASH_STRENGTH);
    }
    snowState.washFrame++;
    return;  // hold off spawning flakes until wash is laid down
  }

  // Phase 2: flakes spawn and fall. Same spawn/step/cull shape as the
  // other drop-based presets, but the per-drop pigment is mostly the
  // water brush — the visible effect on the canvas is paper showing
  // through where flakes pass, not pigment being added.
  const spawnProb = SNOW_SPAWN_PER_SEC / 60;
  while (snowState.drops.length < SNOW_MAX_DROPS && Math.random() < spawnProb) {
    snowState.drops.push(snowSpawnFlake());
  }
  for (let i = snowState.drops.length - 1; i >= 0; i--) {
    const d = snowState.drops[i];
    d.flutterPhase += d.flutterFreq;
    d.x += Math.sin(d.flutterPhase) * d.flutterAmp;
    d.y += d.vy;
    if (d.y > GH + 10 || d.x < -10 || d.x > GW + 10) { snowState.drops.splice(i, 1); continue; }
    if (d.y >= 0 && d.y < GH) {
      paintAt(d.x, d.y, d.brushPx * pxToGridRadius, d.pigment, d.strength);
    }
  }
}

// ----- SNOWING (ADDITIVE) preset --------------------------------------
// The original snowing behavior, preserved as an alternative to the
// wash-and-lift variant. Tiny cerulean dabs with occasional rose flecks
// flutter down on whatever the canvas currently contains — additive
// rather than subtractive. Reads as a faint blue speckle rather than
// the "white snow against a blue sky" of the lift version. Works well
// layered on top of a sunset or dawn wash where the rose flecks pick
// up the warm tones.

const SNOW_ADD_MAX_DROPS = 16;
const SNOW_ADD_SPAWN_PER_SEC = 24;

let snowAddDrops = [];

function snowAddSpawnDrop() {
  return {
    x: Math.random() * GW,
    y: -10 - Math.random() * 30,
    vy: 0.9 + Math.random() * 1.3,
    flutterPhase: Math.random() * Math.PI * 2,
    flutterAmp: 0.3 + Math.random() * 0.4,
    flutterFreq: 0.04 + Math.random() * 0.04,
    brushPx: 4 + Math.random() * 8,
    // Cerulean dominates with occasional rose for warm flecks; γ=0.75
    // granulation makes the dabs settle into a snowflake-like speckle.
    pigment: Math.random() < 0.88 ? 2 : 0,
    strength: 0.10 + Math.random() * 0.10,
  };
}

function snowingAdditiveStep() {
  const spawnProb = SNOW_ADD_SPAWN_PER_SEC / 60;
  while (snowAddDrops.length < SNOW_ADD_MAX_DROPS && Math.random() < spawnProb) {
    snowAddDrops.push(snowAddSpawnDrop());
  }
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  for (let i = snowAddDrops.length - 1; i >= 0; i--) {
    const d = snowAddDrops[i];
    d.flutterPhase += d.flutterFreq;
    d.x += Math.sin(d.flutterPhase) * d.flutterAmp;
    d.y += d.vy;
    if (d.y > GH + 10 || d.x < -10 || d.x > GW + 10) { snowAddDrops.splice(i, 1); continue; }
    if (d.y >= 0 && d.y < GH) {
      paintAt(d.x, d.y, d.brushPx * pxToGridRadius, d.pigment, d.strength);
    }
  }
}

// ----- TORNADO preset (v0.14.2 — wash extracted to Background) ---------
// Funnel-only animation. The green tornado sky now lives in the Background
// dropdown as the "Tornado" option, selectable independently — set it
// before starting the animation if you want the full picture.
//
// Funnel geometry (v0.14.2): a strict triangular taper.
//   • Top width    = N units (N = TORNADO_NUM_AGENTS)
//   • Bottom width = 1 unit
//   • 1 unit       = TORNADO_UNIT_PX display pixels (≥20)
// Width interpolates linearly with height (no quadratic falloff). Cursors
// cluster against the outer cone surface via radiusFrac 0.85-1.0 so the
// cone outline reads clearly rather than filling the whole interior —
// matches the spec to "bring the cursors closer together".
//
// Travel: the funnel meanders left→right via layered non-commensurate
// sines on both axes (see vx/vy below) — natural-feeling erratic motion
// rather than a fixed cycle.

const TORNADO_NUM_AGENTS = 14;
const TORNADO_UNIT_PX = 20;               // display pixels per "unit" (≥20)
const TORNADO_HORIZONTAL_SPEED = 2.2;
const TORNADO_RESPAWN_OFFSCREEN = 80;     // cells past right edge before respawn
const TORNADO_RESPAWN_DELAY_FRAMES = 300; // ~5 sec @ 60 fps between passes

let tornadoState = null;

function tornadoSpawnAgents() {
  // Funnel anchor lines — base near the bottom (touching ground),
  // top near the upper third where the funnel meets the storm cloud.
  tornadoState.baseY = GH * 0.85;
  tornadoState.topY  = GH * 0.05;
  tornadoState.centerX = -30;             // start just off the left edge
  tornadoState.centerY = 0;               // vertical offset from baseline
  tornadoState.t = 0;                     // frame counter for meander sines
  tornadoState.respawnCountdown = 0;      // 0 = active; >0 = paused between passes

  // v0.14.3 — per-tornado meander signature. Each pass gets fresh
  // frequencies, amplitudes, and phases for its three-sine sum on
  // each axis. Frequencies jitter ±30% around baselines (0.018,
  // 0.043, 0.097 for X; 0.022, 0.039, 0.071 for Y) — wide enough to
  // visibly differentiate passes, narrow enough that each one still
  // feels like a tornado. Phases are fully random (0 to 2π).
  // Amplitudes jitter ±25% so different passes have different
  // "agitation" levels.
  const jitter = (base, pct) => base * (1 - pct + Math.random() * 2 * pct);
  tornadoState.sinesX = [
    { freq: jitter(0.0180, 0.30), amp: jitter(1.50, 0.25), phase: Math.random() * Math.PI * 2 },
    { freq: jitter(0.0430, 0.30), amp: jitter(0.60, 0.25), phase: Math.random() * Math.PI * 2 },
    { freq: jitter(0.0970, 0.30), amp: jitter(0.25, 0.25), phase: Math.random() * Math.PI * 2 },
  ];
  tornadoState.sinesY = [
    { freq: jitter(0.0220, 0.30), amp: jitter(0.90, 0.25), phase: Math.random() * Math.PI * 2 },
    { freq: jitter(0.0390, 0.30), amp: jitter(0.40, 0.25), phase: Math.random() * Math.PI * 2 },
    { freq: jitter(0.0710, 0.30), amp: jitter(0.18, 0.25), phase: Math.random() * Math.PI * 2 },
  ];

  const agents = [];
  for (let a = 0; a < TORNADO_NUM_AGENTS; a++) {
    agents.push({
      // Even phase distribution so the orbital ring is uniformly populated
      // around the cone surface. Small random jitter prevents perfect
      // mirror symmetry (which would read as artificial).
      phase: (a / TORNADO_NUM_AGENTS) * Math.PI * 2 + Math.random() * 0.25,
      // Uniform heightFrac — each agent picks a random height along the
      // cone. With N=14 agents this gives reasonable coverage; the
      // cone surface area is larger at top so density visually fades
      // upward naturally.
      heightFrac: Math.random(),
      // Tight cluster against the outer cone surface (0.85-1.0). The
      // user-spec phrase "bring the cursors closer together" → tight
      // radial band rather than scattered across the funnel interior.
      radiusFrac: 0.85 + Math.random() * 0.15,
      // Independent rotation rates so the funnel doesn't look like a
      // rigid disk spinning — different agents at different heights
      // shear past each other.
      rotSpeed: 0.20 + Math.random() * 0.10,
      // Pigment mix biased toward cerulean for the dark column body;
      // occasional rose adds brownish debris tint, occasional yellow
      // brings the sky color back into the funnel.
      pigment: Math.random() < 0.65 ? 2
             : Math.random() < 0.5  ? 0
             : 1,
    });
  }
  tornadoState.agents = agents;
}

function tornadoInit() {
  tornadoState = {};
  tornadoSpawnAgents();
}

function tornadoStep() {
  if (!tornadoState) tornadoInit();

  // v0.14.3 — inter-pass delay. After a tornado exits the right edge,
  // the countdown ticks down for ~5 seconds before the next pass spawns.
  // During the pause we do nothing — no paint, no agents. The previously
  // painted tornado sits on the canvas drying and getting absorbed.
  if (tornadoState.respawnCountdown > 0) {
    tornadoState.respawnCountdown--;
    if (tornadoState.respawnCountdown === 0) tornadoSpawnAgents();
    return;
  }

  // Meander velocity. Sum the three sines per axis using this tornado's
  // unique signature (regenerated on every spawn — see tornadoSpawnAgents).
  // The constant rightward drift (TORNADO_HORIZONTAL_SPEED) ensures the
  // funnel always eventually exits the right edge. Y has soft restoring
  // force toward centerY=0 so vertical excursions stay bounded.
  tornadoState.t++;
  const t = tornadoState.t;
  let vx = TORNADO_HORIZONTAL_SPEED;
  for (let s = 0; s < tornadoState.sinesX.length; s++) {
    const sw = tornadoState.sinesX[s];
    vx += Math.sin(t * sw.freq + sw.phase) * sw.amp;
  }
  let vy = 0;
  for (let s = 0; s < tornadoState.sinesY.length; s++) {
    const sw = tornadoState.sinesY[s];
    vy += Math.sin(t * sw.freq + sw.phase) * sw.amp;
  }
  vy -= tornadoState.centerY * 0.015;
  tornadoState.centerX += vx;
  tornadoState.centerY += vy;

  // Off-canvas right → schedule the next pass after the delay. We DON'T
  // spawn immediately; the countdown handler at the top of this function
  // will pick it up once it hits zero.
  if (tornadoState.centerX > GW + TORNADO_RESPAWN_OFFSCREEN) {
    tornadoState.respawnCountdown = TORNADO_RESPAWN_DELAY_FRAMES;
    return;
  }

  // Convert TORNADO_UNIT_PX (display pixels) to grid cells. pxToGrid is
  // the inverse of the canvas display scaling — at the standard 1920px-
  // wide viewport and GW=1152 this gives 1 px ≈ 0.6 grid cells, so
  // 20 px ≈ 12 grid cells per unit.
  const rect = canvas.getBoundingClientRect();
  const pxToGrid = GW / rect.width;
  const pxToGridRadius = pxToGrid * 0.5;
  const unitGrid = TORNADO_UNIT_PX * pxToGrid;
  // Cone width spec (in grid cells):
  //   • Top half-width    = N/2 units → cone diameter = N units at top
  //   • Bottom half-width = 0.5 units → cone diameter = 1 unit at base
  const halfWidthTop = (TORNADO_NUM_AGENTS / 2) * unitGrid;
  const halfWidthBot = 0.5 * unitGrid;

  const baseY = tornadoState.baseY + tornadoState.centerY;
  const topY  = tornadoState.topY  + tornadoState.centerY;
  const funnelHeight = baseY - topY;

  for (let i = 0; i < tornadoState.agents.length; i++) {
    const agent = tornadoState.agents[i];
    agent.phase += agent.rotSpeed;

    // Y position along the funnel (top→bottom interpolation).
    const y = topY + agent.heightFrac * funnelHeight;
    // widthFrac: 1.0 at top (heightFrac=0), 0.0 at bottom (heightFrac=1).
    // LINEAR taper from halfWidthBot at base to halfWidthTop at apex —
    // the cone's actual outline. (v0.14 used a quadratic falloff that
    // bulged the funnel; the new spec is strict triangular.)
    const widthFrac = 1 - agent.heightFrac;
    const maxRadius = halfWidthBot + (halfWidthTop - halfWidthBot) * widthFrac;
    const radius = maxRadius * agent.radiusFrac;
    // Elliptical orbit (Y squashed to 0.25× X) so the funnel reads as
    // a 3D column projected onto 2D — horizontal sweep dominates the
    // viewer's perspective on rotation around a vertical axis.
    const offsetX = Math.cos(agent.phase) * radius;
    const offsetY = Math.sin(agent.phase) * radius * 0.25;
    const px = tornadoState.centerX + offsetX;
    const py = y + offsetY;
    if (px < -20 || px > GW + 20) continue;
    // Brush diameter: each cursor stamps a roughly one-unit-wide mark
    // (1.0× unit at base, 1.2× near the top for slight visual variety
    // — debris reads heavier in the wider cloud-top region).
    const brushPx = TORNADO_UNIT_PX * (1.0 + 0.2 * widthFrac);
    const strength = 0.22 + Math.random() * 0.10;
    paintAt(px, py, brushPx * pxToGridRadius, agent.pigment, strength);
  }
}

// ----- dispatcher -------------------------------------------------------
function animationStep() {
  switch (animationMode) {
    case 'ai':                aiStep();                break;
    case 'rainy':             rainStep();              break;
    case 'sunny':             sunnyStep();             break;
    case 'windy':             windyStep();             break;
    case 'thunderstorm':      thunderstormStep();      break;
    case 'partlyCloudy':      cloudsStep();            break;
    case 'snowing':           snowingStep();           break;
    case 'snowingAdditive':   snowingAdditiveStep();   break;
    case 'tornado':           tornadoStep();           break;
    // 'off' falls through to no-op
  }
}

function clearAllAnimationState() {
  aiState = null;
  rainDrops = [];
  sunnyStrokes = [];
  sunnySpawnTimer = 30;
  windyStreaks = [];
  windDirection = 1;
  stormDrops = [];
  stormLightningCooldown = 120;
  clouds = [];
  cloudSpawnTimer = 60;
  snowState = null;
  snowAddDrops = [];
  tornadoState = null;
}

// ----- UI: animation mode dropdown (stubbed in library mode) -----------
// Original used a <select> dropdown to drive animationMode. In library
// mode the parent calls inst.setAnimation() directly. Keep a null
// placeholder so any subsequent code that probes the variable still
// finds something.
const animationSelect = null;

// ============================================================
// VISUALIZATIONS (v0.15) — indefinitely-running generative loops
// ============================================================
// Visualizations are a peer to the Animation dropdown but distinct in
// purpose: while Animations model real-world atmospherics that have a
// natural finite duration (a tornado passes, a storm cell drifts on),
// Visualizations are self-contained showcase loops that run forever,
// emphasizing what the simulation itself can produce — KM color mixing,
// edge darkening, granulation, wet-on-wet bleed.
//
// Composition is intentional: visualizations stack with Background
// washes, Animations, and manual brushwork. A Kaleidoscope painted
// over a Tornado-sky Background while the user drops dots with the
// Lift brush all coexists. Each visualization picks its own pigments
// and brush sizes; mixing happens via the sim, not via overrides.

let visualizationMode = 'off';

// --- Kaleidoscope (v0.15) ------------------------------------------------
// A master cursor moves through a sequence of generative motion phases.
// Six cursors paint simultaneously at 60° rotations around canvas center,
// producing six-fold rotational symmetry — the classic kaleidoscope
// optical effect. Phases cycle indefinitely, switching every few seconds
// to deliver the mix the spec calls for: dots, sharp radial lines, and
// organic curves.

const KALEIDOSCOPE_N = 6;                 // # of cursors = order of rotational symmetry
const KALEIDOSCOPE_PHASES = [
  { name: 'arc-trace',   frames: 480 },   // ~8 sec — slow organic curves at varying r
  { name: 'dot-burst',   frames: 300 },   // ~5 sec — sharp dots scattered in an annulus
  { name: 'rose-petals', frames: 540 },   // ~9 sec — r = R·cos(k·θ) flower-petal curves
];

let kaleidoscopeState = null;

function kaleidoscopeInit() {
  kaleidoscopeState = {
    phaseIdx: 0,
    phaseFrame: 0,
    pigment: 0,                 // cycles 0→1→2→0… across phases
    centerX: GW * 0.5,
    centerY: GH * 0.5,
    // Per-phase fields — initialized by initKaleidoscopePhase below
    masterR: 0, masterTheta: 0,
  };
  initKaleidoscopePhase();
}

function initKaleidoscopePhase() {
  const s = kaleidoscopeState;
  const phase = KALEIDOSCOPE_PHASES[s.phaseIdx];
  s.phaseFrame = 0;
  // Advance pigment so successive phases never reuse the same color
  // (modulo 3 ensures full rose/yellow/cerulean rotation regardless of
  // how many phases the system has).
  s.pigment = (s.pigment + 1) % 3;

  switch (phase.name) {
    case 'arc-trace':
      // Master rotates slowly while r drifts outward, then bounces.
      // Result: organic curve trails that fill the annulus over the
      // phase duration. The 6-fold symmetry turns each curve into a
      // flower-like ring.
      s.masterTheta = Math.random() * Math.PI * 2;
      s.thetaVel = 0.014 + Math.random() * 0.006;
      s.masterR = GH * (0.10 + Math.random() * 0.15);
      s.rVel = 0.35 + Math.random() * 0.35;
      break;
    case 'dot-burst':
      // Discrete stamps at random positions within an annulus, painted
      // every TAP_EVERY frames. With 6-fold symmetry each "tap"
      // produces a hexagonal cluster of dots — sharp, scattered, no
      // connecting lines.
      s.tapEvery = 6;
      break;
    case 'rose-petals':
      // Rose curve: r(θ) = R·cos(k·θ) traces a flower with 2k petals
      // when k is even, k petals when k odd. Combined with the 6-fold
      // symmetry from the rotated cursors, this creates intricate
      // nested-flower patterns. k is randomized per phase for variety.
      s.masterTheta = 0;
      s.thetaVel = 0.018 + Math.random() * 0.008;
      s.petalK = 2 + Math.floor(Math.random() * 4);  // 2-5 petals
      s.petalR = GH * (0.28 + Math.random() * 0.10);
      break;
  }
}

function kaleidoscopeStep() {
  if (!kaleidoscopeState) kaleidoscopeInit();
  const s = kaleidoscopeState;
  s.phaseFrame++;

  // Phase transition — wrap around the array indefinitely.
  if (s.phaseFrame >= KALEIDOSCOPE_PHASES[s.phaseIdx].frames) {
    s.phaseIdx = (s.phaseIdx + 1) % KALEIDOSCOPE_PHASES.length;
    initKaleidoscopePhase();
  }

  const phase = KALEIDOSCOPE_PHASES[s.phaseIdx];
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;

  // Each phase determines:
  //   • whether to paint this frame (some phases skip frames for spacing)
  //   • the master cursor's (r, θ) in grid coordinates
  //   • brush size and deposit strength
  let shouldPaint = true;
  let brushPx = 16, strength = 0.30;

  switch (phase.name) {
    case 'arc-trace': {
      s.masterTheta += s.thetaVel;
      s.masterR += s.rVel;
      // Bounce r off bounds — keeps the pattern from drifting off-canvas
      // or collapsing to the center. The bounds give an annulus the
      // arcs trace through.
      if (s.masterR > GH * 0.42 || s.masterR < GH * 0.06) s.rVel *= -1;
      brushPx = 18;
      strength = 0.28;
      break;
    }
    case 'dot-burst': {
      // Re-roll position every tapEvery frames; paint only on tap frames.
      if (s.phaseFrame % s.tapEvery === 0) {
        s.masterR = GH * (0.08 + Math.random() * 0.32);
        s.masterTheta = Math.random() * Math.PI * 2;
        brushPx = 12 + Math.random() * 6;
        strength = 0.48;
      } else {
        shouldPaint = false;
      }
      break;
    }
    case 'rose-petals': {
      s.masterTheta += s.thetaVel;
      // Rose curve magnitude — abs() to keep r positive (negative values
      // would point through the origin, but the rotational symmetry
      // already covers the opposite-direction positions).
      s.masterR = Math.abs(s.petalR * Math.cos(s.petalK * s.masterTheta));
      brushPx = 14;
      strength = 0.26;
      break;
    }
  }

  if (!shouldPaint) return;

  // Place 6 cursors at evenly-spaced rotations around centerX/centerY.
  // All share the same (r, brushPx, strength, pigment); only θ differs.
  // This is the entire rotational-symmetry implementation: rotate the
  // master's polar angle by i × (2π/N) and paint at the resulting (x, y).
  const TAU = Math.PI * 2;
  for (let i = 0; i < KALEIDOSCOPE_N; i++) {
    const angle = s.masterTheta + (i / KALEIDOSCOPE_N) * TAU;
    const x = s.centerX + Math.cos(angle) * s.masterR;
    const y = s.centerY + Math.sin(angle) * s.masterR;
    paintAt(x, y, brushPx * pxToGridRadius, s.pigment, strength);
  }
}

// --- Lissajous (v0.16) ---------------------------------------------------
// A single master point traces  x(t) = sin(a·t + φx)·Rx,  y(t) = sin(b·t)·Ry
// where (a, b, φx, Rx, Ry) all morph slowly via low-frequency carrier sines.
// When the ratio a/b is rational, the figure is closed; irrational and it
// fills the rectangle densely. Slowly drifting (a, b) means the figure
// continuously morphs through different Lissajous topologies — nodes,
// figure-eights, ellipses, complex weaves — building dense overlapping
// curves on the canvas. Pigment cycles every ~600 frames so successive
// figure-eras paint in different colors and KM-mix at their crossings.

let lissajousState = null;

function lissajousStep() {
  if (!lissajousState) {
    lissajousState = { t: 0, pigment: 0, pigCycleAt: 0 };
  }
  const s = lissajousState;
  s.t++;

  // Carrier sines for slowly morphing (a, b). The ranges hold a and b
  // in [1.2, 5.5] — too small a ratio (a/b near 1) collapses the figure
  // to an ellipse; too large makes it scribble unrecognizably. Center
  // values 3.5 and 2.6 are non-commensurate, so the morph never returns
  // to the same configuration.
  const a   = 3.5 + Math.sin(s.t * 0.00040)         * 2.0;
  const b   = 2.6 + Math.sin(s.t * 0.00057 + 1.3)   * 1.8;
  const phi = Math.PI * 0.5 + Math.sin(s.t * 0.0011) * 1.2;

  // Position. Slightly larger horizontal radius matches typical
  // landscape-orientation canvas aspect.
  const cx = GW * 0.5;
  const cy = GH * 0.5;
  const Rx = GW * 0.40;
  const Ry = GH * 0.42;
  const x = cx + Math.sin(s.t * 0.026 * a / 3.5 + phi) * Rx;
  const y = cy + Math.sin(s.t * 0.026 * b / 2.6)       * Ry;

  // Pigment rotation. Switch to next pigment every 600 frames (~10s)
  // so each figure-era leaves a distinct color trace.
  if (s.t - s.pigCycleAt >= 600) {
    s.pigment = (s.pigment + 1) % 3;
    s.pigCycleAt = s.t;
  }

  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  paintAt(x, y, 11 * pxToGridRadius, s.pigment, 0.26);
}

// --- Flow field (v0.16) --------------------------------------------------
// A bank of particles wanders through a vector field where each cell's
// angle is determined by the existing paperH noise array + a slow time
// shift. paperH is already a smooth noise field across the canvas
// (used for granulation), so re-using it gives spatially-coherent flow
// without needing a Perlin/simplex import.
//
// Particles spawn at random positions, follow the field for their
// lifespan (150-350 frames), paint a small dab at each step, and die
// off-canvas or on age-out. The pool refills continuously so the canvas
// stays alive. Visually: wind-blown / topographic line patterns that
// trace contour lines of the underlying noise field.

const FLOW_FIELD_PARTICLES = 22;
let flowFieldState = null;

function flowFieldStep() {
  if (!flowFieldState) flowFieldState = { particles: [], t: 0 };
  const s = flowFieldState;
  s.t++;

  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;

  // Update existing particles
  for (let i = s.particles.length - 1; i >= 0; i--) {
    const p = s.particles[i];
    p.age++;
    if (p.age > p.maxAge || p.x < 0 || p.x >= GW || p.y < 0 || p.y >= GH) {
      s.particles.splice(i, 1);
      continue;
    }
    // Sample the paperH noise field at the particle's cell to get an
    // angle. paperH values are roughly [0, 1] so multiplying by 4π
    // gives the angle space two full turns of variation, which makes
    // the flow lines curve more interestingly than just one turn.
    // Time shift slowly rotates the whole field so the patterns
    // morph as the wash continues.
    const idx = Math.floor(p.y) * GW + Math.floor(p.x);
    const noise = paperH[idx] || 0.5;
    const angle = noise * Math.PI * 4 + s.t * 0.0006;
    p.x += Math.cos(angle) * 2.0;
    p.y += Math.sin(angle) * 2.0;
    paintAt(p.x, p.y, 7 * pxToGridRadius, p.pigment, 0.20);
  }

  // Refill the pool so the canvas stays animated indefinitely
  while (s.particles.length < FLOW_FIELD_PARTICLES) {
    s.particles.push({
      x: Math.random() * GW,
      y: Math.random() * GH,
      age: 0,
      maxAge: 150 + Math.random() * 200,
      pigment: Math.floor(Math.random() * 3),
    });
  }
}

// --- Pulse (v0.16) -------------------------------------------------------
// Concentric expanding rings spawn at random epicenters, each painting
// a circle of dabs at its growing radius. When a ring reaches max size,
// it dies. Multiple rings co-exist; their painted regions overlap and
// interfere via the watercolor sim, turning into organic blobs.
//
// Each pulse picks a random pigment so a session shows all three colors
// crossing — KM-mixing where they overlap. Spawn rate jitters so pulses
// don't pop on a fixed metronome.

let pulseState = null;

function pulseStep() {
  if (!pulseState) {
    pulseState = { pulses: [], t: 0, lastSpawn: -100, nextSpawnGap: 60 };
  }
  const s = pulseState;
  s.t++;

  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;

  // Spawn new pulse on a jittered cadence (60-120 frames apart)
  if (s.t - s.lastSpawn >= s.nextSpawnGap) {
    s.pulses.push({
      x: GW * (0.15 + Math.random() * 0.70),
      y: GH * (0.15 + Math.random() * 0.70),
      r: 0,
      maxR: GH * (0.18 + Math.random() * 0.28),
      pigment: Math.floor(Math.random() * 3),
    });
    s.lastSpawn = s.t;
    s.nextSpawnGap = 60 + Math.floor(Math.random() * 60);
  }

  // Advance each pulse and paint its ring at the current radius
  const N_POINTS = 32;  // sample density along the ring perimeter
  for (let i = s.pulses.length - 1; i >= 0; i--) {
    const p = s.pulses[i];
    p.r += 1.6;
    if (p.r > p.maxR) { s.pulses.splice(i, 1); continue; }
    // Strength tapers as the ring grows — distant rings deposit less
    // pigment, giving the visual sense of a fading wave-front rather
    // than a constant-thickness expanding paint band.
    const tapered = 1 - (p.r / p.maxR);
    const strength = 0.18 + 0.20 * tapered;
    for (let j = 0; j < N_POINTS; j++) {
      const angle = (j / N_POINTS) * Math.PI * 2;
      const x = p.x + Math.cos(angle) * p.r;
      const y = p.y + Math.sin(angle) * p.r;
      if (x < 0 || x >= GW || y < 0 || y >= GH) continue;
      paintAt(x, y, 7 * pxToGridRadius, p.pigment, strength);
    }
  }
}

// ----- dispatcher -------------------------------------------------------
function visualizationStep() {
  switch (visualizationMode) {
    case 'kaleidoscope': kaleidoscopeStep(); break;
    case 'lissajous':    lissajousStep();    break;
    case 'flowField':    flowFieldStep();    break;
    case 'pulse':        pulseStep();        break;
    // 'off' falls through to no-op
  }
}

function clearAllVisualizationState() {
  kaleidoscopeState = null;
  lissajousState = null;
  flowFieldState = null;
  pulseState = null;
}

// ----- UI: visualization mode dropdown (stubbed in library mode) ------
const visualizationSelect = null;

// ============================================================
// TIME OF DAY — sky wash layer (v0.12.2)
// ============================================================
// Each time preset is a one-shot pigment wash painted across the
// canvas using actual pigments, layered on top of whatever was there.
// The wash mixes with subsequent painting via KM compositing — like
// applying a real watercolor sky wash before painting a foreground.
//
// Preset structure (v0.12.2): each preset is a list of independent
// pigment "layers". Each layer has a single pigment and a y→strength
// curve. A dab at fractional position yFrac evaluates EVERY layer's
// curve at yFrac and emits a paintAt for each non-zero contribution,
// all at the same (x, y) and brush size. This lets pigments stack
// on top of each other (e.g. cerulean + rose at the top of night for
// a deeper purple-blue) while still supporting vertical gradients
// (sunset's cerulean→rose→yellow falls out of three curves with
// non-overlapping non-zero regions in the middle, overlapping at the
// transition zones).
//
// The wash spreads dabs over ~0.75 sec so the user watches it apply,
// and so the bleed sim has frame-spacing to smooth between dabs
// instead of all dabs landing simultaneously. Many overlapping
// low-strength dabs accumulate into a soft continuous tone — natural
// wet-on-wet behavior since the canvas starts at wet=0.62.

const TIME_WASH_FRAMES = 45;          // ~0.75 sec at 60 fps
const TIME_WASH_DABS_PER_FRAME = 8;   // total ≈ 360 dab positions per wash
// v0.14.3 — per-preset dab-count override. Some washes need denser
// coverage to fill in the random-dab gaps where the cream paper would
// otherwise show through. Night uses 2× the default for ~720 total dabs
// across the canvas, which (combined with its denser curves) brings
// coverage close to "no white space" without further structural change.
const TIME_WASH_DABS_OVERRIDE = {
  night: 16,
};

// Each preset is an array of layers. Each layer is { pig, curve }
// where curve is an array of [yFrac, strength] control points. The
// curve is piecewise-linear; values of yFrac outside the curve's
// range return 0 strength (so the layer doesn't contribute outside
// its declared region).
const TIME_WASHES = {
  day: [
    // Light uniform cerulean — gentle sky tint.
    { pig: 2, curve: [[0.0, 0.08], [1.0, 0.08]] },
  ],
  night: [
    // v0.14.3 — denser night. Cerulean base bumped from 0.42→0.62 (top)
    // and 0.32→0.50 (bottom); rose zenith from 0.26→0.40. Combined with
    // the per-preset dab-count override below (16 dabs/frame instead of
    // the default 8), the cumulative coverage pushes nearly every cell
    // past the alpha-full-at threshold so the cream paper barely shows.
    // The two pigments still KM-mix into deep blue-purple — same hue,
    // just more saturated. Rose stays confined to the upper 67% so the
    // lower horizon reads as a cooler pure blue.
    { pig: 2, curve: [[0.0, 0.62], [1.0, 0.50]] },         // cerulean denser
    { pig: 0, curve: [[0.0, 0.40], [0.67, 0.0]] },         // rose, top 67% only
  ],
  sunset: [
    // Three-layer gradient: dusk-blue zenith → rose mid → yellow
    // horizon. Each layer's non-zero region overlaps its neighbor
    // at the transition zone so the bleed sim cross-fades cleanly.
    { pig: 2, curve: [[0.0, 0.13], [0.45, 0.0]] },              // cerulean fading out
    { pig: 0, curve: [[0.0, 0.0], [0.45, 0.16], [1.0, 0.0]] },  // rose peaks at 0.45
    { pig: 1, curve: [[0.45, 0.0], [1.0, 0.20]] },              // yellow rising to horizon
  ],
  dawn: [
    // Softer cousin of sunset — same shape, lower strengths, peak
    // pushed slightly toward the top (sky still cool, not yet warm).
    { pig: 2, curve: [[0.0, 0.09], [0.55, 0.0]] },
    { pig: 0, curve: [[0.0, 0.0], [0.55, 0.11], [1.0, 0.0]] },
    { pig: 1, curve: [[0.55, 0.0], [1.0, 0.11]] },
  ],
  tornado: [
    // The classic "tornado sky" — sickly green-yellow through the
    // middle and lower canvas (cerulean + yellow KM-mixing into a
    // pale poison-green), with rose tapering in at the top for the
    // storm-cloud weight overhead. Extracted from the v0.14 tornado
    // animation preset so it can be combined freely: pair with the
    // Tornado animation for the full picture, or with Thunderstorm /
    // Snowing for a stylized stormy palette.
    { pig: 2, curve: [[0.0, 0.18], [1.0, 0.14]] },              // cerulean steady
    { pig: 1, curve: [[0.0, 0.10], [1.0, 0.20]] },              // yellow rising toward horizon
    { pig: 0, curve: [[0.0, 0.10], [0.40, 0.0]] },              // rose top-only (storm clouds)
  ],
};

let timeWash = null;  // { preset, frame }

function startTimeWash(presetName) {
  // Cancel any in-flight wash and start a new one. Switching presets
  // (via Day → Night, etc.) interrupts mid-application — the partially-
  // applied first wash stays on the canvas, and the new wash layers
  // on top of it from a fresh start.
  const spec = TIME_WASHES[presetName];
  if (!spec) { timeWash = null; return; }
  timeWash = { preset: presetName, frame: 0 };
}

// Piecewise-linear interpolation along a single layer's curve. yFrac
// outside the curve's declared range returns 0 — the layer is absent
// from that region of the canvas.
function evalCurve(curve, yFrac) {
  if (yFrac < curve[0][0] || yFrac > curve[curve.length - 1][0]) return 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const y0 = curve[i][0], s0 = curve[i][1];
    const y1 = curve[i + 1][0], s1 = curve[i + 1][1];
    if (yFrac >= y0 && yFrac <= y1) {
      const t = (yFrac - y0) / (y1 - y0);
      return s0 + (s1 - s0) * t;
    }
  }
  return 0;
}

// Called every frame from the main loop. Returns true if the wash
// painted this frame (informational — paintAt already wakes the sim).
function timeWashStep() {
  if (!timeWash) return false;
  const layers = TIME_WASHES[timeWash.preset];
  const dabsPerFrame = TIME_WASH_DABS_OVERRIDE[timeWash.preset] || TIME_WASH_DABS_PER_FRAME;
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  for (let i = 0; i < dabsPerFrame; i++) {
    const x = Math.random() * GW;
    const y = Math.random() * GH;
    const yFrac = y / GH;
    const brushPx = 70 + Math.random() * 80;
    const gridRadius = brushPx * pxToGridRadius;
    // Evaluate every layer's curve at this y. Each non-zero result
    // produces a paintAt at the same (x, y) — pigments stack into the
    // same cells, KM compositing handles the visual mix.
    for (let L = 0; L < layers.length; L++) {
      const layer = layers[L];
      const str = evalCurve(layer.curve, yFrac);
      if (str > 0.001) paintAt(x, y, gridRadius, layer.pig, str);
    }
  }
  timeWash.frame++;
  if (timeWash.frame >= TIME_WASH_FRAMES) {
    timeWash = null;
    // v0.15 — if Auto-dry background is on, settle the wash immediately.
    // dryPaper() converts all suspended pigment to deposited, zeroes
    // wet/pressure/velocity, and empties the active rect — the sim
    // becomes idle until the next paint event. Particularly valuable
    // before a Visualization starts: a dense Night wash + Kaleidoscope
    // would otherwise mean the whole canvas stays wet and every sim
    // step has to update GH×GW cells. Drying first reclaims those
    // cycles for the visualization.
    if (autoDryBackgroundOn) dryPaper();
  }
  return true;
}

// v2 — auto-dry-background flag, originally driven by a UI toggle.
// Defaults off. Library callers flip it via inst.autoDryBackground(true).
let autoDryBackgroundOn = false;

// v2 — transparent-canvas flag. Originally driven by a UI toggle that
// also changes body styles; in library mode we just hold the value so
// the API getter/setter has somewhere to put it. The actual rendering
// blend behavior is governed by ALPHA_FULL_AT in render() — a cell
// with no pigment renders as transparent regardless of this flag.
// In v2 this is mostly a placeholder; full transparent-background
// support is deferred.
let transparentBg = false;

// ----- UI: time-of-day select (stubbed in library mode) -----
const timeOfDaySelect = null;

// ============================================================
// IDLE SKIP — sim/render skipping when canvas is settled
// ============================================================
// Most of a typical session, nothing is happening: the canvas is dry,
// no pigment is moving, no input is arriving. Running simStep + render
// every frame in that state burns CPU for no visible change. This
// state machine detects when the sim has truly settled and skips the
// hot path until something changes.
//
// Wake conditions (anything that mutates state must call markCanvasActive):
//   • paintAt   — user or AI applies paint
//   • rewet     — global re-wet button
//   • resetSim  — Reset button
//
// Sleep conditions (all checked together once framesSincePaint > grace):
//   • Average wet per cell below a small threshold
//   • Average suspended pigment per cell below a small threshold
// Deposited pigment (d[]) is dry and won't change without water input,
// so we don't need it in the idle check.
//
// The totals lastTotalWet / lastTotalSuspended are maintained by
// updateBars (which runs every frame), so the idle check itself is O(1).
// State (framesSincePaint, simIsIdle, totals) is declared up near the
// state arrays so paintAt / resetSim / rewet can call markCanvasActive
// during init without TDZ errors.

const PAINT_GRACE_FRAMES = 60;        // 1 sec of forced sim after every paint
const IDLE_CHECK_INTERVAL = 30;
const IDLE_WET_PER_CELL = 0.025;      // matches evaporate's dry-out threshold
const IDLE_SUSPENDED_PER_CELL = 0.0005;
// v0.10 — bars run at ~10 Hz instead of 60 Hz. The O(N) fused sum was a
// noticeable chunk of per-frame cost at SCALE 1.75 (1.5 M cells), and
// human perception of bar fill changes saturates well below 60 Hz; the
// CSS transition on .dryness-fill / .pigment-indicator-fill smooths the
// gaps. The idle check (shouldRunSim) reads lastTotalWet/Suspended which
// are still refreshed every tick — 10 Hz is more than fast enough for
// idle detection (the check itself only runs every 30 frames anyway).
const BARS_TICK_INTERVAL = 6;

function shouldRunSim() {
  // Always run during the grace period after any paint event — gives
  // the simulation time to bleed, dry, edge-darken before we consider
  // shutting it off.
  if (framesSincePaint < PAINT_GRACE_FRAMES) return true;
  if (simIsIdle) return false;
  // Past the grace period and not currently idle: check periodically
  // whether the canvas has settled.
  if (framesSinceIdleCheck < IDLE_CHECK_INTERVAL) return true;
  framesSinceIdleCheck = 0;
  const avgWet = lastTotalWet / N;
  const avgSusp = lastTotalSuspended / N;
  if (avgWet < IDLE_WET_PER_CELL && avgSusp < IDLE_SUSPENDED_PER_CELL) {
    simIsIdle = true;
    return false;
  }
  return true;
}

// ============================================================
// PIGMENT FADE — gradual lifting of deposited pigment over time
// ============================================================
// Multiplicative decay applied to d[k][i] across all cells at a fixed
// tick rate when enabled via the Fade painting toggle. Suspended
// pigment (g[]) is intentionally NOT faded — wet strokes stay vibrant
// until they settle into d[], then begin contributing to the fade.
//
// The half-life is mutable so the front-end slider can adjust it at
// runtime. fadeFactor is derived from it and recomputed on every
// change via setFadeHalfLifeMs.
const FADE_TICK_INTERVAL = 6;        // 10 Hz at 60 fps; trade CPU for smoothness
const FADE_DEFAULT_MS = 4000;        // 4 s default half-life
const FADE_MIN_MS = 500;             // slider min
const FADE_MAX_MS = 30000;           // slider max
// Don't run fade when there's essentially nothing left to fade —
// avoids waking render() forever to multiply already-zero values.
const FADE_SKIP_BELOW = 0.001;       // avg pigment per cell

let fadeEnabled = false;             // toggled by "Fade painting" button
// v0.19 — when true (default), fade ticks trigger a full-canvas re-render
// so cells outside the active rect stay in sync with their faded d[]
// values. Without this, a rectangular outline appears around freshly-
// painted strokes after a fade tick (the active rect's boundary becomes
// visible because cells just inside the rect render at their current
// faded value while cells just outside still show pre-fade pixels).
// Exposed on the API as Watercolor.fadeFullRender(bool).
let fadeFullRender = true;
let fadeHalfLifeMs = FADE_DEFAULT_MS;
let fadeFactor = Math.pow(0.5, FADE_TICK_INTERVAL / 60 / (fadeHalfLifeMs / 1000));
let framesSinceFade = 0;

function setFadeHalfLifeMs(ms) {
  // Clamp defensively in case the slider sends something out of range
  if (ms < FADE_MIN_MS) ms = FADE_MIN_MS;
  else if (ms > FADE_MAX_MS) ms = FADE_MAX_MS;
  fadeHalfLifeMs = ms;
  fadeFactor = Math.pow(0.5, FADE_TICK_INTERVAL / 60 / (ms / 1000));
}

function fadeStep() {
  const f = fadeFactor;
  const d0 = d[0], d1 = d[1], d2 = d[2];
  // Masked cells freeze pigment in place — fade can't reach them.
  // Branch on maskActive to keep the hot loop tight when no mask exists.
  if (maskActive) {
    // v0.19 — split into "inside mask rect" (do the check) and "outside"
    // (skip it). Outside the rect, mask[i] is guaranteed to be below
    // threshold by definition, so we can take the fast path. Big win
    // for typical small masks vs. a whole-grid per-cell check.
    for (let y = 0; y < GH; y++) {
      const rowMaybeMasked = (y >= maskRectMinY && y <= maskRectMaxY);
      const yo = y * GW;
      for (let x = 0; x < GW; x++) {
        const i = yo + x;
        if (rowMaybeMasked && x >= maskRectMinX && x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD) continue;
        d0[i] *= f;
        d1[i] *= f;
        d2[i] *= f;
      }
    }
  } else {
    for (let i = 0; i < N; i++) {
      d0[i] *= f;
      d1[i] *= f;
      d2[i] *= f;
    }
  }
}

// ============================================================


// ============================================================
// WEBGL RENDER PATH (v2 lib addition — extracted from v0.20)
// ============================================================
// continues to work. The toggle's UI also disables itself.
//
// Toggle: useGPU. When true, the main loop's render() call routes to
// gpuRender(). When false, the CPU render() runs as before.

let glCanvas = null;             // hidden <canvas> hosting the WebGL2 context
let gl = null;                   // WebGL2 context, null if init failed
let gpuProgram = null;           // compiled+linked shader program
let gpuUniforms = null;          // uniform locations cache
let gpuPaintTex = null;          // RGBA32F: r=g0+d0, g=g1+d1, b=g2+d2, a=wet
let gpuExtraTex = null;          // RGBA32F: r=paperH, g=mask, b=0, a=0
let gpuVAO = null;               // fullscreen quad
let gpuAvailable = false;        // result of init; latched
let gpuInitTried = false;        // gate init to first attempt
let useGPU = false;              // user toggle; UI-bound

// Display the GPU canvas — separately from the CPU render path's
// scaled drawImage. We composite into the SAME visible #canvas via
// drawImage, so the two paths are interchangeable at the display layer.
// This keeps every existing piece of UI (cursor preview, dimensions,
// transparent toggle) unchanged.

function initWebGL() {
  if (gpuInitTried) return gpuAvailable;
  gpuInitTried = true;

  // Create the offscreen canvas at sim resolution (GW × GH). The CPU
  // render path uses an offscreen canvas of the same size, then scales
  // to display via drawImage — we'll do the same so behavior matches.
  glCanvas = document.createElement('canvas');
  glCanvas.width = GW;
  glCanvas.height = GH;
  try {
    gl = glCanvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
  } catch (e) {
    console.warn('WebGL2 context creation threw:', e);
    gl = null;
  }
  if (!gl) {
    console.warn('WebGL2 unavailable; toggle will fall back to CPU.');
    return false;
  }

  // EXT_color_buffer_float — needed to render INTO float textures in
  // future sim-on-GPU work. Not strictly required for the v0.20 render
  // shader (which reads floats but writes to the default framebuffer),
  // but we feature-detect now so v0.20.x can land easily.
  gl.getExtension('EXT_color_buffer_float');
  // OES_texture_float_linear — lets shaders sample float textures with
  // linear filtering. We use NEAREST in v0.20 (one-to-one pixel reads)
  // so it's not required, but harmless to request.
  gl.getExtension('OES_texture_float_linear');

  // Vertex shader: fullscreen quad. Standard 2-triangle covering [-1,1]².
  // Outputs vUv ∈ [0,1]² for the fragment shader to sample textures.
  const vsSrc = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  // Fragment shader: mirrors the CPU render() per-cell loop.
  // Inputs:
  //   uPaint  — vec4 per cell: (g0+d0, g1+d1, g2+d2, wet)
  //   uExtra  — vec4 per cell: (paperH, mask, 0, 0)
  //   uPaper  — vec3: PAPER_R/G/B_BASE
  //   uMaskActive — bool
  //   uPigK0/1/2, uPigS0/1/2 — vec3 K, S per pigment (3 pigments)
  //
  // Math identical to the CPU path:
  //   1. xt = g0+d0 + g1+d1 + g2+d2
  //   2. paper texture = paperBase + (paperH - 0.5) * 0.06
  //   3. if xt < 0.004: paper + dampSheen
  //      else: weighted K and S, kmReflect per channel
  //   4. alpha based on xt
  //   5. if mask above threshold: blend warm yellow tint over the result
  //
  // kmReflect ported directly from the CPU JS function. GLSL sinh/cosh
  // expand to the standard exp() form to be cross-vendor portable.
  const fsSrc = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;

    uniform sampler2D uPaint;
    uniform sampler2D uExtra;
    uniform vec3 uPaper;
    uniform bool uMaskActive;

    uniform vec3 uPigK0;
    uniform vec3 uPigK1;
    uniform vec3 uPigK2;
    uniform vec3 uPigS0;
    uniform vec3 uPigS1;
    uniform vec3 uPigS2;

    uniform float uDebugTint;     // 0.0 = off; >0 tints visible green

    const float MASK_THRESHOLD = 0.1;
    const float MASK_VISUAL_FULL = 0.6;
    const float MASK_TINT_PEAK = 0.30;
    const float ALPHA_FULL_AT = 0.012;

    // Kubelka-Munk reflectance for a single channel. Mirrors kmReflect
    // in the CPU code, using exp() for sinh/cosh (more numerically
    // stable for large bSx than glsl sinh()/cosh() on some drivers).
    float kmReflect(float K, float S, float x, float Rbg) {
      S = max(S, 1e-5);
      float a = 1.0 + K / S;
      float b = sqrt(max(0.0, a * a - 1.0));
      float bSx = min(b * S * x, 12.0);
      // sinh(z) = (e^z - e^-z)/2; cosh(z) = (e^z + e^-z)/2
      float ez = exp(bSx);
      float emz = exp(-bSx);
      float sh = (ez - emz) * 0.5;
      float ch = (ez + emz) * 0.5;
      float denom = a * sh + b * ch;
      if (denom < 1e-9) return 0.0;
      float Rlayer = sh / denom;
      float Tlayer = b  / denom;
      float R = Rlayer + (Tlayer * Tlayer * Rbg) / (1.0 - Rlayer * Rbg);
      return clamp(R, 0.0, 1.0);
    }

    void main() {
      // v0.20 — Y-flip on texture sample. The CPU code lays out cells
      // with row 0 at the top of the canvas (matching the 2D canvas
      // convention). WebGL textures, by default, have texture Y=0 at
      // the bottom of the framebuffer. Without flipping, the rendered
      // image is upside-down. Flipping vUv.y at the sample call inverts
      // the read so cell row 0 in the upload buffer lands at the visible
      // top edge.
      vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
      vec4 paint = texture(uPaint, uv);
      vec4 extra = texture(uExtra, uv);
      float xt = paint.r + paint.g + paint.b;     // total pigment
      float wet = paint.a;
      float paperH = extra.r;
      float mask = extra.g;

      float tex = (paperH - 0.5) * 0.06;
      vec3 paperColor = uPaper + vec3(tex);

      vec3 rgb;
      if (xt < 0.004) {
        float dampSheen = wet * 0.018;
        rgb = paperColor + vec3(dampSheen, dampSheen, dampSheen * 1.2);
      } else {
        float inv = 1.0 / xt;
        float w0 = paint.r * inv;
        float w1 = paint.g * inv;
        float w2 = paint.b * inv;
        vec3 K = uPigK0 * w0 + uPigK1 * w1 + uPigK2 * w2;
        vec3 S = uPigS0 * w0 + uPigS1 * w1 + uPigS2 * w2;
        float thickness = min(xt, 4.0);
        rgb = vec3(
          kmReflect(K.r, S.r, thickness, paperColor.r),
          kmReflect(K.g, S.g, thickness, paperColor.g),
          kmReflect(K.b, S.b, thickness, paperColor.b)
        );
      }

      float alpha = xt >= ALPHA_FULL_AT ? 1.0 : (xt / ALPHA_FULL_AT);

      // Mask tint — same continuous ramp as CPU render
      if (uMaskActive && mask > MASK_THRESHOLD) {
        float maskVis = min(1.0,
          (mask - MASK_THRESHOLD) / (MASK_VISUAL_FULL - MASK_THRESHOLD));
        float tb = maskVis * MASK_TINT_PEAK;
        rgb = mix(rgb, vec3(0.96, 0.86, 0.42), tb);
        float maskAlpha = maskVis * (215.0 / 255.0);
        alpha = max(alpha, maskAlpha);
      }

      // v0.20 — debug tint. When uDebugTint > 0, blend a faint green
      // wash over the entire output. Used to make the GPU render path
      // visually distinguishable from the CPU path for verification.
      // Default 0.0 (no tint). Toggle from console with
      // Watercolor.webglDebugTint(true).
      if (uDebugTint > 0.0) {
        rgb = mix(rgb, vec3(0.6, 1.0, 0.6), uDebugTint * 0.25);
      }

      outColor = vec4(rgb, alpha);
    }
  `;

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return false;

  gpuProgram = gl.createProgram();
  gl.attachShader(gpuProgram, vs);
  gl.attachShader(gpuProgram, fs);
  gl.linkProgram(gpuProgram);
  if (!gl.getProgramParameter(gpuProgram, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(gpuProgram));
    return false;
  }

  // Cache uniform locations. getUniformLocation is fast but doing it
  // per frame allocates strings; per-program caching is the standard
  // pattern.
  gpuUniforms = {
    uPaint:       gl.getUniformLocation(gpuProgram, 'uPaint'),
    uExtra:       gl.getUniformLocation(gpuProgram, 'uExtra'),
    uPaper:       gl.getUniformLocation(gpuProgram, 'uPaper'),
    uMaskActive:  gl.getUniformLocation(gpuProgram, 'uMaskActive'),
    uPigK0:       gl.getUniformLocation(gpuProgram, 'uPigK0'),
    uPigK1:       gl.getUniformLocation(gpuProgram, 'uPigK1'),
    uPigK2:       gl.getUniformLocation(gpuProgram, 'uPigK2'),
    uPigS0:       gl.getUniformLocation(gpuProgram, 'uPigS0'),
    uPigS1:       gl.getUniformLocation(gpuProgram, 'uPigS1'),
    uPigS2:       gl.getUniformLocation(gpuProgram, 'uPigS2'),
    uDebugTint:   gl.getUniformLocation(gpuProgram, 'uDebugTint'),
  };

  // Fullscreen quad VAO. Two triangles covering NDC [-1,1]².
  gpuVAO = gl.createVertexArray();
  gl.bindVertexArray(gpuVAO);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,   1, -1,   -1, 1,
     1, -1,   1,  1,   -1, 1
  ]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(gpuProgram, 'aPos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Allocate float textures sized at the sim grid. These get re-uploaded
  // each frame with the CPU state. v0.20.x will move state ownership to
  // these textures and stop the upload.
  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, GW, GH, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  gpuPaintTex = makeTex();
  gpuExtraTex = makeTex();

  gpuAvailable = true;
  return true;
}

// Scratch buffers for the per-frame state upload. Allocated lazily on
// first GPU render. Reallocated on resolution change (handled by
// rebuildScale, see the gpuOnResize hook below).
let gpuPaintBuf = null;
let gpuExtraBuf = null;
// v0.20 — debug tint. When true, the GPU shader blends a faint green
// over the entire output so users can verify the WebGL path is
// actually running. No effect on the CPU render path.
let gpuDebugTint = false;

function gpuEnsureBuffers() {
  if (!gpuPaintBuf || gpuPaintBuf.length !== N * 4) {
    gpuPaintBuf = new Float32Array(N * 4);
    gpuExtraBuf = new Float32Array(N * 4);
  }
}

function gpuOnResize() {
  if (!gpuAvailable) return;
  glCanvas.width = GW;
  glCanvas.height = GH;
  // Reallocate textures at the new size. The old ones get GC'd by the
  // driver once nothing references them.
  gl.bindTexture(gl.TEXTURE_2D, gpuPaintTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, GW, GH, 0, gl.RGBA, gl.FLOAT, null);
  gl.bindTexture(gl.TEXTURE_2D, gpuExtraTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, GW, GH, 0, gl.RGBA, gl.FLOAT, null);
  gpuPaintBuf = null;
  gpuExtraBuf = null;
}

function gpuRender() {
  if (!gpuAvailable) return;
  gpuEnsureBuffers();

  // Pack the CPU state arrays into the texture upload buffers.
  // paint: (g0+d0, g1+d1, g2+d2, wet)
  // extra: (paperH, mask, 0, 0)
  const g0 = g[0], g1 = g[1], g2 = g[2];
  const d0 = d[0], d1 = d[1], d2 = d[2];
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    gpuPaintBuf[j]     = g0[i] + d0[i];
    gpuPaintBuf[j + 1] = g1[i] + d1[i];
    gpuPaintBuf[j + 2] = g2[i] + d2[i];
    gpuPaintBuf[j + 3] = wet[i];
    gpuExtraBuf[j]     = paperH[i];
    gpuExtraBuf[j + 1] = mask[i];
    // bytes 2,3 stay 0; they were Float32Array-initialized to 0 and
    // nothing else writes them.
  }

  gl.bindTexture(gl.TEXTURE_2D, gpuPaintTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.FLOAT, gpuPaintBuf);
  gl.bindTexture(gl.TEXTURE_2D, gpuExtraTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.FLOAT, gpuExtraBuf);

  // Bind program + uniforms + draw the fullscreen quad
  gl.viewport(0, 0, GW, GH);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(gpuProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gpuPaintTex);
  gl.uniform1i(gpuUniforms.uPaint, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, gpuExtraTex);
  gl.uniform1i(gpuUniforms.uExtra, 1);
  gl.uniform3f(gpuUniforms.uPaper, PAPER_R_BASE, PAPER_G_BASE, PAPER_B_BASE);
  gl.uniform1i(gpuUniforms.uMaskActive, maskActive ? 1 : 0);
  gl.uniform3f(gpuUniforms.uPigK0, PIGMENTS[0].K[0], PIGMENTS[0].K[1], PIGMENTS[0].K[2]);
  gl.uniform3f(gpuUniforms.uPigK1, PIGMENTS[1].K[0], PIGMENTS[1].K[1], PIGMENTS[1].K[2]);
  gl.uniform3f(gpuUniforms.uPigK2, PIGMENTS[2].K[0], PIGMENTS[2].K[1], PIGMENTS[2].K[2]);
  gl.uniform3f(gpuUniforms.uPigS0, PIGMENTS[0].S[0], PIGMENTS[0].S[1], PIGMENTS[0].S[2]);
  gl.uniform3f(gpuUniforms.uPigS1, PIGMENTS[1].S[0], PIGMENTS[1].S[1], PIGMENTS[1].S[2]);
  gl.uniform3f(gpuUniforms.uPigS2, PIGMENTS[2].S[0], PIGMENTS[2].S[1], PIGMENTS[2].S[2]);
  gl.uniform1f(gpuUniforms.uDebugTint, gpuDebugTint ? 1.0 : 0.0);
  gl.bindVertexArray(gpuVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);

  // Composite the GL canvas to the display canvas. Same drawImage path
  // the CPU render uses — keeps the display layer interchangeable.
  ctx.clearRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.drawImage(glCanvas, 0, 0, DISPLAY_W, DISPLAY_H);
}


// ============================================================
// PIGMENT SWATCHES (v2 lib addition — extracted from v0.26.2)
// Generates a row of real KM-rendered swatches into a target
// element. Each swatch is a 56×56 <canvas> drawn through the
// same kmReflect compositor the main render uses, so paper
// texture, edge fade, and pigment color look the same as the
// painted canvas. Click handlers update currentPigment and
// dispatch a "pigmentchange" CustomEvent on the root element
// so the host UI can react (highlight active, update cursor,
// etc.) without the lib needing to know about its DOM.
// ============================================================
// PIGMENT SWATCHES — rendered with the actual KM compositor
// ============================================================
function buildPigmentSwatches(rootEl) {
  const root = rootEl;
  const pigmentsRoot = rootEl;
  // Idempotent — clear any existing children so calling this again
  // (e.g. after a paper-color change) replaces rather than appends.
  root.replaceChildren();
  PIGMENTS.forEach((p, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'pigment' + (idx === currentPigment ? ' active' : '');
    wrap.title = p.name;
    wrap.dataset.idx = idx;

    const swatchDiv = document.createElement('div');
    swatchDiv.className = 'pigment-swatch';

    const sc = document.createElement('canvas');
    sc.width = 56; sc.height = 56;
    const sctx = sc.getContext('2d');
    const sd = sctx.createImageData(56, 56);
    // Render swatch using KM with varying thickness for a natural look
    for (let y = 0; y < 56; y++) {
      for (let x = 0; x < 56; x++) {
        const dx = x - 28, dy = y - 28;
        const d2 = dx*dx + dy*dy;
        if (d2 > 28*28) {
          const j = (y * 56 + x) * 4;
          sd.data[j] = 0; sd.data[j+1] = 0; sd.data[j+2] = 0; sd.data[j+3] = 0;
          continue;
        }
        // Thickness varies a bit across the swatch — thicker bottom, thinner top
        const grad = 1 - (y / 56) * 0.4;
        const speckle = 0.85 + 0.3 * smoothNoise(x * 0.3, y * 0.3);
        const xk = 1.1 * grad * speckle;
        const R = kmReflect(p.K[0], p.S[0], xk, PAPER_R_BASE);
        const G = kmReflect(p.K[1], p.S[1], xk, PAPER_G_BASE);
        const B = kmReflect(p.K[2], p.S[2], xk, PAPER_B_BASE);
        const j = (y * 56 + x) * 4;
        sd.data[j]     = R * 255;
        sd.data[j + 1] = G * 255;
        sd.data[j + 2] = B * 255;
        sd.data[j + 3] = 255;
      }
    }
    sctx.putImageData(sd, 0, 0);
    swatchDiv.appendChild(sc);

    const lbl = document.createElement('div');
    lbl.className = 'pigment-label';
    // Two-line label: short name
    const parts = p.name.split(' ');
    lbl.innerHTML = parts.join('<br>');

    wrap.appendChild(swatchDiv);
    wrap.appendChild(lbl);

    wrap.addEventListener('click', () => {
      currentPigment = idx;
      document.querySelectorAll('.pigment').forEach(el => el.classList.remove('active'));
      wrap.classList.add('active');
      pigmentsRoot.dispatchEvent(new CustomEvent('pigmentchange', { detail: { pigment: currentPigment } }));
    });

    root.appendChild(wrap);
  });

  // Water swatch — not a pigment but a tool that adds wetness + pressure
  // and lifts a fraction of deposited pigment back into suspension.
  // Rendered as bare paper with a subtle cool tint (suggesting wet
  // paper) and the same speckle as the pigment swatches.
  {
    const wrap = document.createElement('div');
    wrap.className = 'pigment' + (currentPigment === WATER_INDEX ? ' active' : '');
    wrap.title = 'Water — wets the paper and lifts pigment, no color added';
    wrap.dataset.idx = WATER_INDEX;

    const swatchDiv = document.createElement('div');
    swatchDiv.className = 'pigment-swatch';

    const sc = document.createElement('canvas');
    sc.width = 56; sc.height = 56;
    const sctx = sc.getContext('2d');
    const sd = sctx.createImageData(56, 56);
    for (let y = 0; y < 56; y++) {
      for (let x = 0; x < 56; x++) {
        const dx = x - 28, dy = y - 28;
        const d2 = dx*dx + dy*dy;
        const j = (y * 56 + x) * 4;
        if (d2 > 28*28) {
          sd.data[j] = 0; sd.data[j+1] = 0; sd.data[j+2] = 0; sd.data[j+3] = 0;
          continue;
        }
        const speckle = 0.92 + 0.12 * smoothNoise(x * 0.3, y * 0.3);
        // Wet paper looks slightly darker and a touch cooler than dry paper.
        // Use the same paper base color so the swatch matches its surroundings,
        // then nudge it toward blue-gray.
        const grad = 0.94 - (y / 56) * 0.04;     // mild top-to-bottom shading
        const R = PAPER_R_BASE * speckle * grad * 0.94;
        const G = PAPER_G_BASE * speckle * grad * 0.96;
        const B = PAPER_B_BASE * speckle * grad * 1.02;
        sd.data[j]     = Math.min(255, R * 255);
        sd.data[j + 1] = Math.min(255, G * 255);
        sd.data[j + 2] = Math.min(255, B * 255);
        sd.data[j + 3] = 255;
      }
    }
    sctx.putImageData(sd, 0, 0);
    swatchDiv.appendChild(sc);

    const lbl = document.createElement('div');
    lbl.className = 'pigment-label';
    lbl.innerHTML = 'Water';

    wrap.appendChild(swatchDiv);
    wrap.appendChild(lbl);

    wrap.addEventListener('click', () => {
      currentPigment = WATER_INDEX;
      document.querySelectorAll('.pigment').forEach(el => el.classList.remove('active'));
      wrap.classList.add('active');
      pigmentsRoot.dispatchEvent(new CustomEvent('pigmentchange', { detail: { pigment: currentPigment } }));
    });

    root.appendChild(wrap);
  }

  // Lift swatch — subtractive brush. Rendered as paper with a slightly
  // brighter center (the "absorbed spot" left by a tissue blot) and a
  // gentle warm tint, so it visually contrasts the water swatch's cool
  // tint and reads as removal rather than addition.
  {
    const wrap = document.createElement('div');
    wrap.className = 'pigment' + (currentPigment === LIFT_INDEX ? ' active' : '');
    wrap.title = 'Lift — removes pigment from the paper, water level unchanged';
    wrap.dataset.idx = LIFT_INDEX;

    const swatchDiv = document.createElement('div');
    swatchDiv.className = 'pigment-swatch';

    const sc = document.createElement('canvas');
    sc.width = 56; sc.height = 56;
    const sctx = sc.getContext('2d');
    const sd = sctx.createImageData(56, 56);
    for (let y = 0; y < 56; y++) {
      for (let x = 0; x < 56; x++) {
        const dx = x - 28, dy = y - 28;
        const d2 = dx*dx + dy*dy;
        const j = (y * 56 + x) * 4;
        if (d2 > 28*28) {
          sd.data[j] = 0; sd.data[j+1] = 0; sd.data[j+2] = 0; sd.data[j+3] = 0;
          continue;
        }
        const speckle = 0.92 + 0.12 * smoothNoise(x * 0.3, y * 0.3);
        const dist = Math.sqrt(d2) / 28;
        // Brighter near center, gently dimmer near edge — like the
        // lighter spot a blotted tissue leaves on a wet wash.
        const liftBright = 1.04 - 0.06 * dist;
        const R = PAPER_R_BASE * speckle * liftBright;
        const G = PAPER_G_BASE * speckle * liftBright * 0.99;
        const B = PAPER_B_BASE * speckle * liftBright * 0.96;  // slight warm
        sd.data[j]     = Math.min(255, R * 255);
        sd.data[j + 1] = Math.min(255, G * 255);
        sd.data[j + 2] = Math.min(255, B * 255);
        sd.data[j + 3] = 255;
      }
    }
    sctx.putImageData(sd, 0, 0);
    swatchDiv.appendChild(sc);

    const lbl = document.createElement('div');
    lbl.className = 'pigment-label';
    lbl.innerHTML = 'Lift';

    wrap.appendChild(swatchDiv);
    wrap.appendChild(lbl);

    wrap.addEventListener('click', () => {
      currentPigment = LIFT_INDEX;
      document.querySelectorAll('.pigment').forEach(el => el.classList.remove('active'));
      wrap.classList.add('active');
      pigmentsRoot.dispatchEvent(new CustomEvent('pigmentchange', { detail: { pigment: currentPigment } }));
    });

    root.appendChild(wrap);
  }

  // Rainbow swatch — horizontal sweep through the three pigments
  // using the same KM math that paintAt's rainbow branch will deposit.
  // Shows rose at the left edge through yellow in the middle to blue
  // at the right edge; the blue→rose wrap part of the cycle is not
  // drawn here since the user can already see all three primaries.
  {
    const wrap = document.createElement('div');
    wrap.className = 'pigment' + (currentPigment === RAINBOW_INDEX ? ' active' : '');
    wrap.title = 'Rainbow — cycles rose → yellow → blue → rose over 2.25s';
    wrap.dataset.idx = RAINBOW_INDEX;

    const swatchDiv = document.createElement('div');
    swatchDiv.className = 'pigment-swatch';

    const sc = document.createElement('canvas');
    sc.width = 56; sc.height = 56;
    const sctx = sc.getContext('2d');
    const sd = sctx.createImageData(56, 56);
    const P0 = PIGMENTS[0], P1 = PIGMENTS[1], P2 = PIGMENTS[2];
    for (let y = 0; y < 56; y++) {
      for (let x = 0; x < 56; x++) {
        const dx = x - 28, dy = y - 28;
        const d2 = dx*dx + dy*dy;
        const j = (y * 56 + x) * 4;
        if (d2 > 28*28) {
          sd.data[j] = 0; sd.data[j+1] = 0; sd.data[j+2] = 0; sd.data[j+3] = 0;
          continue;
        }
        // Map x position to first 2/3 of the rainbow cycle so we get
        // rose → yellow → blue across the swatch width. Three weights
        // computed inline with the same shape as updateRainbowWeights
        // but parameterized by x instead of time.
        const frac = x / 55; // 0..1 across width
        let w0, w1, w2;
        if (frac < 0.5) {
          const f = frac / 0.5;
          w0 = 1 - f; w1 = f; w2 = 0;
        } else {
          const f = (frac - 0.5) / 0.5;
          w0 = 0; w1 = 1 - f; w2 = f;
        }
        const Kr = P0.K[0]*w0 + P1.K[0]*w1 + P2.K[0]*w2;
        const Kg = P0.K[1]*w0 + P1.K[1]*w1 + P2.K[1]*w2;
        const Kb = P0.K[2]*w0 + P1.K[2]*w1 + P2.K[2]*w2;
        const Sr = P0.S[0]*w0 + P1.S[0]*w1 + P2.S[0]*w2;
        const Sg = P0.S[1]*w0 + P1.S[1]*w1 + P2.S[1]*w2;
        const Sb = P0.S[2]*w0 + P1.S[2]*w1 + P2.S[2]*w2;
        // Slight thickness variation by y for an organic swatch feel,
        // matching the speckle treatment of the pigment swatches.
        const thickness = 0.55 + 0.4 * smoothNoise(x * 0.3, y * 0.3);
        const R = kmReflect(Kr, Sr, thickness, PAPER_R_BASE);
        const G = kmReflect(Kg, Sg, thickness, PAPER_G_BASE);
        const B = kmReflect(Kb, Sb, thickness, PAPER_B_BASE);
        sd.data[j]     = Math.min(255, Math.max(0, R * 255));
        sd.data[j + 1] = Math.min(255, Math.max(0, G * 255));
        sd.data[j + 2] = Math.min(255, Math.max(0, B * 255));
        sd.data[j + 3] = 255;
      }
    }
    sctx.putImageData(sd, 0, 0);
    swatchDiv.appendChild(sc);

    const lbl = document.createElement('div');
    lbl.className = 'pigment-label';
    lbl.innerHTML = 'Rainbow';

    wrap.appendChild(swatchDiv);
    wrap.appendChild(lbl);

    wrap.addEventListener('click', () => {
      currentPigment = RAINBOW_INDEX;
      document.querySelectorAll('.pigment').forEach(el => el.classList.remove('active'));
      wrap.classList.add('active');
      pigmentsRoot.dispatchEvent(new CustomEvent('pigmentchange', { detail: { pigment: currentPigment } }));
    });

    root.appendChild(wrap);
  }

  // Masking-fluid swatch (v0.13). Painted on first to reserve paper —
  // any subsequent pigment/water/lift skips masked cells. Rendered as
  // a pale yellow blob with a darker yellow speckled rim to match the
  // visual appearance of real masking fluid (which is typically a
  // yellowish-amber liquid latex). Active state still picks it up via
  // the .active class so the user can see which brush is selected.
  {
    const wrap = document.createElement('div');
    wrap.className = 'pigment' + (currentPigment === MASK_INDEX ? ' active' : '');
    wrap.title = 'Mask — paints masking fluid that reserves paper from any subsequent painting. Remove with the "Remove mask" button.';
    wrap.dataset.idx = MASK_INDEX;

    const swatchDiv = document.createElement('div');
    swatchDiv.className = 'pigment-swatch';

    const sc = document.createElement('canvas');
    sc.width = 56; sc.height = 56;
    const sctx = sc.getContext('2d');
    const sd = sctx.createImageData(56, 56);
    for (let y = 0; y < 56; y++) {
      for (let x = 0; x < 56; x++) {
        const dx = x - 28, dy = y - 28;
        const d2 = dx*dx + dy*dy;
        const j = (y * 56 + x) * 4;
        if (d2 > 28*28) {
          sd.data[j] = 0; sd.data[j+1] = 0; sd.data[j+2] = 0; sd.data[j+3] = 0;
          continue;
        }
        // Soft pale-yellow with darker speckle around the edge ring.
        // The speckle helps it read as a special/non-pigment tool
        // similar to how Water and Lift have textured appearances.
        const speckle = 0.90 + 0.18 * smoothNoise(x * 0.32, y * 0.32);
        const dist = Math.sqrt(d2);
        const edgeRing = dist > 22 ? (dist - 22) / 6 : 0;  // 0 inner, 1 outer
        // Blend pale yellow (center) → darker amber-yellow (edge)
        const R = (0.96 - edgeRing * 0.10) * speckle;
        const G = (0.90 - edgeRing * 0.14) * speckle;
        const B = (0.55 - edgeRing * 0.22) * speckle;
        sd.data[j]     = Math.min(255, R * 255);
        sd.data[j + 1] = Math.min(255, G * 255);
        sd.data[j + 2] = Math.min(255, B * 255);
        sd.data[j + 3] = 255;
      }
    }
    sctx.putImageData(sd, 0, 0);
    swatchDiv.appendChild(sc);

    const lbl = document.createElement('div');
    lbl.className = 'pigment-label';
    lbl.innerHTML = 'Mask';

    wrap.appendChild(swatchDiv);
    wrap.appendChild(lbl);

    wrap.addEventListener('click', () => {
      currentPigment = MASK_INDEX;
      document.querySelectorAll('.pigment').forEach(el => el.classList.remove('active'));
      wrap.classList.add('active');
      pigmentsRoot.dispatchEvent(new CustomEvent('pigmentchange', { detail: { pigment: currentPigment } }));
    });

    root.appendChild(wrap);
  }
}


// ============================================================
// PAPER WETNESS PRESETS (v2 lib addition)
// ============================================================
// Five named presets mapping to evaporation-rate multipliers.
// Default ("wetOnWet") applied at init below.
const EVAP_PRESETS = {
  flooded:   1,    // half-life ~9.5s — pooled water, dramatic blooms
  wetOnWet:  3,    // half-life ~3.2s — soft Curtis-style bleed
  damp:      8,    // half-life ~1.2s — edges firmer, controlled
  dryBrush:  18,   // half-life ~0.5s — granular, paint sits in place
  boneDry:   50,   // half-life ~0.2s — almost dry-on-paper
};
function setEvaporationMult(mult) {
  if (!isFinite(mult) || mult < 0.1) mult = 0.1;
  if (mult > 200) mult = 200;
  evaporationRate = Math.pow(0.9988, mult);
}
function applyEvapPreset(presetName) {
  const mult = EVAP_PRESETS[presetName];
  if (mult === undefined) return false;
  setEvaporationMult(mult);
  return true;
}

// ============================================================
// TEXT PAINTING (v2 lib addition)
// ============================================================
const TEXT_FONT_SIZE = 84;
const TEXT_SAMPLE_STEP = 4;
const TEXT_PAINT_STRENGTH = 0.40;

function paintText(text, opts) {
  if (!text) return 0;
  opts = opts || {};
  const fontSize = opts.fontSize || TEXT_FONT_SIZE;
  const sampleStep = opts.sampleStep || TEXT_SAMPLE_STEP;
  const strength = opts.strength || TEXT_PAINT_STRENGTH;
  const pigment = opts.pigment !== undefined ? opts.pigment : currentPigment;
  const centerGX = opts.x !== undefined ? opts.x : GW * 0.5;
  const centerGY = opts.y !== undefined ? opts.y : GH * 0.5;

  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d');
  const fontSpec = 'bold ' + fontSize + 'px Georgia, serif';
  tctx.font = fontSpec;
  const metrics = tctx.measureText(text);
  const padX = Math.ceil(fontSize * 0.1);
  const padY = Math.ceil(fontSize * 0.1);
  const w = Math.max(1, Math.ceil(metrics.width) + padX * 2);
  const h = Math.ceil(fontSize * 1.4) + padY * 2;
  tmp.width = w;
  tmp.height = h;
  tctx.font = fontSpec;
  tctx.textBaseline = 'middle';
  tctx.fillStyle = '#000';
  tctx.fillText(text, padX, h * 0.5);

  const img = tctx.getImageData(0, 0, w, h).data;
  const rect = canvas.getBoundingClientRect();
  const pxToGridRadius = (GW / rect.width) * 0.5;
  const brushPx = sampleStep * 1.6;

  markCanvasActive();

  const startX = centerGX - w * 0.5;
  const startY = centerGY - h * 0.5;
  let painted = 0;
  for (let py = 0; py < h; py += sampleStep) {
    for (let px = 0; px < w; px += sampleStep) {
      const idx = (py * w + px) * 4;
      if (img[idx + 3] < 128) continue;
      const gx = startX + px;
      const gy = startY + py;
      if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) continue;
      paintAt(gx, gy, brushPx * pxToGridRadius, pigment, strength);
      painted++;
    }
  }
  return painted;
}

// ============================================================
// SVG TRACING (v2 lib addition)
// ============================================================
const SVG_TRACE_FIT = 0.70;
const SVG_POINTS_PER_FRAME = 10;
const SVG_SAMPLE_DENSITY_CELLS = 2.0;
const SVG_TRACE_STRENGTH = 0.42;
const SVG_TRACE_BRUSH_PX = 9;

let svgTraceState = null;

function pathStringFromSvgElement(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'path') return el.getAttribute('d') || '';
  if (tag === 'line') {
    const x1 = el.getAttribute('x1') || 0, y1 = el.getAttribute('y1') || 0;
    const x2 = el.getAttribute('x2') || 0, y2 = el.getAttribute('y2') || 0;
    return 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2;
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    if (pts.length < 4) return '';
    let d = 'M' + pts[0] + ' ' + pts[1];
    for (let i = 2; i + 1 < pts.length; i += 2) {
      d += ' L' + pts[i] + ' ' + pts[i + 1];
    }
    if (tag === 'polygon') d += ' Z';
    return d;
  }
  if (tag === 'rect') {
    const x = +(el.getAttribute('x') || 0);
    const y = +(el.getAttribute('y') || 0);
    const w = +(el.getAttribute('width')  || 0);
    const h = +(el.getAttribute('height') || 0);
    return 'M' + x + ' ' + y + ' h' + w + ' v' + h + ' h' + (-w) + ' Z';
  }
  if (tag === 'circle') {
    const cx = +(el.getAttribute('cx') || 0);
    const cy = +(el.getAttribute('cy') || 0);
    const r = +(el.getAttribute('r') || 0);
    return 'M' + (cx - r) + ' ' + cy +
      ' a' + r + ',' + r + ' 0 1,0 ' + (2 * r) + ',0' +
      ' a' + r + ',' + r + ' 0 1,0 ' + (-2 * r) + ',0';
  }
  if (tag === 'ellipse') {
    const cx = +(el.getAttribute('cx') || 0);
    const cy = +(el.getAttribute('cy') || 0);
    const rx = +(el.getAttribute('rx') || 0);
    const ry = +(el.getAttribute('ry') || 0);
    return 'M' + (cx - rx) + ' ' + cy +
      ' a' + rx + ',' + ry + ' 0 1,0 ' + (2 * rx) + ',0' +
      ' a' + rx + ',' + ry + ' 0 1,0 ' + (-2 * rx) + ',0';
  }
  return '';
}

// v0.28 — Pigment-name resolution shared between traceSVG, paintText,
// and any other API path that wants to accept a string or numeric
// pigment indicator. Returns a numeric index or throws on unknown
// names. Recognizes the same string set as the pigment() API:
//   'rose', 'yellow', 'blue', 'cerulean' (alias), 'rainbow',
//   'water', 'lift', 'mask'.
function _resolvePigmentOption(p) {
  if (typeof p === 'number') return p | 0;
  if (typeof p !== 'string') return currentPigment;
  const name = p.toLowerCase();
  const named = { water: WATER_INDEX, lift: LIFT_INDEX,
                  rainbow: RAINBOW_INDEX, mask: MASK_INDEX,
                  rose: 0, yellow: 1, blue: 2, cerulean: 2 };
  if (name in named) return named[name];
  throw new Error('Unknown pigment: ' + p);
}

// v0.28 — SVG trace now uses the active brush instead of hardcoded
// SVG_TRACE_BRUSH_PX / SVG_TRACE_STRENGTH. Optional opts override per-
// call: { pigment, brushSize, strength, flipY }.
//
// flipY default = true. Some SVG sources (CAD exports, plot-style
// diagrams, files originally drawn in Cartesian-Y) end up looking
// upside-down when traced because their authors used Y-up convention
// despite SVG's official Y-down spec. Most consumer SVGs (Illustrator,
// Inkscape, Figma, web design) are already Y-down. Flipping vertically
// turned out to be the more common desired behavior on real-world
// hand-drawn SVGs, so it's the default — opt out with flipY: false.
function loadSVGAndTrace(svgText, opts) {
  opts = opts || {};
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) throw new Error('No <svg> root found');

  let viewBox = svg.getAttribute('viewBox');
  let vbX = 0, vbY = 0, vbW = +(svg.getAttribute('width') || 100), vbH = +(svg.getAttribute('height') || 100);
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4) { vbX = parts[0]; vbY = parts[1]; vbW = parts[2]; vbH = parts[3]; }
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const tmpSvg = document.createElementNS(svgNS, 'svg');
  document.body.appendChild(tmpSvg);

  const allPoints = [];
  const geomEls = svg.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse');
  for (const el of geomEls) {
    const d = pathStringFromSvgElement(el);
    if (!d) continue;
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', d);
    tmpSvg.appendChild(p);
    let len = 0;
    try { len = p.getTotalLength(); } catch (e) { tmpSvg.removeChild(p); continue; }
    if (!isFinite(len) || len <= 0) { tmpSvg.removeChild(p); continue; }
    const samples = Math.max(2, Math.ceil(len / 1));
    for (let s = 0; s <= samples; s++) {
      const pt = p.getPointAtLength((s / samples) * len);
      allPoints.push({ x: pt.x, y: pt.y });
    }
    tmpSvg.removeChild(p);
  }
  document.body.removeChild(tmpSvg);
  if (allPoints.length === 0) return 0;

  // Fit into SVG_TRACE_FIT of the canvas.
  const sx = (GW * SVG_TRACE_FIT) / vbW;
  const sy = (GH * SVG_TRACE_FIT) / vbH;
  const s = Math.min(sx, sy);
  const offsetX = GW * 0.5 - (vbW * s) * 0.5;
  const offsetY = GH * 0.5 - (vbH * s) * 0.5;

  // v0.28 — flipY: when true, mirror Y around the SVG's vertical
  // center, fixing upside-down traces from Y-up SVG sources. Default
  // true. The math: standard Y is `(pt.y - vbY) * s`; flipped is
  // `(vbH - (pt.y - vbY)) * s`.
  const flipY = opts.flipY !== undefined ? !!opts.flipY : true;
  const scaledPoints = allPoints.map(pt => ({
    x: offsetX + (pt.x - vbX) * s,
    y: offsetY + (flipY ? (vbH - (pt.y - vbY)) : (pt.y - vbY)) * s,
  }));

  // Down-sample to roughly one point per SVG_SAMPLE_DENSITY_CELLS grid cells.
  const downSampled = [];
  let lastX = -1e9, lastY = -1e9;
  for (const pt of scaledPoints) {
    const dx = pt.x - lastX, dy = pt.y - lastY;
    if (dx * dx + dy * dy >= SVG_SAMPLE_DENSITY_CELLS * SVG_SAMPLE_DENSITY_CELLS) {
      downSampled.push(pt);
      lastX = pt.x; lastY = pt.y;
    }
  }

  // v0.28 — Use the active brush instead of hardcoded constants.
  // Resolve pigment by name if a string was supplied (e.g. 'rose'),
  // otherwise default to the currently-active pigment. Same for size,
  // strength — fall through to live state if not specified.
  const pigment = opts.pigment !== undefined
    ? _resolvePigmentOption(opts.pigment)
    : currentPigment;
  const brushPx = opts.brushSize !== undefined ? +opts.brushSize : brushSize;
  const strength = opts.strength !== undefined ? +opts.strength : _brushPressure;
  // Brush radius in grid units. Match the same formula pointer-down
  // uses: (diameter / 2) / SCALE.
  const brushR = (brushPx / 2) / SCALE;

  svgTraceState = {
    points: downSampled,
    idx: 0,
    pigment: pigment,
    brushR: brushR,
    strength: strength,
  };
  markCanvasActive();
  return downSampled.length;
}

function svgTraceStep() {
  if (!svgTraceState) return;
  const st = svgTraceState;
  for (let i = 0; i < SVG_POINTS_PER_FRAME && st.idx < st.points.length; i++, st.idx++) {
    const pt = st.points[st.idx];
    paintAt(pt.x, pt.y, st.brushR, st.pigment, st.strength);
  }
  if (st.idx >= st.points.length) svgTraceState = null;
}

function cancelSVGTrace() { svgTraceState = null; }

// Apply the default paper-wetness preset matching the v0.26.2 default.
applyEvapPreset('wetOnWet');


// ============================================================
// PER-INSTANCE INIT (replaces module-level init in original)
// ============================================================
// In standalone mode the original calls generatePaper() + initialState()
// at top-level. In library mode we do it here after all functions are
// defined but before the loop starts.

generatePaper();
// Re-initialize the canvas dimensions now that the target element's
// bounding rect is known. The sim arrays were sized based on
// instanceWindow.innerWidth/Height at top-of-file, so this is mostly
// to set canvas pixel dimensions.
// (canvas + ctx are already initialized earlier in the render block.)

// Initial wet paper (no splotches — empty canvas, like in the
// original after a Reset).
for (let i = 0; i < N; i++) {
  wet[i] = 0.62;
}
markCanvasActive();
setActiveRectFull();
render(true);


// ============================================================
// POINTER PAINTING (v2) — mouse + touch input
// v0.28 — adds mobile mode + palm rejection
// ============================================================
// Pointer events unify mouse + touch + pen on modern browsers. The
// per-frame applyPendingPaint() handles interpolation, so fast drags
// (whether mouse or finger) produce continuous strokes via stamped
// midpoints rather than dotted lines.
//
// v0.28 — mobile mode. Auto-detected from `(pointer: coarse)` media
// query but the caller can override via options.mobile, and the host
// UI can toggle at runtime via inst.mobile(true|false). When mobile
// mode is on, three palm-rejection heuristics filter accidental
// contact:
//   1. CONTACT SIZE — palms produce wide PointerEvent.width/height.
//      Touches with width or height > PALM_CONTACT_PX are dropped.
//   2. PEN LOCKOUT — once a pen-type pointer is active, any concurrent
//      touch-type events are palm. Standard iPad-with-Apple-Pencil
//      pattern: the palm rests while you draw.
//   3. FIRST-TOUCH-WINS — once painting starts on pointerId X, ignore
//      additional touches until the active one ends. Filters
//      multi-touch palm landings.
// In mouse / non-mobile mode, none of these gates apply: pointer
// events fall through as before.

// Detection: matchMedia('(pointer: coarse)') is the standard signal
// for touch-primary devices. Available in all modern browsers.
function _detectMobile() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch (_) {
    // Fallback for environments without matchMedia
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }
}

const _mobileDetected = _detectMobile();
let _mobileMode = options.mobile !== undefined ? !!options.mobile : _mobileDetected;
const PALM_CONTACT_PX = 40;  // contacts wider than this are palms

const _pointerEnabled = options.pointer !== false;
let _isPainting = false;
let _lastGX = 0, _lastGY = 0;
let _pendingPaintX = null, _pendingPaintY = null;
let _activePointerId = null;
let _activePointerType = null;
// v0.28 — captured at pointer-down so move events use the same strength
// as the initial dab (rather than each PointerEvent.pressure varying
// within the same stroke).
let _strokeStrength = 0.7;

function _clientToGrid(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / rect.width;
  const cy = (e.clientY - rect.top)  / rect.height;
  return { gx: cx * GW, gy: cy * GH };
}

// Returns true if this event should be ignored as a palm contact.
// Only active when mobile mode is on; otherwise always returns false.
function _isPalmEvent(e) {
  if (!_mobileMode) return false;
  // 1. Contact size — palms produce wide contacts. width/height are in
  //    CSS pixels; not all browsers populate them (some return 1×1 even
  //    for real fingers). Treat 1×1 as "no info, don't filter."
  if (e.pointerType === 'touch' && e.width > 1 && e.height > 1) {
    if (e.width > PALM_CONTACT_PX || e.height > PALM_CONTACT_PX) return true;
  }
  // 2. Pen lockout — once we're painting with pen, drop touch.
  if (_activePointerType === 'pen' && e.pointerType === 'touch') return true;
  // 3. First-touch-wins — additional touches while painting are palm.
  if (_isPainting && _activePointerId !== null && e.pointerId !== _activePointerId) {
    return true;
  }
  return false;
}

function _onPointerDown(e) {
  if (!_pointerEnabled) return;
  if (_isPalmEvent(e)) return;
  e.preventDefault();
  _isPainting = true;
  _activePointerId = e.pointerId;
  _activePointerType = e.pointerType;
  const { gx, gy } = _clientToGrid(e);
  const r = (brushSize / 2) / SCALE;
  // v0.28 — strength from _brushPressure (was hardcoded 0.7), optionally
  // modulated by PointerEvent.pressure for stylus users. e.pressure
  // defaults to 0.5 for mouse events with no force; we only consult it
  // when _usePointerPressure is on so mouse strokes don't dim.
  let strength = _brushPressure;
  if (_usePointerPressure && e.pressure > 0) {
    strength *= e.pressure * 2;  // *2 since 0.5 is "neutral" → no change
  }
  // Remember the strength for this stroke so move events match the
  // down event (each PointerEvent has its own .pressure value, but the
  // user usually expects consistent strength per stroke).
  _strokeStrength = strength;
  paintAt(gx, gy, r, currentPigment, strength);
  _lastGX = gx; _lastGY = gy;
  canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
}

function _onPointerMove(e) {
  if (!_isPainting || !_pointerEnabled) return;
  // Only follow the active pointer. Other moves (e.g. palm dragging
  // while pen draws) get dropped here too.
  if (_activePointerId !== null && e.pointerId !== _activePointerId) return;
  if (_isPalmEvent(e)) return;
  e.preventDefault();
  const { gx, gy } = _clientToGrid(e);
  _pendingPaintX = gx;
  _pendingPaintY = gy;
}

function _onPointerUp(e) {
  if (!_isPainting) return;
  // Only end painting when the active pointer ends.
  if (_activePointerId !== null && e.pointerId !== _activePointerId) return;
  _isPainting = false;
  _activePointerId = null;
  _activePointerType = null;
  _pendingPaintX = null;
  _pendingPaintY = null;
  canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId);
}

// v0.29 — Continuous flow. When the pointer is pressed and held
// stationary, this lets pigment + water keep flowing into the wet area
// each frame, mimicking a brush or marker pressed against wet paper.
// Without this, pointerdown fires one stamp and then nothing happens
// until you move. With it on, holding the brush in place builds a
// growing puddle that bleeds outward through the sim's diffusion.
//
// Strength tuning: 0.12 per frame at 60fps is ~7x weaker than a
// single per-stamp deposit (0.7) but accumulates to a similar amount
// of pigment over ~1 second of holding still — which is roughly how
// long a wet brush takes to noticeably bleed in real life. Lower
// strength would feel too sluggish; higher would oversaturate before
// the user notices and lifts.
const CONTINUOUS_FLOW_STRENGTH = 0.12;
let _continuousFlow = options.continuousFlow !== undefined ? !!options.continuousFlow : true;

// Interpolated paint: along the path from _lastG to _pendingPaint,
// stamp every ~brushSize/2 pixels worth of distance. Without this, fast
// drags would skip cells and produce broken strokes.
//
// v0.29 — also handles the no-motion case: if the pointer is held
// stationary with continuousFlow on, we keep pumping pigment + water
// at the last known position.
function applyPendingPaint() {
  if (_pendingPaintX === null) {
    // No new position queued. If a stroke is still in progress AND
    // continuous flow is on, drip at the held position.
    if (_isPainting && _continuousFlow) {
      const r = (brushSize / 2) / SCALE;
      paintAt(_lastGX, _lastGY, r, currentPigment, CONTINUOUS_FLOW_STRENGTH);
    }
    return;
  }
  const gx = _pendingPaintX, gy = _pendingPaintY;
  const r = (brushSize / 2) / SCALE;
  // v0.28 — stamp spacing = r * _brushFlow (was hardcoded 0.4). Smaller
  // _brushFlow → more stamps per stroke → smoother continuous look;
  // larger → fewer stamps → dabbed/dotted look. The 0.5 floor prevents
  // pathological behavior at tiny brush sizes.
  const stampSpacing = Math.max(0.5, r * _brushFlow);
  const dx = gx - _lastGX, dy = gy - _lastGY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < stampSpacing) {
    paintAt(gx, gy, r, currentPigment, _strokeStrength);
  } else {
    const steps = Math.ceil(dist / stampSpacing);
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      paintAt(_lastGX + dx * f, _lastGY + dy * f, r, currentPigment, _strokeStrength);
    }
  }
  _lastGX = gx; _lastGY = gy;
  _pendingPaintX = null;
  _pendingPaintY = null;
}

if (_pointerEnabled) {
  canvas.style.touchAction = 'none';   // prevent scroll on touch drag
  canvas.addEventListener('pointerdown', _onPointerDown);
  canvas.addEventListener('pointermove', _onPointerMove);
  canvas.addEventListener('pointerup',   _onPointerUp);
  canvas.addEventListener('pointercancel', _onPointerUp);
  canvas.addEventListener('pointerleave',  _onPointerUp);
}


// ============================================================
// PERFORMANCE INSTRUMENTATION (v2 lib addition — extracted from v0.19)
// ============================================================
// Tracks per-frame timings in a ring buffer and exposes the data via
// perfMetrics(). The host UI (v0.27's overlay) polls this and updates
// its DOM — the lib itself doesn't touch perf-related elements.
//
// Overhead when off: a single boolean check at each timing point.
// When on: 4-6 performance.now() calls per frame + Float32Array writes.
const PERF_BUFFER_SIZE = 120;          // ~2 sec at 60 fps
let perfEnabled = false;
let perfFrameIdx = 0;
const perfRing = {
  frame:  new Float32Array(PERF_BUFFER_SIZE),
  sim:    new Float32Array(PERF_BUFFER_SIZE),
  render: new Float32Array(PERF_BUFFER_SIZE),
  extra:  new Float32Array(PERF_BUFFER_SIZE),
  wash:   new Float32Array(PERF_BUFFER_SIZE),
};
let perfHeapStart = null;
let perfLoafCount = 0;
let perfLoafObserver = null;

function perfActivate(on) {
  perfEnabled = !!on;
  if (perfEnabled) {
    perfFrameIdx = 0;
    perfLoafCount = 0;
    if (performance.memory) perfHeapStart = performance.memory.usedJSHeapSize;
    // Long Animation Frame observer (Chromium-only currently). Counts
    // frames that blocked the main thread > 50ms.
    if (!perfLoafObserver && typeof PerformanceObserver !== 'undefined') {
      try {
        perfLoafObserver = new PerformanceObserver((list) => {
          perfLoafCount += list.getEntries().length;
        });
        perfLoafObserver.observe({ type: 'long-animation-frame', buffered: true });
      } catch (e) { /* type not supported on this browser; harmless */ }
    }
  }
}

function perfPercentile(arr, p) {
  const copy = Array.from(arr);
  copy.sort((a, b) => a - b);
  const idx = Math.min(copy.length - 1, Math.floor(p * copy.length));
  return copy[idx];
}
function perfMean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}
function perfActiveCells() {
  if (typeof activeRectMinX === 'undefined' || activeRectMinX > activeRectMaxX) return 0;
  return (activeRectMaxX - activeRectMinX + 1) *
         (activeRectMaxY - activeRectMinY + 1);
}

// Snapshot of current perf state. The host polls this periodically
// (every ~10 frames is plenty) and renders the values into its overlay.
function perfMetrics() {
  const f50 = perfPercentile(perfRing.frame, 0.50);
  const f95 = perfPercentile(perfRing.frame, 0.95);
  const f99 = perfPercentile(perfRing.frame, 0.99);
  const fAvg = perfMean(perfRing.frame);
  const fps = fAvg > 0 ? 1000 / fAvg : 0;
  const active = perfActiveCells();
  const totalCells = GW * GH;
  let heapDeltaMB = null;
  if (performance.memory && perfHeapStart != null) {
    heapDeltaMB = (performance.memory.usedJSHeapSize - perfHeapStart) / 1048576;
  }
  return {
    enabled: perfEnabled,
    fps:        fps,
    framep50:   f50,
    framep95:   f95,
    framep99:   f99,
    sim:        perfMean(perfRing.sim),
    render:     perfMean(perfRing.render),
    extra:      perfMean(perfRing.extra),
    wash:       perfMean(perfRing.wash),
    activeCells: active,
    totalCells:  totalCells,
    activePct:   totalCells > 0 ? (active / totalCells * 100) : 0,
    heapDeltaMB: heapDeltaMB,
    longAnimationFrames: perfLoafObserver ? perfLoafCount : null,
  };
}

// ============================================================
// PER-INSTANCE MAIN LOOP
// ============================================================
// Single RAF token per instance. destroy() cancels it.
let rafToken = null;
function loop() {
  // v2 perf instrumentation: gated on perfEnabled. When off the calls
  // compile down to a single boolean check at each gate — negligible.
  const t0 = perfEnabled ? performance.now() : 0;

  applyPendingPaint && applyPendingPaint();
  if (typeof animationStep === 'function') animationStep();
  if (typeof visualizationStep === 'function') visualizationStep();
  if (typeof svgTraceStep === 'function') svgTraceStep();
  const tExtra = perfEnabled ? performance.now() : 0;

  // All three frame counters must increment every frame. Without
  // framesSinceIdleCheck++ the idle-skip check at shouldRunSim() is
  // permanently stuck below IDLE_CHECK_INTERVAL and the sim never
  // enters its idle path — every frame runs simStep + render even
  // when the canvas is completely settled. (This was a real bug in
  // an earlier draft of the lib.)
  framesSincePaint++;
  framesSinceIdleCheck++;
  framesSinceFade++;

  const tBeforeSim = perfEnabled ? performance.now() : 0;
  const runSim = shouldRunSim();
  if (runSim) {
    simStep();
    simStep();
  }
  const tAfterSim = perfEnabled ? performance.now() : 0;

  if (runSim) {
    // v2 — route to GPU when useGPU. CPU render() handles its own
    // forceFull/active-rect logic; gpuRender always does a full pass.
    if (typeof useGPU !== 'undefined' && useGPU && gpuAvailable) {
      gpuRender();
    } else {
      render();
    }
  }
  const tAfterRender = perfEnabled ? performance.now() : 0;

  // Time-wash animator: each frame, if a time-of-day wash is active,
  // step its painter forward.
  if (typeof timeWash !== 'undefined' && timeWash !== null) {
    timeWashStep && timeWashStep();
  }

  // Pigment fade
  if (fadeEnabled && framesSinceFade >= FADE_TICK_INTERVAL) {
    framesSinceFade = 0;
    fadeStep();
  }

  if (perfEnabled) {
    const tEnd = performance.now();
    const i = perfFrameIdx++ % PERF_BUFFER_SIZE;
    perfRing.frame[i]  = tEnd - t0;
    perfRing.sim[i]    = tAfterSim - tBeforeSim;
    perfRing.render[i] = tAfterRender - tAfterSim;
    perfRing.extra[i]  = tExtra - t0;
    perfRing.wash[i]   = tEnd - tAfterRender;
  }

  rafToken = requestAnimationFrame(loop);
}
rafToken = requestAnimationFrame(loop);


// ============================================================
// INSTANCE API (returned to caller)
// ============================================================
const api = {
  target: targetEl,
  canvas: canvas,

  // Backgrounds
  setBackground(name) { startTimeWash(name); return api; },
  isBackgroundRunning() { return typeof timeWash !== 'undefined' && timeWash !== null; },

  // Animations
  setAnimation(name, opts) {
    opts = opts || {};
    if (opts.replace !== false && typeof clearAllAnimationState === 'function') {
      clearAllAnimationState();
    }
    animationMode = name || 'off';
    return api;
  },
  getAnimation() { return typeof animationMode !== 'undefined' ? animationMode : 'off'; },

  // Visualizations
  setVisualization(name, opts) {
    opts = opts || {};
    if (opts.replace !== false && typeof clearAllVisualizationState === 'function') {
      clearAllVisualizationState();
    }
    visualizationMode = name || 'off';
    return api;
  },
  getVisualization() { return typeof visualizationMode !== 'undefined' ? visualizationMode : 'off'; },

  // Splash, rewet, dry, reset
  splash(arg1, arg2) { splash(arg1, arg2); return api; },
  splashPresets()    { return splashPresets(); },
  rewet()            { rewet();     return api; },
  dry()              { dryPaper();  return api; },
  reset()            { resetSim();  return api; },

  // v2 — Brush controls.
  // brushSize is in display pixels (diameter). The library converts
  // to grid units internally. Pigment indices: 0=rose, 1=yellow,
  // 2=blue, or named brushes 'water', 'lift', 'rainbow', 'mask'.
  brushSize(v) {
    if (v !== undefined) brushSize = Math.max(1, +v);
    return brushSize;
  },
  pigment(v) {
    if (v === undefined) return currentPigment;
    if (typeof v === 'string') {
      const map = { water: WATER_INDEX, lift: LIFT_INDEX,
                    rainbow: RAINBOW_INDEX, mask: MASK_INDEX };
      if (!(v in map)) throw new Error('Unknown pigment: ' + v);
      currentPigment = map[v];
    } else {
      currentPigment = v|0;
    }
    return api;
  },
  // List of pigments + the named brushes available.
  pigments() {
    return [
      { index: 0, name: PIGMENTS[0].name },
      { index: 1, name: PIGMENTS[1].name },
      { index: 2, name: PIGMENTS[2].name },
      { index: WATER_INDEX,   name: 'water' },
      { index: LIFT_INDEX,    name: 'lift' },
      { index: RAINBOW_INDEX, name: 'rainbow' },
      { index: MASK_INDEX,    name: 'mask' },
    ];
  },

  // v2 — Paint at grid coordinates directly. The same call used by
  // animations/visualizations internally. Useful for choreographed
  // painting from a parent script.
  paintAt(gx, gy, gridRadius, pigmentIdx, strength) {
    paintAt(gx, gy, gridRadius, pigmentIdx, strength);
    return api;
  },

  // v2 — Paper-wetness presets. Five named steps from flooded → boneDry.
  paperWetness(preset) {
    if (preset === undefined) return null;   // no getter for now
    if (!applyEvapPreset(preset)) {
      throw new Error('Unknown paper-wetness preset: ' + preset +
        '. Valid: ' + Object.keys(EVAP_PRESETS).join(', '));
    }
    return api;
  },
  paperWetnessPresets() { return Object.keys(EVAP_PRESETS); },

  // v2 — Text painting. Stamps the text via paintAt over an off-screen
  // canvas render of the text bitmap. Returns the number of dabs painted.
  paintText(text, opts) { return paintText(text, opts); },

  // v2 — SVG tracing. Pass SVG markup as a string. The library walks
  // geometry elements, samples points along each path, and paints them
  // SVG_POINTS_PER_FRAME per frame.
  //
  // v0.28 — accepts opts to customize the trace:
  //   pigment: name or index (default: current pigment)
  //   brushSize: diameter in display pixels (default: current brushSize)
  //   strength: 0..1 stamp strength (default: current pressure())
  //   flipY: invert vertical orientation. Default true (fixes the
  //     common upside-down result from Y-up SVG sources).
  traceSVG(svgText, opts) {
    return loadSVGAndTrace(svgText, opts);
  },
  cancelSVGTrace() { cancelSVGTrace(); return api; },

  // v2 — Mask brush. The MASK pigment freezes cells when painted via
  // paintAt(..., pigment='mask'). removeMask() clears the entire mask.
  removeMask() { removeMask(); return api; },

  // v2 — Render real KM-compositor pigment swatches into the given
  // root element. Same visuals as v0.26.2's swatches (paper texture,
  // edge fade, granulation). Click handlers update the current pigment
  // and dispatch a 'pigmentchange' CustomEvent on the root element so
  // the host can react (highlight active, update cursor preview).
  // Re-call after paperColor() changes to rebuild swatches.
  buildPigmentSwatches(rootEl) {
    buildPigmentSwatches(rootEl);
    return api;
  },

  // v2 — Paper color (RGB in 0..1 floats). Changes the substrate that
  // Kubelka-Munk renders against. Re-renders the canvas immediately so
  // the change is visible without waiting for the next sim step.
  paperColor(r, g, b) {
    if (r === undefined) {
      return { r: PAPER_R_BASE, g: PAPER_G_BASE, b: PAPER_B_BASE };
    }
    PAPER_R_BASE = Math.max(0, Math.min(1, +r));
    PAPER_G_BASE = Math.max(0, Math.min(1, +g));
    PAPER_B_BASE = Math.max(0, Math.min(1, +b));
    render(true);
    return api;
  },

  // v2 — Current rainbow brush RGB color (0..1 per channel). Useful for
  // UI cursor previews that want to track the rainbow cycle.
  rainbowColor() {
    updateRainbowWeights(performance.now());
    // Mix the three pigment K/S triplets weighted by rainbowW for a
    // rough approximation of the current rainbow color.
    return {
      r: PIGMENTS[0].S[0]*rainbowW[0] + PIGMENTS[1].S[0]*rainbowW[1] + PIGMENTS[2].S[0]*rainbowW[2],
      g: PIGMENTS[0].S[1]*rainbowW[0] + PIGMENTS[1].S[1]*rainbowW[1] + PIGMENTS[2].S[1]*rainbowW[2],
      b: PIGMENTS[0].S[2]*rainbowW[0] + PIGMENTS[1].S[2]*rainbowW[1] + PIGMENTS[2].S[2]*rainbowW[2],
    };
  },

  // v2 — Resolution. SCALE = display pixels per simulation cell.
  // 1.0 = highest detail (1.5M cells at 1080p, expensive). 6.0 = fastest
  // (10× fewer cells, broad bleeds). Calling rebuildScale reallocates
  // every state array, regenerates paper, and resets the canvas.
  // Dispatches 'rescaled' CustomEvent on targetEl when done.
  scale(v) {
    if (v === undefined) return SCALE;
    const n = +v;
    if (!isFinite(n) || n < 1 || n > 6) {
      throw new Error('Watercolor.scale: value must be 1..6, got ' + v);
    }
    rebuildScale(n);
    return api;
  },

  // v2 — Fade half-life in milliseconds. Controls the rate at which
  // deposited pigment decays when fadePainting is on. Range 1000..60000.
  // Half-life of 5000ms means deposited pigment loses half its density
  // every 5 seconds.
  fadeHalfLife(ms) {
    if (ms === undefined) return fadeHalfLifeMs;
    setFadeHalfLifeMs(+ms);
    return api;
  },

  // v2 — WebGL render path (extracted from v0.20). Lazy-init on first
  // toggle; subsequent toggles flip the flag. webglAvailable() returns
  // the result of init (latched after first attempt).
  webgl(v) {
    if (v === undefined) return useGPU;
    if (v && !gpuInitTried) initWebGL();
    if (v && !gpuAvailable) {
      console.warn('Watercolor.webgl(true): WebGL2 init failed; using CPU path.');
      useGPU = false;
      return false;
    }
    useGPU = !!v;
    // Force a render pass on the new path immediately so the toggle feels
    // instantaneous instead of waiting for the next sim step.
    if (useGPU) gpuRender(); else render(true);
    return useGPU;
  },
  webglAvailable() {
    if (!gpuInitTried) initWebGL();
    return gpuAvailable;
  },
  webglDebugTint(v) {
    if (v !== undefined) gpuDebugTint = !!v;
    return gpuDebugTint;
  },

  // v2 — Performance instrumentation. perf(true) starts recording per-
  // frame timings into a ring buffer; perfMetrics() returns the current
  // snapshot (fps, p50/p95/p99 frame times, per-phase ms, active cells,
  // heap delta, Long Animation Frame count). The host UI polls this to
  // update its overlay — the lib doesn't touch DOM for perf display.
  // v0.28 — Mobile mode. Auto-detected via matchMedia('(pointer: coarse)')
  // but the caller can override via options.mobile, and the host UI can
  // flip at runtime here. When on, three palm-rejection heuristics gate
  // pointer events: contact-size, pen-then-touch lockout, and first-
  // touch-wins. See the POINTER PAINTING block for details.
  mobile(v) {
    if (v === undefined) return _mobileMode;
    _mobileMode = !!v;
    // If a stroke is in progress when mode changes, reset state so the
    // next pointer event starts cleanly without dangling active IDs.
    if (_isPainting) {
      _isPainting = false;
      _activePointerId = null;
      _activePointerType = null;
      _pendingPaintX = null;
      _pendingPaintY = null;
    }
    return _mobileMode;
  },
  // One-time device detection latched at create(). Useful for "is this
  // a touch device?" without forcing mobile mode to be on.
  mobileDetected() { return _mobileDetected; },

  perf(v) {
    if (v === undefined) return perfEnabled;
    perfActivate(!!v);
    return perfEnabled;
  },
  perfMetrics() { return perfMetrics(); },

  // Coordinate helpers
  grid: {
    get width()  { return GW; },
    get height() { return GH; },
  },
  toGrid(displayX, displayY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (displayX - rect.left) * (GW / rect.width),
      y: (displayY - rect.top)  * (GH / rect.height),
    };
  },

  // Toggles
  edgeDarkening(v) {
    if (v !== undefined) edgeDarkeningEnabled = !!v;
    return edgeDarkeningEnabled;
  },
  pauseDrying(v) {
    if (v !== undefined) dryingPaused = !!v;
    return dryingPaused;
  },
  autoDryBackground(v) {
    if (v !== undefined) autoDryBackgroundOn = !!v;
    return autoDryBackgroundOn;
  },
  fadePainting(v) {
    if (v !== undefined) fadeEnabled = !!v;
    return fadeEnabled;
  },
  transparent(v) {
    if (v !== undefined) transparentBg = !!v;
    return transparentBg;
  },
  // v2 — Canvas-scale override. Default is auto-computed from canvas
  // size; pass a number to override, or undefined to read current value.
  canvasScale(v) {
    if (v !== undefined && v > 0) _canvasScale = +v;
    return _canvasScale;
  },
  // v2 — Paint/water load multipliers (per-brush deposition strength).
  paintLoad(v) {
    if (v !== undefined) paintLoadMult = Math.max(0.1, +v);
    return paintLoadMult;
  },
  waterLoad(v) {
    if (v !== undefined) waterLoadMult = Math.max(0.2, +v);
    return waterLoadMult;
  },

  // v0.28 — Brush dynamics. Three knobs that previously lived as
  // hardcoded constants in the pointer-event handlers and SVG tracer.
  //
  // pressure(v) — base stamp strength, 0..1. Default 0.7. Lower
  //   values dim every stamp (lighter brush); higher saturate faster.
  //   Applied uniformly across the stroke (set at pointer-down).
  pressure(v) {
    if (v === undefined) return _brushPressure;
    _brushPressure = Math.max(0, Math.min(1, +v));
    return _brushPressure;
  },
  // flow(v) — stamp spacing along a drag, as a fraction of brush
  //   radius. Default 0.4. Smaller = more stamps = smoother strokes
  //   (and more sim cost). Larger = fewer stamps = dotted/dabbed look.
  //   Range clamped to 0.05..2.0 to prevent pathological behavior.
  flow(v) {
    if (v === undefined) return _brushFlow;
    _brushFlow = Math.max(0.05, Math.min(2.0, +v));
    return _brushFlow;
  },
  // usePointerPressure(v) — when true, multiplies stamp strength by
  //   PointerEvent.pressure. Useful for stylus + tablet users; mostly
  //   harmless for mouse since the resulting strength is captured at
  //   pointer-down and held for the rest of the stroke. Default false
  //   because mouse browsers commonly report 0.5 (neutral) — turning
  //   this on without a stylus would shift the base by *1.0 (no change)
  //   but the variability per-event would create unintended dimming.
  usePointerPressure(v) {
    if (v === undefined) return _usePointerPressure;
    _usePointerPressure = !!v;
    return _usePointerPressure;
  },
  // continuousFlow(v) — when on, holding the pointer in place keeps
  //   pumping pigment/water at a reduced rate (CONTINUOUS_FLOW_STRENGTH
  //   = 0.12). Mimics how a real brush bleeds when held still on wet
  //   paper. Default on.
  continuousFlow(v) {
    if (v === undefined) return _continuousFlow;
    _continuousFlow = !!v;
    return _continuousFlow;
  },

  // v2 — PNG export. Returns a data URL the caller can use directly
  // (e.g. assign to an <a> href + download, or open in a new window).
  exportPNG(opts) {
    opts = opts || {};
    // Force a full re-render so the entire canvas is fresh in the
    // active buffer (active-rect optimization only updates dirty cells,
    // which is fine for live display but leaves stale rgba beyond the
    // rect on the rendered canvas — most of the time it matches, but
    // export deserves the safety of a forced full pass).
    render(true);
    return canvas.toDataURL(opts.mimeType || 'image/png');
  },

  // State snapshot
  state() {
    return {
      gridWidth: GW, gridHeight: GH,
      displayWidth: DISPLAY_W, displayHeight: DISPLAY_H,
      brushSize: brushSize,
      pigment: currentPigment,
      canvasScale: _canvasScale,
      animationMode: typeof animationMode !== 'undefined' ? animationMode : 'off',
      visualizationMode: typeof visualizationMode !== 'undefined' ? visualizationMode : 'off',
      backgroundRunning: typeof timeWash !== 'undefined' && timeWash !== null,
      edgeDarkening: edgeDarkeningEnabled,
      fadePainting: fadeEnabled,
      pauseDrying: typeof dryingPaused !== 'undefined' ? dryingPaused : false,
    };
  },

  // Teardown
  destroy() {
    if (rafToken !== null) {
      cancelAnimationFrame(rafToken);
      rafToken = null;
    }
    // Remove pointer listeners
    if (_pointerEnabled) {
      canvas.removeEventListener('pointerdown', _onPointerDown);
      canvas.removeEventListener('pointermove', _onPointerMove);
      canvas.removeEventListener('pointerup',   _onPointerUp);
      canvas.removeEventListener('pointercancel', _onPointerUp);
      canvas.removeEventListener('pointerleave',  _onPointerUp);
    }
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  },
};

return api;

}  // end createInstance

window.Watercolor = { create: createInstance };

})();
