// washes-sim-core.js — the simulation core, as a real module.
//
// GRADUATED from src/parts/sim-core.part.js (ENGINE_REVIEW P1#6): the pass
// functions, active-region tracking, and simStep now live behind
// createSimCore(env). Ownership is deliberately split:
//
//   - washes.js keeps OWNING all state: field arrays, grid dims, tunables.
//     It reallocates and reassigns them freely (rebuildScale, palette, API
//     setters) exactly as before.
//   - this module snapshots those bindings via env.bindings() —
//     refreshBindings() re-reads them and MUST be called after any rebuild —
//     and re-reads the runtime-mutable set via env.live() at every exported
//     call, so API changes (evaporation, masks, gravity, palette, edge
//     modes) are visible with at most one-call granularity, matching the
//     closure semantics it replaced.
//
// Inlined into washes.js by scripts/assemble.cjs (esm transform) so the
// single-file build stays self-contained; also importable directly:
//   import { createSimCore } from "washes/sim-core";
export function createSimCore(env) {
  // ---- rebuild-refreshed bindings (owned by the host) ----
  let GW, GH, N, inv_s, inv_s2, s_scale,
    wet, wet_tmp, u, v, u_new, v_new, pressure, paperH, mask,
    g, d, g_tmp, wetBlur, wetBlurTmp, wetBinary, wetBlurLarge,
    WET_DIFFUSION, PIGMENT_DIFFUSION, EDGE_KERNEL, EDGE_KERNEL_LARGE,
    MASK_THRESHOLD;
  function refreshBindings() {
    const b = env.bindings();
    GW = b.GW; GH = b.GH; N = b.N; inv_s = b.inv_s; inv_s2 = b.inv_s2;
    s_scale = b.s_scale;
    wet = b.wet; wet_tmp = b.wet_tmp; u = b.u; v = b.v;
    u_new = b.u_new; v_new = b.v_new; pressure = b.pressure;
    paperH = b.paperH; mask = b.mask; g = b.g; d = b.d; g_tmp = b.g_tmp;
    wetBlur = b.wetBlur; wetBlurTmp = b.wetBlurTmp;
    wetBinary = b.wetBinary; wetBlurLarge = b.wetBlurLarge;
    WET_DIFFUSION = b.WET_DIFFUSION; PIGMENT_DIFFUSION = b.PIGMENT_DIFFUSION;
    EDGE_KERNEL = b.EDGE_KERNEL; EDGE_KERNEL_LARGE = b.EDGE_KERNEL_LARGE;
    MASK_THRESHOLD = b.MASK_THRESHOLD;
  }
  // ---- per-call live state (runtime-mutable via the host API) ----
  let evaporationRate, dryingPaused, edgeDarkeningEnabled, _advectionMode,
    maskActive, maskRectMinX, maskRectMinY, maskRectMaxX, maskRectMaxY,
    _edgeOpenLeft, _edgeOpenRight, _edgeOpenTop, _edgeOpenBottom,
    _gravityDir, _gravityStrength, _gravityBiasX, _gravityBiasY,
    _edgeMode, fadeEnabled, dVel, VEL_CLAMP, PIGMENTS;
  function _refreshLive() {
    const s = env.live();
    evaporationRate = s.evaporationRate; dryingPaused = s.dryingPaused;
    edgeDarkeningEnabled = s.edgeDarkeningEnabled;
    _advectionMode = s.advectionMode;
    maskActive = s.maskActive;
    maskRectMinX = s.maskRectMinX; maskRectMinY = s.maskRectMinY;
    maskRectMaxX = s.maskRectMaxX; maskRectMaxY = s.maskRectMaxY;
    _edgeOpenLeft = s.edgeOpenLeft; _edgeOpenRight = s.edgeOpenRight;
    _edgeOpenTop = s.edgeOpenTop; _edgeOpenBottom = s.edgeOpenBottom;
    _gravityDir = s.gravityDir; _gravityStrength = s.gravityStrength;
    _gravityBiasX = s.gravityBiasX; _gravityBiasY = s.gravityBiasY;
    _edgeMode = s.edgeMode;
    fadeEnabled = s.fadeEnabled; dVel = s.dVel;
    VEL_CLAMP = s.VEL_CLAMP; PIGMENTS = s.PIGMENTS;
  }
  const markCanvasActive = env.markCanvasActive;

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
    let activeMinX = 0,
      activeMaxX = -1; // -1 marker = empty
    let activeMinY = 0,
      activeMaxY = -1;
    let framesSinceShrink = 0;
    const ACTIVE_SHRINK_INTERVAL = 30; // frames between shrink scans
    const ACTIVE_MARGIN = 24; // cells of padding around tracked content
    const ACTIVE_THRESHOLD = 0.001; // pigment/pressure threshold for "active"

    function activeRectIsEmpty() {
      return activeMaxX < activeMinX || activeMaxY < activeMinY;
    }

    function setActiveRectFull() {
      activeMinX = 0;
      activeMaxX = GW - 1;
      activeMinY = 0;
      activeMaxY = GH - 1;
    }

    function setActiveRectEmpty() {
      activeMinX = 0;
      activeMaxX = -1;
      activeMinY = 0;
      activeMaxY = -1;
    }

    function expandActiveRect(centerX, centerY, radius) {
      const lx = Math.max(0, Math.floor(centerX - radius - ACTIVE_MARGIN));
      const rx = Math.min(GW - 1, Math.ceil(centerX + radius + ACTIVE_MARGIN));
      const ty = Math.max(0, Math.floor(centerY - radius - ACTIVE_MARGIN));
      const by = Math.min(GH - 1, Math.ceil(centerY + radius + ACTIVE_MARGIN));
      if (activeRectIsEmpty()) {
        activeMinX = lx;
        activeMaxX = rx;
        activeMinY = ty;
        activeMaxY = by;
      } else {
        if (lx < activeMinX) activeMinX = lx;
        if (rx > activeMaxX) activeMaxX = rx;
        if (ty < activeMinY) activeMinY = ty;
        if (by > activeMaxY) activeMaxY = by;
      }
    }

    function shrinkActiveRect() {
      if (activeRectIsEmpty()) return;
      const g0 = g[0],
        g1 = g[1],
        g2 = g[2];
      const thr = ACTIVE_THRESHOLD;
      let newMinX = activeMaxX + 1,
        newMaxX = activeMinX - 1;
      let newMinY = activeMaxY + 1,
        newMaxY = activeMinY - 1;
      // v1.13 — what counts as "active", refined for the wiring:
      //   wet > 1e-6      — every sim pass gates its per-cell work on
      //     wetness (advection/edge at 0.04, the diffusion stencil at
      //     1e-6), and evaporate snaps sub-0.025 wet to exactly 0, so any
      //     cell a pass could still change is wet. The original
      //     g/pressure-only criterion cut still-wet clear-water halos and
      //     froze their diffusion/damping mid-flight.
      //   pressure — INTERIOR cells only. Splash modes write pressure to
      //     the full grid including the outermost ring, but every pass
      //     that evolves pressure iterates the interior, so boundary
      //     pressure never decays — one deluge would otherwise pin the
      //     rect at full-grid forever. Boundary pressure is dead state:
      //     nothing wet-gated reads it once its interior neighbors dry.
      //   g — any cell (advection does flux into the boundary ring).
      const yTop = 1,
        yBot = GH - 2;
      for (let y = activeMinY; y <= activeMaxY; y++) {
        const yo = y * GW;
        const interiorRow = y >= yTop && y <= yBot;
        for (let x = activeMinX; x <= activeMaxX; x++) {
          const i = yo + x;
          const p =
            interiorRow && x >= 1 && x <= GW - 2 ? pressure[i] : 0;
          if (
            wet[i] > 1e-6 ||
            g0[i] > thr || g1[i] > thr || g2[i] > thr ||
            p > thr
          ) {
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
      const ix = Math.floor(x),
        iy = Math.floor(y);
      const fx = x - ix,
        fy = y - iy;
      const a = hash2(ix, iy);
      const b = hash2(ix + 1, iy);
      const c = hash2(ix, iy + 1);
      const d = hash2(ix + 1, iy + 1);
      const ux = fx * fx * (3 - 2 * fx);
      const uy = fy * fy * (3 - 2 * fy);
      return (
        a * (1 - ux) * (1 - uy) +
        b * ux * (1 - uy) +
        c * (1 - ux) * uy +
        d * ux * uy
      );
    }
    // 1.0 = full noise range (~0.08 .. 0.97); 0.5 halves the variation around mean (~0.29 .. 0.73).
    // Lower values produce subtler granulation and less distinct low spots on the paper.
    const TEXTURE_AMPLITUDE = 0.5;

    // v2.2 — row-ranged so createAsync can time-slice generation across
    // frames. Rows are independent (each cell's value depends only on its
    // own coordinates), so any row partition is bit-identical to the full
    // pass — the render/equivalence goldens prove it.
    function generatePaper(yFrom, yTo) {
      const y0 = yFrom === undefined ? 0 : yFrom;
      const y1 = yTo === undefined ? GH : yTo;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < GW; x++) {
          // SCALE-derived: freq scales as `s` to keep texture feature size
          // in display pixels constant. At SCALE_REF (s=1) → 12.0 (v0.8
          // baseline). Dominant feature wavelength ≈ SCALE/freq display px.
          let h = 0,
            amp = 0.5,
            freq = 12.0 * s_scale;
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
      const gw = GW,
        gh = GH;
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
    const EDGE_WET_ACTIVE = 0.4;
    const EDGE_WET_OFF = 0.1;
    // MAX_PIGMENT caps how much pigment any single cell can hold. The paper
    // caps both g and d at 1 inside §4.5 (TransferPigment), but paintAt,
    // advection convergence, and the evaporation dump-to-deposited all
    // previously bypassed that cap — letting endpoint cells accumulate
    // unbounded pigment, which then read as near-black after KM compositing.
    const MAX_PIGMENT = 1.0;

    // v1.13 — sub-rect box blur. Same separable running-sum math as
    // boxBlur, but produces dst valid only on [x0..x1]×[y0..y1], reading
    // src within ±radius of that window (grid-edge clamps identical to
    // the full pass). The horizontal pass fills wetBlurTmp on the padded
    // row band; the vertical pass consumes exactly that band. Cells
    // outside the window keep whatever dst held before — callers must
    // only read dst inside the window.
    function boxBlurRect(src, dst, radius, x0, y0, x1, y1) {
      const inv = 1 / (2 * radius + 1);
      const r = radius;
      const gw = GW,
        gh = GH;
      const tmp = wetBlurTmp;
      const ry0 = Math.max(0, y0 - r),
        ry1 = Math.min(gh - 1, y1 + r);
      // ---- HORIZONTAL PASS: src -> wetBlurTmp on rows ry0..ry1 ----
      for (let y = ry0; y <= ry1; y++) {
        const yo = y * gw;
        let sum = 0;
        for (let xx = x0 - r; xx <= x0 + r; xx++) {
          const ix = xx < 0 ? 0 : xx > gw - 1 ? gw - 1 : xx;
          sum += src[yo + ix];
        }
        for (let x = x0; x <= x1; x++) {
          tmp[yo + x] = sum * inv;
          const addX = x + r + 1;
          const subX = x - r;
          sum +=
            src[yo + (addX > gw - 1 ? gw - 1 : addX)] -
            src[yo + (subX < 0 ? 0 : subX)];
        }
      }
      // ---- VERTICAL PASS: wetBlurTmp -> dst on rows y0..y1 ----
      for (let x = x0; x <= x1; x++) {
        let sum = 0;
        for (let yy = y0 - r; yy <= y0 + r; yy++) {
          const iy = yy < 0 ? 0 : yy > gh - 1 ? gh - 1 : yy;
          sum += tmp[iy * gw + x];
        }
        for (let y = y0; y <= y1; y++) {
          dst[y * gw + x] = sum * inv;
          const addY = y + r + 1;
          const subY = y - r;
          sum +=
            tmp[(addY > gh - 1 ? gh - 1 : addY) * gw + x] -
            tmp[(subY < 0 ? 0 : subY) * gw + x];
        }
      }
    }

    function applyEdgeDarkening() {
      if (activeRectIsEmpty()) return;
      // v1.13 — binarize + blur only around the active rect instead of
      // ~5 full-grid passes per call. wetBlur / wetBlurLarge are consumed
      // solely by the pressure loop below, which reads inside the rect;
      // values outside go stale but are never read. The binarize window
      // pads by the LARGE kernel so both blurs read fresh source
      // everywhere their windows can reach.
      const padB = EDGE_KERNEL_LARGE;
      const bx0 = Math.max(0, activeMinX - padB),
        bx1 = Math.min(GW - 1, activeMaxX + padB);
      const by0 = Math.max(0, activeMinY - padB),
        by1 = Math.min(GH - 1, activeMaxY + padB);
      for (let y = by0; y <= by1; y++) {
        const yo = y * GW;
        for (let x = bx0; x <= bx1; x++) {
          const i = yo + x;
          wetBinary[i] = wet[i] > 0.04 ? 1 : 0;
        }
      }
      boxBlurRect(wetBinary, wetBlur, EDGE_KERNEL,
        activeMinX, activeMinY, activeMaxX, activeMaxY);
      boxBlurRect(wetBinary, wetBlurLarge, EDGE_KERNEL_LARGE,
        activeMinX, activeMinY, activeMaxX, activeMaxY);
      const activeRange = EDGE_WET_ACTIVE - EDGE_WET_OFF;
      const y0 = Math.max(0, activeMinY);
      const y1 = Math.min(GH - 1, activeMaxY);
      const x0 = Math.max(0, activeMinX);
      const x1 = Math.min(GW - 1, activeMaxX);
      for (let y = y0; y <= y1; y++) {
        const yo = y * GW;
        const rowMaybeMasked =
          maskActive && y >= maskRectMinY && y <= maskRectMaxY;
        for (let x = x0; x <= x1; x++) {
          const i = yo + x;
          // Masked cells: edges shouldn't darken into the mask boundary —
          // no pressure changes at frozen cells.
          if (
            rowMaybeMasked &&
            x >= maskRectMinX &&
            x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD
          )
            continue;
          if (wet[i] > 0.04) {
            const deficit = 1 - wetBlur[i]; // 0 in interior, → 1 near boundary
            if (deficit > 0) {
              const w = wet[i];
              // Smooth fade: 1 above EDGE_WET_ACTIVE, 0 below EDGE_WET_OFF, linear between.
              const activation =
                w >= EDGE_WET_ACTIVE
                  ? 1
                  : w <= EDGE_WET_OFF
                    ? 0
                    : (w - EDGE_WET_OFF) / activeRange;
              // wetBlurLarge ≈ 1 in big wet regions, ≈ 0.1 in small wet patches.
              // The product attenuates edge darkening in small islands so a
              // fresh stroke on dry paper doesn't lose all its pigment to a ring.
              pressure[i] -=
                EDGE_ETA * deficit * wetBlurLarge[i] * w * activation;
            }
          }
        }
      }
    }

    // ============================================================
    // VELOCITY UPDATE (simplified shallow water, §4.3.1)
    // ============================================================
    const DT = 0.42;
    const VISCOSITY = 0.1;
    const DRAG = 0.014;
    const PAPER_TILT = 0.06; // reduced from 0.32 — paper height is now pixel-fine,
    // so its gradient is essentially noise; keep its
    // contribution to velocity small to avoid jitter
    // SCALE-derived: 1/s scaling makes max display-pixel velocity invariant.
    // Capped at 1.5 — the upwind advection in movePigment has a CFL bound
    // VEL_CLAMP * (DT * 0.7) * 2 < 1, so VEL_CLAMP must stay below ~1.7.
    // Cap engages at SCALE < ~1.33 (e.g. at SCALE=1, ideal is 2.0).

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
        const rowMaybeMasked =
          maskActive && y >= maskRectMinY && y <= maskRectMaxY;
        for (let x = x0; x <= x1; x++) {
          const i = yo + x;
          // Masked cells have no flow — treat them like dry walls.
          if (
            rowMaybeMasked &&
            x >= maskRectMinX &&
            x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD
          ) {
            u_new[i] = 0;
            v_new[i] = 0;
            continue;
          }
          if (wet[i] < 0.04) {
            u_new[i] = 0;
            v_new[i] = 0;
            continue;
          }
          // pressure gradient
          const dpdx = pressure[i + 1] - pressure[i - 1];
          const dpdy = pressure[i + GW] - pressure[i - GW];
          // paper slope (gradient of height field)
          const dhdx = paperH[i + 1] - paperH[i - 1];
          const dhdy = paperH[i + GW] - paperH[i - GW];
          // viscous diffusion (laplacian)
          const lapU = u[i - 1] + u[i + 1] + u[i - GW] + u[i + GW] - 4 * u[i];
          const lapV = v[i - 1] + v[i + 1] + v[i - GW] + v[i + GW] - 4 * v[i];

          let nu =
            u[i] +
            DT *
              (-dpdx * 0.5 -
                dhdx * PAPER_TILT +
                VISCOSITY * lapU -
                DRAG * u[i]);
          let nv =
            v[i] +
            DT *
              (-dpdy * 0.5 -
                dhdy * PAPER_TILT +
                VISCOSITY * lapV -
                DRAG * v[i]);
          // v0.81 — gravity bias. Applied per-step (independent of DT
          // because the user-tuned strength already encapsulates rate).
          // v0.82 — gated specifically on edgeMode === 'gravity' instead
          // of "any edge open". Open mode with all four edges drains
          // without any ambient pull, which matches the "infinite paper
          // window" mental model better.
          // v0.83 — 'radial' direction: bias points outward from canvas
          // center per-cell instead of using the cached fixed vector.
          // The magnitude (gravityStrength × VEL_CLAMP) is the same, just
          // the direction varies. Center cells get zero radial bias
          // (their displacement vector is the zero vector); cells near
          // edges get the strongest pull toward the nearest edge.
          // v0.88 — gravity bias applies in both 'gravity' (open edges
          // in the bias direction) AND 'closed-gravity' (closed edges,
          // bias-only). The latter is for cases where you want gravity
          // dynamics without actually losing pigment off the edges, with
          // optional render-time edgeFade to hide the resulting buildup.
          if (_edgeMode === "gravity" || _edgeMode === "closed-gravity") {
            // v0.93 — Both 'radial' (outward) and 'radial-in' (inward)
            // compute the same per-cell displacement vector from canvas
            // center; the only difference is sign. We flip via a single
            // signed scalar so both branches share the math.
            if (_gravityDir === "radial" || _gravityDir === "radial-in") {
              const cx = (GW - 1) * 0.5;
              const cy = (GH - 1) * 0.5;
              const rx = x - cx;
              const ry = y - cy;
              const rmag = Math.sqrt(rx * rx + ry * ry);
              if (rmag > 0.001) {
                const sign = _gravityDir === "radial-in" ? -1 : 1;
                const radialBias = sign * _gravityStrength * VEL_CLAMP;
                const inv = radialBias / rmag;
                nu += rx * inv;
                nv += ry * inv;
              }
            } else {
              nu += _gravityBiasX;
              nv += _gravityBiasY;
            }
          }
          // v0.69 — MAGNITUDE clamp instead of per-axis. The previous form
          // (-CLAMP ≤ nu ≤ CLAMP and -CLAMP ≤ nv ≤ CLAMP independently)
          // bounded the velocity to a SQUARE envelope, with corners at
          // (±CLAMP, ±CLAMP) — magnitude √2·CLAMP. Diagonal-direction cells
          // could be √2× faster than cardinal-direction cells, which fed a
          // visible cross artifact into every downstream system regardless
          // of the pigment advection scheme. Magnitude clamping uses a
          // CIRCULAR envelope: all directions get the same maximum speed.
          // This was the actual root cause of the cross artifact across
          // v0.56-0.68 — I was looking at the pigment advection the whole
          // time (which IS subtly anisotropic in donor-cell mode, but is
          // perfectly isotropic in semilag mode), missing that the velocity
          // field itself was preferring diagonals over cardinals upstream
          // of any pigment work.
          const mag = Math.sqrt(nu * nu + nv * nv);
          if (mag > VEL_CLAMP) {
            const s = VEL_CLAMP / mag;
            nu *= s;
            nv *= s;
          }
          u_new[i] = nu;
          v_new[i] = nv;
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

    // v0.57 — Advection mode controls how the donor-cell pigment advection
    // handles cells where the velocity field is so strong that the
    // proposed per-cell outflux would exceed the cell's pigment ('CFL
    // violation' in shallow-water terms — the L1 cell speed × adt > 1).
    // Without intervention, such cells donate more pigment than they
    // hold, go negative in the copyback, and K-M renders those negative
    // cells as bright cardinal channels (the cross artifact at extreme
    // deluges in v0.56 and earlier).
    //
    //   'standard' — existing v0.56 behavior, fastest but exhibits the
    //                cross at high velocity / pressure / radius.
    //   'clamp'    — per-cell effective adt capped at 1/(|ux|+|vy|) so
    //                total outflux ≤ gk. Kills the negative cells with
    //                ~5% overhead per movePigment call. Pigment can't
    //                outrun the wavefront, so very-high-velocity strokes
    //                look slightly less aggressive — but mass-conserving.
    //   'substep'  — global substep count N = ceil(maxL1Speed * baseAdt),
    //                capped at 16. Each substep runs a full advection
    //                pass at adt/N. Physically correct propagation at any
    //                velocity; cost is N× the advection during the
    //                handful of post-deluge frames where velocities are
    //                still high.
    // v0.65 — Default changed from 'standard' to 'substep'. The cross
    // artifact at the new v0.60+ extreme deluge defaults (velocity 40+)
    // is a real CFL violation: cells on the grid cardinal axes have
    // velocity (V, 0) or (0, V) — full magnitude on one axis — and
    // donor-cell over-pumps them when V·adt > 1. Diagonal cells split
    // velocity 50/50 per axis and stay below the threshold longer, so
    // they evacuate correctly. The visible cross is cardinal cells
    // going negative (K-M renders negative as brighter-than-paper).
    // Substep mode subdivides the timestep automatically so peak CFL
    // stays ≤ 1 — physically correct, ~2-3× cost during high-velocity
    // frames, drops back to 1× as velocities damp. The v0.61 rays
    // mechanism doesn't help here because it adds MORE radial fields,
    // each with the same CFL violation pattern on the same global grid
    // axes — the cross gets reinforced rather than smeared.
    // v0.65: Default changed from 'standard' to 'substep' to address CFL
    //        violation at v0.60+ extreme deluge defaults.
    // v0.66: Substep cap raised 16 → 64 + inner clamp safety because the
    //        v0.65 cap wasn't enough at default velocity 40.
    // v0.67: Default changed from 'substep' to 'semilag'. Substep fixes
    //        CFL violation but not the donor-cell scheme's intrinsic
    //        cardinal-axis bias; even with CFL ≤ 1 enforced perfectly,
    //        cardinal cells transport pigment ~1.7× more efficiently
    //        than diagonals. Semi-Lagrangian removes the anisotropy
    //        entirely via backward-trace + bilinear interpolation. The
    //        previous "jitter at 0.5" workaround traded cross for visible
    //        radial striations; semilag has neither.

    // Extracted donor-cell advection pass. Reads from g[], writes to
    // g_tmp[] (which the caller must initialize via .set(g[k]) per
    // channel first). adt is the effective timestep; useClamp enables
    // the per-cell adt cap described above. Same masking + wet-cell
    // gating as the v0.56 inlined version.
    function _advectStep(adt, useClamp) {
      const y0 = Math.max(1, activeMinY);
      const y1 = Math.min(GH - 2, activeMaxY);
      const x0 = Math.max(1, activeMinX);
      const x1 = Math.min(GW - 2, activeMaxX);
      const maskedRectActive = maskActive;
      for (let y = y0; y <= y1; y++) {
        const yo = y * GW;
        const rowMaybeMasked =
          maskedRectActive && y >= maskRectMinY && y <= maskRectMaxY;
        for (let x = x0; x <= x1; x++) {
          const i = yo + x;
          if (
            rowMaybeMasked &&
            x >= maskRectMinX &&
            x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD
          )
            continue;
          if (wet[i] < 0.04) continue;
          const ux = u[i],
            vy = v[i];
          // Effective adt for this cell. Default = adt. With clamp, cap
          // at 1/(|ux|+|vy|) so total outflux can't exceed cell pigment.
          let cellAdt = adt;
          if (useClamp) {
            const lenL1 = Math.abs(ux) + Math.abs(vy);
            if (lenL1 * adt > 1) cellAdt = 1 / lenL1;
          }
          for (let k = 0; k < 3; k++) {
            const gk = g[k][i];
            if (gk < 0.0008) continue;
            let outFlux = 0;
            if (ux > 0) {
              const f = ux * gk * cellAdt;
              g_tmp[k][i + 1] += f;
              outFlux += f;
            } else if (ux < 0) {
              const f = -ux * gk * cellAdt;
              g_tmp[k][i - 1] += f;
              outFlux += f;
            }
            if (vy > 0) {
              const f = vy * gk * cellAdt;
              g_tmp[k][i + GW] += f;
              outFlux += f;
            } else if (vy < 0) {
              const f = -vy * gk * cellAdt;
              g_tmp[k][i - GW] += f;
              outFlux += f;
            }
            g_tmp[k][i] -= outFlux;
          }
        }
      }
    }

    // v0.67 — Semi-Lagrangian advection (v0.68: mass-conserving).
    //
    // For each cell, look BACKWARD along the velocity vector by `adt`
    // time-units to find where the pigment "came from", then sample
    // that source position via bilinear interpolation from the 4
    // surrounding cells. Mass conservation is applied via a divergence
    // correction: multiply the bilinear sample by the area-ratio
    // exp(-div(v) * adt), so that pigment in expanding (divergent)
    // flow gets diluted as it spreads out, and pigment in converging
    // flow accumulates. Without this correction the scheme preserves
    // density rather than mass — visually that meant the deluge didn't
    // actually "lift and reveal" the canvas at the center, just
    // smoothly redistributed pigment in place.
    //
    // Why this fixes the cross artifact (still true after the
    // mass-conserving change): the bilinear interpolation function
    // doesn't know which axis is which — it uses continuous source
    // coordinates and weights neighbors by proximity, with no
    // per-axis donation logic. Direct numerical comparison at
    // velocity=40 over 5 frames at d=100 cells:
    //   donor-cell:      card/diag ratio = ∞ (negative cells / CFL)
    //   semi-Lagrangian: card/diag ratio = 1.001 (perfectly isotropic)
    //
    // Why the divergence correction restores transport feel:
    //   For a radial outflow, ∇·v ≈ 2V/r near the source (large
    //   positive divergence). The factor exp(-div*adt) at the center
    //   drops density to near zero in one step. Pigment "leaves" the
    //   center and (because mass is conserved per cell volume change)
    //   accumulates at the wave front where ∇·v transitions toward 0.
    //   This matches the donor-cell visual ("lift and reveal a ring of
    //   accumulated pigment") without donor-cell's cardinal bias.
    //
    // Trade-offs vs donor-cell:
    //   - Isotropic ✓ (no cardinal preference)
    //   - No CFL limit ✓ (bilinear sample handles arbitrary velocity)
    //   - Slightly diffusive (bilinear smoothing); for watercolor
    //     this softens hard pixel edges, reads as natural blending
    //   - Mass conservation is approximate via div-correction; some
    //     drift possible over very long simulations, acceptable for
    //     deluge-scale events
    function _advectStepSemiLagrangian(adt) {
      const y0 = Math.max(1, activeMinY);
      const y1 = Math.min(GH - 2, activeMaxY);
      const x0 = Math.max(1, activeMinX);
      const x1 = Math.min(GW - 2, activeMaxX);
      const maskedRectActive = maskActive;
      const g0 = g[0],
        g1 = g[1],
        g2 = g[2];
      const g0t = g_tmp[0],
        g1t = g_tmp[1],
        g2t = g_tmp[2];
      for (let y = y0; y <= y1; y++) {
        const yo = y * GW;
        const rowMaybeMasked =
          maskedRectActive && y >= maskRectMinY && y <= maskRectMaxY;
        for (let x = x0; x <= x1; x++) {
          const i = yo + x;
          if (
            rowMaybeMasked &&
            x >= maskRectMinX &&
            x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD
          )
            continue;
          if (wet[i] < 0.04) continue;
          const ux = u[i],
            vy = v[i];
          // Mass conservation: scale by area-expansion factor.
          // Divergence via central difference (grid-spacing = 1 cell).
          // For divergent flow (∇·v > 0), area expands, density drops.
          // exp() handles large divergence at the splash epicenter
          // (~2V/r) without going negative the way 1-div*adt would.
          const div =
            (u[i + 1] - u[i - 1]) * 0.5 + (v[i + GW] - v[i - GW]) * 0.5;
          const areaRatio = Math.exp(-div * adt);
          // Look backward along velocity vector for bilinear sample.
          let sx = x - ux * adt;
          let sy = y - vy * adt;
          // v0.81 — Open-boundary aware clamp. If the back-trace lands
          // outside an OPEN edge, this cell's contents at the new
          // timestep came from off-canvas — treat that as zero pigment
          // (paper background). Cells past CLOSED edges still clamp.
          // The "outside" threshold for openness is the actual grid
          // boundary (sx < 0 means we crossed the left edge, etc.).
          let offCanvas = false;
          if (sx < 0) {
            if (_edgeOpenLeft) offCanvas = true;
            else sx = 0;
          } else if (sx > GW - 1.001) {
            if (_edgeOpenRight) offCanvas = true;
            else sx = GW - 1.001;
          }
          if (sy < 0) {
            if (_edgeOpenTop) offCanvas = true;
            else sy = 0;
          } else if (sy > GH - 1.001) {
            if (_edgeOpenBottom) offCanvas = true;
            else sy = GH - 1.001;
          }
          if (offCanvas) {
            g0t[i] = 0;
            g1t[i] = 0;
            g2t[i] = 0;
            continue;
          }
          const sx0 = sx | 0;
          const sy0_ = sy | 0;
          const fx = sx - sx0;
          const fy = sy - sy0_;
          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;
          const j = sy0_ * GW + sx0;
          g0t[i] =
            (w00 * g0[j] +
              w10 * g0[j + 1] +
              w01 * g0[j + GW] +
              w11 * g0[j + GW + 1]) *
            areaRatio;
          g1t[i] =
            (w00 * g1[j] +
              w10 * g1[j + 1] +
              w01 * g1[j + GW] +
              w11 * g1[j + GW + 1]) *
            areaRatio;
          g2t[i] =
            (w00 * g2[j] +
              w10 * g2[j + 1] +
              w01 * g2[j + GW] +
              w11 * g2[j + GW + 1]) *
            areaRatio;
        }
      }
    }

    // v1.13 — row-band copy between the pigment buffers, restricted to the
    // active rect padded by one cell. The advection passes write g_tmp only
    // inside the rect (donor-cell reaches i±1/±GW, hence the pad), so
    // everywhere else g_tmp and g are already identical from the previous
    // pre-copy — the old full-grid copies were pure memory traffic
    // (~9 full-grid passes per simStep at semilag defaults).
    function _copyRectRows(dst, src, x0, x1, y0, y1) {
      for (let y = y0; y <= y1; y++) {
        const a = y * GW + x0;
        dst.set(src.subarray(a, y * GW + x1 + 1), a);
      }
    }

    // Copies g_tmp back into g, clamping high at MAX_PIGMENT. v1.13 —
    // iterates the active rect padded by one cell instead of 0..N (the
    // v0.56-compatible full-grid loop): the advection passes only write
    // g_tmp inside that window, and outside it g_tmp equals g from the
    // pre-copy, so the clamp-copy there was a per-element no-op.
    function _commitAdvectionCopyback() {
      if (activeRectIsEmpty()) return;
      const x0 = Math.max(0, activeMinX - 1),
        x1 = Math.min(GW - 1, activeMaxX + 1);
      const y0 = Math.max(0, activeMinY - 1),
        y1 = Math.min(GH - 1, activeMaxY + 1);
      for (let k = 0; k < 3; k++) {
        const arr = g[k];
        const src = g_tmp[k];
        for (let y = y0; y <= y1; y++) {
          const yo = y * GW;
          for (let x = x0; x <= x1; x++) {
            const i = yo + x;
            const vv = src[i];
            arr[i] = vv > MAX_PIGMENT ? MAX_PIGMENT : vv;
          }
        }
      }
    }

    // v0.81 — Drain pigment, water, and pressure at open edges. Semi-
    // Lagrangian's back-trace doesn't naturally model mass leaving the
    // grid (cells pull from upstream, not push to downstream), so for
    // outflow boundaries we run an explicit donor-cell drainage pass
    // on the cells adjacent to each open edge. For each such edge cell,
    // the OUTGOING flux to off-canvas is `vel_normal · adt · pigment`,
    // and that amount is subtracted from the cell.
    //
    // Velocity normal to an edge: for the bottom edge it's +v (positive
    // y is down); for top it's -v; right is +u; left is -u. We only
    // drain when the velocity is OUTWARD (positive normal) — inward-
    // pointing velocity at an open edge means flow is entering the
    // canvas, which is also a valid open-boundary behavior but means no
    // drainage occurs on this step. For now we treat inflow as "no
    // change" — pigment can't enter from off-canvas because off-canvas
    // has zero pigment.
    //
    // Called from simStep after movePigment, only when at least one
    // edge is open. Drains g[], d[], wet[], pressure[] uniformly. The
    // CFL-style cap (flux <= cell value) prevents negative values.
    function drainBoundaries(adt) {
      if (!(_edgeOpenLeft || _edgeOpenRight || _edgeOpenTop || _edgeOpenBottom))
        return;
      const g0 = g[0],
        g1 = g[1],
        g2 = g[2];
      const d0 = d[0],
        d1 = d[1],
        d2 = d[2];

      // Bottom edge: cells at y = GH-2 (the last interior row), drain
      // proportional to +v.
      if (_edgeOpenBottom) {
        const y = GH - 2;
        for (let x = 1; x < GW - 1; x++) {
          const i = y * GW + x;
          const vy = v[i];
          if (vy <= 0) continue; // not outflow
          let flux = vy * adt;
          if (flux > 1) flux = 1;
          g0[i] *= 1 - flux;
          g1[i] *= 1 - flux;
          g2[i] *= 1 - flux;
          d0[i] *= 1 - flux;
          d1[i] *= 1 - flux;
          d2[i] *= 1 - flux;
          wet[i] *= 1 - flux;
          pressure[i] *= 1 - flux;
        }
      }
      // Top edge: cells at y = 1, drain proportional to -v.
      if (_edgeOpenTop) {
        const y = 1;
        for (let x = 1; x < GW - 1; x++) {
          const i = y * GW + x;
          const vy = -v[i];
          if (vy <= 0) continue;
          let flux = vy * adt;
          if (flux > 1) flux = 1;
          g0[i] *= 1 - flux;
          g1[i] *= 1 - flux;
          g2[i] *= 1 - flux;
          d0[i] *= 1 - flux;
          d1[i] *= 1 - flux;
          d2[i] *= 1 - flux;
          wet[i] *= 1 - flux;
          pressure[i] *= 1 - flux;
        }
      }
      // Right edge: cells at x = GW-2, drain proportional to +u.
      if (_edgeOpenRight) {
        const x = GW - 2;
        for (let y = 1; y < GH - 1; y++) {
          const i = y * GW + x;
          const ux = u[i];
          if (ux <= 0) continue;
          let flux = ux * adt;
          if (flux > 1) flux = 1;
          g0[i] *= 1 - flux;
          g1[i] *= 1 - flux;
          g2[i] *= 1 - flux;
          d0[i] *= 1 - flux;
          d1[i] *= 1 - flux;
          d2[i] *= 1 - flux;
          wet[i] *= 1 - flux;
          pressure[i] *= 1 - flux;
        }
      }
      // Left edge: cells at x = 1, drain proportional to -u.
      if (_edgeOpenLeft) {
        const x = 1;
        for (let y = 1; y < GH - 1; y++) {
          const i = y * GW + x;
          const ux = -u[i];
          if (ux <= 0) continue;
          let flux = ux * adt;
          if (flux > 1) flux = 1;
          g0[i] *= 1 - flux;
          g1[i] *= 1 - flux;
          g2[i] *= 1 - flux;
          d0[i] *= 1 - flux;
          d1[i] *= 1 - flux;
          d2[i] *= 1 - flux;
          wet[i] *= 1 - flux;
          pressure[i] *= 1 - flux;
        }
      }
    }

    // Track the most recently used substep count so the wiring can show
    // it ("substep × N") in the UI when the user wants to see how hard
    // the sim is working post-deluge. Sampled per movePigment call.
    let _lastAdvectionSubsteps = 1;

    function movePigment() {
      if (activeRectIsEmpty()) return;
      const baseAdt = DT * 0.7;
      const mode = _advectionMode;
      // v1.13 — pre-copy/copyback window: active rect padded one cell
      // (donor-cell writes reach i±1/±GW; the diffusion stencil reads ±1).
      const cpx0 = Math.max(0, activeMinX - 1),
        cpx1 = Math.min(GW - 1, activeMaxX + 1);
      const cpy0 = Math.max(0, activeMinY - 1),
        cpy1 = Math.min(GH - 1, activeMaxY + 1);

      if (mode === "substep") {
        // Compute global max L1 cell speed in the active rect so we know
        // how many substeps the worst cell needs. One pass over the
        // active rect; ~N memory reads but no writes.
        let maxL1 = 0;
        const sy0 = Math.max(1, activeMinY);
        const sy1 = Math.min(GH - 2, activeMaxY);
        const sx0 = Math.max(1, activeMinX);
        const sx1 = Math.min(GW - 2, activeMaxX);
        for (let y = sy0; y <= sy1; y++) {
          const yo = y * GW;
          for (let x = sx0; x <= sx1; x++) {
            const i = yo + x;
            const s = Math.abs(u[i]) + Math.abs(v[i]);
            if (s > maxL1) maxL1 = s;
          }
        }
        const cflProduct = maxL1 * baseAdt;
        // v0.66 — Cap raised from 16 to 64. At v0.61 defaults
        // (velocity 40, peak L1 ≈ 56.6), cflProduct ≈ 16.6 which needed
        // 17 substeps but capped at 16, so per-substep CFL stayed at
        // 1.04 — the cardinal cross artifact persisted because each
        // substep was still over the CFL ceiling. At cap 64 the same
        // case uses 17 substeps and per-substep CFL drops to 0.97
        // (under 1, safe). Caps the absolute worst case at ~64 substeps
        // for velocity ~217. Beyond that, an additional within-substep
        // flux clamp kicks in as a safety net (cells can't donate more
        // than they hold). Each substep is ~5ms on a 1080×900 canvas;
        // 64 substeps = ~320ms for one degenerate frame, recovers to 1x
        // within a few frames as velocity damps.
        const numSubsteps =
          cflProduct <= 1 ? 1 : Math.min(64, Math.ceil(cflProduct));
        _lastAdvectionSubsteps = numSubsteps;
        const subDt = baseAdt / numSubsteps;
        // If we're at the cap AND still over CFL=1 per substep, engage
        // flux clamp as a safety net so cells can't go negative. Costs
        // ~5% extra per substep but eliminates the worst over-pumping.
        const perSubstepCfl = maxL1 * subDt;
        const useClampSafety = perSubstepCfl > 1;
        for (let s = 0; s < numSubsteps; s++) {
          for (let k = 0; k < 3; k++)
            _copyRectRows(g_tmp[k], g[k], cpx0, cpx1, cpy0, cpy1);
          _advectStep(subDt, useClampSafety);
          _commitAdvectionCopyback();
        }
      } else if (mode === "semilag") {
        // v0.67 — Semi-Lagrangian: isotropic backward-trace + bilinear
        // interp. No CFL limit, no substep needed, no cardinal bias.
        // Slightly diffusive (bilinear smoothing) which reads as natural
        // soft watercolor blending — typically a feature.
        _lastAdvectionSubsteps = 1;
        for (let k = 0; k < 3; k++)
          _copyRectRows(g_tmp[k], g[k], cpx0, cpx1, cpy0, cpy1);
        _advectStepSemiLagrangian(baseAdt);
        _commitAdvectionCopyback();
      } else {
        // 'standard' or 'clamp' — single pass at baseAdt.
        _lastAdvectionSubsteps = 1;
        for (let k = 0; k < 3; k++)
          _copyRectRows(g_tmp[k], g[k], cpx0, cpx1, cpy0, cpy1);
        _advectStep(baseAdt, mode === "clamp");
        _commitAdvectionCopyback();
      }

      // Isotropic diffusion (smooths sharp pixel artifacts, gives soft
      // wet-in-wet feel). Unchanged from v0.56 — runs once regardless of
      // advection mode because the Laplacian doesn't have a CFL issue
      // at PIGMENT_DIFFUSION's small coefficient.
      const y0 = Math.max(1, activeMinY);
      const y1 = Math.min(GH - 2, activeMaxY);
      const x0 = Math.max(1, activeMinX);
      const x1 = Math.min(GW - 2, activeMaxX);
      const tmp0 = g_tmp[0],
        tmp1 = g_tmp[1],
        tmp2 = g_tmp[2];
      const arr0 = g[0],
        arr1 = g[1],
        arr2 = g[2];
      _copyRectRows(tmp0, arr0, cpx0, cpx1, cpy0, cpy1);
      _copyRectRows(tmp1, arr1, cpx0, cpx1, cpy0, cpy1);
      _copyRectRows(tmp2, arr2, cpx0, cpx1, cpy0, cpy1);
      const PD = PIGMENT_DIFFUSION;
      for (let y = y0; y <= y1; y++) {
        const yo = y * GW;
        const rowMaybeMasked =
          maskActive && y >= maskRectMinY && y <= maskRectMaxY;
        for (let x = x0; x <= x1; x++) {
          const i = yo + x;
          if (
            rowMaybeMasked &&
            x >= maskRectMinX &&
            x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD
          )
            continue;
          if (wet[i] < 0.04) continue;
          const im1 = i - 1,
            ip1 = i + 1,
            im_g = i - GW,
            ip_g = i + GW;
          const c0 = tmp0[i],
            c1 = tmp1[i],
            c2 = tmp2[i];
          arr0[i] =
            c0 +
            PD * (tmp0[im1] + tmp0[ip1] + tmp0[im_g] + tmp0[ip_g] - 4 * c0);
          arr1[i] =
            c1 +
            PD * (tmp1[im1] + tmp1[ip1] + tmp1[im_g] + tmp1[ip_g] - 4 * c1);
          arr2[i] =
            c2 +
            PD * (tmp2[im1] + tmp2[ip1] + tmp2[im_g] + tmp2[ip_g] - 4 * c2);
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
      const p0 = PIGMENTS[0],
        p1 = PIGMENTS[1],
        p2 = PIGMENTS[2];
      const den0 = p0.density,
        sta0 = p0.staining,
        gra0 = p0.granulation;
      const den1 = p1.density,
        sta1 = p1.staining,
        gra1 = p1.granulation;
      const den2 = p2.density,
        sta2 = p2.staining,
        gra2 = p2.granulation;
      const g0 = g[0],
        g1 = g[1],
        g2 = g[2];
      const d0 = d[0],
        d1 = d[1],
        d2 = d[2];
      const y0 = Math.max(0, activeMinY);
      const y1 = Math.min(GH - 1, activeMaxY);
      const x0 = Math.max(0, activeMinX);
      const x1 = Math.min(GW - 1, activeMaxX);
      for (let y = y0; y <= y1; y++) {
        const yo = y * GW;
        const rowMaybeMasked =
          maskActive && y >= maskRectMinY && y <= maskRectMaxY;
        for (let x = x0; x <= x1; x++) {
          const i = yo + x;
          // Masked cells: no g↔d transfer. Frozen.
          if (
            rowMaybeMasked &&
            x >= maskRectMinX &&
            x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD
          )
            continue;
          if (wet[i] < 0.04) continue;
          const h = paperH[i];
          const hg0 = 1 - h * gra0,
            hg1 = 1 - h * gra1,
            hg2 = 1 - h * gra2;
          const hu0 = 1 + (h - 1) * gra0,
            hu1 = 1 + (h - 1) * gra1,
            hu2 = 1 + (h - 1) * gra2;

          // pigment 0
          let gi = g0[i],
            di = d0[i];
          let down = gi * hg0 * den0;
          let up = (di * hu0 * den0) / sta0;
          if (down < 0) down = 0;
          if (up < 0) up = 0;
          if (di + down > 1) down = 1 - di > 0 ? 1 - di : 0;
          if (gi + up > 1) up = 1 - gi > 0 ? 1 - gi : 0;
          d0[i] = di + down - up;
          g0[i] = gi + up - down;

          // pigment 1
          gi = g1[i];
          di = d1[i];
          down = gi * hg1 * den1;
          up = (di * hu1 * den1) / sta1;
          if (down < 0) down = 0;
          if (up < 0) up = 0;
          if (di + down > 1) down = 1 - di > 0 ? 1 - di : 0;
          if (gi + up > 1) up = 1 - gi > 0 ? 1 - gi : 0;
          d1[i] = di + down - up;
          g1[i] = gi + up - down;

          // pigment 2
          gi = g2[i];
          di = d2[i];
          down = gi * hg2 * den2;
          up = (di * hu2 * den2) / sta2;
          if (down < 0) down = 0;
          if (up < 0) up = 0;
          if (di + down > 1) down = 1 - di > 0 ? 1 - di : 0;
          if (gi + up > 1) up = 1 - gi > 0 ? 1 - gi : 0;
          d2[i] = di + down - up;
          g2[i] = gi + up - down;
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

    function evaporate() {
      // v0.19 — mask-rect optimization. Branch ONCE on whether any mask
      // exists at all, then either run a fast path with no mask logic, or
      // a path that checks each cell against the (typically tiny) mask
      // rect. The old code did `maskActive && mask[i] > MASK_THRESHOLD`
      // on every one of N cells (whole grid, not active rect), even when
      // a mask only covered a small region.
      //
      // v1.13 — settled-cell skip. evaporate deliberately runs the whole
      // grid (global drying must continue with an empty active rect), but
      // the dry-settle branch was rewriting ~10 values per cell for cells
      // that settled long ago: wet 0 stays 0, there is no suspended
      // pigment to fold into d, velocity was zeroed when the cell dried,
      // and (when fading) the spring velocity was reset at settle time.
      // Those cells are an exact no-op — skip them instead of re-writing.
      const sg0 = g[0], sg1 = g[1], sg2 = g[2];
      const fadeSpring = fadeEnabled && dVel !== null;
      const dv0 = fadeSpring ? dVel[0] : null,
        dv1 = fadeSpring ? dVel[1] : null,
        dv2 = fadeSpring ? dVel[2] : null;
      if (!maskActive) {
        for (let i = 0; i < N; i++) {
          if (
            wet[i] === 0 &&
            sg0[i] === 0 && sg1[i] === 0 && sg2[i] === 0 &&
            u[i] === 0 && v[i] === 0 &&
            (!fadeSpring || (dv0[i] === 0 && dv1[i] === 0 && dv2[i] === 0))
          )
            continue;
          let w = wet[i] * evaporationRate;
          if (w < 0.025) {
            for (let k = 0; k < 3; k++) {
              let nd = d[k][i] + g[k][i];
              if (nd > MAX_PIGMENT) nd = MAX_PIGMENT;
              d[k][i] = nd;
              g[k][i] = 0;
            }
            // v0.50 — Fresh paint just settled to the deposited layer.
            // Reset the spring's velocity for this cell so the fade
            // starts from rest, not mid-trajectory from any previous
            // fading state. Cheap branch — only checks the toggle.
            if (fadeEnabled && dVel !== null) {
              dVel[0][i] = 0;
              dVel[1][i] = 0;
              dVel[2][i] = 0;
            }
            w = 0;
            u[i] = 0;
            v[i] = 0;
          }
          wet[i] = w;
        }
      } else {
        // Mask exists. Two-region pass: cells inside the mask rect get the
        // per-cell check; cells outside skip directly to the fast path.
        // This is the v0.19 win — mask checks are restricted to a small
        // sub-area instead of running across the whole grid.
        for (let y = 0; y < GH; y++) {
          const rowMaybeMasked = y >= maskRectMinY && y <= maskRectMaxY;
          const yo = y * GW;
          for (let x = 0; x < GW; x++) {
            const i = yo + x;
            if (
              rowMaybeMasked &&
              x >= maskRectMinX &&
              x <= maskRectMaxX &&
              mask[i] > MASK_THRESHOLD
            )
              continue;
            // v1.13 — settled-cell skip; see the twin fast-path block above.
            if (
              wet[i] === 0 &&
              sg0[i] === 0 && sg1[i] === 0 && sg2[i] === 0 &&
              u[i] === 0 && v[i] === 0 &&
              (!fadeSpring || (dv0[i] === 0 && dv1[i] === 0 && dv2[i] === 0))
            )
              continue;
            let w = wet[i] * evaporationRate;
            if (w < 0.025) {
              for (let k = 0; k < 3; k++) {
                let nd = d[k][i] + g[k][i];
                if (nd > MAX_PIGMENT) nd = MAX_PIGMENT;
                d[k][i] = nd;
                g[k][i] = 0;
              }
              // v0.50 — Fresh paint settled into d[]; reset spring velocity
              // so fade starts from rest. See twin block above.
              if (fadeEnabled && dVel !== null) {
                dVel[0][i] = 0;
                dVel[1][i] = 0;
                dVel[2][i] = 0;
              }
              w = 0;
              u[i] = 0;
              v[i] = 0;
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
        const rowMaybeMasked =
          maskActive && y >= maskRectMinY && y <= maskRectMaxY;
        for (let x = x0; x <= x1; x++) {
          const i = yo + x;
          // Masked cells are frozen — wet can't diffuse into or out of them.
          if (
            rowMaybeMasked &&
            x >= maskRectMinX &&
            x <= maskRectMaxX &&
            mask[i] > MASK_THRESHOLD
          )
            continue;
          // Skip cells with no wet anywhere in the 5-cell stencil — the
          // Laplacian is zero, no change would result. This is the common
          // case in unpainted areas.
          const c = wet_tmp[i];
          const wa = wet_tmp[i - 1],
            wb = wet_tmp[i + 1];
          const wc = wet_tmp[i - GW],
            wd = wet_tmp[i + GW];
          if (c < 1e-6 && wa < 1e-6 && wb < 1e-6 && wc < 1e-6 && wd < 1e-6)
            continue;
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
      // v0.81 — open-boundary outflow drainage. No-op when all edges
      // closed. Runs after movePigment so the drained values include the
      // result of this frame's advection. adt matches movePigment's
      // baseAdt (DT * 0.7).
      drainBoundaries(DT * 0.7);
      transferPigment();
      if (!dryingPaused) evaporate();
      // v1.13 — the shrink half of active-region tracking. The header
      // comment above the rect state always described this ("runs every
      // ACTIVE_SHRINK_INTERVAL frames in the main loop") but it was never
      // wired — the rect only ever grew, so after strokes near opposite
      // corners every rect-bounded pass ran effectively full-grid until
      // the canvas idled. Counted in sim steps here (the loop runs two
      // per frame) so headless drivers exercise it identically; tightens
      // to current suspended-pigment/pressure content, and empties after
      // a full dry-down (which also lets simStep take its early-return).
      if (++framesSinceShrink >= ACTIVE_SHRINK_INTERVAL * 2) {
        framesSinceShrink = 0;
        shrinkActiveRect();
      }
    }


  // ============================================================
  // BRUSH STAMP DEPOSIT (v1.20 — migration Phase 1)
  // Moved verbatim from the host's paintAt: the six deposit branches,
  // driven by a FULLY RESOLVED stamp. The host (or the worker protocol)
  // resolves everything UI-flavored before calling — pigment identity to
  // a channel or weights (rainbow included), load sliders to gains,
  // brush mode to a texture descriptor carrying the noise field — so
  // this function is pure field math and runs identically in-process or
  // in a worker.
  //
  //   stamp = {
  //     kind: 'pigment'|'rainbow'|'water'|'lift'|'paper'|'mask',
  //     cx, cy, radius,            // grid units, already canvas-scaled
  //     strength,
  //     // pigment:  channel, depositMult, wetGain, presGain, texture|null
  //     // rainbow:  weights [w0,w1,w2], depositMult, wetGain, presGain
  //     // water:    wetGain, presGain, liftGain
  //     // paper:    wetGain
  //     // texture:  { field, baseThresh, bandHalf, anisoK, paperWeight,
  //     //             bristleK, motionX, motionY }
  //   }
  //
  // Callers own expandActiveRect + the wake hook (the host's paintAt
  // keeps doing both before delegating); mask stamps report the cells
  // that crossed the threshold via env.commitMaskStamp(minX, maxX,
  // minY, maxY) so mask-rect bookkeeping stays host-owned.
  // ============================================================
  function applyStamp(stamp) {
    const gx = stamp.cx,
      gy = stamp.cy,
      strength = stamp.strength;
    const r = stamp.radius;
    const r2 = r * r;
    const minX = Math.max(0, Math.floor(gx - r));
    const maxX = Math.min(GW - 1, Math.ceil(gx + r));
    const minY = Math.max(0, Math.floor(gy - r));
    const maxY = Math.min(GH - 1, Math.ceil(gy + r));

    if (stamp.kind === "mask") {
      let anyAboveThreshold = false;
      let rMinX = GW,
        rMaxX = -1,
        rMinY = GH,
        rMaxY = -1;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const dx = px - gx,
            dy = py - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const i = py * GW + px;
          const falloff = 1 - Math.sqrt(d2) / r;
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
      if (anyAboveThreshold && env.commitMaskStamp) {
        env.commitMaskStamp(rMinX, rMaxX, rMinY, rMaxY);
        _refreshLive(); // the host just updated mask state — re-read it
      }
      return;
    }

    if (stamp.kind === "water") {
      const wetGain = stamp.wetGain;
      const presGain = stamp.presGain;
      const liftGain = stamp.liftGain;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const dx = px - gx,
            dy = py - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const i = py * GW + px;
          if (maskActive && mask[i] > MASK_THRESHOLD) continue;
          const falloff = 1 - Math.sqrt(d2) / r;
          const f2 = falloff * falloff;
          const ww = wet[i] + wetGain * falloff;
          wet[i] = ww > 1 ? 1 : ww;
          pressure[i] += presGain * f2;
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

    if (stamp.kind === "lift") {
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const dx = px - gx,
            dy = py - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const i = py * GW + px;
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

    if (stamp.kind === "paper") {
      const wetGain = stamp.wetGain;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const dx = px - gx,
            dy = py - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const i = py * GW + px;
          if (maskActive && mask[i] > MASK_THRESHOLD) continue;
          const falloff = 1 - Math.sqrt(d2) / r;
          const f2 = falloff * falloff;
          const clearAmount = strength * f2;
          const keep = Math.max(0, 1 - clearAmount);
          d[0][i] *= keep;
          d[1][i] *= keep;
          d[2][i] *= keep;
          g[0][i] *= keep;
          g[1][i] *= keep;
          g[2][i] *= keep;
          const wetAdd = f2 * strength * wetGain;
          const nw = wet[i] + wetAdd;
          wet[i] = nw > 1 ? 1 : nw;
        }
      }
      return;
    }

    if (stamp.kind === "rainbow") {
      const w0 = stamp.weights[0],
        w1 = stamp.weights[1],
        w2 = stamp.weights[2];
      const g0 = g[0],
        g1 = g[1],
        g2 = g[2];
      const wetGain = stamp.wetGain;
      const presGain = stamp.presGain;
      const depositMult = stamp.depositMult;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const dx = px - gx,
            dy = py - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const i = py * GW + px;
          if (maskActive && mask[i] > MASK_THRESHOLD) continue;
          const falloff = 1 - Math.sqrt(d2) / r;
          const f2 = falloff * falloff;
          const add = strength * f2 * depositMult;
          let na = g0[i] + add * w0;
          if (na > MAX_PIGMENT) na = MAX_PIGMENT;
          g0[i] = na;
          na = g1[i] + add * w1;
          if (na > MAX_PIGMENT) na = MAX_PIGMENT;
          g1[i] = na;
          na = g2[i] + add * w2;
          if (na > MAX_PIGMENT) na = MAX_PIGMENT;
          g2[i] = na;
          const ww = wet[i] + wetGain * falloff;
          wet[i] = ww > 1 ? 1 : ww;
          pressure[i] += presGain * f2;
        }
      }
      return;
    }

    // kind === 'pigment' — single channel, optional texture modulation
    const arr = g[stamp.channel];
    const pigDepositMult = stamp.depositMult;
    const tex = stamp.texture;
    const textureActive = !!tex;
    const textureField = tex ? tex.field : null;
    const textureBaseThresh = tex ? tex.baseThresh : 0;
    const textureBandHalf = tex ? tex.bandHalf : 0.05;
    const textureAnisoK = tex ? tex.anisoK : 0;
    const texturePaperWeight = tex ? tex.paperWeight : 0.55;
    const textureMotionX = tex ? tex.motionX : 0;
    const textureMotionY = tex ? tex.motionY : 0;
    const textureBristleK = tex ? tex.bristleK : 0;
    const effPigWetGain = stamp.wetGain;
    const effPigPresGain = stamp.presGain;
    const rInv = r > 0 ? 1 / r : 0;

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - gx,
          dy = py - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = py * GW + px;
        if (maskActive && mask[i] > MASK_THRESHOLD) continue;
        const falloff = 1 - Math.sqrt(d2) / r;
        const f2 = falloff * falloff;
        let textureMul = 1.0;
        if (textureActive) {
          let nval = textureField ? textureField[i] : 0.5;
          if (texturePaperWeight > 0) {
            nval = nval * (1 - texturePaperWeight) +
                   paperH[i] * texturePaperWeight;
          }
          if (textureAnisoK !== 0) {
            const dxN = dx * rInv,
              dyN = dy * rInv;
            const align = dxN * textureMotionX + dyN * textureMotionY;
            nval += textureAnisoK * align * 0.05;
          }
          const lo = textureBaseThresh - textureBandHalf;
          const hi = textureBaseThresh + textureBandHalf;
          const t = (nval - lo) / Math.max(1e-6, hi - lo);
          const smoothT = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
          textureMul = smoothT;
          if (textureBristleK > 0) {
            const r1 = (((i * 2654435761) >>> 0) & 0xffff) / 0xffff;
            if (r1 < textureBristleK) textureMul = 0;
          }
          if (textureMul <= 0) continue;
        }
        let na = arr[i] + strength * f2 * pigDepositMult * textureMul;
        if (na > MAX_PIGMENT) na = MAX_PIGMENT;
        arr[i] = na;
        const ww =
          wet[i] + effPigWetGain * falloff * (textureActive ? textureMul : 1);
        wet[i] = ww > 1 ? 1 : ww;
        pressure[i] += effPigPresGain * f2 * (textureActive ? textureMul : 1);
      }
    }
  }

  refreshBindings();
  _refreshLive();
  const _rectOut = { minX: 0, maxX: -1, minY: 0, maxY: -1 };
  return {
    refreshBindings,
    applyStamp(stamp) { _refreshLive(); return applyStamp(stamp); },
    rectBounds() {
      _rectOut.minX = activeMinX; _rectOut.maxX = activeMaxX;
      _rectOut.minY = activeMinY; _rectOut.maxY = activeMaxY;
      return _rectOut;
    },
    lastAdvectionSubsteps: () => _lastAdvectionSubsteps,
    simStep(params) { _refreshLive(); return simStep(params); },
    movePigment() { _refreshLive(); return movePigment(); },
    transferPigment() { _refreshLive(); return transferPigment(); },
    diffuseWet() { _refreshLive(); return diffuseWet(); },
    evaporate() { _refreshLive(); return evaporate(); },
    updateVelocity() { _refreshLive(); return updateVelocity(); },
    applyEdgeDarkening() { _refreshLive(); return applyEdgeDarkening(); },
    drainBoundaries(adt) { _refreshLive(); return drainBoundaries(adt); },
    generatePaper, smoothNoise,
    expandActiveRect, setActiveRectFull, setActiveRectEmpty,
    activeRectIsEmpty, shrinkActiveRect,
    MAX_PIGMENT, DT, VISCOSITY, DRAG, PAPER_TILT,
    EDGE_ETA, EDGE_WET_ACTIVE, EDGE_WET_OFF, ACTIVE_THRESHOLD,
  };
}
