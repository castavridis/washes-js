// gpu-sync.test.cjs — drift guard for the duplicated GPU sim.
//
// The WebGL2 sim exists twice on purpose (CHANGELOG 1.0.1): embedded inside
// washes.js (single-file deployment) AND as the standalone washes/gpu-sim
// entry. Until the extraction work single-sources them behind a build step
// (ENGINE_REVIEW P1#6), this test keeps the copies honest: every shader in
// washes-gpu-sim.js must appear byte-identical in washes.js. Shaders are
// where drift actually bites — the 1.0.1 texture-parity work rewrote them —
// so an edit to one copy without the other fails CI here.
//
// Scope note: this guards the shader sources and the initGpuSim entry, not
// every line of the surrounding factory. Full single-sourcing replaces this
// test; do not "fix" a failure by allowlisting — port the edit to both
// copies (or land the extraction).
//
// Run: node tests/gpu-sync.test.cjs

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const standalone = fs.readFileSync(path.join(SRC, 'washes-gpu-sim.js'), 'utf8');
const embedded = fs.readFileSync(path.join(SRC, 'washes.js'), 'utf8');

// Shader declarations are single-line: const nameFrag = "...escaped...";
const SHADER_RE = /const (\w+(?:Frag|Vert)) = ("(?:[^"\\]|\\.)*");/g;

function shaderMap(src, label) {
  const map = new Map();
  for (const m of src.matchAll(SHADER_RE)) {
    if (map.has(m[1]) && map.get(m[1]) !== m[2]) {
      console.error(`✗ ${label}: shader ${m[1]} declared twice with DIFFERENT content`);
      process.exitCode = 1;
    }
    map.set(m[1], m[2]);
  }
  return map;
}

const sim = shaderMap(standalone, 'washes-gpu-sim.js');
const emb = shaderMap(embedded, 'washes.js');

let failed = false;

if (sim.size === 0) {
  console.error('✗ no shaders found in washes-gpu-sim.js — extraction regex broken?');
  failed = true;
}

for (const [name, body] of sim) {
  if (!emb.has(name)) {
    console.error(`✗ shader ${name} exists in washes-gpu-sim.js but not in washes.js`);
    failed = true;
  } else if (emb.get(name) !== body) {
    // locate first difference for a useful message
    const a = body, b = emb.get(name);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.error(`✗ shader ${name} DIFFERS between the copies (first divergence at char ${i}):`);
    console.error(`    gpu-sim: …${a.slice(Math.max(0, i - 30), i + 30)}…`);
    console.error(`    washes:  …${b.slice(Math.max(0, i - 30), i + 30)}…`);
    failed = true;
  }
}

for (const of of ['function initGpuSim(']) {
  if (!standalone.includes(of)) { console.error(`✗ washes-gpu-sim.js lost ${of}`); failed = true; }
  if (!embedded.includes(of)) { console.error(`✗ washes.js lost the embedded ${of}`); failed = true; }
}

const renderOnly = [...emb.keys()].filter((k) => !sim.has(k));
console.log(`gpu-sync: ${sim.size} sim shaders checked byte-identical; ` +
  `${renderOnly.length} additional shaders in washes.js are render-path-only (${renderOnly.join(', ') || 'none'})`);

if (failed) process.exit(1);
console.log('gpu-sync: OK — the duplicated GPU sim copies match');
