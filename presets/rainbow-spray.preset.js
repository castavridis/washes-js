// Washes preset — "Rainbow Spray"
// The multicolor brush from the mask-reveal demo. The rainbow look isn't the
// palette alone — it's the *technique*: every dab picks a RANDOM one of the
// three palette inks, so blue/red/amber spray out together and bloom into each
// other on the paper. Reproduce both the palette AND the random-index painting.

export const RAINBOW_SPRAY = {
  // the three working pigments — a warm-cool spread that mixes well
  palette: [
    { color: '#2f6fb0', granulation: 0.30 },  // blue
    { color: '#b0353b' },                      // red
    { color: '#d68a2e' },                      // amber
  ],

  // engine feel-settings that give it its character
  settings: {
    evaporation: 0.55,                 // strokes linger so colors keep blooming
    flow: 0.14,                        // gentle diffusion lets the inks intermingle
    paperColor: { r: 1, g: 1, b: 1 },  // white paper
  },

  // THE KEY PART — paint with a random pigment index each dab.
  // radius/strength are the demo's defaults; tweak to taste.
  // Call this instead of a plain paintNorm to get the rainbow spray.
  paint(wc, nx, ny, { radius = 0.05, strength = 0.6 } = {}) {
    const idx = (Math.random() * 3) | 0;     // ← random ink per dab = rainbow
    wc.paintNorm(nx, ny, radius, idx, strength);
  },
};

// Usage:
//   const wc = Washes.create(el, {
//     pigments: RAINBOW_SPRAY.palette,
//     paperColor: RAINBOW_SPRAY.settings.paperColor,
//   });
//   wc.evaporation(RAINBOW_SPRAY.settings.evaporation);
//   wc.flow(RAINBOW_SPRAY.settings.flow);
//   // then paint with the rainbow technique:
//   RAINBOW_SPRAY.paint(wc, 0.5, 0.5);
//
// or apply the palette to an existing instance:
//   wc.palette(RAINBOW_SPRAY.palette);
//   // ...and use RAINBOW_SPRAY.paint(wc, nx, ny) wherever you'd paint.
//
// Note: a plain wc.paintNorm(nx, ny, r, 0, s) would paint a SINGLE color.
// The rainbow comes from rotating the pigment index, which RAINBOW_SPRAY.paint
// does for you.
