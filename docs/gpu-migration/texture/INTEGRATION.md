# Texture-parity integration

How to wire `brush_stamp.frag` into the uploaded `washes-gpu-sim.js` and
`washes.js`. The deposit math is verified (see README); the GL/GLSL wiring below
needs a WebGL2 context to validate, so it's given as exact diffs rather than a
pre-edited "done" file.

Good news: the paper field is **already** on the GPU (`TEX_PAPER`, bound in
`bindAllTextures`). So `u_paper` only needs a uniform bind — no new upload. Only
the noise field is new.

## 1. `washes-gpu-sim.js`

### 1a. Replace the `brushStampFrag` shader string
Replace the inlined `const brushStampFrag = "...";` with the contents of
`brush_stamp.frag` (escaped as a JS string, same as the other shaders). It adds
two samplers — `u_brushTexture`, `u_paper` — and swaps the procedural noise for
the field-sampling deposit-factor math.

### 1b. Add a texture unit + the brush-field texture
```js
// near the other TEX_* unit constants
const TEX_BRUSH = 10;                       // active mode's noise field
```
```js
// where the other textures are created (alongside `paper`):
const brushTex = createTexture(GW, GH);     // R-channel float; reuses createTexture
```
```js
// in bindAllTextures(), alongside the existing binds:
bindTextureUnit(TEX_BRUSH, brushTex);
```

### 1c. `setBrushTexture` — upload the active noise field
```js
// field: Float32Array(GW*GH) in [0,1], the lib's crayon/dryBrush/salt/splatter
// field for the current mode. Grid-resolution, so it samples 1:1 by cell.
function setBrushTexture(field, w, h) {
  gl.activeTexture(gl.TEXTURE0 + TEX_BRUSH);
  gl.bindTexture(gl.TEXTURE_2D, brushTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, field);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
```
NEAREST is deliberate: the CPU samples the field by integer cell, so we want no
interpolation — 1:1 texel-to-cell.

### 1d. Bind the two samplers in `passBrush` (with the other uniform sets)
```js
gl.uniform1i(u["u_brushTexture"], TEX_BRUSH);
gl.uniform1i(u["u_paper"], TEX_PAPER);     // already-bound paper field
```

### 1e. Expose `setBrushTexture` on the handle
Add `setBrushTexture,` to the object returned at the bottom (`return { ... }`).

## 2. `washes.js` (lib) — feed the field on mode change

In the GPU routing path, whenever the brush mode is a texture mode, generate the
field (the lib already has `_ensureTextureNoise`) and hand it to the GPU. The
cleanest spot is the `brushMode(v)` setter and the first textured stamp.

```js
// helper near the GPU routing
function _gpuPushBrushField() {
  if (!useGpuSim || !gpuSimHandle) return;
  if (_brushMode === 'wet') return;
  _ensureTextureNoise(_brushMode);
  const field =
      (_brushMode === 'crayon' || _brushMode === 'dry') ? crayonNoise
    : _brushMode === 'dryBrush' ? dryBrushNoise
    : _brushMode === 'salt' ? saltNoise : splatterNoise;
  if (field) gpuSimHandle.setBrushTexture(field, GW, GH);
}
```
Call `_gpuPushBrushField()` (a) at the end of the `brushMode(v)` setter, and
(b) once after `rebuildScale()` regenerates the grid (the fields are
grid-sized, so they must be re-uploaded when GW/GH change). `setBrushMode(...)`
keeps passing the scalar knobs exactly as today — the shader now reads the real
field instead of synthesizing noise.

## 3. Validate on a GPU

Port `texture-parity.test.mjs` to run in a browser against the GPU handle:
paint a `'wet'` stamp and an identical textured stamp, `downloadState()` both,
and assert the per-cell ratio matches `depositFactor()` within a float tolerance
(use ~1e-3, not 1e-4 — GPU `highp` vs CPU float64). The handle's
`debugApplyBrushStampsOnly()` isolates the brush pass so no other phase muddies
the comparison. If that passes, GPU textures match the CPU look.
