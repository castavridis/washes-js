// Type-only smoke test for washes.d.ts (the v2 surface, engine 2.0.0).
// This file is not shipped — it verifies the declarations compile cleanly
// under realistic consumer usage. Run via:
//   tsc --noEmit --strict tests/types-smoke.ts
//
// If this compiles without errors, the public API surface is correctly
// typed.

import { Washes } from '../src/washes';
import type {
  WashesInstance,
  WashesV1Compat,
  CreateOptions,
  EdgeMode,
  GravityDirection,
  PigmentOption,
  SplashEpicenterNorm,
  Preset,
} from '../src/washes';

// --- Basic instantiation ---
declare const hostElement: HTMLElement;

const wc: WashesInstance = Washes.create(hostElement);

// With options
const opts: CreateOptions = {
  gouacheMode: 'auto',
  scale: 2,
  cursorPreview: false,
  seed: 42,
};
const wc2 = Washes.create(hostElement, opts);
console.log(wc2.coverage());

// --- Painting: normalized is THE space ---
wc.paint(0.5, 0.5, 0.06, 'blue', 0.8)
  .stroke(0.6, 0.55, { pigment: 'rose' })
  .line(0.1, 0.1, 0.9, 0.9, { strength: 0.5 })
  .penUp()
  .stir(0.5, 0.5, 2, -1, 0.05)
  .rewet(0.3, 0.3, 0.04)
  .lift(0.4, 0.4, 0.05, 0.5)
  .blot(0.6, 0.6, 0.05)
  .dry();

const splashes: SplashEpicenterNorm[] = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.75, radius: 0.1, velocity: 50, pressure: 20 },
];
wc.splash(splashes, 'deluge');
wc.splash('bigSplash', null, { rayCount: 4, jitterAmount: 0.5 });
wc.splash({ coords: splashes, preset: 'fineSpritz' });

// --- The cell-space home ---
const gw: number = wc.grid.width;
const dims = wc.grid.size();
const nPt = wc.grid.toNorm(10, 20);
const gPt = wc.grid.fromNorm(nPt.nx, nPt.ny);
wc.grid.paint(gPt.gx, gPt.gy, 6, 'blue', 0.8).pause();
const fromDisp = wc.grid.fromDisplay(100, 50);
const toDisp = wc.grid.toDisplay(fromDisp.gx, fromDisp.gy);
console.log(gw, dims.gridWidth, toDisp.x, toDisp.y);

// --- Pigment selection ---
const p1: PigmentOption = 0;
const p2: PigmentOption = 'rose';
const p3: PigmentOption = 'water';
wc.pigment(p1);
wc.pigment(p2);
wc.pigment(p3);

// --- Setters chain, getters are zero-arg — universally ---
wc.evaporation(9).flow(0.5).edgeFade(24).dryness(0.6).transparent(false);
const evap: number = wc.evaporation();
const mode: EdgeMode = 'gravity';
wc.edgeMode(mode);
const currentMode: EdgeMode = wc.edgeMode();
const dir: GravityDirection = 'radial';
wc.gravityDirection(dir).gravityStrength(0.10);
wc.velocityClamp(2.5).velocityClamp(null);  // null restores auto
const clamp: number = wc.velocityClamp();
console.log(evap, currentMode, clamp);

// brushSize speaks fractions of the smaller side
wc.brushSize(0.05);
const bs: number = wc.brushSize();
console.log(bs);

// --- Run state: one policy + pause; drying says what it does ---
import type { RunPolicy } from '../src/washes';
const policy: RunPolicy = wc.run();
wc.run('until-dry').run('auto');
console.log(policy);
const dryingOn: boolean = wc.drying();
wc.drying(false).drying(true);
console.log(dryingOn);

// --- set/get unification ---
wc.animation('rainy', { replace: true });
const anim = wc.animation();
wc.animation(null);
wc.visualization('velocity');
wc.visualization(null);
wc.backgroundAnimation('sunset');
const bgAnim: string | null = wc.backgroundAnimation();
const bgRunning: boolean = wc.backgroundAnimationRunning();
console.log(anim, bgAnim, bgRunning);

// --- Preserve-by-default ---
wc.scale(2.5);                    // preserves the painting
wc.scale(1.75, { wipe: true });   // explicit wipe
wc.remeasure();                   // preserves
wc.remeasure({ wipe: true });
const cellScale: number = wc.scale();
console.log(cellScale);

// --- SVG tracing returns the total point count synchronously ---
async function example() {
  const svg = '<svg>...</svg>';
  const points: number = wc.traceSVG(svg, { durationMs: 1500, pigment: 'rose' });
  console.log('will paint ' + points + ' points');
  wc.traceSVG(svg, { animate: false, pigment: 'blue' });
  const dataUrl: string = wc.exportImage();
  console.log(dataUrl.length);
  const blob = await wc.exportImage({ asBlob: true });
  console.log(blob.size);
}
example();

// --- Preset round-trip ---
const preset: Preset = wc.getPreset();
const copy = Washes.create(hostElement);
copy.applyPreset(preset);

// --- Reading values ---
const currentBrush: number = wc.brushSize();
const isWebGL: boolean = wc.webgl();
console.log(currentBrush, isWebGL);

// --- Quality + background (CSS backdrop) ---
import type { QualityPreset, QualityHint } from '../src/washes';
const qPreset: QualityPreset = 'low';
wc.quality(qPreset);
const currentQ: QualityPreset | null = wc.quality();
console.log(currentQ);
const hint: QualityHint = 'auto-mobile';
const wcMobile = Washes.create(hostElement, { qualityHint: hint });
console.log(wcMobile.state());
wc.background('linear-gradient(180deg, #fef3c7, #ddd6fe)');
wc.background('#1a1a1a');
wc.background(null);
const bg: string = wc.background();
console.log(bg);

// --- Typed event map + once() ---
import type { WashesEventMap, PerfLevel } from '../src/washes';

const unIdle = wc.on('idle', (d) => console.log(d.totalWetness));
unIdle();
wc.on('perflevel', (d) => {
  const lvl: PerfLevel = d.level;
  console.log(lvl, d.scale, d.gridWidth);
});
wc.on('palettechange', (d) => console.log(d.custom));
wc.on('gouachechange', (d) => console.log(d.enabled, d.lerpAmount));
async function eventExample() {
  const rescale: WashesEventMap['rescale'] = await wc.once('rescale');
  console.log(rescale.scale, rescale.gridWidth, rescale.gridHeight);
  const applied = await wc.once('presetapplied');
  copy.applyPreset(applied.preset);
}
eventExample();

// --- pause / resume ---
import type { PausedState } from '../src/washes';
wc.pause();
wc.pause({ acceptInput: true });
const pauseState: PausedState = wc.paused();
if (pauseState) {
  const accepting: boolean = pauseState.acceptInput;
  console.log('paused, acceptInput =', accepting);
}
wc.resume();

// --- compat1: the v1 adapter ---
const legacy: WashesV1Compat = Washes.compat1(wc, { warn: false });
legacy.paintAt(40, 30, 6, 'blue', 0.8);
legacy.brushSize(56);              // px diameter, v1 units
const legacyEvap: number = legacy.evaporation(9);
console.log(legacyEvap);

// --- Statics ---
const ver: string = Washes.version;
const coreTier: (keyof WashesInstance)[] = Washes.tiers.core;
console.log(ver, coreTier.length, Washes.brushModes.join(','));

// --- Window global also typed ---
if (typeof window !== 'undefined') {
  const wc3 = window.Washes.create(hostElement);
  wc3.destroy();
}

// --- Error cases that SHOULD fail compilation ---

// @ts-expect-error — invalid edge mode
wc.edgeMode('floppy');

// @ts-expect-error — splash needs an array of epicenters
wc.splash({ x: 0, y: 0 }, 'deluge');

// @ts-expect-error — brushSize takes a number
wc.brushSize('big');

// @ts-expect-error — unknown direction
wc.gravityDirection('northwest');

// @ts-expect-error — paintAt retired from v2 (compat1 has it)
wc.paintAt(40, 30, 6, 'blue', 0.8);

// @ts-expect-error — exportPNG retired from v2 (compat1 has it)
wc.exportPNG();

// @ts-expect-error — value-returning setter forms are gone: setters chain
const evapNum: number = wc.evaporation(9);
console.log(evapNum);

// --- v0.98 texture brush modes + dry dynamics ---
import type { BrushMode, HeatmapColor } from '../src/washes';

const bm: BrushMode = 'crayon';
wc.brushMode(bm);
wc.brushMode('splatter');
wc.brushMode('dryBrush');
const currentBrushMode: BrushMode = wc.brushMode();
console.log(currentBrushMode);

wc.dryness(0.6).dryPaperReject(0.4).dryAnisotropy(0.8).dryBrushSkip(0.3);
const drynessNow: number = wc.dryness();
console.log(drynessNow);

// --- wetness heatmap overlay (all three call forms) ---
const lo: HeatmapColor = [0, 24, 51];
const hi: HeatmapColor = '#66ccff';
wc.wetnessHeatmap(true, lo, hi);
wc.wetnessHeatmap({ enabled: true, low: lo, high: hi });
const heatmapOn: boolean = wc.wetnessHeatmap();
console.log(heatmapOn);

// @ts-expect-error — 'dry' brush-mode alias dropped in 2.0 (use 'crayon')
wc.brushMode('dry');

// @ts-expect-error — invalid brush mode
wc.brushMode('sponge');

export {}; // make this a module
