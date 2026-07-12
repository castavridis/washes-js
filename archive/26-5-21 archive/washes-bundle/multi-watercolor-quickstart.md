# Build your own Multi-Watercolor

A friendly quickstart for putting four watercolor canvases on a single page — one full-viewport hero you can paint on, plus three thumbnail cards that animate themselves on load and wash away when clicked.

This is what `multi-watercolor-v0.4.html` does. Here's the path that got us there, simplified into something you can build in an afternoon.

---

## What you'll need

- `watercolor-lib.js` — the simulation library. One file, no dependencies, exposes a single global `Watercolor.create()` factory.
- An HTML file. That's it. No bundler, no build step, no npm. Open it in a browser and it works.

If you have those two things, you're set.

---

## The big idea

The library is built around a factory function. You give it a host element and an options object; you get back an "instance" handle with all the painting methods. State (pigment arrays, paint loads, animation modes, the lot) is closed over per instance — they don't share anything except the global `Watercolor` namespace.

That means you can call `Watercolor.create()` as many times as you want on the same page, and each canvas gets its own world. That's the trick that makes a "multi-watercolor" page even possible.

```js
const hero = Watercolor.create(document.getElementById('hero'));
const thumb1 = Watercolor.create(document.getElementById('thumb-1'));
const thumb2 = Watercolor.create(document.getElementById('thumb-2'));
const thumb3 = Watercolor.create(document.getElementById('thumb-3'));
// Four independent painting systems, ~150 lines of total code between them.
```

Each instance owns its own RAF loop, its own simulation grid, its own brush state. Tell `hero` to use a big rose brush and `thumb1` to do sketch mode in blue, and they don't fight.

---

## The bones

You need a host div for each canvas. The lib attaches a `<canvas>` element inside whatever you give it.

```html
<!-- Full-viewport background -->
<div class="hero" id="hero"></div>

<!-- Three thumbnail cards over the hero -->
<div class="thumbnails">
  <article class="thumb" data-project="orchard">
    <div class="thumb-canvas" id="thumb-1"></div>
    <div class="thumb-title">Orchard</div>
  </article>
  <article class="thumb" data-project="harbor">
    <div class="thumb-canvas" id="thumb-2"></div>
    <div class="thumb-title">Harbor</div>
  </article>
  <article class="thumb" data-project="meadow">
    <div class="thumb-canvas" id="thumb-3"></div>
    <div class="thumb-title">Meadow</div>
  </article>
</div>
```

The hero is the background — `position: fixed; inset: 0`. The thumbnails sit on top in their own container with a higher `z-index`. That stacking order is doing real work for you: when the user clicks a thumbnail, the DOM event system routes the click to the card (because it's on top). When they click empty hero area, the event goes to the hero canvas (because nothing else is in the way). No event-coordination code needed.

---

## Layout that flips for mobile

The original spec was *3 rows × 1 column on desktop, 1 row × 3 columns on mobile*. That's a one-line flex-direction flip.

```css
.thumbnails {
  position: fixed;
  z-index: 5;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;       /* vertical column on desktop */
  gap: 18px;
  width: min(440px, calc(100vw - 48px));
  pointer-events: none;         /* default; children re-enable */
}

.thumb {
  width: 100%;
  aspect-ratio: 1;              /* keep cards square */
  pointer-events: auto;         /* re-enable clicks on the cards */
  /* …visual styling… */
}

@media (max-width: 760px) {
  .thumbnails {
    flex-direction: row;        /* horizontal row on mobile */
    top: auto; left: 0; right: 0;
    bottom: 16px;
    transform: none;
    width: auto;
    padding: 0 12px;
  }
  .thumb {
    flex: 1;                    /* split row evenly */
  }
}
```

A few details worth pointing out, because they're easy to skip and painful to debug:

**`pointer-events: none` on the container, `pointer-events: auto` on the cards.** Without this, the container would catch clicks in the gaps between cards, intercept them, and the hero canvas wouldn't receive paint events when the user dragged through that area. The "none on the parent, auto on the children" pattern is the right hammer for "this element is for layout only, let interactions fall through."

**`aspect-ratio: 1`** keeps the cards square at every container size. The SVG sketches are designed for square viewBoxes, so this matters for the artwork to fit.

**`flex: 1`** on mobile cards lets them split the row evenly. If the viewport is 375px wide with 12px padding and 10px gaps, each card gets `(375 - 24 - 20) / 3 = ~110px`. They stay square because of the aspect-ratio rule.

---

## Don't forget `touch-action: none`

If you skip this, painting on a touch device will silently scroll the page instead of leaving paint. Add it to `html, body`:

```css
html, body {
  touch-action: none;
  overflow: hidden;
  overscroll-behavior: none;
  -webkit-user-select: none;
  user-select: none;
}
```

This tells the browser "give every touch gesture to JS, don't consume them yourself for scrolling/zoom." On a drawing surface, that's what you want.

---

## Boot the hero

The hero is full-viewport, paintable, and runs a randomized scene on load.

```js
const hero = Watercolor.create(document.getElementById('hero'), {
  canvasScale: 0.6,             // smaller simulation grid → smoother on modest hardware
  pointer: true,                // enable mouse/touch/pen → paint
  cursorPreview: false,         // use the CSS crosshair instead of a DOM cursor
});

// Brush state tuned for casual finger/mouse painting on a large surface
hero.brushSize(60);
hero.paintLoad(0.85);
hero.waterLoad(1.1);
hero.pigment('rose');
```

A few of these are worth a second of context:

**`canvasScale: 0.6`** — the simulation grid is 60% of the host's pixel resolution. CSS scales the rendered output back up. You lose a little crispness; you gain a *lot* of CPU headroom. On a 1920×1080 viewport, that's ~700k cells instead of ~2M. Pick lower if the hero is animation-heavy.

**`pointer: true`** — this is the one option that makes the hero drawable. The lib attaches its own pointermove/pointerdown/pointerup listeners to the canvas. Set to `false` and the canvas becomes decorative (which is what you want for the thumbnails).

**`cursorPreview: false`** — the lib has a flag for "should there be a brush-shaped cursor following the pointer?" but the actual DOM cursor element is the host's responsibility (in the main demo app it's wired up; here we just use a CSS crosshair to keep the multi-watercolor file simple).

---

## Random scene on load

Each visit picks one animation and one background. Curate the pools to keep the first impression friendly — leave the dramatic stuff (thunderstorm, tornado) for explicit opt-in elsewhere.

```js
const ANIMATIONS  = ['rainy', 'sunny', 'windy', 'partlyCloudy',
                     'snowing', 'snowingAdditive', 'ai'];
const BACKGROUNDS = ['day', 'dawn', 'sunset', 'night'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

hero.setBackground(pick(BACKGROUNDS));   // base wash first
hero.setAnimation(pick(ANIMATIONS));     // animation on top
```

**Order matters here.** `setBackground` is a one-shot paint of a time-of-day wash. `setAnimation` registers a continuous per-frame step function. If you set the animation first, it paints briefly, then gets covered by the background. Background first → animation second → both stay visible.

That gives 28 unique combinations (7 × 4). The page feels different every time someone lands.

---

## The thumbnails

Same factory, different config. Each one runs `sketchMode()` (which is a settings bundle — small brush, dry paper, no bleed, no edge darkening), then traces an SVG.

```js
const SVGS = {
  orchard: '<svg viewBox="0 0 100 100">...</svg>',
  harbor:  '<svg viewBox="0 0 100 100">...</svg>',
  meadow:  '<svg viewBox="0 0 100 100">...</svg>',
};

const thumbConfigs = [
  { hostId: 'thumb-1', project: 'orchard', pigment: 'blue'   },
  { hostId: 'thumb-2', project: 'harbor',  pigment: 'rose'   },
  { hostId: 'thumb-3', project: 'meadow',  pigment: 'yellow' },
];

const thumbs = thumbConfigs.map((cfg, i) => {
  const wc = Watercolor.create(document.getElementById(cfg.hostId), {
    canvasScale: 0.7,
    pointer: false,          // clicks go to the card, not the canvas
    cursorPreview: false,
  });
  wc.sketchMode();           // felt-pen bundle

  // Stagger so all three don't draw simultaneously — looks more alive
  setTimeout(() => {
    wc.traceSVG(SVGS[cfg.project], {
      pigment: cfg.pigment,
      durationMs: 1500,        // 1.5s animation
      easing: 'penStroke',     // mimics how a hand draws
      perStrokePauseMs: 200,   // brief pause between SVG paths
    });
  }, 250 + i * 350);

  return { ...cfg, wc };
});
```

A few things worth chewing on:

**`canvasScale: 0.7`** on the thumbnails. They're small (~140px on desktop, ~110px on mobile) so we can afford a slightly higher resolution than the hero without trouble.

**`pointer: false`** keeps the lib from listening for pointer events on the thumbnail canvas — we want clicks to route to the parent `<article>` card so we can run our own obliterate logic.

**`sketchMode()`** is a one-shot settings bundle, not a mode flag. It calls a series of setters: `brushSize(7)`, `paintLoad(1.6)`, `waterLoad(0.25)`, `pressure(0.95)`, `paperWetness('boneDry')`, `continuousFlow(false)`, `edgeDarkening(false)`, `fadePainting(false)`. After it runs there's no "sketch mode" to turn off — just a brush configured for fine-line work.

**`easing: 'penStroke'`** is the easing curve that mimics hand-drawn motion: a quick 15% ramp-up to get up to speed, a steady 70% middle, then a 15% deceleration to land. Combined with `perStrokePauseMs: 200`, you get a believable drawing rhythm — smooth strokes punctuated by pen-lift moments between SVG path elements. This is the single best feel-improvement you can make over linear timing.

**The setTimeout stagger** (`250 + i * 350`) means the three thumbnails start drawing 250ms / 600ms / 950ms after load. Simultaneous animations on a page read as "all running automatically." Staggered ones read as "drawing themselves, one after another." Small thing, big difference.

---

## The click handler (where I goofed, so you don't have to)

When you click a thumbnail, you want the wash to start *where you clicked*, not at the center. The library has `toGrid()` to convert client coordinates into the simulation's internal grid coordinates.

Here's the code:

```js
thumbs.forEach((thumb) => {
  const card = document.querySelector(`[data-project="${thumb.project}"]`);
  let busy = false;

  card.addEventListener('click', async (e) => {
    if (busy) return;
    busy = true;

    // ⚠️ Pass clientX/clientY DIRECTLY. Don't pre-subtract rect.left.
    // The lib does its own getBoundingClientRect() inside toGrid.
    const { x, y } = thumb.wc.toGrid(e.clientX, e.clientY);

    await thumb.wc.obliterate({
      mode: 'water',           // water rinse — pigment lifts and diffuses
      durationMs: 500,
      x, y,                    // splash centered where you clicked
    });

    console.log('Project clicked:', thumb.project);
    // In a real portfolio, navigate here: router.push(...)

    // For this demo, redraw the sketch so the page stays interactive
    setTimeout(() => {
      thumb.wc.reset();
      thumb.wc.sketchMode();
      thumb.wc.traceSVG(SVGS[thumb.project], {
        pigment: thumb.pigment, durationMs: 1200,
        easing: 'penStroke', perStrokePauseMs: 150,
      });
      busy = false;
    }, 900);
  });
});
```

**The gotcha I want you to skip.** Earlier versions of this demo had:

```js
// 🚨 Wrong
const rect = card.getBoundingClientRect();
const grid = thumb.wc.toGrid(e.clientX - rect.left, e.clientY - rect.top);
await thumb.wc.obliterate({ x: grid.gx, y: grid.gy });
```

Two bugs in two lines. (1) `toGrid` already does `getBoundingClientRect()` on its own canvas — pre-subtracting double-subtracts. (2) The returned object is `{x, y}`, not `{gx, gy}`. The destructured `gx`/`gy` were `undefined`, which obliterate silently defaulted to canvas center.

Result: every click obliterated at center. It *looked* like it worked, because there was always some animation. But the wash never followed the click point.

Moral: read the return shape, and trust the helper to do what it says. `toGrid(clientX, clientY)` is the whole interface.

**The `busy` flag** prevents double-clicks while an obliterate is in flight. Without it, rapidly clicking would queue overlapping obliterates and the redraw setTimeout would fire while a previous one was still running, getting into weird states.

---

## Keyboard shortcuts (the only "UI")

The demo deliberately has no buttons. Brush selection, reset, perf, help — all keyboard.

```js
document.addEventListener('keydown', (e) => {
  // Skip if user is typing in a form field somewhere
  if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case '1': hero.pigment('rose');   break;
    case '2': hero.pigment('yellow'); break;
    case '3': hero.pigment('blue');   break;
    case '4': hero.pigment('water');  break;
    case 'r': case 'R': hero.reset(); break;
    case 'p': case 'P': togglePerf(); break;
    case 'h': case 'H': toggleHelp(); break;
    case 'Escape': closeOverlaysIfOpen();
  }
});
```

The reason to skip buttons isn't dogmatic minimalism — it's that for a portfolio background, every visible control fights with the artwork for attention. Keyboard shortcuts are discoverable through a small `H`-toggled help overlay, and you can document them in a hint that fades after first paint. The result is a page that *looks* like nothing but a painted background and three cards, but rewards keyboard exploration.

---

## Perf overlay

The library exposes `perf(true)` to enable instrumentation and `perfMetrics()` to read the numbers. Build a tiny DOM panel and poll at 4 Hz:

```js
const perfEl = document.getElementById('perf');
let perfTimer = null;

function updatePerf() {
  const m = hero.perfMetrics();
  setText('perf-fps',    m.fps?.toFixed(1) ?? '—');
  setText('perf-p50',    m.framep50.toFixed(2) + 'ms');
  setText('perf-active', m.activePct.toFixed(1) + '%');
  // …etc, see v0.4 source for the full list
}

function togglePerf() {
  const open = perfEl.classList.toggle('open');
  hero.perf(open);                 // enable/disable instrumentation
  if (open) {
    updatePerf();
    perfTimer = setInterval(updatePerf, 250);
  } else {
    clearInterval(perfTimer);
    perfTimer = null;
  }
}
```

One subtle thing: the lib gates `performance.now()` calls behind `perfEnabled` to avoid paying for instrumentation when it's off. That means toggling perf actually changes what you're measuring slightly — a kind of perf Heisenberg. For a portfolio page this doesn't matter; for serious profiling, leave it on for the whole session.

---

## Going further

Ideas that fit naturally:

- **Project navigation on click**: replace the demo's redraw with an actual route push. `router.push('/projects/' + thumb.project)` after the obliterate completes.
- **Raster-trace thumbnails**: instead of SVG paths, sample pixels from a PNG and `paintAt` each one. The obliterate animation works unchanged — it doesn't care how the pigment got onto the canvas.
- **Persistent painting**: serialize the hero's grid arrays to localStorage on `beforeunload`, restore on boot. The user's doodles survive across visits.
- **Click-and-hold for sustained pour**: increase the brush's `flow()` value while a pointer is held down, return to default on release. Felt-tip → fountain pen → faucet.
- **Color from URL**: parse `?pigment=blue` from `location.search` and apply on load. Lets you link to specific moods.

The library is the same in all these cases. You're just composing its primitives — `paintAt`, `traceSVG`, `obliterate`, `setAnimation`, `setBackground`, the brush-state setters — in different patterns.

---

## A short list of things to remember

1. **One instance per host element.** Each `Watercolor.create()` call is independent. State doesn't bleed.
2. **`pointer: true` for drawable surfaces, `false` for displays.** This is the single most important option.
3. **Z-order routes clicks naturally.** Cards above hero in stacking order = clicks on cards go to cards, clicks elsewhere go to hero. No coordination code needed.
4. **`toGrid(clientX, clientY)` returns `{x, y}`.** Pass raw client coordinates. Read raw `x` and `y`. Anything else is a bug.
5. **`touch-action: none` on the html/body** or finger-painting will scroll the page instead of leaving paint.
6. **Background before animation.** Setting an animation first then a background covers the animation with the wash.

Have fun. The library is built for this kind of composition — you're not fighting it, you're using it the way it wants to be used. Make something weird.
