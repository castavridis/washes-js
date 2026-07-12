// context-recovery.js
//
// Cross-cutting fix: a WebGL context can be lost at any time (tab backgrounded,
// GPU reset, driver update). The CPU path never had this failure mode; the GPU
// path must survive it. On loss we mark the backend dead and stop drawing; on
// restore we rebuild GL resources and re-seed state from a CPU-side shadow copy.
//
// The shadow is refreshed cheaply: not every frame (that would reintroduce the
// per-frame readback we worked to remove), but on a coarse cadence and on
// visibility change — the moments when loss is most likely. Snapshot/restore are
// injected so the orchestration is unit-testable without a real GL context.

/**
 * @param {object} cfg
 * @param {{ addEventListener: Function, removeEventListener: Function }} cfg.canvas
 * @param {() => any} cfg.snapshot   capture current sim state (downloadState into a CPU shadow)
 * @param {(snap: any) => void} cfg.restore  rebuild GL resources + uploadState(shadow)
 * @param {() => void} [cfg.onLost]
 * @param {() => void} [cfg.onRestored]
 * @param {number} [cfg.snapshotIntervalMs=2000]  coarse refresh cadence
 * @param {() => number} [cfg.now=Date.now]
 */
export function createContextRecovery(cfg) {
  const {
    canvas,
    snapshot,
    restore,
    onLost,
    onRestored,
    snapshotIntervalMs = 2000,
    now = Date.now,
  } = cfg;

  /** @type {any} */
  let lastShadow = null;
  let lastSnapAt = 0;
  let lost = false;

  /** Refresh the shadow if the cadence has elapsed. Call once per frame; it's
   *  cheap because it no-ops between intervals. */
  function maybeSnapshot() {
    if (lost) return;
    const t = now();
    // Always establish a shadow on the first call (none exists yet at startup);
    // afterwards, only refresh on the coarse cadence.
    if (lastShadow === null || t - lastSnapAt >= snapshotIntervalMs) {
      lastShadow = snapshot();
      lastSnapAt = t;
    }
  }

  /** Force a snapshot now (e.g. on visibilitychange → hidden). */
  function forceSnapshot() {
    if (lost) return;
    lastShadow = snapshot();
    lastSnapAt = now();
  }

  /** @param {{ preventDefault?: () => void }} [e] */
  function handleLost(e) {
    // Default browser behavior is to NOT fire 'restored' unless loss is
    // preventDefault()-ed. This is the one place that's required.
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    lost = true;
    if (onLost) onLost();
  }

  function handleRestored() {
    restore(lastShadow);
    lost = false;
    lastSnapAt = 0; // force a fresh shadow soon after restore
    if (onRestored) onRestored();
  }

  canvas.addEventListener('webglcontextlost', handleLost, false);
  canvas.addEventListener('webglcontextrestored', handleRestored, false);

  return {
    maybeSnapshot,
    forceSnapshot,
    isLost: () => lost,
    /** test/inspection hook */
    _shadow: () => lastShadow,
    dispose() {
      canvas.removeEventListener('webglcontextlost', handleLost, false);
      canvas.removeEventListener('webglcontextrestored', handleRestored, false);
    },
  };
}
