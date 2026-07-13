// seed.test.mjs — create({ seed }) determinism (v1.23).
//
// The sim core is deterministic; the host's randomness (splash epicenters
// and jitter, auto-paint, animations, paper regen timing) goes through the
// instance PRNG when a seed is given. Proof: two same-seed instances given
// the same script produce bit-exact paintings; a different seed diverges;
// bad seeds fail loud; unseeded stays on the live Math.random global.
//
// Runs in BARE Node (no DOM shim), like headless-bare.test.mjs.
//
// Run: node tests/seed.test.mjs

import assert from 'node:assert/strict';

assert.equal(typeof document, 'undefined', 'test precondition: bare Node, no DOM shim');

const { Washes } = await import(new URL('../src/index.js', import.meta.url).href);

// The script every instance replays: a deterministic base painting, then a
// splash with random epicenters AND per-cell jitter — the two heaviest
// consumers of host randomness in one call.
function paintScript(wc) {
  wc.paintNorm(0.4, 0.5, 0.08, 0, 0.9);
  wc.paintNorm(0.6, 0.4, 0.05, 2, 0.8);
  wc.splash('bigSplash', null, { jitterAmount: 1 });
}

function snapshotOf(seed) {
  const wc = Washes.createHeadless({ width: 320, height: 240, seed });
  paintScript(wc);
  const snap = wc.saveState();
  wc.destroy();
  return snap;
}

const a = snapshotOf(42);
const b = snapshotOf(42);
for (const plane of ['fluid', 'pigment', 'deposit', 'paper']) {
  assert.equal(
    Buffer.compare(Buffer.from(a[plane].buffer), Buffer.from(b[plane].buffer)), 0,
    `same seed → ${plane} plane bit-exact`);
}

const c = snapshotOf(7);
assert.notEqual(
  Buffer.compare(Buffer.from(a.fluid.buffer), Buffer.from(c.fluid.buffer)), 0,
  'different seed → different splash (fluid plane diverges)');

// Seeds are folded to uint32 — 42 and 42 + 2^32 collide by contract.
const d = snapshotOf(42 + 4294967296);
assert.equal(
  Buffer.compare(Buffer.from(a.fluid.buffer), Buffer.from(d.fluid.buffer)), 0,
  'seed folds to uint32 (42 + 2^32 ≡ 42)');

// Loud edges: non-number / non-finite seeds are programmer error.
for (const bad of ['42', NaN, Infinity, null]) {
  assert.throws(() => Washes.createHeadless({ width: 64, height: 48, seed: bad }),
    TypeError, `seed ${String(bad)} throws`);
}

// Unseeded instances read the LIVE Math.random global on every draw — even
// one patched after create() (the harness seeds per-pattern this way).
const wcU = Washes.createHeadless({ width: 320, height: 240 });
const origRandom = Math.random;
try {
  let calls = 0;
  Math.random = function () { calls++; return 0.5; };
  wcU.splash('bigSplash', null, { jitterAmount: 1 });
  assert.ok(calls > 0, `unseeded splash drew from the patched global (${calls} calls)`);
} finally {
  Math.random = origRandom;
  wcU.destroy();
}

console.log('seed: OK — same seed bit-exact across all planes, ' +
  'different seed diverges, uint32 folding, loud bad-seed edges, ' +
  'unseeded stays late-bound to Math.random');
