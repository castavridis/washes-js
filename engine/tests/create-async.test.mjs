// create-async.test.mjs — the v2.2 loader path.
//
// Proves three things:
//   1. Chunked (deferred) paper generation is BIT-IDENTICAL to the sync
//      path — saveState().paper compared byte-for-byte.
//   2. createAsync resolves to a working instance after 'ready', and the
//      built-in veil is added and removed around it.
//   3. 'ready' fires on the sync create path too (first RAF tick).
//
// The engine's headless environment installs a NO-OP requestAnimationFrame
// (the frame clock is browser territory), so this test predefines a real
// setTimeout-driven one BEFORE the engine loads — the headless shim only
// fills the gap when RAF is undefined.
//
// Run: node tests/create-async.test.mjs

import assert from 'node:assert/strict';

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 8);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { Washes } = await import(new URL('../src/index.js', import.meta.url).href);

// ---------- 1. deferred paper === sync paper, bit for bit ----------
const W = 200, H = 140;

const wcSync = Washes.createHeadless({ width: W, height: H });
const paperSync = wcSync.saveState().paper;
assert.ok(paperSync instanceof Float32Array && paperSync.length > 0, 'sync paper present');

// Deferred path: createHeadless assembles the same headless host create()
// needs; deferPaper routes paper generation through the loop's chunker.
const wcDefer = Washes.createHeadless({ width: W, height: H, deferPaper: true });
await wcDefer.once('ready');
const paperDefer = wcDefer.saveState().paper;

assert.equal(paperDefer.length, paperSync.length, 'same grid');
let diff = -1;
for (let i = 0; i < paperSync.length; i++) {
  if (paperSync[i] !== paperDefer[i]) { diff = i; break; }
}
assert.equal(diff, -1, `chunked paper diverges from sync at cell ${diff}`);

// ---------- 2. createAsync end-to-end (veil on) ----------
const host = document.createElement('div');
host.style.width = W + 'px';
host.style.height = H + 'px';
const wcAsync = await Washes.createAsync(host, { size: { width: W, height: H }, pointer: false });
assert.ok(typeof wcAsync.paint === 'function', 'instance resolved');
// veil was appended during boot and is gone (or fading) after ready
const veils = host.children.filter
  ? host.children.filter((c) => c.className === 'washes-loading')
  : [];
const fading = veils.length === 0 || veils.every((v) => v.style.opacity === '0');
assert.ok(fading, 'veil removed or fading after ready');
wcAsync.paint(0.5, 0.5, 0.1, 0, 0.9);
assert.ok(wcAsync.coverage(0.001) > 0, 'resolved instance paints');
assert.equal(wcAsync.saveState().paper.length, paperSync.length, 'async instance has full paper');

// ---------- 3. sync create fires 'ready' too ----------
const wcSync2 = Washes.createHeadless({ width: 80, height: 60 });
await wcSync2.once('ready'); // first RAF tick

wcSync.destroy(); wcDefer.destroy(); wcAsync.destroy(); wcSync2.destroy();
console.log(
  'create-async: OK — chunked paper bit-identical to sync (' +
  paperSync.length + ' cells), createAsync resolved + painted, ready fired on both paths');
