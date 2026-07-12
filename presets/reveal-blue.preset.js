// Washes preset — "Reveal Blue"
// Saved from the mask-reveal demo (the wash you liked when shown raw).
// A vivid blue/red/amber watercolor palette with a slightly granular blue,
// tuned to linger on the paper. Drop these into any Washes instance.

export const REVEAL_BLUE = {
  // the three working pigments (body / warm accent / highlight)
  palette: [
    { color: '#2f6fb0', granulation: 0.30 },  // blue — the signature body ink
    { color: '#b0353b' },                      // warm red accent
    { color: '#d68a2e' },                      // amber highlight
  ],
  // engine feel-settings that gave it its character in the demo
  settings: {
    evaporation: 0.55,   // strokes linger so washes persist a beat
    flow: 0.14,          // gentle diffusion
    paperColor: { r: 1, g: 1, b: 1 },  // white paper (swap for a tinted ground)
  },
};

// Usage:
//   const wc = Washes.create(el, {
//     pigments: REVEAL_BLUE.palette,
//     paperColor: REVEAL_BLUE.settings.paperColor,
//   });
//   wc.evaporation(REVEAL_BLUE.settings.evaporation);
//   wc.flow(REVEAL_BLUE.settings.flow);
//
// or apply to an existing instance:
//   wc.palette(REVEAL_BLUE.palette);
//   wc.evaporation(REVEAL_BLUE.settings.evaporation);
//   wc.flow(REVEAL_BLUE.settings.flow);
