#!/usr/bin/env node
// ============================================================
// sync-gpu.cjs — single-sources the GPU sim.
//
// The WebGL2 sim ships twice on purpose (see CHANGELOG 1.0.1):
// as the standalone `washes/gpu-sim` entry AND embedded inside
// washes.js so the core library stays one self-contained file.
// washes-gpu-sim.js is the SOURCE OF TRUTH; this script rebuilds
// the embedded block between the GPU-SIM SYNC sentinels from it.
//
//   node scripts/sync-gpu.cjs           # rewrite washes.js in place
//   node scripts/sync-gpu.cjs --check   # exit 1 if out of sync (CI)
//
// The transform: take everything in washes-gpu-sim.js after its
// `"use strict";` line up to and including the "Global attachment"
// rule line (the shared core), and wrap it as
//   const __gpuSim = (function () { "use strict"; <core>
//   return initGpuSim; })();
// — the embedded form returns the factory instead of attaching
// window.WashesGpuSim.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const SIM_PATH = path.join(SRC, 'washes-gpu-sim.js');
const LIB_PATH = path.join(SRC, 'washes.js');

const BEGIN = '  // >>> GPU-SIM SYNC BEGIN';
const END = '  // <<< GPU-SIM SYNC END';
const ATTACH_MARKER = '// ─── Global attachment ';

const sim = fs.readFileSync(SIM_PATH, 'utf8');
const lib = fs.readFileSync(LIB_PATH, 'utf8');

// ---- extract the shared core from the standalone module ----
const strictAt = sim.indexOf('"use strict";\n');
if (strictAt < 0) fail('washes-gpu-sim.js: no "use strict"; line');
const coreStart = strictAt + '"use strict";\n'.length;
const attachAt = sim.indexOf(ATTACH_MARKER, coreStart);
if (attachAt < 0) fail('washes-gpu-sim.js: no "Global attachment" rule line');
const attachLineEnd = sim.indexOf('\n', attachAt);
const core = sim.slice(coreStart, attachLineEnd + 1);

// ---- build the embedded form ----
const embedded =
  BEGIN + ' — this block is generated from washes-gpu-sim.js\n' +
  '  // by scripts/sync-gpu.cjs. Edit THAT file, then run `npm run sync:gpu`;\n' +
  '  // CI fails if the copies drift (sync-gpu --check + tests/gpu-sync.test.cjs).\n' +
  '  const __gpuSim = (function () {\n' +
  '  "use strict";\n' +
  core +
  '  return initGpuSim;\n' +
  '  })();\n' +
  END;

// ---- splice between sentinels ----
const b = lib.indexOf(BEGIN);
const e = lib.indexOf(END);
if (b < 0 || e < 0 || e < b) fail('washes.js: GPU-SIM SYNC sentinels missing or malformed');
const next = lib.slice(0, b) + embedded + lib.slice(e + END.length);

if (process.argv.includes('--check')) {
  if (next !== lib) {
    console.error('sync-gpu: OUT OF SYNC — the embedded GPU sim in washes.js does not match');
    console.error('washes-gpu-sim.js. Edit washes-gpu-sim.js (the source of truth), then run:');
    console.error('  npm run sync:gpu');
    process.exit(1);
  }
  console.log('sync-gpu: in sync — embedded block matches washes-gpu-sim.js');
} else if (next === lib) {
  console.log('sync-gpu: already in sync — washes.js unchanged');
} else {
  fs.writeFileSync(LIB_PATH, next);
  console.log('sync-gpu: embedded GPU sim regenerated from washes-gpu-sim.js');
}

function fail(msg) {
  console.error('sync-gpu: ' + msg);
  process.exit(1);
}
