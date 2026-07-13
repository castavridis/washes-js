# src/parts — the incremental extraction

Sections of `washes.js` live here as **source-of-truth fragments** and are
spliced verbatim into `washes.js` between `PART` sentinels by
`scripts/assemble.cjs`. Same model as the GPU block (`scripts/sync-gpu.cjs`):
`washes.js` stays one self-contained, directly loadable file — an assembly
artifact for these sections — and **these files are where you edit**.

```
edit src/parts/<name>.part.js  →  npm run assemble  →  washes.js updated
```

CI runs `assemble --check` and fails on any drift in either direction.
Editing between the sentinels in `washes.js` directly will be overwritten.

## Current parts

| Part | What's in it |
|---|---|
| `pigment-data.part.js` | The Curtis et al. (1997) Figure 5 pigment sets (K/S coefficients, density/staining/granulation), ink pigment sets, tool sentinel indices, and adjacent brush-state defaults |
| `../washes-sim-core.js` | **GRADUATED (v1.18)** — the physics as a real ES module (`createSimCore(env)`, npm entry `washes/sim-core`): active-region tracking, paper generation, box blurs, edge darkening (§4.3.3), velocity update (§4.3.1), pigment advection, boundary drainage, pigment transfer (§4.5), evaporation, `simStep`. Assembled into `washes.js` via the `esm-inline` transform; see the module header for the host/core ownership contract |
| `sim-backend.part.js` | The SimBackend seam (MIGRATION.md Phase 0): the CPU adapter and the state codec inverse |

## The rules

- Parts are **closure fragments**, not modules: they still share
  `createInstance`'s scope, so cross-part references are normal. That's by
  design — verbatim splicing means the carve-out itself can never change
  behavior (proven: the extraction commit's only `washes.js` diff is the
  sentinel comments, and every golden stayed bit-exact).
- A part graduates to a real ES module when its seam is ready (the sim core
  is next, behind the `SimBackend` interface — ENGINE_REVIEW P1#6). Until
  then, don't add exports/imports to part files.
- New carve-outs: add the sentinels + file, register the name in
  `scripts/assemble.cjs`'s `PARTS` list, and keep the first assembled run
  byte-identical.
