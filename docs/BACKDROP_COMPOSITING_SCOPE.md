# Backdrop compositing — scoping note

*What it is, what already exists, what's worth building, and where the line sits
between this and the harder "image as pigment" feature.*

## The two things people mean by "image on the canvas"

It matters to separate these, because one is nearly free and one is a real
project:

1. **Backdrop compositing (this note).** An image (or gradient, or DOM, or
   video) sits *behind* the wash. Pigment is painted over it like glaze over a
   photo. The backdrop is inert — the simulation never touches it; it just shows
   through wherever paper is thin. This is a *display* feature.

2. **Image-as-pigment ingestion (separate, harder).** An image is decomposed
   into the active palette's three inks and written into the deposited-pigment
   field, so painting over it *physically interacts* — rewets, blooms, lifts,
   mixes. This is a *simulation* feature and a bounded inverse problem. Out of
   scope here; flagged at the end.

This note scopes #1.

## What already exists (most of it)

The foundation is in place as of 1.12:

- The engine canvas is `position:absolute; inset:0` inside the host element, so
  **anything painted on the host shows behind the canvas**.
- `transparent(true)` / `create({ transparent:true })` makes unpainted paper
  fall to alpha 0, so the host shows through (1.12 wired the alpha floor to the
  flag for real).
- `background(value)` already sets `targetEl.style.background` to any CSS value
  — solid, `linear-gradient(...)`, `radial-gradient(...)`, **`url(...)`** — and
  auto-enables transparent mode.

So today, this works with no new code:

```js
const wc = Washes.create(host, { transparent: true });
wc.background('url(/photo.jpg) center / cover no-repeat');
// now paint — strokes glaze over the photo
```

That covers a real and useful case. The reason to build anything more is that
this minimal path has sharp edges users will hit, and "backdrop compositing" as
a *named, dependable feature* means smoothing them.

## The gaps worth closing

### A. It's CSS-only, so the backdrop and the wash can desync
`background()` paints the host via CSS; the wash paints the canvas via the
render loop. They're two independent layers that happen to stack. Consequences:

- **Export ignores it.** `exportPNG()` captures the canvas, not the CSS
  backdrop — so "save my painting over this photo" produces the wash on
  transparent paper, not the composite. This is the single biggest gap; people
  expect what they see to be what they save.
- **No fit control beyond CSS.** `cover`/`contain`/positioning are CSS strings
  the caller has to know; there's no `backdrop(img, { fit:'cover' })` ergonomic
  layer, and no readback of the backdrop's intrinsic size for layout.
- **Paper tint still applies.** In transparent mode pigment is still KM-composited
  against `paperColor`, so a wash over a dark photo reads as the *paper's* hue at
  low opacity, not the photo's. That's correct physics but surprising; it wants
  documenting and maybe a `paperColor:'transparent'`-style escape hatch.

### B. No backdrop in the engine's own coordinate space
Because the backdrop is CSS on the host, the engine doesn't know it exists —
can't sample it, can't align a mask to it, can't let the backdrop influence
granulation or edge darkening. For pure *compositing* that's fine (inert is the
point), but it means features like "mask the wash to the photo's bright areas"
aren't reachable from this path (they belong to feature #2).

## Proposed scope (a real but contained feature)

A `backdrop()` API that owns the layer properly, plus export that respects it.

```js
// set / replace / clear an inert backdrop drawn just behind the wash
wc.backdrop(src, {
  fit: 'cover' | 'contain' | 'stretch' | 'center',   // default 'cover'
  opacity: 1,                                          // 0..1
  position: 'center',                                  // CSS-ish anchor
});
wc.backdrop(null);          // clear
wc.backdrop();              // → current { src, fit, opacity, naturalWidth, naturalHeight } | null

// export now composites: backdrop → wash, in one image
await wc.exportPNG({ includeBackdrop: true });        // default true when a backdrop is set
```

**Implementation sketch (honest about cost):**

- *Display:* keep using the host background under the hood (it's already correct
  and GPU-cheap), but manage it through `backdrop()` so the engine *records* the
  src + fit and can reproduce it. Auto-enable transparent mode; restore prior
  transparent state on `backdrop(null)`. ~Half a day.
- *Export:* the real work. On `exportPNG({ includeBackdrop })`, draw the backdrop
  into an offscreen canvas at the export resolution with the recorded fit, then
  draw the wash canvas over it, then encode. Reuses the offscreen-canvas pattern
  the mask rasterizer and `paintImage` already use. Needs the backdrop image to
  be loaded and same-origin/CORS-clean (a tainted canvas can't `toBlob`) —
  documented, and `backdrop()` should reject a cross-origin image that would
  taint export, or warn. ~A day.
- *Ergonomics:* `fit` math (cover/contain → drawImage source/dest rects),
  intrinsic-size readback, opacity. A few hours.

**Engine ~1.13.0.** No simulation changes — this is display + export plumbing,
which makes it low-risk and highly verifiable.

## Verification plan (fits the headless harness)

- **Display:** `backdrop(img)` sets transparent mode + records src/fit; `backdrop(null)`
  restores prior transparent state. Assert state via a `backdrop()` getter
  (no pixels needed).
- **Fit math:** unit-test cover/contain/center → expected source/dest rects for a
  few aspect-ratio pairs (pure arithmetic, no canvas).
- **Export compositing:** mock the offscreen canvas; assert draw order is
  backdrop-then-wash and that `includeBackdrop:false` skips the backdrop draw.
  A pixel round-trip (known backdrop color in bare-paper cells, known pigment in
  painted cells) confirms the composite.
- **Taint guard:** a cross-origin-flagged image triggers the documented
  warning/rejection rather than a silent `toBlob` failure.

## What this explicitly does NOT do (and why)

- **No interaction.** The backdrop never rewets, blooms, lifts, or mixes — it's
  behind the simulation, not in it. Wanting that is feature #2 (image-as-pigment),
  a bounded per-cell KM inversion against the active palette, scoped separately.
- **No per-pixel engine access to the backdrop.** Sampling/masking against the
  backdrop's content also belongs to #2.
- **Not a layer stack.** One backdrop, one wash. Multiple wash layers / blend
  modes is a different, larger feature.

## Recommendation

Ship the `backdrop()` + `exportPNG({ includeBackdrop })` scope as 1.13.0. It
turns an existing-but-sharp capability into a dependable, exportable feature —
and "paint a watercolor over my photo and save the result" is the concrete user
story it unlocks. The export work is the real substance; the display half is
mostly formalizing what `background()` already does. Image-as-pigment stays a
separate, larger release whenever you want the wash to actually *touch* the
image.
