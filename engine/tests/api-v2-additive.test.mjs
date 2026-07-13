// api-v2-additive.test.mjs — the v2 control surface (grown additively in
// 1.25, primary since 2.0.0): run() policies, drying(), the wc.grid
// namespace, normalized-as-default primaries, chaining setters, and the
// 2.0 unit changes. Compat equivalences (v1 call ≡ v2 call, bit-exact)
// live here too, driven through Washes.compat1().
//
// Run: node tests/api-v2-additive.test.mjs

import assert from 'node:assert/strict';

assert.equal(typeof document, 'undefined', 'test precondition: bare Node');

const { Washes } = await import(new URL('../src/index.js', import.meta.url).href);

const wc = Washes.createHeadless({ width: 320, height: 240, seed: 5 });

// --- run(): one policy; the v1 pair is reachable only through compat1 ---
assert.equal(wc.run(), 'auto', 'default policy is auto');
assert.equal(wc.run('until-dry'), wc, 'setter chains');
assert.equal(wc.run(), 'until-dry', 'policy reads back');
assert.equal(wc.runUntilDry, undefined, 'runUntilDry retired from v2');
assert.equal(wc.keepSimulating, undefined, 'keepSimulating retired from v2');
const compat = Washes.compat1(wc, { warn: false });
assert.equal(compat.runUntilDry(), true, 'compat sees the same flag');
compat.keepSimulating(true);
assert.equal(wc.run(), 'always', 'compat writes surface through run()');
wc.run('auto');

// --- drying(): pauseDrying retired; inverse holds through compat ---
assert.equal(wc.drying(), true, 'drying runs by default');
assert.equal(wc.drying(false), wc, 'setter chains');
assert.equal(compat.pauseDrying(), true, 'drying(false) IS pauseDrying(true)');
wc.drying(true);

// --- §4: value-returning setters chain in v2, return values in compat ---
assert.equal(wc.evaporation(9), wc, 'v2 evaporation chains');
assert.equal(wc.flow(0.5), wc, 'v2 flow chains');
assert.equal(compat.flow(0.5), compat.flow(), 'compat flow returns the value, v1-style');
assert.equal(wc.inkPaintLoad, undefined, 'the never-functional ink layer is gone from v2');
assert.equal(wc.edgeMode('closed'), wc, 'v2 edgeMode chains');
assert.equal(wc.edgeMode(), 'closed', 'getter form unchanged');

// --- §1: normalized primaries; grid names live in wc.grid ---
assert.equal(wc.paintNorm, undefined, 'paintNorm retired (it IS paint now)');
assert.equal(wc.paintAt, undefined, 'paintAt retired (grid.paint is the cell home)');
assert.equal(wc.paint(0.5, 0.5, 0.06, 0, 0.9), wc, 'paint chains');
assert.ok(wc.coverage(0.001) > 0, 'paint painted');
const dims = wc.grid.size();
assert.ok(dims.gridWidth > 0 && dims.gridHeight > 0, 'grid.size() reads live dims');
const n = wc.grid.toNorm(dims.gridWidth / 2, dims.gridHeight / 2);
assert.deepEqual(n, { nx: 0.5, ny: 0.5 }, 'toNorm maps center to (0.5, 0.5)');
assert.equal(wc.grid.paint(10, 10, 4, 'blue', 0.7), wc, 'grid.paint chains to the v2 instance');
const gd = wc.grid.fromDisplay(0, 0);
assert.ok(typeof gd.gx === 'number' && typeof gd.gy === 'number', 'grid.fromDisplay bridges');

// v2.1.0 — the grid verb family (v1's grid-space implementations, exactly)
assert.equal(wc.grid.stir(20, 20, 1, 0, 5), wc, 'grid.stir chains');
assert.equal(wc.grid.rewet(20, 20, 5), wc, 'grid.rewet chains');
assert.equal(wc.grid.dry(20, 20, 5), wc, 'grid.dry chains');
assert.ok(typeof wc.grid.sample(20, 20) === 'object', 'grid.sample reads a cell');
{
  const a = Washes.createHeadless({ width: 320, height: 240, seed: 31 });
  const b = Washes.createHeadless({ width: 320, height: 240, seed: 31 });
  a.grid.paint(40, 30, 6, 0, 0.8); a.grid.stir(40, 30, 1.2, -0.4, 8); a.grid.rewet(50, 35, 7); a.grid.dry(30, 25, 6);
  const cb = Washes.compat1(b, { warn: false });
  cb.paintAt(40, 30, 6, 0, 0.8); cb.stir(40, 30, 1.2, -0.4, 8); cb.rewet(50, 35, 7); cb.dry(30, 25, 6);
  const pa = planes2(a.saveState()), pb = planes2(b.saveState());
  pa.forEach((buf, i) => assert.equal(Buffer.compare(buf, pb[i]), 0, `grid verbs ≡ v1 grid calls (plane ${i})`));
  a.destroy(); b.destroy();
}
function planes2(snap) { return ['fluid', 'pigment', 'deposit', 'paper'].map((p) => Buffer.from(snap[p].buffer)); }

// v2 paint ≡ v1 paintNorm, bit-exactly (same seed, same script)
function planes(snap) { return ['fluid', 'pigment', 'deposit', 'paper'].map((p) => Buffer.from(snap[p].buffer)); }
{
  const a = Washes.createHeadless({ width: 320, height: 240, seed: 11 });
  const b = Washes.createHeadless({ width: 320, height: 240, seed: 11 });
  a.paint(0.4, 0.5, 0.05, 2, 0.7);
  Washes.compat1(b, { warn: false }).paintNorm(0.4, 0.5, 0.05, 2, 0.7);
  const pa = planes(a.saveState()), pb = planes(b.saveState());
  pa.forEach((buf, i) => assert.equal(Buffer.compare(buf, pb[i]), 0, `paint ≡ compat paintNorm (plane ${i})`));
  a.destroy(); b.destroy();
}

// --- v2 splash is normalized; compat splash keeps grid epicenters ---
{
  const a = Washes.createHeadless({ width: 320, height: 240, seed: 23 });
  const b = Washes.createHeadless({ width: 320, height: 240, seed: 23 });
  a.paint(0.5, 0.5, 0.08, 0, 0.9);
  b.paint(0.5, 0.5, 0.08, 0, 0.9);
  const { gridWidth: GW, gridHeight: GH } = a.grid.size();
  a.splash([{ x: 0.5, y: 0.5 }], 'bigSplash');
  Washes.compat1(b, { warn: false }).splash([{ x: GW * 0.5, y: GH * 0.5 }], 'bigSplash');
  const pa = planes(a.saveState()), pb = planes(b.saveState());
  pa.forEach((buf, i) => assert.equal(Buffer.compare(buf, pb[i]), 0, `v2 splash ≡ compat grid splash (plane ${i})`));
  a.destroy(); b.destroy();
}

// --- §1: brushSize speaks fractions; compat keeps px diameters exactly ---
wc.brushSize(0.1);
assert.ok(Math.abs(wc.brushSize() - 0.1) < 1e-9, 'fraction round-trips');
compat.brushSize(50);
assert.equal(compat.brushSize(), 50, 'compat px diameter round-trips exactly');

// --- §4: set/get unification + the dropped 'dry' alias ---
assert.equal(wc.setAnimation, undefined, 'setAnimation retired');
assert.equal(wc.animation('rainy'), wc, 'animation(name) chains');
assert.equal(wc.animation(), 'rainy', 'animation() reads back');
wc.animation(null);
assert.equal(wc.animation(), 'off', 'animation(null) clears');
assert.equal(wc.visualization(), 'off', 'visualization() reads');
assert.equal(wc.backgroundAnimation(), null, 'backgroundAnimation() idle → null');
assert.equal(wc.backgroundAnimationRunning(), false, 'not running');
assert.throws(() => wc.brushMode('dry'), /crayon/, "brushMode('dry') throws with the migration hint");
assert.equal(compat.brushMode('dry'), 'dry', 'compat still accepts the alias');
wc.brushMode('wet');

// --- exportImage is the name; exportPNG lives in compat ---
assert.equal(wc.exportPNG, undefined, 'exportPNG retired from v2');
assert.equal(typeof wc.exportImage(), 'string', 'exportImage works');
assert.equal(compat.exportPNG(), wc.exportImage(), 'compat exportPNG ≡ v2 exportImage');

// --- the hidden bridge is invisible to enumeration ---
assert.ok(!Object.keys(wc).some((k) => k.includes('v1internal')), 'symbol bridge not enumerable');
assert.throws(() => Washes.compat1({}), /2\.x instance/, 'compat1 of a foreign object throws');

wc.destroy();
console.log('api-v2-additive: OK — v2 primaries normalized + chaining, retired names gone, ' +
  'paint ≡ paintNorm and splash ≡ grid-splash bit-exact through compat1, ' +
  'units adapt (fraction vs px), set/get unified, dry alias dropped');
