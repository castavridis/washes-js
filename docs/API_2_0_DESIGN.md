# Washes API 2.0 — design proposal

*2026-07-13, drafted against engine 1.21. Source material: the API-surface
audit in `ENGINE_REVIEW.md` (five coordinate systems, five run-state
controls, the event zoo, split conventions) plus everything learned landing
P0/P1. This is a PROPOSAL — the "Decisions needed" section at the end is
where taste calls are yours. Nothing here is implemented except where
marked shipped.*

## Principles

1. **One way per concept.** Where v1 grew twins and aliases, v2 picks one
   and keeps the other as a documented deprecation.
2. **Breaks are batched, mechanical, and shimmed.** Every rename ships with
   a v1-compat layer (`Washes.compat1()` wraps an instance with the old
   names + old units, warning once per call site) so hosts migrate a call
   at a time.
3. **Preserve-by-default.** Anything that would wipe the painting takes
   `{ wipe: true }` to do so; art-preserving is the default everywhere
   (v1 is inconsistent: `remeasure` wipes, `autoPerf` preserves, `scale`
   wipes unless `{preserve}`).
4. **Throw on programmer error, warn-and-degrade on environment.** Unknown
   pigment names, malformed options, out-of-range enums → throw. Missing
   WebGL2, zero-size hosts, worker unavailability → warn once and fall
   back.

## 1. Coordinates: normalized becomes THE space

v1 has five unit systems; brush size alone uses three across siblings.

- **All position/size APIs take normalized 0..1 fractions** (of the canvas;
  radii as fraction of the smaller side). The `*Norm` twins become the
  primary names — `paint`, `stroke`, `line`, `stir`, `rewet`, `dry`,
  `lift`, `blot`, `mask` — and the grid-space originals disappear behind
  the compat shim.
- **Grid space stays available, explicitly:** `wc.grid` namespace —
  `wc.grid.paint(gx, gy, r, …)`, `wc.grid.toNorm(gx, gy)`,
  `wc.grid.fromNorm(nx, ny)`, `wc.grid.size() → {GW, GH}`. Generative
  pieces that think in cells keep a first-class home; nothing else on the
  main surface speaks cells.
- **`brushSize(fraction)`** — fraction of the smaller side, matching every
  other radius. (v1: display-px *diameter*.) `displayRect()` remains the
  bridge for hosts doing DOM math.
- `splash` gains the normalized form it always lacked; the timeline
  sidecar's `nradius` default aligns with the engine's (0.03).

## 2. Run state: one policy + pause

v1: `pause/resume`, `pauseDrying`, `keepSimulating`, `runUntilDry`,
auto-idle, the governor — five overlapping controls.

```js
wc.run('auto')        // default: auto-idle when settled (v1 default)
wc.run('until-dry')   // step until bone dry, then idle   (v1 runUntilDry)
wc.run('always')      // never idle                        (v1 keepSimulating)
wc.run()              // → current policy
wc.pause({ acceptInput })  // unchanged — the one true freeze
wc.resume()
wc.drying(false)      // the pauseDrying knob, renamed to say what it does
```

The governor stays where 1.6 put it: `quality('auto')` — a *quality*
concern, not a run-state one.

## 3. Events: one typed map, one casing — SHIPPED (1.24, additive half)

v1: `on()` takes lowercase names while seven undeclared DOM CustomEvents
fire in mixed casing (`paletteChange` + `pigmentchange` was literally a
shipped bug, fixed in 1.12.1 by dual-firing).

- **Everything goes through `on(name, cb)`** with a full typed event map in
  the d.ts: `idle`, `active`, `dry`, `rescale`, `perflevel` → `perfLevel`?
  — no: **all-lowercase, no exceptions**: `idle | active | dry | rescale |
  perflevel | palettechange | gouachechange | cursorpreviewchange |
  presetapplied | driedinstantly`.
- DOM CustomEvents keep firing (embedders use them) but become mirrors of
  the `on()` names, all lowercase, all declared in the d.ts, marked
  "mirror".
- `on()` returns the unsubscribe (already true); `once(name)` added,
  returning a Promise.

*1.24 shipped: the typed `WashesEventMap`, `once()`, and all six DOM-only
events emitting through `on()` under lowercase names. Still for 2.0: the
DOM mirror renames (`rescaled` → `rescale`, `paletteChange` →
`palettechange`) and declaring the mirrors in the d.ts.*

## 4. Conventions

- **Setters chain, getters are zero-arg** — universally. The ~40 methods
  returning the value from their setter form switch to returning `this`
  (this is the single most mechanical break; the shim covers it).
- `set/get` pairs (`setAnimation`/`getAnimation`, `setBackground`…) become
  getter/setter overloads like everything else: `animation(v?)`,
  `background(v?)`, `visualization(v?)`.
- `'dry'` stops meaning four things: the brush-mode alias is dropped
  (v0.98 deprecation completes), the verb `dry()` and the event `dry`
  remain (different namespaces), the knob family keeps `dryness*`.
- `brushModes` becomes static-only; `exportPNG` renamed `exportImage`
  (it encodes JPEG too); `destroy` and `exportImage` move out of the
  *debug* tier; the tiers table becomes complete (all members) and typed
  `Record<'core'|'tuning'|'debug', (keyof WashesInstance)[]>`.

## 5. Serialization — SHIPPED (1.22, additive)

`saveState()` / `loadState(snapshot)` — the painting itself, round-tripped
bit-exactly through the same SimStateArrays codec the GPU and worker seams
use. Settings stay a separate concern (`getPreset`/`applyPreset`); pair
them for a full document. v2 may add `{ resample: true }` on load for
dims-mismatched snapshots; v1.22 throws with a clear message.

## 6. Determinism: `create({ seed })` — SHIPPED (1.23, additive)

The extracted sim core is already fully deterministic; the remaining
`Math.random` call sites (~130) were host-side — splash jitter, spray,
animations, paper regeneration timing. `create({ seed })` gives the
instance a seeded PRNG (mulberry32) used everywhere the host previously
called `Math.random`, making whole pieces reproducible and enabling
golden-image tests downstream. Roadmap feature 5 closed here. Unseeded
instances stay late-bound to the live `Math.random` global (the harness's
per-pattern seeding depends on it); seeds fold to uint32; bad seeds throw.
Proof: `tests/seed.test.mjs` (same-seed scripts replay bit-exactly across
all four state planes).

## 7. Sim-behavior fixes batched with 2.0 (need visual QA)

- **Boundary-ring pressure leak**: splash writes pressure to the outermost
  ring which no pass ever evolves (documented 1.13). Fix = don't write it
  (or decay it in drainBoundaries). Changes goldens → intended-change
  protocol + browser eyeballing.
- **GPU pigment falloff** (`falloff` vs CPU `falloff²`, known since 1.0.1)
  — one-token change, browser QA required.

## Compat & migration

- `washes/compat1`: wraps a v2 instance in the v1 surface (old names, old
  units, value-returning setters), warning once per distinct call site.
  Ships for at least two minors.
- A migration table in the CHANGELOG mapping every renamed/re-united
  member; the api-surface test enforces the v2 d.ts; a second reflection
  test enforces the compat surface against the v1 d.ts snapshot.
- Goldens: coordinate/event/convention changes are behavior-preserving at
  the field level — the golden suites must stay bit-exact through the
  entire rename storm. The two sim-behavior fixes are separate,
  golden-regenerating commits.

## Sequencing

1. (done) serialization — additive, in 1.22
2. (done) `seed` — additive, in 1.23
3. (done) event map + `once` — additive (new names first, old kept), in
   1.24 (DOM CustomEvents untouched; they become declared lowercase
   mirrors in the 2.0 batch)
4. the rename/convention batch + compat shim → **2.0.0**
5. sim-behavior fixes (browser QA) → 2.1

## Decisions needed (your taste) — ALL DECIDED 2026-07-13

1. **Normalized-as-default**: ✅ **move forward** — `paint` becomes
   normalized, grid-space retires to `wc.grid.*`.
2. **Event casing**: ✅ **all-lowercase** (`palettechange`), everywhere
   including the DOM mirrors. (Landed for `on()`/`once()` in 1.24; the DOM
   mirror renames wait for the 2.0 batch.)
3. **`exportPNG` → `exportImage`**: ✅ **do the rename** (in the 2.0
   batch, covered by the compat shim).
4. **Compat shim lifetime**: ✅ **until 3.0**.
5. **`run()` policy strings**: ✅ **`'auto' | 'until-dry' | 'always'`**
   as proposed.
