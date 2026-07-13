// dom-shim.cjs — minimal DOM/Canvas mocks for running the Washes lib in Node.
//
// Extracted from washes-test-harness.cjs so other headless tests (API-surface
// reflection, equivalence) can share one shim. None of these stubs do anything
// useful visually — they just satisfy the lib's bootstrap code that touches
// document/window/canvas APIs.

'use strict';

function makeEl(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(),
    nodeName: (tag || 'div').toUpperCase(),
    attributes: {},
    children: [],
    childNodes: [],
    style: {},
    dataset: {},
    parentNode: null,
    parentElement: null,
    width: 1024,
    height: 768,
    _listeners: {},
    ownerSVGElement: null,
    classList: {
      toggle() {}, add() {}, remove() {}, contains() { return false; },
    },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this.attributes, n)
        ? this.attributes[n] : null;
    },
    appendChild(c) {
      this.children.push(c);
      this.childNodes.push(c);
      c.parentNode = this;
      c.parentElement = this;
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    },
    replaceChildren() {
      this.children = [];
      this.childNodes = [];
    },
    addEventListener(t, fn) {
      this._listeners[t] = this._listeners[t] || [];
      this._listeners[t].push(fn);
    },
    removeEventListener() {},
    dispatchEvent(ev) {
      (this._listeners[ev.type] || []).forEach((f) => f(ev));
      return true;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 1080, bottom: 900, width: 1080, height: 900, x: 0, y: 0 };
    },
    toDataURL() { return 'data:image/png;base64,F'; },
    toBlob(cb) { setTimeout(() => cb({ size: 1, type: 'image/png' }), 0); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getContext(t) {
      if (t === 'webgl2') return null;
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {}, fillText() {},
        measureText() { return { width: 50 }; },
        save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        fillStyle: '', strokeStyle: '', font: '',
        textBaseline: '', textAlign: '',
        globalAlpha: 1, globalCompositeOperation: 'source-over',
      };
    },
  };
  return e;
}

function installMockDOM() {
  global.document = {
    _body: makeEl('body'),
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
    getElementById: () => null,
    querySelectorAll: () => [],
    documentElement: { style: { setProperty() {} }, dataset: {} },
  };
  global.document.body = global.document._body;
  global.window = {
    innerWidth: 1080,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener() {},
    location: { search: '' },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false }),
  };
  // navigator and performance became read-only getters on global in Node 20+;
  // defineProperty works where direct assignment doesn't.
  Object.defineProperty(global, 'navigator', {
    value: { maxTouchPoints: 0 },
    configurable: true, writable: true,
  });
  Object.defineProperty(global, 'performance', {
    value: { now: () => Date.now() },
    configurable: true, writable: true,
  });
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};
  global.URLSearchParams = URLSearchParams;
  global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  global.Blob = function () {};
  global.DOMParser = function () {
    return { parseFromString: () => ({ querySelector: () => null, querySelectorAll: () => [] }) };
  };
  global.Image = function () {};
  global.CustomEvent = function (t, o) { this.type = t; this.detail = o && o.detail; };
}

// Deterministic Math.random for reproducible runs. mulberry32 — small, fast,
// good enough for paper noise / splash jitter.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Patch Math.random with a seeded generator; returns a restore function.
function seedMathRandom(seed) {
  const orig = Math.random;
  Math.random = mulberry32(seed);
  return function restore() { Math.random = orig; };
}

module.exports = { makeEl, installMockDOM, seedMathRandom, mulberry32 };
