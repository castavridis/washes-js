// brush-texture-deposit.js
//
// Reference implementation of the v1.0 lib's texture deposit-multiplier math,
// extracted verbatim from washes.js paintAt() (the v1.0 formula — note this
// DIFFERS from v0.98: threshold is used directly, not dryness-scaled; bristle
// skip is a hard per-index-hash cutoff; anisotropy perturbs nval before the
// threshold). The GLSL in brush_stamp.frag transliterates this, and
// texture-parity.test.mjs proves THIS matches the real v1.0 lib cell-for-cell.
//
// Modes: 'crayon' | 'dryBrush' | 'salt' | 'splatter' ('dry' = crayon alias).

/** Per-mode constants, exactly as v1.0 derives them from the user knobs. */
export function modeConstants(mode, dryness, paperReject) {
  switch (mode) {
    case 'crayon':
    case 'dry':
      return { baseThresh: 0.4 + 0.25 * paperReject, bandHalf: 0.10, paperWeight: 0.55, anisoMul: 6,  waterMult: 1 - dryness * 0.85 };
    case 'dryBrush':
      return { baseThresh: 0.4 + 0.25 * paperReject, bandHalf: 0.06, paperWeight: 0.25, anisoMul: 12, waterMult: 1 - dryness * 0.85 };
    case 'salt':
      return { baseThresh: 0.75, bandHalf: 0.12, paperWeight: 0, anisoMul: 0, waterMult: 1 - dryness * 0.3 };
    case 'splatter':
      return { baseThresh: 0.70, bandHalf: 0.03, paperWeight: 0, anisoMul: 0, waterMult: 1 - dryness * 0.5 };
    default:
      return null; // 'wet'
  }
}

/**
 * Per-cell texture deposit multiplier in [0,1] (v1.0). 1 = full deposit,
 * 0 = rejected (paper shows through).
 *
 * @param {number} fn  noise field value at the cell, 0..1
 * @param {number} ph  paperH at the cell, 0..1
 * @param {number} i   cell index (py*GW+px) — drives the bristle-skip hash
 * @param {object} c   { baseThresh, bandHalf, paperWeight, bristleK, anisoNudge }
 *                     anisoNudge defaults to 0 (first stamp / no motion). For a
 *                     mid-stroke stamp it is anisoK * align * 0.05 (see shader).
 */
export function textureMul(fn, ph, i, c) {
  let nval = fn;
  if (c.paperWeight > 0) nval = nval * (1 - c.paperWeight) + ph * c.paperWeight;
  if (c.anisoNudge) nval += c.anisoNudge;
  const lo = c.baseThresh - c.bandHalf;
  const hi = c.baseThresh + c.bandHalf;
  const t = (nval - lo) / Math.max(1e-6, hi - lo);
  let mul = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  if (c.bristleK > 0) {
    const r1 = (((i * 2654435761) >>> 0) & 0xffff) / 0xffff;
    if (r1 < c.bristleK) mul = 0;
  }
  return mul;
}
