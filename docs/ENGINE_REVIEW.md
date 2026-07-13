# Washes engine review — how to make it better

*2026-07-12, against v1.12.1. Method: three parallel code audits (architecture
map, hot-loop performance, API surface) plus direct inspection of the tests,
packaging, and GPU paths. Line references are into `engine/src/washes.js` /
`washes.d.ts` at v1.12.1.*

> **Status (2026-07-12, branch `engine-review-p0` → engine 1.13.0):**
> **P0 executed.** ✅ #1 shrinkActiveRect wired (criterion refined: wet-aware,
> boundary-pressure-blind — see CHANGELOG 1.13.0; headless local-paint
> benchmark 44.7s → 3.2s, ≈14×, because `create()` starts the rect full-grid
> so the optimization had been effectively disabled for every real session).
> ✅ #2 evaporate settled-skip, movePigment copy restriction, edge-darkening
> rect blurs — all bit-exact against new equivalence goldens; the render
> full-canvas drawImage item is deferred (browser-QA only, see P0#2 text).
> ✅ #3 harness asserts (seeded, 231 checks, golden equivalence suite).
> ✅ #4 CI workflow + Playwright browser smoke authored (advisory job;
> GPU-parity spec is `fixme` until the auto-fallback work — not runnable in
> the offline dev container). ✅ #5 api-surface reflection test; d.ts now
> 136 = 136 with an empty allowlist. Found en route: the frozen
> boundary-ring pressure leak and the `paintAt` optional-pigment throw
> (both documented in CHANGELOG 1.13.0 → Known, queued for P2).
> **P1/P2/P3 remain open.**
>
> **P1 slice 1 (branch `engine-review-p1` → engine 1.14.0):** render
> byte-hash goldens added (composited output frozen alongside sim fields);
> #9 resolved as an exp-form `kmReflect` rewrite instead of the LUT (~1.2×
> isolated, byte-identical output, zero 8-bit flips over a 10M-sample sweep
> — the LUT stays shelved unless profiling demands it); the GPU dual-copy
> hazard from #6 now has an interim CI drift guard (`tests/gpu-sync.test.cjs`,
> 11 shaders byte-checked) pending true single-sourcing; the fadeStep
> closure item was examined and deliberately left (hoisting trades a 10 Hz
> allocation for per-cell context reads). Still open in P1: the extraction
> itself (#6), true headless (#7), worker sim (#8).
>
> **P1 slice 2 (branch `engine-review-p1-slice2` → engine 1.15.0):** the
> GPU dual-copy is now *generated* — `washes-gpu-sim.js` is the source of
> truth and `scripts/sync-gpu.cjs` rebuilds the embedded block between
> sentinels (byte-stable transform; CI runs `--check` alongside the shader
> guard). And #7's interim deliverable landed: `createHeadless()` installs
> a minimal internal environment when no DOM exists, so it runs in bare
> Node with zero caller-side shims (`tests/headless-bare.test.mjs`). Still
> open in P1: the module extraction (#6 proper, including the
> environment-free core that retires the interim shim) and the worker sim
> (#8).
>
> **P1 slice 3 (branch `engine-review-p1-slice3` → engine 1.16.0):** the
> migration plan's Phase 0 seam is production code — the frame loop steps
> the sim through `_simBackend` (CPU adapter over simStep/paintAt/state
> codec), faithfulness proven by the harness `backend` pattern
> (field-identical stepping, stamp equivalence, bit-exact state
> round-trip). Worker/GPU backends now have a socket to plug into.
> `paintAt`'s optional pigment/strength foot-guns fixed (the strength half
> was silent NaN poisoning, found by the new regression check). Packaging:
> standalone build ships in the tarball, `prepublishOnly` gates on the
> full battery, CI verifies `npm pack`. Remaining in P1: the module
> extraction proper (#6) and the worker backend (#8) — both now
> materially easier behind the seam.
>
> **P1 slice 4 (branch `engine-review-p1-slice4` → engine 1.17.0):** the
> extraction is underway — 2,142 lines carved into `src/parts/`
> (`pigment-data`, `sim-core`, `sim-backend`) as source-of-truth
> fragments assembled verbatim into `washes.js` by `scripts/assemble.cjs`
> (CI-enforced, byte-stable; the carve-out's only `washes.js` diff is the
> sentinel comments and every golden stayed bit-exact). The physics now
> has an editable home a tenth the size of the monolith. Next: graduate
> `sim-core` to a real module behind the SimBackend seam, then the worker
> backend (#8).

---

## What's already strong (keep these properties)

- **The sim core is clean.** The physics zone (~lines 2085–3260) has zero
  DOM access; fields are flat `Float32Array` structure-of-arrays; the hot path
  is nearly allocation-free. These are exactly the right fundamentals.
- **Self-documenting discipline.** The changelog is rigorous and honest
  ("Pending browser/GPU QA" is stated, not hidden); doc comments state
  constraints; `diagnose()` and `Washes.tiers` show real API empathy.
- **The sidecar pattern.** `washes-timeline.js` adds choreography with zero
  engine code — the right way to grow scope.
- **Zero dependencies, zero build.** Single-file deployability is a feature;
  any restructuring below should preserve it as a *build output*.
- **The groundwork for the next steps already exists** — the
  `docs/gpu-migration/` scaffold (typed backend seam + bit-identical CPU
  adapter) is the extraction plan; this review mostly says "execute it."

---

## P0 — dormant wins and safety nets (days each)

### 1. `shrinkActiveRect` is written but never called
The active-region system exists to localize per-frame work, and its own comment
(L1995–2004) calls localization "the biggest single perf win" — but
`shrinkActiveRect` (L2053) has **no call site** and `framesSinceShrink` (L2012)
never increments. The rect only grows (`expandActiveRect`, from `paintAt`
L3747) and resets only on clear. After strokes near opposite corners, every
"rect-restricted" pass runs full-grid until idle. Wiring the existing function
into the loop is likely a 2–5× win on long sessions.

### 2. Full-grid passes that ignore the active rect
- `applyEdgeDarkening` (L2262): full-N binarize + two 2-pass `boxBlur`s, ×2
  sim steps = ~10 full-grid passes per frame regardless of the rect.
  Rect-restrict (padded by the kernel radius).
- `evaporate` (L3092–96): unconditionally rewrites ~10 values per cell for
  *permanently dry* cells (w=0, g=0), full-N ×2/frame. Skip when already zero.
- `movePigment`: 9 full-N memcpys + a 3N loop per sim step (L2908, L2728,
  L2933–35) ≈ ~54 MB/frame of memory traffic at 746k cells. The row-wise
  rect-restricted copy pattern already exists at L2448–54 — apply it here.
- `render` ends with full-canvas `clearRect` + `drawImage` upscale every frame
  (L3615–17) even when the dirty `putImageData` rect is small.

### 3. Make the test harness assert
`tests/washes-test-harness.cjs` is a *diagnostic instrument*: it prints
measured vs "expect:" values for a human to eyeball; nothing asserts and the
only `process.exit(1)` sites are load/arg errors. The "32-check suites" cited
in the changelog lived in dev sessions, not the repo. The harness already
computes both sides of every comparison — add tolerances + assertions + a
non-zero exit, and wire `npm test` into CI (GitHub Actions). Without this,
every refactor below is flying blind.

### 4. Browser/GPU CI
A recurring theme in the changelog is "cannot be exercised without a WebGL2
context" — it caused the GPU flat-fill incident (silent, uncatchable) and left
the falloff-vs-falloff² parity item open. One Playwright job running
`texture-parity` against the real GPU handle plus a first-frame pixel-readback
health check would (a) close that debt permanently and (b) unblock GPU-by-
default with automatic CPU fallback — the single biggest available performance
feature, already 90% built.

### 5. Keep the d.ts honest mechanically
The declarations drifted from runtime three documented times (FIXES.md; the
1.9.2 `paintText` types matched *neither* inputs nor output; `webgl` is
declared twice today, W800/W915; the header still says "Authored against
v0.98"). Cheap fix: a reflection test that diffs `Object.keys(instance)`
against the declared surface. Better: author the API façade in typed JSDoc and
*emit* the d.ts.

---

## P1 — structural (the enabler, ~weeks)

### 6. Break up the 12,000-line closure
`createInstance` spans L1060–13341 — one function, **372 closure variables**,
returning a 133-key object literal (L11073). Consequences: no unit is testable
in isolation, Workers are impossible (state is rebindable `let`s, not
transferable), and the GPU sim must be *embedded* (L38–1058) **and** shipped
separately in `washes-gpu-sim.js` — two full copies of ~1,000 lines of shader
code to keep in sync (verified identical today; one edit away from not being).

Extract along the seam already designed and verified in `docs/gpu-migration/`
(`sim-backend.d.ts` + the bit-identical CPU adapter): `sim/` (pure math over a
state struct), `render/` (KM composite), `brush/`, `host/` (DOM shell, pointer,
resize), `api/` (façade). Add a ~50-line esbuild step emitting three artifacts:
the single-file IIFE (unchanged deployment story), the ESM package, and **one**
GPU source imported by both entry points. This one change ends the dual-copy
hazard, makes the P0 perf work reviewable, and is the prerequisite for #8.

### 7. True headless mode
`createHeadless()` still dereferences `document` (L13297) — "headless" runs
only under the harness's DOM shim, which lives *inside the lib* (L1128–1190).
After #6, inject the canvas/DOM surface at the host layer and make the sim +
render core genuinely environment-free. Unlocks Node rendering (server-side
PNG generation, property-based testing) for free. Also remove the `?scale=`
URL-param read (L1807) from the core — that's a host concern.

### 8. Worker + SharedArrayBuffer sim (after #6)
The audit confirms feasibility: sim state is flat Float32Arrays and the step is
DOM-free pure math. Blockers are the closure structure (#6) and
`rebuildScale`'s mid-session reallocation (L4339–57; make the governor swap
buffers through a handle). Payoff: the sim leaves the main thread entirely —
the governor then manages *worker* budget and UI jank disappears on low-end
devices. `OffscreenCanvas` for the composite is the natural follow-on.

### 9. KM lookup table
`kmReflect` (L3260) runs 3× per pigmented cell per frame with `sqrt` + `sinh` +
`cosh` each. `Rlayer`/`Tlayer` depend only on `(a, bSx)` with `bSx` capped at
12 (L3265) — a small 2D LUT + closed-form background composition removes ~12
transcendentals per cell. Validate against the existing texture-parity
tolerance (<1e-4) pattern.

---

## P2 — API v2 (batch the breaks for a major)

The surface grew to ~124 members across 40+ releases and it shows. Batch these
into one deliberate 2.0 with a v1-compat shim:

- **One coordinate story.** Five unit systems coexist (display px, grid cells,
  normalized, fraction-of-smaller-side, client px); *brush size alone* uses
  three units across siblings (`brushSize` display-px diameter, `paintAt`
  grid-cell radius, `paintNorm` fraction). Make normalized canonical (the Norm
  twins become the methods), expose explicit converters, one brush-size unit.
  The timeline's `nradius` default (0.02) should also match the engine's (0.03).
- **One run-state model.** Five overlapping controls exist — `pause/resume`,
  `pauseDrying`, `keepSimulating`, `runUntilDry`, auto-idle/governor (plus the
  timeline's own pause). Collapse to a single run policy + `pause()`.
- **One event system.** Today: lowercase `on('perflevel')` alongside seven
  DOM CustomEvents absent from the types, in mixed casing (`paletteChange` vs
  `pigmentchange` — the 1.12.1 patch was literally this bug). Typed event map,
  one casing, every event declared.
- **One setter convention.** The d.ts header promises chaining but most
  setters return the value; only some chain. Pick one (chain everywhere;
  getters stay zero-arg overloads).
- **Consistent error policy** (throw on programmer error / warn-and-fallback
  on environment), and consistent destructive-op policy (`remeasure` wipes,
  `scale` wipes unless `{preserve}`, `autoPerf` preserves — make preserve the
  default everywhere, wipe opt-in).
- **Finish `tiers`** — 45 methods are untiered, and `destroy`/`exportPNG` sit
  in *debug*. Type it as `Record<'core'|'tuning'|'debug', (keyof Instance)[]>`.
- **Painting serialization.** `getPreset()` round-trips settings only; the
  artwork itself can't be saved. The fields are flat arrays and the GPU handle
  already has `uploadState/downloadState` as precedent — expose
  `saveState()/loadState()`. Unlocks undo, galleries, and sharing; probably
  the most-wanted user feature on the list.
- **Deterministic seed** (roadmap feature 5). 130 `Math.random` call sites →
  inject a seedable PRNG. Doubles as the foundation for golden-image
  regression tests.

## P3 — distribution

- Publish to npm (everything is ready; repo URL now real), with `dist/`
  standalone + source maps in `files`.
- Generated API docs from the (now-emitted) types — the in-playground docs are
  lovely but not indexable or linkable.
- Single-source the version string (package.json ↔ CITATION.cff drifted to
  1.0.1 vs 1.12.1 until this consolidation).

---

## Suggested order

1. P0#3 harness asserts → 2. P0#1–2 perf quick wins (now provable) →
3. P0#4 GPU CI → 4. P1#6 extraction + build (ends GPU dual-copy) →
5. P0#5 d.ts emission (falls out of #6) → 6. P1#7–9 → 7. P2 as a planned 2.0 →
8. P3 alongside.

The through-line: the library's physics and API empathy outgrew its packaging
as one 13k-line closure. Almost every improvement above either *is* the
extraction or gets dramatically cheaper after it — and the project already
wrote its own extraction plan in `docs/gpu-migration/`.
