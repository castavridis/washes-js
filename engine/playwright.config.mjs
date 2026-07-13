// Playwright config for the browser smoke tests (tests/browser/).
// Chromium only — CI runs it with SwiftShader for WebGL2.
export default {
  testDir: './tests/browser',
  timeout: 60_000,
  use: {
    viewport: { width: 900, height: 700 },
  },
};
