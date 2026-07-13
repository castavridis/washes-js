# Changelog

All notable changes to **washes** are documented here. Dates are ISO 8601.

## [1.20.0] — 2026-07-13

P1 slice 7 (migration Phase 1): the brush deposit lives in the core —
the worker paints.

### Changed
- **`applyStamp` — the six paintAt deposit branches, extracted verbatim
  into the sim core.** Stamps are FULLY RESOLVED by the caller (pigment
  identity → channel or rainbow weights, load sliders → gains, brush
  mode → a texture descriptor carrying the noise field), so the deposit
  is pure field math and runs identically in-process or in a worker.
  `paintAt` keeps everything UI-flavored — resolution, the GPU-forward
  branch, the rainbow clock, stroke-motion tracking — and delegates.
  Mask stamps report threshold-crossing cells via the new
  `env.commitMaskStamp` hook so mask-rect bookkeeping stays host-owned.
- **The worker backend accepts stamps.** `stampBrush(resolvedStamps)`
  posts to the worker, which applies them with the identical core math
  (pigment / rainbow / water / lift / paper / mask). The one remaining
  gap is texture-mode stamps — their noise field is a grid-sized host
  array needing a brush-field upload protocol (follow-up) — and they
  fail loud with that guidance, as do raw unresolved stamps.

### Testing
- Golden coverage landed BEFORE the surgery: a deterministic
  `performance.now` in the DOM shim (verified benign — all prior goldens
  bit-exact under it) plus the `tool-brushes` equivalence scenario
  exercising every branch (rainbow included, now deterministic). After
  the extraction: every golden still bit-exact (249 checks).
- The worker parity test now paints mid-run: 240 steps with
  pigment/rainbow/water/mask stamps applied locally via `applyStamp` and
  remotely via `stampBrush` are **bit-exact** across all four state
  planes — including the symmetric mask-commit hooks on both sides.

## [1.19.0] — 2026-07-12

P1 slice 6: the worker backend — the simulation runs off-thread.

### Added
- **`washes/worker-backend` + `washes/sim-worker`.** A SimBackend
  implementation over a worker-hosted `createSimCore`:
  `washes-sim-worker.js` is the worker entry (owns its own fields + core,
  speaks an init/live/step/upload/download/destroy protocol with
  SimStateArrays crossing as transferables, and runs identically under a
  browser module Worker and Node's worker_threads via a port adapter);
  `createWorkerBackend(wrapWorkerPort(worker), opts)` is the host side.
  Parity is the strongest claim available: because the extracted core is
  fully deterministic (zero `Math.random` on any path — paper generation
  is hash-noise), `tests/worker-backend.test.mjs` asserts 120 steps on a
  real worker thread are **bit-exact** against the in-process core.
- **`washes/state-codec`** — the SimStateArrays pack/unpack as a shared
  module (matches the host codec byte-for-byte), plus the transfer-list
  helper.

### Contract notes (stated in the module header too)
- `step()` on the worker backend is fire-and-forget
  (`capabilities.async = true`); `stepN()`/`flush()` are the awaitable
  forms. The in-process CPU adapter remains the synchronous backend.
- `stampBrush()` throws with guidance: brush deposit math still lives in
  the host (`paintAt`), so routing stamps is the migration plan's
  Phase 1. Interactive painting stays on the CPU backend; batch users
  paint into a state array and `uploadState()`.
- Wiring the browser frame loop to this backend (render-latency model,
  stamp routing, rebuild protocol) is the remaining #8 work.

## [1.18.0] — 2026-07-12

P1 slice 5: the first SEMANTIC extraction — the simulation core is a real
ES module.

### Changed
- **`sim-core` graduated from closure fragment to `washes/sim-core`.**
  `src/washes-sim-core.js` exports `createSimCore(env)`: the pass
  functions, active-region tracking, and `simStep`, behind an explicit
  ownership contract — the host keeps owning all state (field arrays,
  dims, tunables; it reallocates and reassigns them exactly as before),
  while the core snapshots bindings (`refreshBindings()` after rebuilds)
  and re-reads the runtime-mutable set at every exported call. Eleven
  host-mutated declarations were relocated to the host; rect state moved
  into the core (read via `rectBounds()`); everything else is untouched
  closure text. The module is inlined into `washes.js` by the assembler's
  new `esm-inline` transform, so the single-file build stays
  self-contained — and is also importable directly, with typings
  (`washes-sim-core.d.ts`).
- **Proof of both properties:** the full battery is green with every
  golden bit-exact through the inlined form (the graduation changed no
  behavior), and the new `tests/sim-core-standalone.test.mjs` imports the
  module with NO host, DOM, or canvas and runs the physics on a synthetic
  32×24 grid — wet diffuses, dries, deposits settle, the rect empties.
  The standalone import also caught two closure leaks the inlined form
  masks (`s_scale`, `_edgeMode`), now part of the env contract.

## [1.17.0] — 2026-07-12

P1 slice 4: the extraction begins for real — 2,142 lines of `washes.js`
now live as source-of-truth part files.

### Changed
- **Three sections of `washes.js` are assembled from `src/parts/`.**
  `pigment-data.part.js` (the Curtis Fig. 5 pigment sets + tool
  sentinels), `sim-core.part.js` (the physics: rect tracking, paper,
  blurs, edge darkening, velocity, advection, drainage, transfer,
  evaporation, `simStep`), and `sim-backend.part.js` (the seam) are
  spliced verbatim between `PART` sentinels by `scripts/assemble.cjs`
  (`npm run assemble`; CI enforces `--check`). `washes.js` remains one
  self-contained, directly loadable file — the parts are where you edit.
  Because the splice is verbatim closure text, the carve-out itself is
  provably behavior-free: the only `washes.js` diff is the sentinel
  comments, and every golden stayed bit-exact. Parts graduate to real
  ES modules as their seams land (sim core is next, behind SimBackend);
  see `src/parts/README.md` for the rules.

## [1.16.0] — 2026-07-12

P1 slice 3: the backend seam from the migration plan is now production
code, and `paintAt`'s optional parameters are actually optional.

### Added
- **The sim backend seam (MIGRATION.md Phase 0, realized).** The frame
  loop steps the sim through `_simBackend` — a CPU adapter implementing
  the scaffold's `SimBackend` contract (`step` / `stampBrush` /
  `uploadState` / `downloadState` / `getTextures` / `destroy`) as thin
  pass-throughs over existing code, with a new `_unpackSimState` inverse
  of the state codec (rebuilds mask flags/rect and re-arms the rect
  tracker). A worker or GPU backend can now slot in behind the same
  interface. Faithfulness is proven the way the scaffold proved its
  adapter: the harness `backend` pattern shows seam-driven stepping is
  field-identical to direct `simStep` driving, a stamp through
  `stampBrush` equals the same `paintAt` call, and state round-trips
  bit-exactly; the equivalence and render goldens are untouched.

### Fixed
- **`paintAt` optionals no longer bite.** `pigment` resolves exactly as
  `paintNorm` and the pointer path do (undefined → current brush ink,
  names → indices, unknown names fail loud) — it previously threw on
  `g[undefined]`. And `strength` now defaults to 0.5 (paintNorm's
  default) — an omitted strength previously poisoned the deposit with
  silent NaNs, caught by the new regression check while fixing the
  pigment half. Closes the 1.13.0 Known item.

### Packaging
- `dist/washes.standalone.js` ships in the npm tarball (CDN script-tag
  consumers via unpkg/jsdelivr get the classic build), and
  `prepublishOnly` gates publishing behind sync-check, a fresh
  standalone build, and the full test battery. CI verifies
  `npm pack --dry-run`.

## [1.15.0] — 2026-07-12

P1 slice 2: the GPU dual-copy is now generated, not hand-maintained, and
"headless" finally means bare Node.

### Changed
- **The embedded GPU sim is generated from `washes-gpu-sim.js`.** The
  standalone entry is the source of truth; the block inside `washes.js`
  sits between `GPU-SIM SYNC` sentinels and is rebuilt by
  `npm run sync:gpu` (`scripts/sync-gpu.cjs`). The transform is
  byte-stable — its first run reproduced the previously hand-maintained
  copy exactly. CI enforces both `sync-gpu --check` and the shader-diff
  guard, so a one-sided edit fails two ways. (Full module-level
  single-sourcing still arrives with the extraction; this removes the
  hand-sync hazard today.)

### Added
- **`createHeadless()` runs in bare Node.** It previously dereferenced
  `document`, so "headless" meant "headless if the caller stubs ~100
  lines of DOM first" (exactly what the test harness does). When no
  `document` exists it now installs a minimal internal environment on
  globalThis — the same surface the harness proved sufficient to run
  the entire engine. Browsers and jsdom-style embedders never reach it.
  `tests/headless-bare.test.mjs` exercises create/paint/coverage/
  sample/state/diagnose/destroy with deliberately no shim; in CI.

## [1.14.0] — 2026-07-12

The first P1 slice: render-path work under a new byte-level safety net,
plus a drift guard for the intentionally duplicated GPU sim.

### Performance
- **`kmReflect` computes sinh/cosh from one exponential.** With
  `e = exp(bSx)`, `2·denom = (a+b)·e − (a−b)/e` and the ½ factors cancel
  in `Rlayer` — one `exp` instead of `sinh + cosh` in the render path's
  hottest call (3× per pigmented cell per frame). Honest numbers: ~1.2×
  on the isolated call (V8's sinh/cosh are decent; the sqrt and divides
  dominate the rest). Accuracy: 10M-sample domain sweep max
  |ΔR| = 1.9e-14 with zero 8-bit quantization flips; render goldens
  byte-identical. (The audited 2D-LUT idea stays on the shelf — at ~1.2×
  for five lines versus a lookup table with palette-rebuild plumbing,
  this is the better trade today.)

### Testing
- **Render byte-hash goldens.** The equivalence pattern freezes sim
  fields; the new `render` pattern freezes the composited RGBA bytes
  (FNV-1a) across four scenarios — virgin paper, splash + steps, custom
  palette (color-derived K/S), transparent mode. In `all` and CI.
  Regenerate only for an intended visual change, with the measured
  byte-level impact stated in the commit.
- **GPU dual-copy drift guard.** The WebGL2 sim intentionally exists
  twice (embedded in `washes.js` + the `washes/gpu-sim` entry; see
  1.0.1). `tests/gpu-sync.test.cjs` now fails CI unless all 11 shader
  sources are byte-identical between the copies. This is the interim
  guard until the extraction work single-sources them (ENGINE_REVIEW
  P1#6); failures are fixed by porting the edit to both copies, never by
  allowlisting.

### Notes
- `fadeStep`'s per-tick inner closure (flagged in the review) was
  examined and deliberately left: hoisting it would trade one 10 Hz
  function allocation for per-cell context-slot reads in the hot loop —
  the cure costs more than the disease.

## [1.13.0] — 2026-07-12

The engine-review P0 release: performance work verified behavior-preserving
by a new golden-equivalence suite (all four changes reproduce the previous
engine's fields **bit-exactly** on seeded scenarios), plus mechanical
enforcement that the type declarations match the runtime.

### Performance
- **Active-region shrink is finally wired.** `shrinkActiveRect` was fully
  written and documented ("runs every ACTIVE_SHRINK_INTERVAL frames in the
  main loop") but had no call site — and `create()` starts the rect
  full-grid for the first composite, so in practice **every session ran
  every rect-bounded pass over the whole grid forever**. It now runs from
  `simStep` every ~30 frames: the rect tightens to live content and empties
  after a full dry-down (re-arming simStep's early-return). Headless
  benchmark (648×540 grid, six local stamps + 2000 steps, best of 3):
  **44.7 s → 3.2 s (≈14×)**. Real-canvas gains scale with how much of the
  sheet is idle.
  - The shrink criterion was refined while wiring: cells with `wet > 1e-6`
    are kept (every pass gates its work on wetness; the original
    g/pressure-only test froze still-wet clear-water halos mid-flight), and
    pressure is only consulted on **interior** cells (splash modes write
    pressure to the outermost ring, which no pass ever evolves — one deluge
    would have pinned the rect at full-grid forever; see Known below).
- **`evaporate` skips settled cells.** The dry-settle branch rewrote ~10
  values per cell per step (×2/frame) for cells that settled long ago —
  wet 0, no suspended pigment, velocity zeroed at settle, fade spring at
  rest. Every such write is a provable no-op; both the fast and masked
  paths now skip them.
- **`movePigment` buffer copies are rect-restricted.** Nine full-grid
  array passes per sim step (pre-copies, clamped copyback, diffusion
  snapshot — ~54 MB/frame of traffic at 746k cells) now cover the active
  rect padded by one cell, which is exactly where the advection passes
  read and write.
- **Edge darkening is rect-restricted.** Was a full-grid binarize plus two
  full-grid separable box blurs per call (~10 full-grid passes/frame);
  now a padded-window binarize and a new `boxBlurRect` produce identical
  values everywhere they are read.

### Fixed
- **`washes.d.ts` matches the runtime again — mechanically.** Nine
  GPU/WebGL isolation toggles were undeclared, `webgl` was declared twice,
  and the header still said "authored against v0.98". All fixed, and the
  new `tests/api-surface.test.mjs` reflects over a live instance and fails
  CI on any future drift in either direction (runtime 136 = declared 136,
  empty allowlist).

### Testing
- **The harness asserts.** It was a diagnostic instrument (printed
  measured vs expected for a human); every pattern now checks its
  documented expectations and exits non-zero on failure. `Math.random` is
  seeded (mulberry32) so runs are bit-reproducible.
- **Equivalence goldens.** Five scripted scenarios (full-rect splash +
  dry-down, two-corner strokes, masked splash, open-edge drain,
  fade-enabled steps) checkpoint per-field statistics against
  `tests/equivalence-goldens.json` at 1e-9 relative tolerance. This suite
  caught a real semantic issue in the first shrink criterion before it
  shipped.
- **`active-rect` pattern** documents the tracking lifecycle (full on the
  virgin damp sheet → empty when dried → local rect for local paint →
  empty again).
- **CI workflow** (GitHub Actions): harness, texture parity, API surface,
  standalone build, and `tsc --strict` on Node 20; plus an advisory
  Playwright job for real-browser WebGL smoke.

### Known (pre-existing, documented while here)
- **Boundary-ring pressure never decays.** Splash modes write pressure to
  the full grid, but every pressure-evolving pass iterates the interior
  only, so the outermost ring keeps its splash pressure forever (probe:
  exactly the 2372-cell perimeter pinned at ~15 after one deluge). It is
  dead state — nothing reads it once neighbors dry — and the shrink
  criterion sidesteps it; an actual cleanup is queued for the API 2.0
  batch.
- **`paintAt` throws when `pigment` is omitted** despite the parameter
  being typed optional (the deposit path indexes `g[pigmentIdx]`
  unguarded). Queued for the same batch.

## [1.12.1] — 2026-06-10

### Fixed
- **`palette()` now refreshes lib-built pigment swatches.** Swapping the
  palette updated the pigments correctly but emitted only `paletteChange`,
  which the standard swatch-refresh wiring doesn't listen for, so the picker
  kept showing the old colors. `palette()` now also dispatches `pigmentchange`
  (the event hosts already use to rebuild swatches), so the visible swatches
  track the active pigments. `buildPigmentSwatches()` already reads the live
  pigment set, so a host that rebuilds on either event shows the new inks.

## [1.12.0] — 2026-06-10

### Added
- **Transparent canvas.** `create({ transparent: true })` is now honored (the
  option was previously ignored), and `transparent(true|false)` re-renders
  immediately. In transparent mode, paper-thin and unpainted areas fall to
  alpha 0 so the canvas composites over whatever is behind it (photography,
  DOM, a CSS gradient via `background()`); painted pigment stays fully opaque
  and is still composited via Kubelka–Munk against the configured paper color,
  so hue is unchanged — only the empty paper becomes see-through.

### Fixed
- **Opaque paper was accidentally see-through.** Output alpha was purely
  pigment-thickness driven in every mode, so unpainted paper rendered at
  alpha 0 even when transparency was off — an opaque-background page could see
  through the "paper" to the page behind the canvas. Opaque mode now renders
  paper as a solid sheet (alpha 255); only transparent mode lets it fade.

### Notes
- Pigment tints what is behind it: KM composites against the configured
  `paperColor`, so over a busy backdrop a thin wash reads as that paper hue at
  low opacity, not as the backdrop. Set `paperColor` to suit the composite.
## [1.11.0] — 2026-06-10

### Added
- **Arbitrary masks.** The per-cell mask field is now writable from any shape,
  not just rectangles:
  - `maskPath(d, opts)` — freeze cells inside an SVG path string. Coordinates
    are a 0..1 viewBox mapped to the grid by default (resolution-independent);
    `opts.viewBox=[w,h]` for custom units, `opts.grid=true` for raw grid cells,
    `opts.invert` to flip. Even-odd fill.
  - `maskImage(src, opts)` — freeze cells where an already-loaded image is
    opaque (alpha ≥ `opts.threshold`, default 0.5). `src` is any drawImage-able
    source; URL/File loading stays the host's job so the engine remains
    synchronous and dependency-free.
  - `maskInvert()` — flip every cell's masked state.

  All route through the same field, GPU sync, and forced recomposite that
  `maskNorm`/`removeMask` already used, so masked cells freeze in every CPU and
  GPU pass exactly as rectangular masks do.

### Notes
- The mask is boolean per cell, so shape edges are grid-resolution (no
  sub-cell anti-aliasing). Raise quality / grid resolution for crisper edges.
- `maskPath` needs `Path2D` (all modern browsers; absent in bare Node — the
  engine warns and no-ops rather than throwing).
## [1.10.0] — 2026-06-10

### Added
- **Custom pigment palettes — `palette()`.** Redefine the three working
  pigments without touching the simulation. Each entry is a color
  (`{ color:'#635bff', granulation?, staining?, density? }`, with Kubelka–Munk
  K/S derived from the color) or explicit `{ K:[3], S:[3] }`. `palette(null)`
  restores the stock set; `palette()` returns the resolved records; also
  settable via `create({ pigments:[...] })`. Indices 0/1/2 and the names
  rose/yellow/blue now map to your inks, so all existing paint calls and the
  three-channel mixing model work unchanged — a limited palette, exactly as a
  painter works. Forces a full recomposite (not a per-frame call); emits
  `paletteChange`.

### Notes
- The color→K/S inversion targets the layer's full-thickness reflectance
  (R∞ = 1 + K/S − √((K/S)²+2K/S)) and sets scattering so a dried saturated
  stamp lands within a small ΔE of the requested hex over white paper. Over a
  **tinted** paper the result shifts warmer/cooler — pigments are an identity,
  not an exact screen color. Pair with `paperColor()` accordingly.
- True >3-pigment palettes remain out of scope: the simulation has exactly
  three channels end to end. `palette()` redefines those three; it doesn't
  multiply them.
- The pre-existing `pigments()` (lists available indices/names) is unchanged
  and now reflects custom names.

## [1.9.2] — 2026-06-10

### Fixed
- **`paintText` with pigment names painted nothing.** The shared pigment
  resolver's doc comment promised name resolution for paintText, but the
  implementation passed the raw string into the stamp path, which threw on
  the first stamp — so `paintText('FIELDS', { pigment: 'blue' })` silently
  painted zero stamps. Names now resolve exactly as in `paintNorm`.
- **`paintText` type declarations matched neither inputs nor output.**
  Declared `Promise<void>` (actual: synchronous stamp count — now typed
  `number`); `strength` and `sampleStep` were accepted but undeclared (now
  declared); `fontFamily`/`brushSize`/`onComplete` were declared but ignored
  (removed). x/y documented as text CENTER in grid cells, fontSize as grid
  cells.

## [1.9.1] — 2026-06-10

### Changed
- **Idle recovery dwell 2.5s → 1s** (and matching 1s shift cooldown).
  Quarter → full now restores in roughly 2–3 seconds of rest instead of ~7.
  1s is the floor we recommend: below ~0.8s the governor starts shifting
  during natural between-stroke pauses, which reads as resolution flicker.

## [1.9.0] — 2026-06-10

### Fixed
- **Governor never recovered while idle.** The performance governor measured
  frames only while the simulation was running, so once the canvas dried (or
  was dried manually) and the sim idled, no measurements accumulated and the
  resolution stayed parked at its reduced level indefinitely. The governor
  now climbs back toward `full` while idle, one level per ~2.5s dwell —
  idle is the cheapest time to restore resolution (the resample competes
  with nothing) — and the next stroke simply re-downshifts, art-preserved,
  if the restored level genuinely can't be sustained.

## [1.8.0] — 2026-06-10

### Fixed
- **Governor stuck at its lowest level.** Upshift was interval-driven with a
  13ms threshold — but on a vsync display, healthy rAF intervals are pinned
  to the refresh period (~16.7ms at 60Hz), so the threshold could never be
  met and the governor sat at its lowest level forever regardless of
  headroom. Upshift is now driven by **busy time** (actual work per frame,
  loop start → governor tick): sustained <~9ms of work steps up. Downshift
  remains interval-driven (missed vsync is the correct over-budget signal).

### Changed (breaking for 1.5–1.7 `perflevel` consumers)
- **Perf levels renamed `full` / `half` / `quarter`** (approximate cell count
  vs base resolution) — previously `high`/`medium`/`low`, which collided with
  the quality **preset** names. The vocabulary is now disjoint by design:
  *presets* (`quality()`: auto/high/medium/low/minimum) are feature bundles;
  *perf levels* (`perfLevel()`, `state().perfLevel`, the `perflevel` event)
  are resolution fractions. Affects the event detail, both getters, and
  `diagnose()`.

## [1.7.0] — 2026-06-10

### Fixed
- **Stroke teleport on rescale.** A grid rebuild mid-stroke zeroed the
  brush's last stroke point, so the next pointer move interpolated a stroke
  from the top-left origin to the pointer — visible as a diagonal line when
  the perf governor shifted while drawing. The last stroke point (pointer
  brush and `strokeTo` pen alike) is now rescaled into the new grid, so a
  stroke continues smoothly across any rescale.
- **`toGrid()` type declaration.** Returned `{x, y}` at runtime but was
  declared `{gx, gy}`; the declaration now matches reality.

### Changed
- **Quality presets keep the canvas.** Switching between
  `auto`/`high`/`medium`/`low`/`minimum` now resamples the painting into the
  new grid instead of wiping it — switching quality mid-piece no longer costs
  the piece. The Resolution slider (bare `scale(v)`) keeps its historical
  wipe; `scale(v, { preserve: true })` is the new opt-in for hosts that want
  preservation there too.

## [1.6.0] — 2026-06-10

### Added
- **`quality('auto')`.** The autoPerf governor is now a first-class quality
  preset. Selecting it hands the resolution knob to the governor (shifts
  between high/medium/low under load, preserving the painting); selecting any
  manual preset takes control back — the governor is disabled and the base
  scale restored art-preservingly before the preset's own (art-wiping) scale
  change applies, exactly as manual presets always have. The `quality()`
  getter reports `'auto'` whenever the governor is enabled, however it was
  turned on, so UIs stay truthful. Invalid-preset warning updated to mention
  `'auto'`.

## [1.5.0] — 2026-06-10

### Added
- **Auto performance throttler.** `autoPerf(true)` lets the engine shift grid
  resolution between three levels — high / medium (1.4× coarser) / low
  (1.9× coarser) — based on measured frame cost while the sim is active,
  **preserving the painting across every shift**. Hysteresis plus cooldowns
  prevent flapping: sustained frames over ~26ms step down (3s cooldown
  between shifts); a much longer run under ~13ms steps back up (5s cooldown).
  Frames are only measured while the simulation is actually running, so idle
  canvases never trigger upshifts they can't sustain. `autoPerf(false)`
  restores the original resolution (also preserving). New `perfLevel()`
  getter, `'perflevel'` event, and `autoPerf`/`perfLevel` in `state()` and
  `diagnose()`.
- **Art-preserving rescale (internal).** `rebuildScale` can now resample
  every persistent field — wetness, velocity, suspended and deposited
  pigment (bilinear), and the mask (nearest-neighbor) — into the new grid
  instead of wiping. This is what makes the governor's shifts invisible
  apart from resolution itself. Explicit resolution changes (the Resolution
  slider, `remeasure()`) keep their existing wipe behavior unchanged.

### Notes
- Densities, not totals, are preserved across resampling — the painting
  looks the same at the new resolution; fine detail below the coarser grid's
  Nyquist limit is genuinely lost on downshift and does not return on
  upshift (it was rendered, not stored).
- Paper texture regenerates at each new resolution, so granulation patterns
  shift subtly across levels; deposited pigment is unaffected.

## [1.4.0] — 2026-06-09

The ergonomics release: everything on this list came out of building real
hosts against 1.2/1.3 (a tooling playground, embedded product panels, and
generative pieces) and writing down what hurt.

### Fixed
- **Idle accounting.** The wet/suspended totals the auto-idle gate reads were
  declared but never updated, so the sim idled on a fixed timer after any
  paint regardless of wetness — washes froze mid-dry. The totals are now
  maintained on idle-check frames (O(N) every 30 frames), so auto-idle
  respects actual wetness. `runUntilDry` remains the strict
  every-cell-bone-dry option.

### Added
- **Host size safety.** A host that measures ~0 at `create()` (display:none,
  in-flow aspect-ratio box before layout) no longer yields a permanently
  mis-sized canvas: the engine warns once, then rebuilds automatically when
  the host gains real size (ResizeObserver, rAF-poll fallback). Live resizes
  are deliberately not auto-rebuilt (a rebuild wipes the painting) — call
  `remeasure()` for that. New `size: {width, height}` create option overrides
  measurement entirely.
- **Lifecycle events.** `on('idle'|'active'|'dry'|'rescale', cb)` →
  unsubscribe. `'dry'` fires once per wet episode when the canvas settles with
  essentially no wetness left — the long-requested "onDryDone".
- **Sim state in `state()`.** `isIdle`, `totalWetness`, `totalSuspended`
  alongside the existing configuration snapshot.
- **`diagnose()`.** One call answering "why is my canvas blank": renderer
  (gpu/cpu), grid + display + host sizes, degenerate-host flag, idle state,
  total wetness.
- **Watercolor verbs.** `lift`/`liftNorm` (move dried deposit back into
  suspension — the hidden prerequisite for any rinse), `flood` (soak the
  sheet), `blot`/`blotNorm` (dab water + floating pigment away),
  `pour(dx,dy,strength)` / `endPour()` (tip the basin: gravity + open edges,
  then restore).
- **`Washes.createHeadless({width,height})`.** Fixed-size, CPU, pointerless,
  detached-host instance for tests/CI.
- **`Washes.tiers`.** The 100+ method surface grouped: `core` (compose with
  these), `tuning` (sensible defaults), `debug` (diagnose, don't compose).

### Notes
- `paperColor()` already accepted CSS/hex strings since 1.1; now documented
  as the norm. The subtractive three-pigment model (rose/yellow/blue mixing
  on a light ground) is documented in the type declarations.
- GPU first-frame health checks with automatic CPU fallback were scoped out
  of this release: pixel-readback heuristics could not be verified headless.
  `diagnose()` plus the degenerate-host rebuild cover the observed blank-canvas
  cases; auto-fallback remains future work.

## [1.3.0] — 2026-06-09

### Added
- **`runUntilDry(v?)`** — keep the simulation stepping until the wash is
  *completely* dry, then idle automatically. Unlike `keepSimulating` (which
  runs every frame forever until toggled off), `runUntilDry` stops on its own
  once no cell is wet, so it doesn't burn CPU after drying. Targets the common
  complaint that a localized stroke freezes mid-dry: the auto-idle heuristic
  shuts the sim off once the *canvas-average* wetness dips below the settle
  threshold, which a small wet region barely moves — so it idles while still
  visibly wet. `runUntilDry` measures the wet field directly and keeps going
  through the full drying tail.

### Notes
- `runUntilDry` reads the wet field directly rather than the internal
  `lastTotalWet` idle accumulator, which is **not maintained** in this build
  (declared and read by the idle check but never updated) — the reason the
  default auto-idle fires a fixed grace period after any paint regardless of
  how wet the canvas still is. Fixing that accumulator (so the *default* idle
  respects real wetness) is left as separate work to avoid changing default
  behavior in a minor release. The scan runs only on idle-check frames and
  breaks on the first wet cell, so the cost is negligible and opt-in.

## [1.2.0] — 2026-06-09

A second ergonomics pass, driven by building ten generative pieces on top of
1.1 and noting the authoring layer that had to be hand-written every time.
**Backward-compatible** except for one deliberate fail-loud change (see
`brushMode`). Verified headless on the CPU path (32-check functional + correctness
suite, a 150-frame generative drive, full-file parse, and `tsc --strict`);
GPU/visual behavior remains browser-QA.

### Added (ergonomics)
- **Normalized motion/wetness twins.** `addVelocityNorm` / `stirNorm` /
  `rewetNorm` / `dryNorm` mirror `paintNorm` and `maskNorm` — positions are
  fractions in 0..1, `nradius` a fraction of the smaller side (default 0.03), so
  the whole spatial surface can be addressed without multiplying by the grid
  size. No-arg `rewetNorm` / `dryNorm` keep the whole-canvas behavior.
- **Continuous strokes.** `strokeTo(gx, gy, opts)` remembers the previous point
  and lays a line of overlapping dabs to the new one; `strokeToNorm`, a one-call
  `line(x0, y0, x1, y1, opts)`, and `penUp()` round it out. Replaces the
  point-to-point interpolation loop that nearly every piece reimplemented.
  `opts`: `{ pigment, strength, radius, spacing }` (`nradius` for the Norm form).
- **`clearPaint()`.** Clears pigment, wetness and motion but **keeps**
  configuration *and the freeze mask* — the regenerating-loop counterpart to
  `reset()` (which also wipes the mask). Removes the re-lay-the-grid /
  re-apply-every-setting boilerplate after each generation. `reset()` and
  `clearPaint()` both lift the stroke pen.
- **Managed frame loop.** `onFrame((dtMs, elapsedMs, instance) => …)` registers a
  callback invoked after each simulated/rendered frame and returns an
  unsubscribe function. Callbacks are wrapped so a throw can't kill the render
  loop. Replaces the hand-rolled `requestAnimationFrame` + `t0` bookkeeping.

### Added (capability)
- **Field sampling.** `sample(gx, gy)` (and `sampleNorm`) returns the cell's
  `{ wetness, mask, velocity, suspended, deposited, pigment, density }`, and
  `coverage(threshold?)` returns the fraction of inked cells. Generative pieces
  can now read their own field — grow toward wet, stop when full — instead of
  running fully open-loop.

### Changed
- **`brushMode` fails loud.** An unknown mode name now **throws** (with the valid
  list) instead of silently warning and keeping the old mode — a typo was
  previously an invisible no-op. The valid set is discoverable via
  `wc.brushModes()` and the static `Washes.brushModes`. *(Behavioral change for
  callers that passed invalid names and relied on the silent no-op.)*

### Fixed (ergonomics)
- **`create()` no longer depends on the host being positioned.** The canvas is
  `position:absolute; inset:0`, so a statically positioned host let every
  instance's canvas escape to the nearest positioned ancestor and overlap.
  `create()` now promotes a `static` host to `position:relative` (and clips
  `overflow`), honoring any explicit non-static value. Removes a real
  multi-instance foot-gun.

## [1.1.0] — 2026-06-08

API ergonomics pass + two new capability areas. **Fully backward-compatible:**
every prior call signature still works; all additions are new methods or new
argument forms. Verified headless on the CPU path (25-check behavior suite +
full-file parse + `tsc --strict`); GPU/visual behavior remains browser-QA.

### Fixed (ergonomics)
- **`paperColor` no longer fails silently.** It now accepts a CSS/hex string
  (`'#fdf3ee'`, `'#fff'`, `'rgb(...)'`) in addition to `(r, g, b)` floats, and
  **throws** on an unparseable string or non-finite numbers instead of storing
  `NaN` (which rendered the whole canvas black — the original foot-gun).
- **Rainbow brush no longer throws.** Painting the rainbow by index `3` (the GPU
  sentinel) hit an undefined array on the CPU path; `3` is now mapped to the CPU
  rainbow sentinel and its weights are initialised on first use.
- **Gravity "just works".** A positive `gravityStrength()` in the default
  `closed` edge mode was a silent no-op (bias only applied in
  `gravity`/`closed-gravity`). Setting a strength now auto-promotes
  `closed → closed-gravity` (and reverts at 0), so tilt takes effect without
  having to discover `edgeMode()`.
- **Setters chain.** `paintLoad`, `waterLoad`, `gravityStrength`,
  `gravityDirection`, and `fadePainting` now return the instance when called
  with an argument (and still return the value when called as a getter), so
  `wc.paintLoad(0.3).waterLoad(1).fadePainting(true)` works.

### Added (ergonomics)
- **Normalized coordinates.** `paintNorm(nx, ny, nradius?, pigment?, strength?)`
  and `maskNorm` / `unmaskNorm` take fractions in 0..1 over the canvas, so
  callers never juggle grid-vs-display-vs-viewport spaces. `maskNorm` maps to the
  correct client coordinates internally.
- **Coordinate introspection.** `displayRect()` returns the live CSS rectangle of
  the canvas (`x, y, width, height, dpr`) — the exact space `maskRect` measures
  against — and `toClient(gx, gy)` is the inverse of `toGrid`. No more reaching
  into the DOM to compute mask geometry.
- **Arbitrary-direction gravity.** `gravityVector(x, y)` sets a free
  (normalized) gravity vector; `gravityDirection` additionally accepts an **angle
  in degrees** (0 = right, 90 = down) or an `{x, y}` vector, not just the
  8-compass names.
- **`fadePainting(ms)`** — a positive number enables fade and sets its half-life
  in one call; `0`/`false` disables; `true` toggles.

### Added (features)
- **Velocity injection — `addVelocity(gx, gy, vx, vy, gridRadius?)`** (alias
  `stir`). Pushes velocity into the fluid within a radius (squared falloff) and
  wets the region enough that the velocity actually transports pigment. Motion or
  gesture input can now stir a wash directly instead of faking it with water
  deposits + gravity.
- **Local wet/dry — `rewet(gx, gy, gridRadius?)` and `dry(gx, gy, gridRadius?)`.**
  Regional versions of the previously global-only calls: `rewet` raises wetness
  and lifts deposited pigment back into suspension inside the circle; `dry`
  settles suspended → deposited and zeroes the fluid there. Both respect the
  freeze mask. No-arg calls keep the original whole-canvas behavior.

### Verification status
- **Verified (headless, CPU):** all new/changed methods exist and behave —
  hex/`rgb()` parsing, throw-on-bad-input, chaining, `fadePainting(ms)`, rainbow
  by name and index, `paintNorm`, gravity angle→vector and named-dir clearing,
  `addVelocity`/`stir`, regional + global `dry`/`rewet`, `displayRect`/`toClient`
  math, `maskNorm`/`unmaskNorm`. Engine parses; `tsc --strict` on declarations
  passes.
- **Pending browser/GPU QA:** the *visual* result of velocity injection and
  regional wet/dry, and parity of these ops on the WebGL2 path, need a real
  context. The new sim writes target the CPU fields (the default path) and call
  the existing GPU resync hooks; GPU-side visual parity is unverified here.

## [1.0.1] — 2026-06-07

### Fixed
- **Texture brushes crashed on the CPU path.** v1.0 kept the six call sites to
  `_smoothNoise2D` inside `_ensureTextureNoise` but dropped the function
  definition, so selecting any texture brush mode (crayon / dryBrush / salt /
  splatter) and painting threw `ReferenceError: _smoothNoise2D is not defined`.
  Restored the helper (the v0.98 hash-based value-noise definition). Texture
  brushes work again on the CPU, and the GPU path now has fields to upload.

### Added
- **GPU texture brushes match the CPU look.** The WebGL2 backend previously
  synthesized brush-mode noise procedurally (hash / fbm / Worley) — a look-alike,
  not a match. It now samples the *same* precomputed noise fields the CPU uses,
  uploaded via the new `GpuSimHandle.setBrushTexture(field, w, h)`, and applies
  the CPU's exact deposit-multiplier math (direct `baseThresh ± bandHalf`
  smoothstep, paper-height blend, motion anisotropy, per-index-hash bristle
  skip). The procedural-era per-stamp deposit cap is removed.
- Package now ships an optional GPU entry point: `import … from "washes/gpu-sim"`
  alongside the main `import … from "washes"`.
- **GPU sim folded into the core library (opt-in).** `washes-gpu-sim` is now
  embedded inside `washes.js` as an internal factory, so the library is a single
  self-contained file. GPU activation is **opt-in** via `Washes.create(el, { gpu:
  true })`. Auto-on was implemented first but reverted: in-browser it rendered
  incorrectly (a flat fill), and because GPU init throws no error the failure is
  silent (not catchable), so enabling it by default would break every WebGL2
  browser. The CPU path is the verified default until the GPU render is validated
  in a browser. Shader-compile failures still fall back to CPU automatically. The
  standalone `washes/gpu-sim` entry point is retained for direct use.
- `tests/texture-parity.test.mjs` — proves the deposit math matches the CPU lib.

### Verification status
- **Verified (headless):** the CPU deposit formula and the JS reference that the
  shader transliterates match the real lib **to < 1e-4 per cell** across all four
  modes (`npm run test:texture-parity`). Core fluid-sim regression harness and
  `tsc --strict` on all declarations pass.
- **Pending browser validation:** the GLSL compile/run and the GL wiring
  (`setBrushTexture`, sampler binds) cannot be exercised without a WebGL2 context.
  The shader is a line-for-line transliteration of the verified JS reference; run
  `texture-parity` against the GPU handle in a browser to confirm runtime parity.

### Known parity item (not addressed here)
- GPU pigment deposit uses linear `falloff`; the CPU uses `falloff²`. This affects
  overall stroke softness for *every* pigment stamp (wet included), not the
  texture speckle (which is governed by the now-matched deposit multiplier).
  Aligning it is a one-token change that also shifts the plain-wet path, so it is
  left for a dedicated visual check.

## [1.0.0]
- WebGL2 GPU backend (`washes/gpu-sim`): full fluid pipeline (velocity update,
  semi-Lagrangian advection, transfer/evaporate, wet diffusion, edge pipeline)
  with MRT ping-pong; entry-point split from the core library.

## [0.98.0]
- Texture brushes (crayon / dryBrush / salt / splatter) with per-mode dryness,
  paper rejection, anisotropy, and bristle-skip controls; wetness heatmap.
