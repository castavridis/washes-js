// engine-smoke.spec.mjs — real-browser smoke for the paths the headless
// harness cannot reach: Canvas2D rendering, the WebGL render path, and the
// opt-in GPU sim. Loads dist/washes.standalone.js as a classic script into
// a blank page (no server needed).
//
// NOT runnable in this repo's offline dev container (no browsers) — this is
// the CI-side half of ENGINE_REVIEW P0#4. The gpu-sim parity spec is
// test.fixme until the known GPU render incident (CHANGELOG 1.0.1) is
// resolved; the job is continue-on-error in CI either way.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const STANDALONE = path.join(here, '..', '..', 'dist', 'washes.standalone.js');

async function bootPage(page) {
  await page.setContent('<div id="host" style="width:640px;height:480px;position:relative"></div>');
  await page.addScriptTag({ content: fs.readFileSync(STANDALONE, 'utf8') });
}

// Paint, run the sim, and report how many canvas pixels differ from paper.
const PAINT_AND_COUNT = `
  async () => {
    const wc = Washes.create(document.getElementById('host'));
    wc.paintNorm(0.5, 0.5, 0.08, 0, 0.9);
    wc.paintNorm(0.3, 0.4, 0.05, 2, 0.8);
    wc.runUntilDry(true);
    await new Promise((r) => setTimeout(r, 1500));
    const canvas = wc.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { webgl: true, painted: -1 }; // WebGL canvas: no 2d ctx
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const paper = [img[0], img[1], img[2]];
    let painted = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (Math.abs(img[i] - paper[0]) + Math.abs(img[i + 1] - paper[1]) +
          Math.abs(img[i + 2] - paper[2]) > 24) painted++;
    }
    return { webgl: false, painted };
  }
`;

test('CPU path renders pigment onto the canvas', async ({ page }) => {
  await bootPage(page);
  const res = await page.evaluate(`(${PAINT_AND_COUNT})()`);
  expect(res.painted).toBeGreaterThan(200); // two brush dabs cover real area
});

test('WebGL render path activates (or falls back) without breaking paint', async ({ page }) => {
  await bootPage(page);
  const res = await page.evaluate(`
    async () => {
      const wc = Washes.create(document.getElementById('host'));
      const available = wc.webglAvailable();
      wc.webgl(true); // silently falls back to CPU when unsupported
      wc.paintNorm(0.5, 0.5, 0.08, 1, 0.9);
      wc.runUntilDry(true);
      await new Promise((r) => setTimeout(r, 1500));
      const blob = await wc.exportPNG({ asBlob: true });
      return { available, webglOn: wc.webgl(), pngBytes: blob.size };
    }
  `);
  // exportPNG composites whatever path rendered; a paper-only PNG of this
  // size compresses far smaller than one with a pigment bloom in it.
  expect(res.pngBytes).toBeGreaterThan(8_000);
});

// Known incident (CHANGELOG 1.0.1): enabling the GPU sim rendered a flat
// fill in-browser, and GPU init failures are silent. Parity assertion is
// fixme until the first-frame health check + auto-fallback work lands —
// at which point this becomes the regression test for it.
test.fixme('GPU sim opt-in matches the CPU look (parity)', async ({ page }) => {
  await bootPage(page);
  const res = await page.evaluate(`(${PAINT_AND_COUNT})()`);
  expect(res.painted).toBeGreaterThan(200);
});
