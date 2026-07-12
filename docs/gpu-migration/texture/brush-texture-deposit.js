// brush-texture-deposit.js
//
// Reference implementation of the CPU lib's texture deposit-factor math,
// extracted verbatim from washes.js's paintAt() texture block (v0.98/v1.0).
// This is the single source of truth: the GLSL in brush_stamp.frag is a
// line-for-line transliteration of these functions, and texture-parity.test.mjs
// proves THIS matches the real CPU lib cell-for-cell. So if the shader matches
// this, it matches the CPU look.
//
// Modes: 'crayon' | 'dryBrush' | 'salt' | 'splatter' ('dry' = crayon alias).

/**
 * Per-mode constants, exactly as the CPU derives them from the user knobs.
 * @param {string} mode
 * @param {number} dryness     0..1 (the lib's _drynessAmount)
 * @param {number} paperReject 0..1 (_dryPaperReject)
 */
export function modeConstants(mode, dryness, paperReject) {
  switch (mode) {
    case 'crayon':
    case 'dry':
      return { baseThresh: 0.4 + 0.25 * paperReject, bandHalf: 0.05, paperWeight: 0.55, anisoMul: 6,  waterMult: 1 - dryness * 0.85 };
    case 'dryBrush':
      return { baseThresh: 0.4 + 0.25 * paperReject, bandHalf: 0.03, paperWeight: 0.25, anisoMul: 12, waterMult: 1 - dryness * 0.85 };
    case 'salt':
      return { baseThresh: 0.75, bandHalf: 0.12, paperWeight: 0,    anisoMul: 0,  waterMult: 1 - dryness * 0.3 };
    case 'splatter':
      return { baseThresh: 0.70, bandHalf: 0.02, paperWeight: 0,    anisoMul: 0,  waterMult: 1 - dryness * 0.5 };
    default:
      return null; // 'wet' → no texture
  }
}

/**
 * Per-cell deposit factor in [0,1]. 1 = full deposit, 0 = fully rejected
 * (paper shows through). Mirrors the CPU loop body exactly.
 *
 * The anisotropy term (dryBrush, paperH-gradient projected on motion) is
 * applied separately by `anisotropyReject` below — it's only active when a
 * motion vector exists (i.e. not on the first stamp of a stroke).
 *
 * @param {number} fn   noise field value at the cell, 0..1
 * @param {number} ph   paperH at the cell, 0..1
 * @param {object} c    { amount, baseThresh, bandHalf, paperWeight, bristleK }
 *                      amount = dryness; bristleK = dryness * bristleSkip
 * @returns {number} deposit factor, 0..1 (before anisotropy)
 */
export function depositFactor(fn, ph, c) {
  if (c.amount <= 0) return 1;
  const combined = fn * (1 - c.paperWeight) + ph * c.paperWeight;
  const thresh = 1 - c.amount * c.baseThresh;
  const lo = thresh - c.bandHalf;
  const hi = thresh + c.bandHalf;
  let skipMask;
  if (combined < lo) skipMask = 0;
  else if (combined > hi) skipMask = 1;
  else { const t = (combined - lo) / (c.bandHalf * 2); skipMask = t * t * (3 - 2 * t); }
  let totalReject = skipMask * (0.85 + 0.15 * c.bristleK);
  if (totalReject > 1) totalReject = 1;
  return 1 - totalReject;
}

/**
 * Anisotropy add-on for dryBrush: paperH gradient projected onto the stroke
 * motion vector increases rejection where paper rises along the stroke. Adds
 * to totalReject (so SUBTRACTS from the returned factor). No-op when anisoK==0,
 * motion is zero, or proj <= 0. Caller passes the pre-anisotropy `factor`.
 */
export function applyAnisotropy(factor, dhdx, dhdy, motionX, motionY, anisoK) {
  if (anisoK <= 0 || (motionX === 0 && motionY === 0)) return factor;
  const proj = dhdx * motionX + dhdy * motionY;
  if (proj <= 0) return factor;
  let totalReject = (1 - factor) + proj * anisoK;
  if (totalReject > 1) totalReject = 1;
  return 1 - totalReject;
}
