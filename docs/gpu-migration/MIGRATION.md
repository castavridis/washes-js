# Washes CPU→GPU migration

This scaffold implements the parts of the migration that can be built **and
verified in a headless environment**, and specifies the parts that need a real
WebGL2 GPU to validate. Nothing GPU-dependent is presented as "done" — after the
13-version cross-artifact saga, unvalidated advection/shader code is exactly the
thing not to ship blind.

## Status at a glance

| Item | Phase | Files | Validated here? |
| --- | --- | --- | --- |
| Backend seam (typed interface) | 0 | `backend/sim-backend.d.ts` | ✅ `tsc --strict` |
| CPU backend adapter | 0 | `backend/cpu-backend.js` | ✅ bit-identical to real v0.98 sim |
| Backend selector + parity gate | 3 | `backend/select-backend.js` | ✅ `tsc --checkJs --strict` |
| Stamp batching (32/pass cap) | cross-cut | `backend/stamp-batcher.js` | ✅ unit test |
| Context-loss recovery | cross-cut | `backend/context-recovery.js` | ✅ unit test (caught a real startup bug) |
| GPU brush paint-load uniform | 1 | spec below | ⛔ needs GPU |
| GPU texture brush modes | 1 | spec below | ⛔ needs GPU |
| GPU ink channel | 1 | spec below | ⛔ needs GPU |
| Per-pass GPU↔CPU parity harness | 1 | spec below | ⛔ needs headless-gl / browser |
| GPU-direct K–M render | 2 | spec below | ⛔ needs GPU |
| Multi-instance shared context | cross-cut | design below | ⛔ needs GPU |
| Build pipeline (.ts + shaders) | cross-cut | recommendation below | — |

Run the verified pieces:

```
node tests/stamp-batcher.test.mjs
node tests/context-recovery.test.mjs
node tests/cpu-backend.test.mjs        # loads the real v0.98 lib
tsc --noEmit --strict tests/backend.smoke.ts
```

---

## Phase 0 — the seam (done, verified)

`sim-backend.d.ts` promotes the GPU module's de-facto contract (`step`,
`stampBrush`, `uploadState`, `downloadState`, `getTextures`, `destroy`) to a
first-class typed interface that both backends implement. `cpu-backend.js` is an
**adapter**: it satisfies the interface by driving the lib's existing sim through
a small hook object, rather than relocating ~9k lines. The equivalence test
(`cpu-backend.test.mjs`) loads the real v0.98 lib, drives one instance through
the adapter and an identical instance directly, and asserts bit-identical state
across probe cells and total mass — so introducing the seam changes nothing.
Physical extraction of the sim core behind this interface is then a safe,
incremental follow-up.

## Cross-cutting (done, verified)

`stamp-batcher.js` splits any stamp list into ≤32-per-pass batches and dispatches
the brush pass once per batch (the GPU shader's `MAX_STAMPS` is 32; the CPU path
has no cap, so dense strokes / deluge / SVG tracing overflow it today).
`context-recovery.js` wires `webglcontextlost`/`restored`, `preventDefault`s the
loss (required, or the browser never fires `restored`), and re-seeds from a
coarse CPU shadow snapshot rather than a per-frame readback.

## Phase 3 — selection (wired, gated)

`select-backend.js` detects WebGL2 + `EXT_color_buffer_float` and picks GPU
**only when a `parityOk(needs)` predicate returns true** for the features the
instance uses. This is what lets the default flip incrementally: until Phase 1
parity is signed off for, say, texture brushes, any instance that needs them
stays on the CPU even where WebGL2 exists. Default `parityOk` is "nothing
validated yet," so the GPU is never silently chosen prematurely.

---

## Phase 1 — parity (specs; require a GPU to validate)

### 1a. Paint-load uniform (retire the strength-folding hack)

`BrushStamp` gains `paintAmount`. The shader currently packs two vec4s per stamp;
add a third for the new field and use it in the pigment branch.

`brush_stamp.frag` — current pigment branch:
```glsl
vec3 deposit = weights * falloff * strength;
```
becomes:
```glsl
// u_stampParams2[s].x = paintAmount (1.0 default)
float paintAmount = u_stampParams2[s].x;
vec3 deposit = weights * falloff * strength * paintAmount;
```
Add `uniform vec4 u_stampParams2[MAX_STAMPS];` and pack `paintAmount` at `.x` in
the JS uniform upload. This removes the `gpuStrength = strength * paintLoadMult`
workaround in `washes-patched.js` — paint load no longer rides on `strength`, so
the lift/mask/paper branches (which use `1.0 - sub`) are unaffected.

### 1b. Texture brush modes (the v0.98 headline, GPU side)

The GPU brush stamp has no rejection logic. Port the CPU `_brushMode` block
(crayon/dryBrush/salt/splatter) into the shader:

- Upload the existing CPU noise fields (`crayonNoise`, `dryBrushNoise`,
  `splatterNoise`) as a single-channel texture `u_brushTexture`.
- Add uniforms: `int u_textureMode`, `float u_dryness`, `float u_dryPaperReject`,
  `float u_dryAnisotropy`, `float u_dryBrushSkip`.
- In the pigment branch, sample the texture at `uv` and compute a rejection
  factor that **must reproduce the CPU math** (see the lib's `_brushMode` block:
  `texturePaperWeight`, the directional term for dryBrush using stroke direction,
  the skip threshold). Modulate `deposit *= rejection`.

This one is the most error-prone: validate it pass-by-pass (1d) against the CPU
oracle, mode by mode, before enabling it in `select-backend`'s `parityOk`.

### 1c. Ink channel

Ink is a separate single channel on the CPU. On the GPU, store it in the unused
alpha of the pigment texture (`out_pigment.a`), advect it with the same velocity
field as the K–M channels, and apply the ink-darkening multiplier in the render
shader (1e). Add `u_inkActive` to gate cost to zero when no ink is deposited.

### 1d. Per-pass parity harness (the oracle)

Extend `washes-test-harness` with a GPU mode: instantiate both backends, upload
**identical** state, run each isolated pass via the GPU handle's `debug*` methods
(`debugApplyBrushStampsOnly`, `…TransferOnly`, `…WetDiffusionOnly`,
`…VelocityOnly`, `…AdvectionOnly`) and the CPU equivalent, `downloadState`, and
diff within a per-pass tolerance. **Determinism is tolerance-based, not exact**
(GPU `highp` float vs CPU float64 through semi-Lagrangian advection). Re-run the
existing anisotropy and hotspot tests against GPU output so the cross artifact and
pinpoint bug can't silently return. Needs headless-gl (`gl` npm) or Playwright in
a real browser — neither installable in this sandbox.

## Phase 2 — GPU-direct render (spec; requires a GPU)

The handle already exposes `getFluidTexture`/`getPigmentTexture`/
`getDepositTexture`, and the demo already samples them — so the render path does
**not** read back per frame today. Finish it by moving K–M reflectance→RGB
compositing (plus paper, ink darkening, gouache lerp) into the render fragment
shader sampling those textures. Keep `downloadState` strictly out of the frame
loop — only `exportPNG`, CPU-only effects, and the context-loss shadow call it.

---

## Cross-cutting (remaining)

**Multi-instance + GL context limits.** Browsers cap WebGL contexts (~16/page),
but the lib supports many instances. Don't give each instance its own context.
Use one shared WebGL2 context with per-instance FBO/texture sets (or a context
pool with LRU eviction where evicted instances fall back to CPU or pause). This
is a real architectural decision the CPU path sidesteps; design it before
enabling GPU on pages that mount many canvases.

**Build pipeline.** Fold `washes-gpu-sim.ts` and the 10 shader files into an
esbuild/Vite step that inlines shaders as string constants and emits both
`washes.js` (CPU + GPU) and a `washes.d.ts` that re-exports `SimBackend`,
`BrushStamp`, and `SimParams`. Retire `convert-ts-to-js.py` (a stopgap) so the
GPU module and its types are first-class rather than hand-converted.

## Suggested order

0. ✅ Land the seam + cross-cutting JS (this scaffold).
1. Build the per-pass parity harness (1d) **first** — it's the oracle every later
   step is checked against.
2. 1a paint-load, then 1c ink, then 1b texture brushes (hardest), each gated into
   `parityOk` only after per-pass sign-off.
3. Phase 2 GPU-direct render.
4. Multi-instance shared context, then flip the default via `select-backend`.
