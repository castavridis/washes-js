# Washes

An interactive watercolor simulation for the browser — a three-layer fluid,
pigment, and paper model with Kubelka–Munk optical compositing, built on
Curtis et al.'s 1997 SIGGRAPH paper *Computer-Generated Watercolor*.

**Live site:** <https://castavridis.github.io/washes-js/> — the landing page
links to everything below. The flagship demo is the
[playground](demos/playground.html) (demo v1.0.18 — loads the live engine build).

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page (GitHub Pages entry) — a live, paintable engine hero plus navigation |
| `demos/` | `playground.html` (the full instrument, with built-in docs + changelog) · `snake.html` ("Serpentine") · `mask-reveal.html` ("Develop") |
| `engine/` | The `washes` npm-shaped package, v1.23.0 — `src/` (core, GPU sim, timeline sidecar, typings, shader), `tests/`, `dist/washes.standalone.js` for classic script tags |
| `presets/` | Saved brush/palette modules (`rainbow-spray`, `reveal-blue`) |
| `showcase/` | Finished pieces: `pages/` (GRAIN, Surfacing, VANTAGE) · `studio/` (six brand studies) · `personality/` (ten temperament studies) · `labs/` (physics + experiments) |
| `reference/papers/` | Seven interactive explainers of the papers the engine is built on |
| `docs/` | Roadmap (annotated with shipped status), backdrop-compositing scope, bundle-QA record (`FIXES.md`), CPU→GPU migration scaffold |
| `archive/` | Dated snapshots: original bundles + conversation transcripts (`26-5-21`), the source ZIPs (`26-7-12`), and `versions/` — runnable snapshots of watercolor v0.1 → v1.0 and washes v0.61 → v0.98 |

## Two changelogs, by design

- **`engine/CHANGELOG.md`** tracks the engine package (0.98.0 → 1.23.0).
- **The playground's in-app changelog** (docs panel) tracks the demo itself
  (v0.1 → v1.0.18). Since v1.0.18 the playground — and every demo and
  showcase page — loads the live engine build
  (`engine/dist/washes.standalone.js`), so engine releases reach the pages
  without re-embedding; demo releases now cover the pages' own behavior.

## Using the engine

```js
// ESM / bundlers
import { Washes } from './engine/src/index.js';
const wc = Washes.create(host, { pigments: [{ color: '#2f6fb0' }] });
wc.paintNorm(0.5, 0.5, 0.06, 'blue', 0.8);
```

```html
<!-- classic script tag -->
<script src="engine/dist/washes.standalone.js"></script>
<script> const wc = Washes.create(host); </script>
```

Optional entry points: `washes/gpu-sim` (WebGL2 backend, opt-in via
`create(el, { gpu: true })`) and `washes/timeline` (declarative stroke
choreography). See [`engine/README.md`](engine/README.md).

## Tests

```bash
cd engine
npm test                     # regression harness (headless CPU path)
npm run test:texture-parity  # CPU/GPU texture-deposit parity (12 checks)
node scripts/build-standalone.cjs   # regenerate dist/washes.standalone.js
```

## License

MIT — see [`engine/LICENSE`](engine/LICENSE). Cite via
[`engine/CITATION.cff`](engine/CITATION.cff).
