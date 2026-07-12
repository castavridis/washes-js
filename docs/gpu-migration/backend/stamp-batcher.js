// stamp-batcher.js
//
// Cross-cutting fix: the brush_stamp shader accepts at most MAX_STAMPS (32)
// stamps per pass. The CPU path has no such cap, so fast strokes, the deluge
// preset, and dense SVG tracing can queue far more than 32 stamps in a frame.
// Dropping the overflow loses paint; the fix is to dispatch the brush pass
// multiple times per frame, 32 at a time, accumulating into the same textures.
//
// Pure functions so they're trivially testable without a GPU.

export const DEFAULT_MAX_STAMPS = 32;

/**
 * Split a stamp list into fixed-size batches.
 * @param {any[]} stamps
 * @param {number} [maxPerPass=32]
 * @returns {any[][]}  array of batches, each length <= maxPerPass
 */
export function batchStamps(stamps, maxPerPass = DEFAULT_MAX_STAMPS) {
  if (!Number.isInteger(maxPerPass) || maxPerPass < 1) {
    throw new RangeError('maxPerPass must be a positive integer');
  }
  /** @type {any[][]} */
  const out = [];
  if (!stamps || stamps.length === 0) return out;
  for (let i = 0; i < stamps.length; i += maxPerPass) {
    out.push(stamps.slice(i, i + maxPerPass));
  }
  return out;
}

/**
 * Dispatch a queued stamp list as one-or-more capped passes.
 * `dispatch(batch)` is the brush-pass call; it reads the *current* textures and
 * writes them back, so running it N times accumulates correctly.
 * @param {any[]} stamps
 * @param {(batch: any[]) => void} dispatch
 * @param {number} [maxPerPass=32]
 * @returns {number} number of passes dispatched
 */
export function flushStamps(stamps, dispatch, maxPerPass = DEFAULT_MAX_STAMPS) {
  const batches = batchStamps(stamps, maxPerPass);
  for (let i = 0; i < batches.length; i++) dispatch(batches[i]);
  return batches.length;
}
