// compat-surface.test.mjs — the v1-compat contract (v1.25 scaffolding).
//
// tests/v1-surface.snapshot.json is the frozen definition of "the v1
// surface". This test asserts Washes.compat1(create()) exposes every
// member in it, with the recorded typeof. Today compat1 is a documented
// passthrough (the instance IS v1), so this is trivially green; when the
// 2.0 rename batch lands, compat1 becomes a real adapter and this test is
// what keeps the shim complete until 3.0.
//
// Run: node tests/compat-surface.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeEl, installMockDOM, seedMathRandom } = require('./dom-shim.cjs');

installMockDOM();
seedMathRandom(1);

const here = path.dirname(url.fileURLToPath(import.meta.url));
const { Washes } = await import(url.pathToFileURL(path.join(here, '..', 'src', 'index.js')).href);

const snapshot = JSON.parse(fs.readFileSync(path.join(here, 'v1-surface.snapshot.json'), 'utf8'));
const wrapped = Washes.compat1(Washes.create(makeEl('div')));

const missing = [];
const wrongType = [];
for (const [name, type] of Object.entries(snapshot.members)) {
  if (typeof wrapped[name] === 'undefined') missing.push(name);
  else if (typeof wrapped[name] !== type) wrongType.push(`${name} (${typeof wrapped[name]} ≠ ${type})`);
}
assert.deepEqual(missing, [], `compat1 surface is missing v1 members: ${missing.join(', ')}`);
assert.deepEqual(wrongType, [], `compat1 members changed type: ${wrongType.join(', ')}`);

// Loud edge: compat1 of not-an-instance.
assert.throws(() => Washes.compat1(null), /compat1/, 'compat1(null) throws');
assert.throws(() => Washes.compat1('wc'), /compat1/, 'compat1(string) throws');

console.log(`compat-surface: OK — compat1() exposes all ${snapshot.memberCount} v1 members ` +
  `(snapshot from ${snapshot.capturedAtVersion})`);
