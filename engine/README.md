# Washes

An interactive watercolor simulation library for the browser. Built on Curtis et al.'s 1997 SIGGRAPH paper "Computer-Generated Watercolor," with a three-layer fluid + pigment + paper model and Kubelka–Munk optical compositing.

```bash
npm install washes
```

```js
import { Washes } from 'washes';

const wc = Washes.create(document.getElementById('canvas-host'), {
  gouacheMode: 'auto',
});

wc.splash([{ x: 0.5, y: 0.5, velocity: 40 }], 'deluge');  // normalized coords (2.0)
```

## What it does

- Physics-based watercolor simulation running at 60fps in the browser
- Three pigments (quinacridone rose, hansa yellow, cerulean blue) composited via Kubelka–Munk
- Brushes, splashes, lifts, masks, deluges, SVG tracing, image painting, text painting
- Configurable paper texture, edge darkening, granulation, evaporation
- Optional open-edge boundary modes (paint can fall off the page)
- Optional gravity bias (8-direction compass plus radial)
- WebGL rendering when available; CPU fallback always works

## Quick examples

### Splash a deluge near a corner

```js
wc.splash([{ x: 0.15, y: 0.15, velocity: 40 }], 'deluge');
```

### Animate an SVG drawing

```js
const svg = await fetch('/my-logo.svg').then(r => r.text());
wc.traceSVG(svg, { pigment: 'rose', durationMs: 1500 });
```

### Open boundaries with radial gravity (paint falls off all edges)

```js
wc.edgeMode('gravity');
wc.gravityDirection('radial');
wc.gravityStrength(0.10);  // moderate pull
```

### Chained configuration

```js
// 2.0 — setters chain universally; zero-arg getters read.
wc.pigment('blue')
  .backgroundAnimation('sunset')
  .brushSize(0.05)                    // fraction of the smaller side
  .splash([{ x: 0.3, y: 0.3 }], 'deluge');
```

## TypeScript

Types ship with the package. No `@types/` install needed.

```ts
import { Washes, type WashesInstance, type EdgeMode } from 'washes';

const wc: WashesInstance = Washes.create(host);

const mode: EdgeMode = 'gravity';
wc.edgeMode(mode);
```

## Loading without a bundler

The package also attaches `window.Washes` for use via a `<script>` tag.

```html
<script src="node_modules/washes/src/washes.js"></script>
<script>
  const wc = window.Washes.create(document.getElementById('host'));
</script>
```

## Documentation

The full documentation — including the math and physics, debugging history, prior art, and "Dig Deeper" sections — lives in the playground HTML page that ships in `examples/`. Open `examples/playground.html` in a browser to explore.

## License

MIT. See [LICENSE](./LICENSE).

## Citation

If you use Washes in academic or technical work, please cite via [CITATION.cff](./CITATION.cff) or the BibTeX below:

```bibtex
@software{washes,
  title = {Washes: a JavaScript watercolor simulation},
  author = {Stephanie},
  year = {2026},
  url = {https://github.com/castavridis/washes-js},
  note = {Implementation of Curtis et al. 1997, with extensions}
}
```

## Acknowledgements

Built on the work of:
- **Curtis, Anderson, Seims, Fleischer, Salesin** — *Computer-Generated Watercolor* (SIGGRAPH 1997). The paper this lib implements.
- **Kubelka & Munk** — *Ein Beitrag zur Optik der Farbanstriche* (1931). The optical compositing model.
- **Stam** — *Stable Fluids* (SIGGRAPH 1999). The semi-Lagrangian advection scheme.
- **Foster & Metaxas** — *Realistic Animation of Liquids* (Graphical Models 1996). The shallow-water fluid step.
- **Bridson** — *Fluid Simulation for Computer Graphics* (2nd ed., 2015). Reference for boundary conditions and divergence correction.
- **Sochorová & Jamriška** — *Practical Pigment Mixing for Digital Painting* (Mixbox, SIGGRAPH Asia 2021). Sibling work in the same Kubelka–Munk lineage.

The project was nerd-sniped into existence at the Recurse Center by Dan Knutson, Cyrene Zhang, and Kanad Gupta. Extended conversations with Evan Gedrich Pintado, Iris Fernandes Valdez, Lissa Hyacinth, and Jonathan King shaped its scope. See the in-app "Origin" section for the full story.
