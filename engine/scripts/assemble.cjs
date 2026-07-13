#!/usr/bin/env node
// ============================================================
// assemble.cjs — the incremental extraction's build step.
//
// Sections of washes.js live as source-of-truth fragments in
// src/parts/*.part.js and are spliced verbatim into washes.js
// between PART sentinels (same model as scripts/sync-gpu.cjs,
// which handles the GPU block's wrapper transform). washes.js
// stays a fully self-contained, directly loadable file — the
// parts are where you EDIT.
//
//   node scripts/assemble.cjs           # rewrite washes.js in place
//   node scripts/assemble.cjs --check   # exit 1 if out of sync (CI)
//
// Parts are verbatim closure fragments today (same scope, same
// semantics, zero transform); individual parts graduate to real
// modules as the extraction proceeds (ENGINE_REVIEW P1#6).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const LIB_PATH = path.join(SRC, 'washes.js');
const PARTS_DIR = path.join(SRC, 'parts');

// mode 'verbatim': closure fragment spliced as-is (2-line BEGIN comment).
// mode 'esm-inline': a real ES module whose `export function createSimCore`
// is inlined as `const createSimCore = (function () { … })();` — the module
// file is also importable directly (washes/sim-core npm entry).
const PARTS = [
  { name: 'pigment-data', file: () => path.join(PARTS_DIR, 'pigment-data.part.js'), mode: 'verbatim' },
  { name: 'sim-core', file: () => path.join(SRC, 'washes-sim-core.js'), mode: 'esm-inline' },
  { name: 'sim-backend', file: () => path.join(PARTS_DIR, 'sim-backend.part.js'), mode: 'verbatim' },
];

let lib = fs.readFileSync(LIB_PATH, 'utf8');
const original = lib;

for (const part of PARTS) {
  const partPath = part.file();
  if (!fs.existsSync(partPath)) fail(`missing part file: ${path.relative(path.join(SRC, '..'), partPath)}`);
  let content = fs.readFileSync(partPath, 'utf8');
  if (content.endsWith('\n')) content = content.slice(0, -1);

  const beginMark = `    // >>> PART ${part.name} BEGIN`;
  const endMark = `    // <<< PART ${part.name} END`;
  const b = lib.indexOf(beginMark);
  const e = lib.indexOf(endMark);
  if (b < 0 || e < 0 || e < b) fail(`sentinels for part "${part.name}" missing or malformed in washes.js`);

  let block;
  if (part.mode === 'esm-inline') {
    if (!content.includes('export function createSimCore')) fail(`${part.name}: expected export function createSimCore`);
    block =
      beginMark + ` — assembled from src/${path.basename(partPath)};\n` +
      '    // edit THAT file, then run `npm run assemble` (CI enforces --check).\n' +
      '    // Graduated to a real ES module — see the file header for the\n' +
      '    // ownership contract (host owns state; core snapshots via env).\n' +
      '  const createSimCore = (function () {\n' +
      content.replace('export function createSimCore', 'function createSimCore') + '\n' +
      '  return createSimCore;\n' +
      '  })();\n';
  } else {
    // keep the two-line BEGIN sentinel comment, replace everything after it
    const afterBegin = lib.indexOf('\n', lib.indexOf('\n', b) + 1) + 1;
    lib = lib.slice(0, afterBegin) + content + '\n' + lib.slice(e);
    continue;
  }
  lib = lib.slice(0, b) + block + lib.slice(e);
}

if (process.argv.includes('--check')) {
  if (lib !== original) {
    console.error('assemble: OUT OF SYNC — washes.js does not match src/parts/*.part.js.');
    console.error('Edit the part files (the source of truth), then run: npm run assemble');
    process.exit(1);
  }
  console.log(`assemble: in sync — ${PARTS.length} parts match washes.js`);
} else if (lib === original) {
  console.log('assemble: already in sync — washes.js unchanged');
} else {
  fs.writeFileSync(LIB_PATH, lib);
  console.log(`assemble: washes.js reassembled from ${PARTS.length} parts`);
}

function fail(msg) {
  console.error('assemble: ' + msg);
  process.exit(1);
}
