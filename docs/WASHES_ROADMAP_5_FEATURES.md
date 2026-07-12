# Washes — engineering plan for five API features

> **Status (2026-07-12).** Four of the five shipped: custom pigment palettes
> (engine 1.10.0), arbitrary masks (1.11.0), transparent canvas (1.12.0), and
> stroke choreography as the `washes-timeline.js` sidecar (`engine/src/`).
> **5. Deterministic seed remains unbuilt.** The next scoped feature beyond
> this plan is backdrop compositing — see `BACKDROP_COMPOSITING_SCOPE.md`.

Grounded in a read of the 1.9.2 source, not wishes. Each section states what the
code already gives us, the actual work, the risks I found, the public API, and a
verification plan that fits our headless harness. Sequenced at the end.

Two findings up front reshape the estimates:

- **Transparent canvas is ~60% built already.** The render loop has an
  `ALPHA_FULL_AT` fade-in that drives the output alpha byte from pigment amount:
  cells with no pigment already go toward alpha 0. Paper is drawn opaque *over*
  that only because three `PAPER_*_BASE` constants are written into RGB
  unconditionally. So "transparent" is mostly a render-path branch, not new physics.
- **The mask is already a per-cell `.a` channel**, read identically by the CPU
  path and every GPU shader (`diffuseWet`, `edgeApply`, `updateVelocity`,
  `advectSemilag`, `transferEvaporate` all sample `u_deposit.a` and freeze the
  cell when `> 0.1`). Arbitrary masks therefore need a **rasterizer** that writes
  that field — not any change to the simulation.

The pigment model is full Kubelka–Munk: `PIGMENTS` is a swappable array of
`{name, K:[3], S:[3], density, staining, granulation}`, already referenced
through a mutable variable whose hot-loop reads are cached per function entry
(documented contract). That is the single most important fact for feature 1.

---

## 1. Custom pigment palettes

**Why first:** every one of the six studio demos approximated brand color by
mixing the fixed rose/yellow/blue triad. It is the most-requested thing and the
architecture is unusually ready for it.

**What exists.** `PIGMENTS_TRANSPARENT` / `PIGMENTS_OPAQUE` are arrays of three
pigment records with explicit K/S reflectance coefficients. The render loop reads
`PIGMENTS[i].K[c]` / `.S[c]`; the GPU path uploads them as `u_density`,
`u_staining`, `u_granulation`, and per-pigment K/S `uniform3f`s. Swapping the
array reference is already declared safe (only WebGL needs a uniform re-upload +
one forced-full render).

**The real work — and the honest constraint.** The sim has **exactly three
pigment channels** (`g[0..2]`, `d[0..2]`) end to end: CPU arrays, GPU MRT
attachments, advection, transfer. Making the *count* dynamic is a deep change
(every shader is written for `vec3`). So the tractable, high-value version is:

> Keep three channels; let the developer **redefine what those three pigments
> are** — their K/S (i.e. their color), density, staining, and granulation.

That covers ~90% of brand cases: pick three inks that span your palette (e.g.
Stripe blurple, a warm neutral, near-black) and mix within them, exactly as a
real painter works from a limited palette.

The one genuinely new piece of math: developers think in hex, not K/S
coefficients. I need a **sRGB → K/S inversion**. The forward model already exists
(`kmReflect(K,S,x,Rbg)`); I invert it per channel for a fully-saturated layer
using the Kubelka–Munk two-constant simplification `K/S = (1-R)²/(2R)`, solved at
the target reflectance with a fixed scattering S and the K that lands the channel
on the requested color. This is a known, stable closed form — no solver.

**API**
```js
// Redefine the three working pigments. Accepts hex/CSS or explicit K/S.
wc.pigments([
  { color:'#635bff', granulation:0.3, staining:4 },  // → K/S derived from color
  { color:'#e3e8ee' },
  { color:'#0a2540', density:0.05 }
]);
wc.pigments();              // → current palette (resolved records)
wc.pigment(0);              // unchanged: select working pigment by index
// names still resolve: 'rose'|'yellow'|'blue' alias indices 0/1/2 for back-comat
```

**Risks.** (a) Color fidelity: KM over a *tinted, textured* paper substrate won't
hit hex exactly — a deep blue ink over cream reads warmer. I'll document it as
"pigment identity, not a color picker," and offer a `paperColor` pairing note.
(b) Granulation/staining interact with the look; defaults must be sane when only
`color` is given. (c) GPU uniform re-upload + forced-full render on every
`pigments()` call — fine for setup, must not be called per frame (documented).

**Verification (headless-friendly).** Forward-render a single-pigment swatch at
known thickness over white; assert the output RGB is within ΔE tolerance of the
requested hex. Round-trip: `pigments([{color:X}])` then `sample()` a saturated
stamp → reconstruct RGB → compare. Back-compat: `'rose'` still equals old index 0
when the palette is the default. Confirm `PIGMENTS` swap doesn't desync the GPU
uniform cache (assert a forced-full render was queued).

**Estimate:** the color→K/S inversion + plumbing is ~a day of real care; the
sim is untouched. **Engine 1.10.0.**

---

## 2. Arbitrary (non-rect) masks

**Why second:** pairs naturally with pigments for brand work (mask to a logo,
flood your brand ink). The Stripe band faked this with CSS skew; the dolphin
waterline stacked rects.

**What exists.** A full per-cell `mask` field with `maskActive`, `MASK_THRESHOLD`,
and a `maskRectMin/Max` bounding box used only as a render/iteration optimization.
The physics already does the right thing per-cell — masked cells freeze in every
CPU and GPU pass. `maskNorm` only *writes* that field in a rectangle.

**The real work.** A rasterizer that fills `mask[]` from a shape:
- `maskPath(d, opts)` — parse an SVG path `d` string, scan-fill into the grid
  (even-odd rule). I'll use an offscreen 2D canvas at grid resolution as the
  rasterizer (`Path2D(d)` + `isPointInPath`, or fill + `getImageData`) — robust
  and tiny, and the engine already creates offscreen canvases.
- `maskImage(src, opts)` — load an image, threshold its alpha into `mask[]`. This
  reuses the exact pattern `paintImage`/`paintText` already use (offscreen canvas,
  `getImageData`, per-cell sample).
- `maskInvert()` / `removeMask()` (latter exists).
- Recompute `maskRectMin/Max` to the shape's true bounds so the optimization holds.

**API**
```js
wc.maskPath('M10,10 L90,10 90,90Z', { mode:'keep'|'block', invert:false });
wc.maskImage(imgOrUrl, { threshold:0.5, invert:false });   // Promise
wc.maskNorm(x,y,w,h);     // unchanged (rect)
wc.removeMask();          // unchanged
```

**Risks.** (a) The GPU mask lives in `u_deposit.a`; writing it must sync to the
GPU texture (same path `maskNorm` already uses — I'll route through it).
(b) Coordinate space: path/viewBox → grid. I'll take a `viewBox`/normalized
convention and document it once, clearly (we already paid for *not* doing this in
the d.ts `toGrid` bug). (c) Anti-aliasing: the mask is boolean per cell; edges
will be grid-resolution hard. Acceptable; note it.

**Verification.** Rasterize a triangle path; assert cells inside are frozen
(paint there → no deposit) and cells outside paint normally; assert
`maskRectMin/Max` equals the triangle's bounds. `maskImage` with a half-alpha
split image → assert the mask boundary lands at the split. GPU/CPU parity:
same path, assert identical frozen-cell set on both renderers (CPU directly; GPU
via the existing uniform-upload assertion).

**Estimate:** ~a day; rasterizer + coordinate doc are the substance.
**Engine 1.11.0.**

---

## 3. Transparent canvas / alpha paper

**Why third:** unlocks compositing washes over photography, DOM, gradients —
the most "award-bait" item — and it's already half-implemented.

**What exists.** In `render()`: `ALPHA_FULL_AT = 0.012`, `ALPHA_SCALE`, and a
documented fade where `xt` (total pigment) near 0 → alpha 0, above threshold →
alpha 255, with an anti-aliased band. The comment literally says cells with no
pigment "go fully transparent (body color shows through)." Today that alpha is
computed but the RGB underneath is still composited over opaque
`PAPER_*_BASE`, and the canvas has no transparency intent.

**The real work.**
- A `transparent: true` create option / `transparent(bool)` setter.
- In transparent mode, the per-cell RGB must be **premultiplied** against the
  computed alpha and the paper substrate dropped (or kept only as a
  developer-chosen tint with its own alpha). KM needs *a* background reflectance
  to composite against; I'll composite against the requested paper color but
  carry the fade alpha into the output so paper areas are see-through.
- Ensure `imgData.data.fill(0)` clears (it does) and the 2D context honors alpha
  (it does by default; `imageSmoothingQuality` already set).
- The dampness "sheen" on bare paper must not re-opaque transparent cells.

**API**
```js
Washes.create(el, { transparent:true });
wc.transparent(true);     // toggle at runtime → forces full re-render
// paper becomes a tint: wc.paperColor('#ffffff00') style alpha, or paperAlpha(0)
```

**Risks.** (a) KM over transparent ground is physically odd (there's no paper to
reflect); I'll composite against the *stated* paper color for hue but expose it
through alpha — pragmatic, documented as "pigment tints what's behind it."
(b) Edge darkening and granulation were tuned against cream; on transparent they
may look thin — may need a small alpha boost for deposited pigment.
(c) Performance: forced-full re-render on toggle (fine).

**Verification.** Render a stamp on `transparent:true`; read output alpha — assert
painted cells α≈255, bare cells α≈0, transition monotonic. Composite test:
draw over a known color in a second canvas; assert painted area blends and bare
area shows the backdrop unchanged. Regression: opaque mode pixels unchanged vs
1.9.2 (byte-compare a render).

**Estimate:** ~half a day to a day; the scaffolding exists, the care is in KM
compositing and not regressing opaque mode. **Engine 1.12.0.**

---

## 4. Stroke choreography / timeline

**Why fourth:** turns the "watch it paint itself" signature (Shopify tote,
Rippling onboarding) from hand-rolled `setTimeout` chains into a declarative API.
Pure host-side; **zero simulation risk** — it only schedules existing calls.

**What exists.** `strokeTo`/`strokeToNorm`/`line`/`penUp` (the flow-spaced pen),
`onFrame` (unsubscribe), and the lifecycle clock. Nothing schedules them over
time; every demo did its own `setInterval`.

**The real work.** A small timeline driver, built on `onFrame` (not `setTimeout`,
so it's governor- and tab-visibility-friendly and pauses with the sim):
- `stroke(points, {duration, easing, pigment, radius, strength})` — animate the
  pen along a path over `duration` ms with an easing function, emitting
  `strokeToNorm` at flow spacing.
- A `timeline()` builder to sequence/stagger multiple strokes with offsets.
- `pathFromSVG(d)` helper → point array (shared with `maskPath`'s parser).
- Respects `prefers-reduced-motion` by collapsing duration to 0 (paint instantly).

**API**
```js
wc.stroke(  // returns a handle with .cancel() and a Promise that resolves on done
  [[0.2,0.5],[0.8,0.5]],
  { duration:900, easing:'easeInOut', pigment:'blue', nradius:0.02, strength:0.6 }
);
wc.timeline()
  .stroke(bodyPts,   { duration:600, pigment:'blue' })
  .wait(120)
  .stroke(handlePts, { duration:500, pigment:'blue', easing:'easeOut' })
  .play();              // → Promise; .pause()/.resume()/.cancel()
```

**Risks.** (a) Interaction with the perf governor: a rescale mid-timeline must
rescale in-flight stroke coordinates — but we already fixed exactly that for the
pen in 1.7.0, so the timeline rides on it. (b) Cancellation/cleanup if the
instance is destroyed mid-play (unsubscribe `onFrame`). (c) Easing lib: ship ~6
named easings, accept a custom `fn`.

**Verification.** Drive a timeline with a mocked clock (we already pump rAF with a
controllable `CLOCK`); assert pen position at t=0/mid/end matches the eased path;
assert total painted coverage ≈ the same path drawn directly; assert `.cancel()`
stops further deposition; assert reduced-motion paints in one frame. Governor
cross-test: force a rescale mid-stroke, assert no teleport (reuses the 1.7.0
corridor test).

**Estimate:** ~a day, all host-side and highly testable. **Engine 1.13.0** (or
ship as a sidecar module, since it touches no sim — see sequencing note).

---

## 5. Deterministic seed

**Why last:** highest value-to-effort *ratio* is good, but the effort is
**mechanical and invasive**, and it's the least visible of the five. Best done
when the surface above it is stable so we seed once and don't re-thread.

**What exists — and the catch.** There are **129 `Math.random()` call sites**:
paper texture (`generatePaper`), brush jitter, splatter/salt scatter, preset
randomization, rainbow pigment, and more. There is **no PRNG seam** today.

**The real work.** Introduce one injectable PRNG (mulberry32/xorshift128 — tiny,
fast, well-distributed) as an instance-level `_rng()` and **replace all 129
`Math.random()` calls** with it. Then a `seed` create option / `seed()` setter
re-initializes the stream. Because paper texture is generated at `create()` and
on every `rebuildScale`, seeding must re-derive paper deterministically — which
means the governor's art-preserving rescale must *not* consume seed entropy
differently across levels (it resamples, doesn't regenerate paper from RNG mid-
stroke — verified that path resamples rather than re-randomizes, so we're safe,
but the test must lock it in).

**API**
```js
Washes.create(el, { seed: 1234 });
wc.seed(1234);     // re-seed the stream; next generatePaper/jitter reproducible
wc.seed();         // → current seed
```

**Risks.** (a) Completeness: a *single* missed `Math.random()` breaks
determinism silently. Mitigation: after the swap, grep must return 0
`Math.random(` in the engine, and a test runs two seeded instances and
byte-compares a full render. (b) Ordering dependence: RNG draw order now matters;
any future code must use `_rng`. I'll add a lint note + a one-line comment at the
PRNG def. (c) `createHeadless` and the governor must thread the seed through
`rebuildScale` (it reallocates + regenerates paper).

**Verification.** Two instances, same seed, same script → identical `sample()`
grid and identical rendered bytes; different seeds → different. Grep guard:
`grep -c 'Math.random(' === 0`. Rescale determinism: seed, paint, force a
governor downshift+upshift, assert the painting matches the same script without
the shift (densities, within resample tolerance). Reproducible "edition":
`seed(N)` → paint tote → `sample()` fingerprint stable across runs.

**Estimate:** ~a day, but it's careful find-and-replace across 129 sites + a
strong determinism test. **Engine 1.14.0.**

---

## Sequencing & rationale

| Order | Feature | Engine | Why here |
|------|---------|--------|----------|
| 1 | Custom pigments | 1.10.0 | Highest demand; architecture ready; unblocks brand work |
| 2 | Arbitrary masks | 1.11.0 | Pairs with pigments; mask field already per-cell |
| 3 | Transparent canvas | 1.12.0 | ~60% built (ALPHA_FULL_AT); unlocks compositing |
| 4 | Stroke choreography | 1.13.0 | Zero sim risk; rides on 1.7.0 rescale fix |
| 5 | Deterministic seed | 1.14.0 | Mechanical but invasive; seed once on a stable surface |

**Two cross-cutting notes.**

- **#4 could ship as a sidecar.** It touches no simulation code — only schedules
  public calls. Shipping `washes-timeline.js` as an optional module keeps the
  core engine smaller and lets it iterate independently. I lean sidecar.
- **#1 and #3 share the render loop.** Both edit the per-cell KM/alpha section of
  `render()`. Doing pigments (1.10) then transparent (1.12) means touching that
  loop twice; if we want, fold transparent in right after pigments while the loop
  is paged into memory. I kept them separate above for clean changelogs and
  independent verification, but flag the option.

**What I'd build first if you want one:** custom pigments. It's the feature every
brand brief asks for in its first hour, the sim stays untouched, and the only new
math (sRGB→K/S) is a known closed form I can verify headlessly against the
existing forward model.

## Honest gaps this plan does *not* close

- True N-pigment palettes (>3 inks mixing simultaneously) remain out of scope —
  the three-channel sim is load-bearing everywhere. The plan redefines the three,
  it doesn't multiply them.
- Exact hex fidelity is impossible under KM-over-tinted-paper; pigments are
  identities, not a color picker.
- Mask and seed determinism are grid-resolution and draw-order bound respectively;
  both are documented constraints, not bugs.
