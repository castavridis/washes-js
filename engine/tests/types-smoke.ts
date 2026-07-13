// Type-only smoke test for washes.d.ts. This file is not shipped — it's
// here to verify the declarations compile cleanly under realistic consumer
// usage. Run via:
//   tsc --noEmit --strict tests/types-smoke.ts
//
// If this compiles without errors, the public API surface is correctly
// typed.

import { Washes } from '../src/washes';
import type {
  WashesInstance,
  CreateOptions,
  EdgeMode,
  GravityDirection,
  PigmentOption,
  SplashEpicenter,
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

// --- Painting ---
const splashes: SplashEpicenter[] = [
  { x: 100, y: 100 },
  { x: 200, y: 200, velocity: 50 },
];
wc.splash(splashes, 'deluge');
wc.splash([{ x: 0, y: 0 }], 'default', { radius: 200, pressure: 30 });

// --- Pigment selection ---
const p1: PigmentOption = 0;
const p2: PigmentOption = 'rose';
const p3: PigmentOption = 'water';
wc.pigment(p1);
wc.pigment(p2);
wc.pigment(p3);

// --- Edge boundary modes ---
const mode: EdgeMode = 'gravity';
wc.edgeMode(mode);

const dir: GravityDirection = 'radial';
wc.gravityDirection(dir);

wc.gravityStrength(0.10);
wc.velocityClamp(2.5);
wc.velocityClamp(null);  // restore auto

// --- SVG tracing returns the total point count synchronously ---
async function example() {
  const svg = '<svg>...</svg>';
  const points: number = wc.traceSVG(svg, { durationMs: 1500, pigment: 'rose' });
  console.log('will paint ' + points + ' points');
  // v0.90: animate: false renders the SVG instantly with no animation
  wc.traceSVG(svg, { animate: false, pigment: 'blue' });
  const dataUrl: string = wc.exportPNG();
  console.log(dataUrl.length);
  const blob = await wc.exportPNG({ asBlob: true });
  console.log(blob.size);
}
example();

// --- Preset round-trip ---
const preset: Preset = wc.getPreset();
const copy = Washes.create(hostElement);
copy.applyPreset(preset);

// --- Chained calls (only "verb" methods like splash, setBackground,
//     pigment, removeMask return the instance; setters that return the
//     new value (most of them) don't chain) ---
wc.pigment('blue')
  .setBackground('sunset')
  .splash([{ x: 100, y: 100 }], 'deluge');

// --- Reading values ---
const currentMode: EdgeMode = wc.edgeMode();
const currentBrush: number = wc.brushSize();
const isWebGL: boolean = wc.webgl();

// --- v0.88: edge fade ---
wc.edgeFade(24);
const fade: number = wc.edgeFade();

// --- v0.89: quality presets and background ---
import type { QualityPreset, QualityHint } from '../src/washes';

const qPreset: QualityPreset = 'low';
wc.quality(qPreset);
const currentQ: QualityPreset | null = wc.quality();

const hint: QualityHint = 'auto-mobile';
const wcMobile = Washes.create(hostElement, { qualityHint: hint });

wc.background('linear-gradient(180deg, #fef3c7, #ddd6fe)');
wc.background('#1a1a1a');
wc.background(null);
const bg: string = wc.background();

// --- v0.90: pause / resume ---
// --- v1.24: typed event map + once() ---
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
  const preset = await wc.once('presetapplied');
  copy.applyPreset(preset.preset);
}
eventExample();

import type { PausedState } from '../src/washes';

wc.pause();
wc.pause({ acceptInput: true });
const pauseState: PausedState = wc.paused();
if (pauseState) {
  const accepting: boolean = pauseState.acceptInput;
  console.log('paused, acceptInput =', accepting);
}
wc.resume();

// --- Window global also typed ---
if (typeof window !== 'undefined') {
  const wc3 = window.Washes.create(hostElement);
  wc3.destroy();
}

// --- Error cases that SHOULD fail compilation (commented out — uncomment
//     and re-run to verify the type system catches them) ---

// @ts-expect-error — invalid edge mode
wc.edgeMode('floppy');

// @ts-expect-error — splash needs an array of epicenters
wc.splash({ x: 0, y: 0 }, 'deluge');

// @ts-expect-error — brushSize takes a number
wc.brushSize('big');

// @ts-expect-error — unknown direction
wc.gravityDirection('northwest');

// --- v0.98: texture brush modes + dry dynamics ---
import type { BrushMode, HeatmapColor } from '../src/washes';

const bm: BrushMode = 'crayon';
wc.brushMode(bm);
wc.brushMode('splatter');
wc.brushMode('dryBrush');
const currentBrushMode: BrushMode = wc.brushMode();

wc.dryness(0.6);
wc.dryPaperReject(0.4);
wc.dryAnisotropy(0.8);
wc.dryBrushSkip(0.3);
const drynessNow: number = wc.dryness();

// --- v0.86: wetness heatmap overlay (all three call forms) ---
const lo: HeatmapColor = [0, 24, 51];
const hi: HeatmapColor = '#66ccff';
wc.wetnessHeatmap(true, lo, hi);
wc.wetnessHeatmap({ enabled: true, low: lo, high: hi });
const heatmapOn: boolean = wc.wetnessHeatmap();

// @ts-expect-error — invalid brush mode
wc.brushMode('sponge');

export {}; // make this a module
