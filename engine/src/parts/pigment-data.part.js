    // ============================================================
    // PIGMENT DATA — from Figure 5 of Curtis et al. 1997
    // K, S coefficients given per RGB channel; rho = density,
    // omega = staining power, gamma = granulation.
    // ============================================================
    // v0.37 — Two pigment sets. PIGMENTS_TRANSPARENT is the canonical
    // Curtis et al. (1997) Figure 5 watercolor data, used by default and
    // for the "transparent" half of any future mixed workflow. The pigment
    // works by passing light through itself and selectively absorbing —
    // the paper underneath is what reflects color back. This means
    // transparent pigments are nearly invisible on dark paper (no light
    // to filter).
    //
    // PIGMENTS_OPAQUE is the gouache-equivalent set: high scattering (S)
    // across the board so the pigment particles themselves reflect light
    // regardless of background. Tuned to be vibrant on near-black paper
    // while remaining recognizably the same three colors. K/S ratios
    // (v0.38, more saturated than v0.37 initial values):
    //   rose:   ~0.002 / 3.0  / 0.82  → R ≈ 0.96, 0.13, 0.30  (saturated magenta-pink)
    //   yellow: ~0.0005 / 0.0036 / 4.0 → R ≈ 0.97, 0.92, 0.10 (electric yellow)
    //   blue:   ~3.0   / 0.60 / 0.002 → R ≈ 0.13, 0.35, 0.96  (saturated cerulean)
    // Density bumped further (real gouache settles aggressively); staining
    // and granulation stay reduced since gouache sits on the surface.
    //
    // The active set is referenced through the mutable `PIGMENTS` variable
    // below. Hot loops cache `PIGMENTS[i]` to local const at function
    // entry, so swapping the reference costs nothing per-cell — only the
    // WebGL uniforms need an explicit re-upload, and the next render needs
    // to be forced full so already-deposited pigment recomposites correctly.
    const PIGMENTS_TRANSPARENT = [
      {
        name: "Quinacridone Rose",
        K: [0.22, 1.47, 0.57],
        S: [0.05, 0.003, 0.03],
        density: 0.02,
        staining: 5.5,
        granulation: 0.81,
      },
      {
        name: "Hansa Yellow",
        K: [0.06, 0.21, 1.78],
        S: [0.5, 0.88, 0.009],
        density: 0.06,
        staining: 1.0,
        granulation: 0.08,
      },
      {
        name: "Cerulean Blue",
        K: [1.52, 0.32, 0.25],
        S: [0.06, 0.26, 0.4],
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
        density: 0.01,
        staining: 5.0,
        granulation: 0.75,
      },
    ];
    const PIGMENTS_OPAQUE = [
      {
        // v0.38 — more vibrant. Targets R ≈ [0.96, 0.13, 0.30] →
        // saturated magenta-pink instead of the v0.37 dusty rose.
        // v0.39 — density bumped 0.08 → 0.20 for thicker per-stamp
        // deposition (gouache builds opaque faster than watercolor).
        name: "Opaque Rose",
        K: [0.005, 7.5, 2.04],
        S: [2.5, 2.5, 2.5],
        density: 0.2,
        staining: 1.5,
        granulation: 0.1,
      },
      {
        // v0.38 — more vibrant. Targets R ≈ [0.97, 0.92, 0.10] →
        // electric/lemon yellow.
        // v0.39 — density 0.10 → 0.22. Yellow takes slightly more
        // density than rose/blue because its visual saturation peaks
        // later (both red AND green channels contribute, so a thin
        // stroke reads as washed-out cream rather than full yellow).
        name: "Opaque Yellow",
        K: [0.0012, 0.009, 10.0],
        S: [2.5, 2.5, 2.5],
        density: 0.22,
        staining: 1.0,
        granulation: 0.05,
      },
      {
        // v0.38 — more vibrant. Targets R ≈ [0.13, 0.35, 0.96] →
        // saturated cerulean / electric blue.
        // v0.39 — density bumped 0.08 → 0.20.
        name: "Opaque Blue",
        K: [7.5, 1.51, 0.005],
        S: [2.5, 2.5, 2.5],
        density: 0.2,
        staining: 1.5,
        granulation: 0.1,
      },
    ];
    // Active set — reassigned by gouacheMode(true|false). All read sites
    // in the lib reference this name; swapping the binding swaps the
    // physics across the whole engine.
    let PIGMENTS = PIGMENTS_TRANSPARENT;

    // ── v1.10 — custom pigment palettes ────────────────────────────────
    // Redefine what the three working pigments ARE (their color identity via
    // K/S, plus density/staining/granulation). The 3-channel sim is
    // unchanged; we only change the pigments those channels represent.
    let _customPigments = null;   // array<pigmentRecord> | null (null = stock)

    // sRGB hex/CSS → Kubelka–Munk {K,S} per channel for a saturated layer.
    // Forward model is kmReflect(K,S,thick,Rbg); we invert the two-constant
    // simplification K/S = (1-R)^2 / (2R) per channel at the target
    // reflectance, with S fixed per channel and K derived to land the hue.
    // A scattering floor keeps very dark inks from producing extreme K.
    function _colorToKS(rgb, granulation) {
      // rgb in 0..1. Clamp reflectance away from 0/1 so K/S stays finite.
      const ksOf = (R) => {
        const r = Math.min(0.992, Math.max(0.02, R));
        return (1 - r) * (1 - r) / (2 * r);     // K/S ratio
      };
      // Scattering S sets how fast a layer reaches its full (infinite-
      // thickness) reflectance R∞ = 1 + K/S − √((K/S)² + 2K/S). A dried
      // saturated stamp has thickness ≈ 1.3; with S≈3 the layer is within
      // ~0.05 of R∞ there, so the rendered swatch matches the requested
      // color. granulation modulates S around that base (more granular →
      // a touch more scattering / opacity) without breaking the match.
      const Sbase = 3.0 * (0.85 + (granulation == null ? 0.3 : granulation) * 0.5);
      const K = [0, 0, 0], S = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        S[c] = Sbase;
        K[c] = ksOf(rgb[c]) * Sbase;        // K/S ratio fixes the hue; S fixes the approach
      }
      return { K, S };
    }

    // Normalize one developer-supplied pigment spec into the engine record
    // shape {name,K,S,density,staining,granulation}. Accepts either an
    // explicit {K,S,...} or a {color:'#hex'|css, density?,staining?,granulation?}.
    function _normalizePigment(spec, idx) {
      if (!spec || typeof spec !== "object")
        throw new Error("pigments(): entry " + idx + " must be an object");
      const gran = spec.granulation == null ? 0.3 : +spec.granulation;
      let K = spec.K, S = spec.S;
      if (!Array.isArray(K) || !Array.isArray(S)) {
        const rgb = _parseColorToRGB(spec.color);
        if (!rgb) throw new Error("pigments(): entry " + idx + " needs a valid color or explicit K/S; got " + JSON.stringify(spec.color));
        const ks = _colorToKS(rgb, gran);
        K = ks.K; S = ks.S;
      }
      return {
        name: spec.name || ("Custom " + idx),
        color: spec.color || null,
        K: [K[0], K[1], K[2]],
        S: [S[0], S[1], S[2]],
        density: spec.density == null ? 0.04 : +spec.density,
        staining: spec.staining == null ? 2.5 : +spec.staining,
        granulation: gran,
      };
    }

    // Single source of truth for which array is live. Custom palette wins
    // over gouache/auto/transparent; otherwise the existing logic stands.
    function _applyActivePigments() {
      if (_customPigments) { PIGMENTS = _customPigments; return; }
      if (_gouacheMode === "auto") { _recomputeLerpedPigments(_paperDarkness()); PIGMENTS = PIGMENTS_LERPED; }
      else if (_gouacheMode) PIGMENTS = PIGMENTS_OPAQUE;
      else PIGMENTS = PIGMENTS_TRANSPARENT;
    }

    // v0.51 — Auto-LERP between transparent and opaque sets based on the
    // darkness of the paper. Physically motivated: light hitting a
    // transparent pigment passes through, bounces off the paper, and
    // comes back through the pigment (so the paper color dominates).
    // Light hitting an opaque pigment scatters off the particles
    // themselves (so the paper barely matters). For a sheet that's
    // somewhere between white and black, the optically correct medium
    // is somewhere between fully-transparent and fully-opaque — a
    // mixture of scattering and non-scattering particles. Linear LERP
    // of K, S, density, staining, and granulation between the two
    // pigment sets approximates this mixture.
    //
    // PIGMENTS_LERPED is the third "active" array. When gouacheMode is
    // 'auto', PIGMENTS points here, and the contents are recomputed
    // every time paperColor() changes via _recomputeLerpedPigments().
    // Same shape as the other two arrays so all read sites (CPU loops,
    // GPU uniform upload, swatch rendering, rainbow color) just work.
    const PIGMENTS_LERPED = [
      {
        name: "Quinacridone Rose (auto)",
        K: [0, 0, 0],
        S: [0, 0, 0],
        density: 0,
        staining: 0,
        granulation: 0,
      },
      {
        name: "Hansa Yellow (auto)",
        K: [0, 0, 0],
        S: [0, 0, 0],
        density: 0,
        staining: 0,
        granulation: 0,
      },
      {
        name: "Cerulean Blue (auto)",
        K: [0, 0, 0],
        S: [0, 0, 0],
        density: 0,
        staining: 0,
        granulation: 0,
      },
    ];

    // v0.51 — Current LERP amount when in auto mode. 0 = pure transparent,
    // 1 = pure opaque. Exposed via gouacheLerpAmount() for inspection.
    // Always reflects the value most recently used to populate
    // PIGMENTS_LERPED, even when auto mode is not active (so it's safe
    // to read at any time).
    let _gouacheLerpT = 0;

    // Compute paper darkness ∈ [0, 1] from the current paper RGB. Uses
    // Rec. 709 luminance weights (matching modern display gamut math)
    // and inverts so 0 = white paper, 1 = black paper. The base paper
    // color is read fresh on every call; the per-cell paper texture noise
    // is not factored in (it averages to zero and would only add jitter).
    function _paperDarkness() {
      // Rec. 709 luminance
      const L =
        0.2126 * PAPER_R_BASE + 0.7152 * PAPER_G_BASE + 0.0722 * PAPER_B_BASE;
      const d = 1 - L;
      return d < 0 ? 0 : d > 1 ? 1 : d;
    }

    // Recompute PIGMENTS_LERPED contents at the given LERP amount t∈[0,1].
    // t is clamped defensively. After this call, every read of PIGMENTS[i].K
    // etc. will return the LERPed value on the next frame.
    function _recomputeLerpedPigments(t) {
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      _gouacheLerpT = t;
      const a = PIGMENTS_TRANSPARENT;
      const b = PIGMENTS_OPAQUE;
      const out = PIGMENTS_LERPED;
      for (let i = 0; i < 3; i++) {
        for (let c = 0; c < 3; c++) {
          out[i].K[c] = a[i].K[c] + (b[i].K[c] - a[i].K[c]) * t;
          out[i].S[c] = a[i].S[c] + (b[i].S[c] - a[i].S[c]) * t;
        }
        out[i].density = a[i].density + (b[i].density - a[i].density) * t;
        out[i].staining = a[i].staining + (b[i].staining - a[i].staining) * t;
        out[i].granulation =
          a[i].granulation + (b[i].granulation - a[i].granulation) * t;
      }
    }

    // A sentinel for the water brush — selectable like a pigment, but adds
    // only water + pressure + a localized lift of deposited pigment. Kept
    // out of the PIGMENTS array so KM compositing and swatch loops aren't
    // forced to special-case a non-pigment entry.
    const WATER_INDEX = -1;
    // A sentinel for the lift (subtract) brush — removes pigment from the
    // paper at touched cells, leaving water and pressure alone. The water
    // brush already lifts in the sense of re-suspending d → g, but it
    // doesn't reduce the total pigment on the page; this one does.
    const LIFT_INDEX = -2;
    // A sentinel for the rainbow brush — deposits a time-varying mixture
    // of all three pigments. The deposit weights cycle rose → yellow →
    // blue → rose with one stop every RAINBOW_STOP_MS, so a continuous
    // stroke smears through the full pigment cycle. See rainbowWeights().
    const RAINBOW_INDEX = -3;
    const RAINBOW_PERIOD_MS = 2250;
    const RAINBOW_STOP_MS = 750;
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

    // v0.32 — Paper brush. The pigment-sentinel approach (alongside
    // WATER_INDEX, LIFT_INDEX, etc.) for painting the *paper color* over
    // the canvas. Used by obliterate's 'paper' mode and exposed as a
    // regular brush via the 'paper' name. Painting clears deposited +
    // suspended pigment in the brush footprint and adds wetness, so the
    // cell renders as clean paper (whatever paperColor() returns) with a
    // slight wet sheen that bleeds outward through the simulation. Unlike
    // 'lift' (which gradually moves pigment back into suspension where it
    // can re-settle), the paper brush ZEROS pigment outright — it's an
    // opaque-paint metaphor, not a wet-blot one.
    const PAPER_INDEX = -5;
    const MASK_THRESHOLD = 0.1; // cell considered masked above this
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
    const MASK_TINT_PEAK = 0.3; // max yellow blend over underlying
    // v0.80 — runtime toggle for the amber mask tint. When false, masked
    // cells render as ordinary paper/pigment so the mask is invisible
    // (still functionally frozen — flow continues to skip them, the user
    // just doesn't see the amber overlay). Useful for taking screenshots
    // where the mask shouldn't be visible, or for previewing what a
    // composition looks like with the mask in place but not displayed.
    let _maskTintVisible = true;

    // v0.84 — VEL_CLAMP is auto-computed from SCALE (1/scale, capped at
    // 1.5) so display-pixel velocity stays invariant across resolutions.
    // The user can override via the API. Once overridden, the resolution
    // slider's recompute logic skips VEL_CLAMP so the manual value
    // persists. The flag flips back via velocityClamp(null) to restore
    // auto-recompute behavior.
    let _velocityClampManual = false;

    // v0.86 — Wetness heatmap overlay. When enabled, renders a separate
    // overlay canvas showing wet[] mapped through a two-color gradient.
    // Lets the user see which parts of the canvas are still wet (useful
    // for layering — wet-on-wet vs wet-on-dry behavior differs visibly).
    // Two color stops are user-configurable so the heatmap can be styled
    // to match a portfolio palette. Default: blue-on-yellow (dry→wet).
    let _wetnessHeatmapEnabled = false;
    let _wetnessLowColor = [0xfc, 0xf3, 0xa7]; // pale yellow (dry)
    let _wetnessHighColor = [0x29, 0x6f, 0xa7]; // deep blue (wet)
    let _wetnessOverlayCanvas = null;
    let _wetnessOverlayCtx = null;
    let _wetnessOverlayImageData = null;

    // v0.88 — Edge fade. Render-time alpha falloff in the last N pixels
    // of each edge, using a smoothstep curve. Hides pigment that's
    // accumulated near the boundary (useful with 'closed-gravity' mode
    // to get the gravity dynamics without the visible edge buildup).
    // 0 = disabled. Independent of edge mode — composes freely with any
    // of closed / closed-gravity / open / gravity.
    let _edgeFadePixels = 0;

    // v0.89 — Most-recently-applied quality preset name. null until
    // quality() is called at least once. Returned by quality() reads
    // so embedders can show the current state in their UI.
    let _qualityCurrent = null;

    // v0.90 — Pause state. When paused, the rAF loop continues to run
    // (to keep input/render responsive when acceptInput is true) but
    // skips simStep, fadeStep, timeWashStep, animationStep, and
    // visualizationStep. The svgTraceStep + applyPendingPaint + render
    // path continues to run unconditionally so the user can still
    // programmatically deposit pigment (via traceSVG/splash/etc.) and
    // see it; with acceptInput: true the user can also paint via
    // pointer.
    //
    // _pauseStartedAt is captured at the moment of pause; on resume,
    // timer references for time-based animations (background washes,
    // SVG traces, breathe modes) are shifted by the elapsed pause time
    // so they pick up exactly where they left off instead of jumping
    // ahead by the wall-clock duration of the pause.
    let _paused = false;
    let _pauseAcceptInput = false;
    let _pauseStartedAt = 0;
    // v0.90 — Pause render gating. During pause we want render() to fire
    // once per deposit-batch, not every frame. _pauseDirty is set true
    // by paintAt + markCanvasActive (so any deposit, programmatic or
    // pointer-driven, flips it); the loop reads + clears it. Without
    // this, paused-with-input would call render() every frame even when
    // the user is idle, wasting CPU on each of N canvases.
    let _pauseDirty = false;

    // Permissive color parser for the wetness heatmap API. Accepts:
    //   '#rgb'        → expand each digit
    //   '#rrggbb'     → standard hex
    //   [r, g, b]     → 0..255 ints
    // Falls back to the provided default on parse failure.
    function _parseHeatmapColor(v, fallback) {
      if (Array.isArray(v) && v.length >= 3) {
        return [v[0] | 0, v[1] | 0, v[2] | 0];
      }
      if (typeof v === "string") {
        let s = v.trim();
        if (s.charAt(0) === "#") s = s.slice(1);
        if (s.length === 3) {
          s = s
            .split("")
            .map((c) => c + c)
            .join("");
        }
        if (s.length === 6) {
          const n = parseInt(s, 16);
          if (!isNaN(n)) {
            return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
          }
        }
      }
      return fallback;
    }

    // v0.81 — Edge boundary behavior. Three modes:
    //   'closed'  — all four edges reflect; mass conserved exactly.
    //               Current/default behavior, preserved for backward compat.
    //   'open'    — all four edges drain. Pigment, water, pressure that
    //               advects past the boundary is discarded. Optional
    //               velocity bias via gravityStrength + gravityDirection.
    //   'gravity' — edges open in the direction of gravity (e.g. 'down'
    //               opens just the bottom; 'down-right' opens bottom and
    //               right). Velocity bias always active.
    //
    // Encoded internally as: _edgeOpenLeft/Right/Top/Bottom flags + a
    // (_gravityBiasX, _gravityBiasY) velocity perturbation applied in
    // updateVelocity. The flags + bias are derived from the public
    // triple (mode, direction, strength) whenever any of them change,
    // so the inner loops just read flags and bias without conditionals
    // on the higher-level state.
    let _edgeMode = "closed";
    let _edgeModeExplicit = false; // v1.1 — true once the user calls edgeMode()
    let _gravityDir = "down";
    let _gravityStrength = 0;
    let _edgeOpenLeft = false;
    let _edgeOpenRight = false;
    let _edgeOpenTop = false;
    let _edgeOpenBottom = false;
    let _gravityBiasX = 0;
    let _gravityBiasY = 0;
    let _gravityVec = null; // v1.1 — custom unit gravity vector; overrides _COMPASS when set

    // 8-direction compass → (dx, dy) unit vector. Y is screen-positive
    // (down), matching the lib's convention.
    // v0.83 — 'radial' is a special pseudo-direction. It doesn't map to
    // a single (dx, dy) vector; instead, in updateVelocity each cell
    // computes its own outward-from-center radial vector. _COMPASS keeps
    // (0, 0) as a sentinel so _recomputeEdgeState can treat 'radial'
    // as "no fixed bias" while the velocity loop applies per-cell pull.
    // v0.93 — 'radial-in' is the same as 'radial' but with the per-cell
    // vector flipped to point INWARD (toward canvas center) instead of
    // outward. Edge handling differs accordingly: in gravity edge mode,
    // inward radial pulls pigment AWAY from edges toward the center, so
    // no edges should open (it'd just leak mass with no inflow). We
    // keep the (0,0) sentinel so the bias is computed per-cell in the
    // velocity loop, same as outward radial.
    const _COMPASS = {
      up: [0, -1],
      "up-right": [Math.SQRT1_2, -Math.SQRT1_2],
      right: [1, 0],
      "down-right": [Math.SQRT1_2, Math.SQRT1_2],
      down: [0, 1],
      "down-left": [-Math.SQRT1_2, Math.SQRT1_2],
      left: [-1, 0],
      "up-left": [-Math.SQRT1_2, -Math.SQRT1_2],
      radial: [0, 0],
      "radial-in": [0, 0],
    };

    // Recompute the cached open-edge flags and velocity bias whenever
    // any of (_edgeMode, _gravityDir, _gravityStrength) change. Called
    // from the API setters. The (dx, dy) compass vector picks both the
    // edges that open in gravity mode AND the velocity bias direction.
    function _recomputeEdgeState() {
      const [dx, dy] = _gravityVec
        ? [_gravityVec.x, _gravityVec.y]
        : _COMPASS[_gravityDir] || _COMPASS["down"];
      // Bias scaled by gravityStrength × VEL_CLAMP. Slider 0..1 of the
      // public API maps directly here.
      _gravityBiasX = _gravityStrength * VEL_CLAMP * dx;
      _gravityBiasY = _gravityStrength * VEL_CLAMP * dy;
      if (_edgeMode === "closed" || _edgeMode === "closed-gravity") {
        // v0.88 — closed-gravity is closed-edge physics (no drainage)
        // PLUS active gravity bias. The bias-vs-mode decision is now made
        // in updateVelocity (which checks _edgeMode), not via the edge
        // flags. Both 'closed' and 'closed-gravity' leave all flags false.
        _edgeOpenLeft = _edgeOpenRight = _edgeOpenTop = _edgeOpenBottom = false;
      } else if (_edgeMode === "open") {
        _edgeOpenLeft = _edgeOpenRight = _edgeOpenTop = _edgeOpenBottom = true;
      } else if (_edgeMode === "gravity") {
        // v0.83 — 'radial' opens all four edges since the pull is
        // omnidirectional outward. Cardinal/diagonal directions still
        // open only the edge(s) facing the pull.
        // v0.93 — 'radial-in' pulls pigment AWAY from edges toward the
        // center, so no edges should be open: opening any would just
        // leak mass that should have stayed put. Behaves like closed
        // physics with active inward bias.
        if (_gravityDir === "radial") {
          _edgeOpenLeft =
            _edgeOpenRight =
            _edgeOpenTop =
            _edgeOpenBottom =
              true;
        } else if (_gravityDir === "radial-in") {
          _edgeOpenLeft =
            _edgeOpenRight =
            _edgeOpenTop =
            _edgeOpenBottom =
              false;
        } else {
          // Open edges in the direction of gravity. A diagonal opens two
          // edges; a cardinal opens just one. Use sign of dx/dy with a
          // small epsilon to handle floating-point exact zeros.
          _edgeOpenRight = dx > 0.001;
          _edgeOpenLeft = dx < -0.001;
          _edgeOpenBottom = dy > 0.001;
          _edgeOpenTop = dy < -0.001;
        }
      }
    }
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
        rainbowW[0] = 1 - f;
        rainbowW[1] = f;
        rainbowW[2] = 0;
      } else if (t < 2 * RAINBOW_STOP_MS) {
        const f = (t - RAINBOW_STOP_MS) / RAINBOW_STOP_MS;
        rainbowW[0] = 0;
        rainbowW[1] = 1 - f;
        rainbowW[2] = f;
      } else {
        const f = (t - 2 * RAINBOW_STOP_MS) / RAINBOW_STOP_MS;
        rainbowW[0] = f;
        rainbowW[1] = 0;
        rainbowW[2] = 1 - f;
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

