// opaque-canvas.test.mjs — the v2.3 { opaque: true } create option.
//
// Proves four things:
//   1. An opaque instance requests its display 2d context with
//      { alpha: false }; a default instance never does.
//   2. transparent(true) is refused while opaque — the getter stays false.
//   3. background(...) is refused while opaque (it would otherwise silently
//      re-enable transparent mode); the host style is left untouched.
//   4. { transparent: true } passed together with { opaque: true } resolves
//      to opaque (the stricter promise wins).
//
// Run: node tests/opaque-canvas.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const { makeEl, installMockDOM, seedMathRandom } = require('./dom-shim.cjs');

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

installMockDOM();
seedMathRandom(1);

// Record the attributes every canvas 2d context is requested with.
const ctxAttrs = [];
const origCreateElement = global.document.createElement;
global.document.createElement = (t) => {
  const el = origCreateElement(t);
  if (String(t).toLowerCase() === 'canvas') {
    const origGetContext = el.getContext.bind(el);
    el.getContext = (type, attrs) => {
      if (type === '2d') ctxAttrs.push(attrs);
      return origGetContext(type, attrs);
    };
  }
  return el;
};

const { Washes } = await import(url.pathToFileURL(path.join(SRC, 'index.js')).href);

const SIZE = { size: { width: 320, height: 180 }, pointer: false };

// ---------- 1. opaque instance requests { alpha: false } ----------
const wcA = Washes.create(makeEl('div'), { ...SIZE, opaque: true });
assert.ok(
  ctxAttrs.some((a) => a && a.alpha === false),
  'display context requested with { alpha: false }',
);

// (v2 setters return the instance for chaining — assert state via getters.)

// ---------- 2. transparent(true) refused while opaque ----------
assert.equal(wcA.transparent(), false, 'starts non-transparent');
wcA.transparent(true);
assert.equal(wcA.transparent(), false, 'transparent(true) refused — getter still false');

// ---------- 3. background() refused while opaque ----------
const hostB = makeEl('div');
const wcB = Washes.create(hostB, { ...SIZE, opaque: true });
wcB.background('#123456');
assert.equal(wcB.transparent(), false, 'background() did not re-enable transparency');
assert.equal(hostB.style.background || '', '', 'host background left unset');
wcB.background(null);
assert.equal(hostB.style.background || '', '', 'clearing the background still allowed');

// ---------- 4. conflicting options: opaque wins ----------
const wcC = Washes.create(makeEl('div'), { ...SIZE, opaque: true, transparent: true });
assert.equal(wcC.transparent(), false, '{ transparent: true } ignored when opaque');

// ---------- control: default instance keeps an alpha-enabled context ----------
ctxAttrs.length = 0;
const wcD = Washes.create(makeEl('div'), { ...SIZE });
assert.ok(
  !ctxAttrs.some((a) => a && a.alpha === false),
  'default instance never requests { alpha: false }',
);
wcD.transparent(true);
assert.equal(wcD.transparent(), true, 'transparent mode still available by default');

wcA.destroy();
wcB.destroy();
wcC.destroy();
wcD.destroy();

console.log(
  'opaque-canvas: OK — { alpha:false } context, transparency guards, option conflict resolution',
);
