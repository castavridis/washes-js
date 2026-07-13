// api-surface.test.mjs — keeps washes.d.ts honest mechanically.
//
// The declarations drifted from the runtime three documented times before
// this test existed (see docs/FIXES.md and ENGINE_REVIEW P0#5). This test
// reflects over a real instance and diffs its members against the
// WashesInstance interface in src/washes.d.ts:
//   - a runtime member missing from the d.ts fails (undeclared API), unless
//     it is listed in KNOWN_UNDECLARED — the frozen, pre-existing debt.
//     Shrinking that list is welcome; growing it fails.
//   - a declared member missing from the runtime always fails (phantom API).
//
// Run: node tests/api-surface.test.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const { makeEl, installMockDOM, seedMathRandom } = require('./dom-shim.cjs');

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

installMockDOM();
seedMathRandom(1);

// Import the real ESM entry (also proves index.js resolves in bare Node).
const { Washes } = await import(url.pathToFileURL(path.join(SRC, 'index.js')).href);
const inst = Washes.create(makeEl('div'));

const runtime = new Set(Object.keys(inst));

// ---- parse the WashesInstance interface out of the d.ts ----
const dts = fs.readFileSync(path.join(SRC, 'washes.d.ts'), 'utf8');
const start = dts.indexOf('export interface WashesInstance');
if (start < 0) { console.error('✗ could not find WashesInstance in washes.d.ts'); process.exit(1); }
const close = dts.indexOf('\n}', start);
const body = dts.slice(dts.indexOf('{', start) + 1, close);

const declared = new Set();
for (const line of body.split('\n')) {
  // members are declared at 2-space indent: `name(...)`, `name: T`,
  // `readonly name: T`, `name<T>(...)`. Comment/JSDoc lines never match.
  const m = /^ {2}(?:readonly\s+)?([a-zA-Z_$][\w$]*)\s*[(:<?]/.exec(line);
  if (m && m[1] !== 'new') declared.add(m[1]);
}

// ---- frozen pre-existing debt (v1.12.1 era). Do not add to this list —
// declare new API in washes.d.ts instead. Removing entries (by declaring
// them) is the direction this list is supposed to move.
const KNOWN_UNDECLARED = new Set([
]);

const undeclared = [...runtime].filter((k) => !declared.has(k) && !KNOWN_UNDECLARED.has(k)).sort();
const phantom = [...declared].filter((k) => !runtime.has(k)).sort();
const staleAllow = [...KNOWN_UNDECLARED].filter((k) => declared.has(k) || !runtime.has(k)).sort();

let failed = false;
if (undeclared.length) {
  failed = true;
  console.error(`✗ runtime members missing from washes.d.ts (${undeclared.length}):`);
  for (const k of undeclared) console.error(`    ${k}${typeof inst[k] === 'function' ? '()' : ''}`);
}
if (phantom.length) {
  failed = true;
  console.error(`✗ declared in washes.d.ts but missing from the runtime (${phantom.length}):`);
  for (const k of phantom) console.error(`    ${k}`);
}
if (staleAllow.length) {
  failed = true;
  console.error(`✗ KNOWN_UNDECLARED entries that are stale (now declared or gone): ${staleAllow.join(', ')}`);
}

console.log(`api-surface: runtime ${runtime.size} members, declared ${declared.size}, allowlisted ${KNOWN_UNDECLARED.size}`);
if (failed) process.exit(1);
console.log('api-surface: OK — d.ts matches the runtime surface');
