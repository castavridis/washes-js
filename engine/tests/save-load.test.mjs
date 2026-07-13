// save-load.test.mjs — saveState()/loadState() round-trip (v1.22).
//
// The painting must survive bit-exactly: paint, simulate, save, wreck the
// canvas, load — and every field byte matches the moment of saving. Also
// proves cross-instance restore (same dims) and the loud dims-mismatch and
// bad-snapshot edges.
//
// Run: node tests/save-load.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installMockDOM, seedMathRandom } = require('./dom-shim.cjs');

installMockDOM();
seedMathRandom(0xABCDEF);

const here = path.dirname(url.fileURLToPath(import.meta.url));
const { Washes } = await import(url.pathToFileURL(path.join(here, '..', 'src', 'index.js')).href);

const wc = Washes.createHeadless({ width: 320, height: 240 });
wc.paintNorm(0.4, 0.5, 0.08, 0, 0.9);
wc.paintNorm(0.6, 0.4, 0.05, 2, 0.8);
wc.paintAt(80, 60, 8, 'mask', 0.9);

const snap = wc.saveState();
assert.equal(snap.format, 'washes-state@1');
assert.ok(snap.fluid instanceof Float32Array && snap.fluid.length === snap.GW * snap.GH * 4);

const covAtSave = wc.coverage(0.001);
assert.ok(covAtSave > 0, 'painted before saving');

// wreck the canvas, then restore
wc.clearPaint();
assert.equal(wc.coverage(0.001), 0, 'clearPaint wiped the painting');
wc.loadState(snap);
assert.equal(wc.coverage(0.001), covAtSave, 'coverage restored exactly');

const snap2 = wc.saveState();
for (const plane of ['fluid', 'pigment', 'deposit', 'paper']) {
  assert.equal(Buffer.compare(Buffer.from(snap[plane].buffer), Buffer.from(snap2[plane].buffer)), 0,
    `${plane} round-trips bit-exactly`);
}

// cross-instance restore (same dims)
const wc2 = Washes.createHeadless({ width: 320, height: 240 });
wc2.loadState(snap);
assert.equal(wc2.coverage(0.001), covAtSave, 'second instance shows the same painting');

// loud edges
assert.throws(() => wc.loadState({ format: 'nope' }), /washes-state@1/, 'bad snapshot fails loud');
const wc3 = Washes.createHeadless({ width: 200, height: 150 });
assert.throws(() => wc3.loadState(snap), /does not match/, 'dims mismatch fails loud');

wc.destroy(); wc2.destroy(); wc3.destroy();
console.log(`save-load: OK — painting round-trips bit-exactly ` +
  `(coverage ${covAtSave.toFixed(5)}, ${snap.GW}×${snap.GH}, cross-instance restore verified)`);
