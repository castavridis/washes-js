// api-v2-additive.test.mjs — the v2 control surface that arrived in 1.25
// (API 2.0 tranche 1, all additive): run() policies, drying(), the
// wc.grid namespace, splashNorm, exportImage.
//
// Run: node tests/api-v2-additive.test.mjs

import assert from 'node:assert/strict';

assert.equal(typeof document, 'undefined', 'test precondition: bare Node');

const { Washes } = await import(new URL('../src/index.js', import.meta.url).href);

const wc = Washes.createHeadless({ width: 320, height: 240, seed: 5 });

// --- run(): one policy, cross-consistent with the v1 pair ---
assert.equal(wc.run(), 'auto', 'default policy is auto');
assert.equal(wc.run('until-dry'), wc, 'setter chains');
assert.equal(wc.run(), 'until-dry', 'policy reads back');
assert.equal(wc.runUntilDry(), true, 'v1 twin sees the same flag');
wc.keepSimulating(true);
assert.equal(wc.run(), 'always', 'v1 writes surface through run()');
wc.run('auto');
assert.equal(wc.keepSimulating(), false, 'auto clears keepSimulating');
assert.equal(wc.runUntilDry(), false, 'auto clears runUntilDry');
assert.throws(() => wc.run('forever'), /until-dry/, 'unknown policy throws with the valid names');

// --- drying(): pauseDrying renamed to say what it does ---
assert.equal(wc.drying(), true, 'drying runs by default');
assert.equal(wc.drying(false), wc, 'setter chains');
assert.equal(wc.pauseDrying(), true, 'drying(false) IS pauseDrying(true)');
wc.pauseDrying(false);
assert.equal(wc.drying(), true, 'and the inverse holds');

// --- grid namespace ---
const dims = wc.grid.size();
assert.ok(dims.gridWidth > 0 && dims.gridHeight > 0, 'grid.size() reads live dims');
const st = wc.state();
assert.equal(dims.gridWidth, st.gridWidth ?? dims.gridWidth, 'dims agree with state()');
const n = wc.grid.toNorm(dims.gridWidth / 2, dims.gridHeight / 2);
assert.deepEqual(n, { nx: 0.5, ny: 0.5 }, 'toNorm maps center to (0.5, 0.5)');
const g = wc.grid.fromNorm(0.5, 0.5);
assert.deepEqual(g, { gx: dims.gridWidth / 2, gy: dims.gridHeight / 2 }, 'fromNorm inverts');
assert.equal(wc.grid.paint(g.gx, g.gy, 6, 'blue', 0.8), wc, 'grid.paint chains to the instance');
assert.ok(wc.coverage(0.001) > 0, 'grid.paint painted');

// grid.paint ≡ paintAt, bit-exactly (same seed, same script)
{
  const a = Washes.createHeadless({ width: 320, height: 240, seed: 11 });
  const b = Washes.createHeadless({ width: 320, height: 240, seed: 11 });
  a.paintAt(40, 30, 6, 2, 0.7);
  b.grid.paint(40, 30, 6, 2, 0.7);
  const sa = a.saveState(), sb = b.saveState();
  for (const plane of ['fluid', 'pigment', 'deposit', 'paper']) {
    assert.equal(Buffer.compare(Buffer.from(sa[plane].buffer), Buffer.from(sb[plane].buffer)), 0,
      `grid.paint ≡ paintAt (${plane})`);
  }
  a.destroy(); b.destroy();
}

// --- splashNorm ---
// Coordinate mapping: splashNorm({x:.5,y:.5}) ≡ splash at grid center
// (no radius override → both resolve the preset's radiusPx identically).
{
  const a = Washes.createHeadless({ width: 320, height: 240, seed: 23 });
  const b = Washes.createHeadless({ width: 320, height: 240, seed: 23 });
  a.paintNorm(0.5, 0.5, 0.08, 0, 0.9);
  b.paintNorm(0.5, 0.5, 0.08, 0, 0.9);
  const { gridWidth: GW, gridHeight: GH } = a.grid.size();
  a.splash([{ x: GW * 0.5, y: GH * 0.5 }], 'bigSplash');
  b.splashNorm([{ x: 0.5, y: 0.5 }], 'bigSplash');
  const sa = a.saveState(), sb = b.saveState();
  for (const plane of ['fluid', 'pigment', 'deposit', 'paper']) {
    assert.equal(Buffer.compare(Buffer.from(sa[plane].buffer), Buffer.from(sb[plane].buffer)), 0,
      `splashNorm coords map to splash's grid coords (${plane})`);
  }
  // The normalized radius override has an effect (fraction of smaller side).
  const c = Washes.createHeadless({ width: 320, height: 240, seed: 23 });
  c.paintNorm(0.5, 0.5, 0.08, 0, 0.9);
  c.splashNorm([{ x: 0.5, y: 0.5, radius: 0.1 }], 'bigSplash');
  const sc = c.saveState();
  assert.notEqual(Buffer.compare(Buffer.from(sb.fluid.buffer), Buffer.from(sc.fluid.buffer)), 0,
    'normalized radius override changes the field');
  a.destroy(); b.destroy(); c.destroy();
}

// --- exportImage: same encoder as exportPNG ---
assert.equal(typeof wc.exportImage, 'function', 'exportImage exists');
assert.equal(wc.exportImage(), wc.exportPNG(), 'exportImage() returns byte-identical output');

wc.destroy();
console.log('api-v2-additive: OK — run() policies cross-consistent with the v1 pair, ' +
  'drying() inverts pauseDrying, grid namespace ≡ paintAt bit-exactly, ' +
  'splashNorm maps coords + radius, exportImage ≡ exportPNG');
