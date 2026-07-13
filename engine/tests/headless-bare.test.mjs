// headless-bare.test.mjs — proves createHeadless() runs in BARE Node.
//
// Deliberately installs NO DOM shim (unlike every other test): the point is
// that the engine's own _ensureHeadlessEnvironment covers the gap. Guards
// ENGINE_REVIEW P1#7's interim deliverable — "headless" no longer means
// "headless, provided you hand-stub ~100 lines of DOM first."
//
// Run: node tests/headless-bare.test.mjs

import assert from 'node:assert/strict';

assert.equal(typeof document, 'undefined', 'test precondition: bare Node, no DOM shim');

const { Washes } = await import(new URL('../src/index.js', import.meta.url).href);

const wc = Washes.createHeadless({ width: 320, height: 240 });
assert.ok(wc && typeof wc.paint === 'function', 'instance created');

wc.paint(0.5, 0.5, 0.06, 0, 0.9);
wc.paint(0.3, 0.6, 0.04, 2, 0.7);

const cov = wc.coverage(0.001);
assert.ok(cov > 0, `coverage sees the ink (got ${cov})`);

const s = wc.sample(0.5, 0.5);
assert.ok(s && typeof s === 'object', 'sample returns a cell');

const st = wc.state();
assert.ok(st && typeof st === 'object', 'state() works');

const diag = wc.diagnose();
assert.ok(diag && typeof diag === 'object', 'diagnose() works');

wc.destroy();

console.log(`headless-bare: OK — createHeadless ran in bare Node ` +
  `(coverage ${cov.toFixed(5)}, cell keys: ${Object.keys(s).join('/')})`);
