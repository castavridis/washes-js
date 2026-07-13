// events.test.mjs — the unified event surface (v1.24).
//
// API 2.0 sequencing item 3, additive half: every event that previously
// fired only as a DOM CustomEvent now also comes through on() under its
// all-lowercase name, once(name) resolves with the next detail, and the
// DOM CustomEvents keep firing untouched (they become declared mirrors in
// 2.0). Also guards the two fixes this slice made: on('rescale') fires on
// EVERY grid rebuild (scale() included, not just host remeasures), and the
// governor's off-switch emits level 'full', not the pre-v1.8 'high'.
//
// Run: node tests/events.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeEl, installMockDOM, seedMathRandom } = require('./dom-shim.cjs');

installMockDOM();
seedMathRandom(0xE7E75);

const here = path.dirname(url.fileURLToPath(import.meta.url));
const { Washes } = await import(url.pathToFileURL(path.join(here, '..', 'src', 'index.js')).href);

const host = makeEl('div');
const wc = Washes.create(host);

const got = {};                 // on() firings, name → [detail, ...]
const dom = {};                 // DOM CustomEvent firings, type → [detail, ...]
const track = (name) => wc.on(name, (d) => (got[name] = got[name] || []).push(d));
const trackDom = (type) => host.addEventListener(type, (ev) => (dom[type] = dom[type] || []).push(ev.detail));

for (const n of ['rescale', 'palettechange', 'gouachechange', 'cursorpreviewchange', 'presetapplied', 'driedinstantly']) track(n);
for (const t of ['rescaled', 'paletteChange', 'pigmentchange', 'gouachechange', 'cursorpreviewchange', 'presetapplied', 'driedinstantly']) trackDom(t);

// --- palettechange (+ the v1.12.1 dual-fire and the camelCase DOM mirror) ---
const oncePalette = wc.once('palettechange');
wc.palette([{ color: '#336699' }, { color: '#996633' }, { color: '#339966' }]);
assert.equal(got.palettechange?.length, 1, "on('palettechange') fired");
assert.equal(got.palettechange[0].custom, true, 'detail says custom palette');
assert.equal(dom.paletteChange?.length, 1, 'DOM paletteChange (camelCase, v1 spelling) still fires');
assert.equal(dom.pigmentchange?.length, 1, 'v1.12.1 pigmentchange dual-fire still fires');
assert.equal((await oncePalette).custom, true, 'once() resolved with the detail');

wc.palette(null);
assert.equal(got.palettechange.length, 2, 'palette(null) fires too');
assert.equal(got.palettechange[1].custom, false, 'detail says stock palette');

// --- gouachechange ---
wc.gouacheMode(true);
assert.equal(got.gouachechange?.length, 1, "on('gouachechange') fired");
assert.equal(got.gouachechange[0].enabled, true, 'detail carries the mode');
assert.equal(typeof got.gouachechange[0].lerpAmount, 'number', 'detail carries lerpAmount');
assert.deepEqual(dom.gouachechange[0], got.gouachechange[0], 'DOM mirror carries the same detail');

// --- cursorpreviewchange ---
wc.cursorPreview(false);
assert.equal(got.cursorpreviewchange?.[0]?.enabled, false, "on('cursorpreviewchange') fired with detail");
assert.equal(dom.cursorpreviewchange?.length, 1, 'DOM mirror fired');

// --- presetapplied ---
wc.applyPreset(wc.getPreset());
assert.equal(got.presetapplied?.length, 1, "on('presetapplied') fired");
assert.ok(got.presetapplied[0].preset && typeof got.presetapplied[0].preset === 'object', 'detail carries the preset');

// --- driedinstantly ---
wc.paintNorm(0.5, 0.5, 0.06, 0, 0.9);
wc.dry();
assert.equal(got.driedinstantly?.length, 1, "on('driedinstantly') fired");
assert.equal(dom.driedinstantly?.length, 1, 'DOM mirror fired');

// --- rescale now covers every rebuild: scale() was DOM-only before ---
const before = got.rescale?.length || 0;
wc.scale(wc.scale() + 0.25, { preserve: true });
assert.equal((got.rescale?.length || 0) - before, 1, "on('rescale') fires from scale()");
const r = got.rescale[got.rescale.length - 1];
assert.ok(r.scale > 0 && r.gridWidth > 0 && r.gridHeight > 0, 'rescale detail: {scale, gridWidth, gridHeight}');
assert.equal(dom.rescaled.length, got.rescale.length, 'DOM rescaled and on(rescale) fire 1:1');

// --- once() unsubscribes after one firing ---
let onceCount = 0;
wc.once('cursorpreviewchange').then(() => onceCount++);
wc.cursorPreview(true);
wc.cursorPreview(false);
await new Promise((res) => setTimeout(res, 0));
assert.equal(onceCount, 1, 'once() fired exactly once across two events');

// --- once() validates like on() ---
assert.throws(() => wc.once(42), /once\(name\)/, 'non-string event name throws');

// --- the governor's off-switch emits the post-v1.8 level name ---
assert.equal(wc.perfLevel(), 'full', "perfLevel() reads 'full' at base resolution");

wc.destroy();
console.log('events: OK — 6 DOM-only events unified through on(), once() resolves ' +
  'and detaches, rescale covers scale() rebuilds, DOM mirrors untouched');
