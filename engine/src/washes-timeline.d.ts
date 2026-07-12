// washes-timeline.d.ts — types for the choreography sidecar (v1.0.0)
import type { WashesInstance } from "./washes";

export type EasingFn = (t: number) => number;
export type EasingName =
  | "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeOutBack" | "easeOutCubic";

export const easings: Record<EasingName, EasingFn>;

export interface StrokeOptions {
  /** ms to animate the whole path. Default 800. */
  duration?: number;
  /** named easing or a custom (t:0..1)=>0..1 function. Default easeInOut. */
  easing?: EasingName | EasingFn;
  /** pigment index or name; defaults to the instance's current pigment. */
  pigment?: number | string;
  /** brush radius as a fraction of the smaller grid dimension. Default 0.02. */
  nradius?: number;
  /** per-stamp strength. Default 0.6. */
  strength?: number;
  /** flow spacing override (engine default if omitted). */
  spacing?: number;
}

export interface TimelineOptions {
  /** force reduced motion (otherwise read from prefers-reduced-motion). */
  reducedMotion?: boolean;
}

export type TimelineState =
  | "idle" | "playing" | "paused" | "done" | "cancelled" | "error";

export class WashesTimeline {
  constructor(wc: WashesInstance, opts?: TimelineOptions);
  /** Queue a stroke along points ([nx,ny] in 0..1) over duration ms. */
  stroke(points: Array<[number, number]>, opts?: StrokeOptions): this;
  /** Queue a pause. */
  wait(ms: number): this;
  /** Queue a one-shot callback. */
  call(fn: () => void): this;
  /** Build + play a single stroke; returns the play() promise. */
  once(points: Array<[number, number]>, opts?: StrokeOptions): Promise<void | { cancelled: true }>;
  /** Start playback on the engine frame clock. */
  play(): Promise<void | { cancelled: true }>;
  pause(): this;
  resume(): this;
  cancel(): this;
  readonly state: TimelineState;
}
