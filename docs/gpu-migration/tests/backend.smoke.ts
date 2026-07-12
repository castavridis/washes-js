// backend.smoke.ts — type-only verification of the SimBackend contract.
//   tsc --noEmit --strict tests/backend.smoke.ts
import type {
  SimBackend,
  BrushStamp,
  SimParams,
  SimStateArrays,
  BackendCapabilities,
  BackendChoice,
} from '../backend/sim-backend';

declare const GW: number;
declare const GH: number;

const params: SimParams = {
  DT: 1, viscosity: 0.1, drag: 0.02, velClamp: 2.5, pressureDecay: 0.9,
  wetDiffusion: 0.2, pigmentDiffusion: 0.05, evaporationRate: 0.01, maxPigment: 1,
  gravityMode: 3, gravityBias: [0, 1], gravityStrength: 0.1,
  edgeOpen: { left: false, right: false, top: false, bottom: false },
  edgeDarkeningEnabled: true, dryingPaused: false,
};

const stamps: BrushStamp[] = [
  { cx: 10, cy: 10, radius: 8, strength: 1, brushType: 0, pigmentIdx: 0,
    wetAmount: 0.5, pressureAmount: 0.5 },
  // Phase 1 fields are optional and typed:
  { cx: 20, cy: 20, radius: 8, strength: 1, brushType: 0, pigmentIdx: 1,
    wetAmount: 0.5, pressureAmount: 0.5, paintAmount: 1.5, textureMode: 'crayon' },
];

const state: SimStateArrays = {
  fluid: new Float32Array(GW * GH * 4),
  pigment: new Float32Array(GW * GH * 4),
  deposit: new Float32Array(GW * GH * 4),
  paper: new Float32Array(GW * GH * 4),
};

// A backend must satisfy the full contract.
declare const backend: SimBackend;
const caps: BackendCapabilities = backend.capabilities;
const _maxStamps: number = caps.maxStampsPerStep;
backend.stampBrush(stamps);
backend.step(params);
backend.uploadState(state);
backend.downloadState(state);
const tex = backend.getTextures(); // WebGLTexture bundle | null
if (tex) { const _f: WebGLTexture = tex.fluid; }
backend.destroy();

const choice: BackendChoice = { kind: 'gpu', reason: 'ok' };

// @ts-expect-error — 'tpu' is not a valid backend kind
const bad: BackendChoice = { kind: 'tpu', reason: 'x' };

// @ts-expect-error — step requires params
backend.step();

export {};
