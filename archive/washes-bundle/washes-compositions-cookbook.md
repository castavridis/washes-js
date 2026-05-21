# Washes compositions cookbook

A reference of working call sequences for the Washes library, organized by visual outcome rather than by API method. The goal is to give Claude (and you) a style guide: when suggesting code for a new sketch, the suggestions should look and read like the recipes below.

Every recipe assumes you've already done:

```js
import { Washes } from 'washes';
const wc = Washes.create(document.getElementById('host'), { gouacheMode: 'auto' });
```

Recipes are organized from atomic (one-shot effects) to compositional (multi-step pieces). Each one names what it produces and the API methods it relies on.

---

## Atomic effects

### A simple deluge

The fundamental building block. One radial outburst of pigment at a click position.

```js
wc.splash([{ x: 400, y: 300, velocity: 40 }], 'deluge');
```

Variations:
- Higher `velocity` (60-80): more violent burst, takes longer to settle.
- Lower `velocity` (10-20): gentle ripple, settles quickly.
- Multiple epicenters in one call: simultaneous bursts that interact.

```js
// Three simultaneous deluges in a triangle
wc.splash([
  { x: 300, y: 200, velocity: 30 },
  { x: 500, y: 200, velocity: 30 },
  { x: 400, y: 400, velocity: 30 },
], 'deluge');
```

### A solid brush stroke

```js
wc.pigment('blue');
wc.brushSize(40);
// Then either: paint via pointer events (already wired by default),
// OR programmatically stamp:
wc.paintAt(200, 150, 20, 'blue', 0.8);  // grid coords, gridRadius, pigment, strength
```

Note: `paintAt` uses grid coordinates, not display pixels. Use `wc.toGrid(x, y)` to convert if you have display coords.

### Lift (erase)

```js
wc.pigment('lift');
wc.brushSize(60);
// Paint with the lift brush — removes pigment from cells it touches.
// Returns the active brush to lift mode until you switch back:
wc.pigment(0);  // back to rose
```

---

## Backgrounds

### Even wash background

Cover the entire canvas with a single pigment at low load. Good as an underpainting layer for portfolio backgrounds.

```js
const w = wc.state().DISPLAY_W ?? 1080;
const h = wc.state().DISPLAY_H ?? 900;

wc.pigment('yellow');
wc.brushSize(800);
wc.paintLoad(0.15);
wc.splash([{ x: w / 2, y: h / 2, velocity: 5 }], 'deluge');
```

Lower `paintLoad` for a more transparent wash; raise for a more opaque tint.

### Three-pigment Venn background

A subtle compositional background using all three pigments at low load. Each pigment becomes a soft circle; intersections mix via Kubelka–Munk. See the v0.81+ "Venn preview" in the docs for what each intersection looks like at the chosen load.

```js
const w = 1080, h = 900;

wc.brushSize(600);
wc.paintLoad(0.10);

wc.pigment('rose');
wc.splash([{ x: w * 0.40, y: h * 0.45, velocity: 8 }], 'deluge');

wc.pigment('yellow');
wc.splash([{ x: w * 0.60, y: h * 0.45, velocity: 8 }], 'deluge');

wc.pigment('blue');
wc.splash([{ x: w * 0.50, y: h * 0.65, velocity: 8 }], 'deluge');
```

### Radial-gravity ambient

Pigment drifts continuously toward all edges. Good for moody, never-twice-the-same backgrounds. The wash never fully settles.

```js
wc.edgeMode('gravity');
wc.gravityDirection('radial');
wc.gravityStrength(0.08);   // gentle pull; raise for more dramatic

// Drop a single centered splash that will radiate outward forever
wc.splash([{ x: 540, y: 450, velocity: 30 }], 'deluge');
```

---

## Transitions (portfolio in/out)

### "Drawing in" — animate an SVG over time

For a logo or shape that appears as the page loads. The SVG paths are drawn as if by hand at the given speed.

```js
const svg = await fetch('/logo.svg').then(r => r.text());

await wc.traceSVG(svg, {
  pigment: 'blue',
  brushSize: 32,
  speed: 600,            // px/sec
  scale: 0.8,
  translateX: 100,
  translateY: 50,
});
```

The returned Promise resolves when the trace completes. Chain another effect after:

```js
await wc.traceSVG(svg, { pigment: 'blue', speed: 600 });
// After draw-in, optionally bloom the lines outward:
wc.splash([{ x: 540, y: 450, velocity: 20 }], 'deluge');
```

### "Falling off" — open edges + gravity-down

For a page-exit transition. Paint slides off the bottom edge as the user navigates away.

```js
wc.edgeMode('gravity');
wc.gravityDirection('down');
wc.gravityStrength(0.20);   // strong pull
wc.velocityClamp(3.0);      // raise the cap so flow is dramatic
// The simulation does the rest. After ~3 seconds the canvas should
// be mostly empty.
```

### "Obliterate" — built-in disintegration

The lib has a built-in obliterate animation that progressively destroys the painting. Good for dramatic exits.

```js
await wc.obliterate({
  duration: 1200,         // ms
  easing: 'ease-out',
});
```

---

## Compositional pieces (multi-step)

### "Sunset with bleed"

Vertical color gradient: rose at top, yellow in middle, blue at bottom. Use small splashes at different y positions to build up the gradient.

```js
const w = 1080;
wc.brushSize(900);
wc.paintLoad(0.12);

wc.pigment('rose');
for (let x = 0; x <= w; x += 150) {
  wc.splash([{ x, y: 100, velocity: 6 }], 'deluge');
}

wc.pigment('yellow');
for (let x = 0; x <= w; x += 150) {
  wc.splash([{ x, y: 350, velocity: 6 }], 'deluge');
}

wc.pigment('blue');
for (let x = 0; x <= w; x += 150) {
  wc.splash([{ x, y: 600, velocity: 6 }], 'deluge');
}
```

### "Constellation" — sparse points of single-pigment color

A scatter of small splashes at semi-random positions. Use as a background or in the corners of a hero image.

```js
const W = 1080, H = 900;
const points = 12;
wc.brushSize(50);
wc.pigment('rose');

const splashes = [];
for (let i = 0; i < points; i++) {
  splashes.push({
    x: 100 + Math.random() * (W - 200),
    y: 100 + Math.random() * (H - 200),
    velocity: 8 + Math.random() * 8,
  });
}
wc.splash(splashes, 'splash');
```

For Poisson-disk-like spacing (more even-looking placement), generate candidate points and reject any too close to an existing point.

### "Stained edge frame"

A subtle wash that hugs the edges of the canvas, leaving the center clear. Used as a frame around content.

```js
const W = 1080, H = 900;

wc.brushSize(600);
wc.paintLoad(0.08);
wc.pigment('yellow');

// Four corner splashes
wc.splash([
  { x: 0, y: 0, velocity: 5 },
  { x: W, y: 0, velocity: 5 },
  { x: 0, y: H, velocity: 5 },
  { x: W, y: H, velocity: 5 },
], 'deluge');
```

The splashes radiate outward; mass conservation pushes pigment toward the canvas corners. With `edgeMode: 'open'` the corners would drain, breaking the effect — keep closed mode for this one.

### "Wet stage for portrait"

A pre-wet area in the middle of the canvas where you'll later paint a portrait or other subject. The pre-wetting makes subsequent paint bleed more, giving a soft "rendered in watercolor" look to anything painted there.

```js
const cx = 540, cy = 450;

// First: pre-wet the area without much pigment
wc.pigment('water');
wc.brushSize(400);
wc.paintLoad(0.05);
wc.splash([{ x: cx, y: cy, velocity: 4 }], 'deluge');

// Wait briefly for the water to spread
await new Promise(r => setTimeout(r, 500));

// Now paint into the wet area — it'll bleed naturally
wc.pigment('rose');
wc.brushSize(40);
wc.paintAt(...wc.toGrid(cx - 30, cy - 30).map(Math.round), 15, 'rose', 0.7);
wc.paintAt(...wc.toGrid(cx + 30, cy + 30).map(Math.round), 15, 'rose', 0.7);
```

The pre-wet stage acts like a real watercolor "wet-on-wet" technique.

### "Color story" — palette demo for a portfolio piece

Drop three swatches of equal size at the three thirds of the canvas. Useful as a portfolio piece showing off the lib's color compositing.

```js
const W = 1080, H = 900;
const y = H * 0.5;

wc.brushSize(500);
wc.paintLoad(0.18);

wc.pigment('rose');
wc.splash([{ x: W * 0.25, y, velocity: 10 }], 'deluge');

wc.pigment('yellow');
wc.splash([{ x: W * 0.50, y, velocity: 10 }], 'deluge');

wc.pigment('blue');
wc.splash([{ x: W * 0.75, y, velocity: 10 }], 'deluge');
```

---

## Style reference (when suggesting code for a new sketch)

A good Washes call sequence has these properties:

1. **Coordinates are display pixels** (not grid coords) unless using `paintAt`. Use `wc.toGrid(x, y)` if grid coords are needed.
2. **`brushSize` is in display pixels.** Default 28, range realistically 4-2000.
3. **`paintLoad` and similar are in 0..1.** Higher = more opaque.
4. **Splash `velocity` is roughly 5-80.** Below 5 is gentle; above 60 is dramatic.
5. **Multi-pigment compositions** set the pigment before each operation. Don't try to "mix" pigments mid-call — the lib's Kubelka–Munk compositing does that automatically when overlapping pigments land at the same grid cell.
6. **Don't await `splash`** — it's synchronous. Do `await` `traceSVG`, `paintText`, `paintImage`, `obliterate`. They return Promises.
7. **Match the deluge style to the mood**: `'deluge'` for strong outward radiation, `'splash'` for sharper localized splash, `'spray'` for diffuse coverage.
8. **Backgrounds want low `paintLoad` (0.08–0.15) and big brushes (400–900).** Foreground subjects want default `paintLoad` (0.5+) and small brushes (20–60).
9. **Use `edgeMode: 'gravity'` + `direction: 'radial'`** for ambient, alive-feeling backgrounds. Use `edgeMode: 'closed'` (default) when you want a specific composition to settle into its final form.
10. **Code-style preference**: terse method chains where possible (`wc.pigment('blue')`), one effect per statement, comments explaining *why* not *what*.

---

## Methods worth knowing about for sketch-to-code translation

When the sketch shows... | Reach for...
--- | ---
Outward radial burst, dramatic | `splash([...], 'deluge', { velocity: 40+ })`
Single localized splat | `splash([...], 'splash', { velocity: 20-30 })`
Diffuse, soft, multiple points | `splash([many], 'spray', { velocity: 5-10 })`
Animated line drawing | `traceSVG(...)` (returns Promise)
Cover large area uniformly | `brushSize(800)` + `paintLoad(0.1)` + `splash(...)`
Text appearing | `paintText(text, { fontSize, x, y, pigment })` (Promise)
Image stenciled in watercolor | `paintImage(url, { threshold: 0.5 })` (Promise)
Empty masked region (clear corner) | `pigment('mask')` then paint where you want frozen
Pre-wet stage for bleed | `pigment('water')` + `paintLoad(0.05)` then splash
Erase | `pigment('lift')` + brush over area
Page-exit animation | `edgeMode('gravity')` + `gravityStrength(0.2)`, OR `obliterate({ duration })`
Ambient never-settles background | `edgeMode('gravity')` + `gravityDirection('radial')` + `gravityStrength(0.05-0.1)`
Visualize wetness | `wetnessHeatmap(true, lowColor, highColor)`

---

## Tone

When suggesting code from a sketch, prefer:

- **3-10 lines of code, heavily commented.** A sketch isn't a full application — the recipe should be readable in 30 seconds.
- **Variables for any numbers a user might want to tweak** (canvas dimensions, position offsets, color choices). Not just inline magic numbers.
- **An "if you want X" follow-up suggesting one variation.** "If you want the bleed to be more aggressive, raise `paintLoad` to 0.25."
- **Acknowledge what the sketch can't capture in code.** Watercolor has randomness; the rendered output will look different each time. If the sketch shows specific drip shapes, those will vary; if it shows specific colors, those are achievable.

When the sketch shows something the lib can't do (true wet-on-dry overpainting without bleed, impasto texture, drying *patterns* like cauliflowering), say so directly and suggest the closest available technique.
