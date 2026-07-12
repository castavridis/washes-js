# GPU texture brushes — CPU-matching build

The "right long-term" option: make the GPU texture brushes use the **same**
precomputed noise fields the CPU uses, with the **same** deposit-factor math, so
crayon / dryBrush / salt / splatter match the CPU look instead of the procedural
approximation in the uploaded `washes-gpu-sim.js`.

## Files

| File | What | Status |
| --- | --- | --- |
| `brush-texture-deposit.js` | JS reference of the CPU deposit-factor math (single source of truth) | ✅ verified |
| `texture-parity.test.mjs` | proves the reference matches the real CPU lib per cell | ✅ runs headless |
| `brush_stamp.frag` | the shader — a line-for-line transliteration of the reference | ⛔ needs a GPU to run |
| `INTEGRATION.md` | exact diffs to wire it into `washes-gpu-sim.js` + `washes.js` | ⛔ GL needs a GPU |

```
node texture-parity.test.mjs        # 12/12 pass against the vendored v0.98 lib
```

## What's verified

`texture-parity.test.mjs` paints a `'wet'` stamp and an identical textured stamp
on two paper-identical instances of the real lib; the per-cell ratio
`g_textured / g_wet` IS the CPU's deposit factor (everything else in the deposit
is identical). It then checks `brush-texture-deposit.js` predicts that factor
from the same noise field + paper height. Result: **max per-cell error < 1e-4**
across all four modes, with a confirmed speckle spread (not a uniform dim). So
the math the shader implements reproduces the CPU look.

## How this differs from the uploaded procedural shader

- Samples `u_brushTexture` (the lib's `crayonNoise`/`dryBrushNoise`/`saltNoise`/
  `splatterNoise`, uploaded) instead of in-shader hash/fbm/Worley — so the noise
  pattern *is* the CPU's, not a look-alike.
- Blends with the real paper height (`u_paper`, already on the GPU) at the CPU's
  per-mode `paperWeight` (0.55 crayon, 0.25 dryBrush, 0 salt/splatter).
- Uses the CPU's exact threshold/smoothstep/bristle-skip/anisotropy formula.
- **Removes** the procedural build's per-stamp deposit cap
  (`mix(0.40, 0.12, dryness)`) — it existed to paper over the procedural noise
  not matching CPU pacing, and would now cause divergence.

## Known remaining parity item (separate from textures)

The GPU pigment deposit uses linear `falloff`; the CPU uses `falloff²` (`f2`).
This affects the stroke's overall softness for *every* pigment stamp (wet
included), not the texture speckle — which is governed by the deposit factor and
is matched. Aligning it is a one-token change (`falloff` → `f2` in the pigment
deposit) but it shifts the plain-wet path too, so it deserves its own visual
check rather than riding along with this change. Left as-is here.
