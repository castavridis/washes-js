// snapshot-v1-surface.mjs — freeze the v1 instance surface for the 2.0
// compat contract.
//
// Writes tests/v1-surface.snapshot.json: the sorted member names of a live
// instance, plus each member's typeof. The compat reflection test
// (tests/compat-surface.test.mjs) asserts Washes.compat1(create()) exposes
// every one of these forever — that file is the definition of "the v1
// surface" that compat1() promises until 3.0.
//
// Re-run ONLY when a 1.x release intentionally adds public API (the
// snapshot should always describe the final v1 surface); the diff belongs
// in the same commit as the API addition.
//
// Run: node scripts/snapshot-v1-surface.mjs

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const here = path.dirname(url.fileURLToPath(import.meta.url));
const { makeEl, installMockDOM, seedMathRandom } = require(path.join(here, '..', 'tests', 'dom-shim.cjs'));

installMockDOM();
seedMathRandom(1);

const { Washes } = await import(url.pathToFileURL(path.join(here, '..', 'src', 'index.js')).href);
const inst = Washes.create(makeEl('div'));

const members = {};
for (const k of Object.keys(inst).sort()) members[k] = typeof inst[k];

const out = path.join(here, '..', 'tests', 'v1-surface.snapshot.json');
fs.writeFileSync(out, JSON.stringify({
  capturedAtVersion: JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version,
  memberCount: Object.keys(members).length,
  members,
}, null, 2) + '\n');
console.log(`v1-surface snapshot written: ${Object.keys(members).length} members → ${path.relative(process.cwd(), out)}`);
