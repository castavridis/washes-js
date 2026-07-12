# Washes bundle — fixes

Corrected files for the issues found in the review. All changes are verified:
the regression harness passes against the corrected source, the TypeScript
declarations compile clean under `--strict`, and the type smoke test (including
its `@ts-expect-error` assertions) passes.

## What changed

### 1. (High) Standalone `washes.js` was the wrong build → regenerated as v0.98
The old `current/washes.js` was byte-identical to the early factory extraction
(`watercolor-lib.js`): no texture-brush code and only a `window.Watercolor`
global — so the package README's `window.Washes.create(...)` snippet resolved to
`undefined`, and none of the v0.98 features were present.

The new `current/washes.js` is built from the actual v0.98 source (the same code
that ships inside the npm tarball). It is the self-contained IIFE, which attaches
**both** `window.Washes` and `window.Watercolor`, with the three trailing ESM
`export` lines omitted (a classic `<script>` tag can't contain top-level
`export`, so those would throw; use the npm package for `import`). Texture brush
modes (`crayon`/`dryBrush`/`salt`/`splatter`) are present.

- Verified: parses as a classic script, `window.Washes.create()` works, the full
  regression harness runs against it.

### 2. (Medium) Version metadata was stale → bumped to 0.98.0
`package.json` said `0.85.0`; bumped to `0.98.0`. `CITATION.cff` gained
`version: "0.98.0"` and `date-released: "2026-06-06"`.

### 3. (Medium) Headline feature was missing from the types → added
`washes.d.ts` had no declaration for the v0.98 texture-brush API. Added:
- `BrushMode` type (`'wet' | 'crayon' | 'dryBrush' | 'salt' | 'splatter' | 'dry'`;
  `'dry'` documented as the deprecated legacy alias for `'crayon'`)
- `brushMode(v?: BrushMode): BrushMode`
- `dryness`, `dryPaperReject`, `dryAnisotropy`, `dryBrushSkip` (all `(v?: number): number`)
- `wetnessHeatmap` (three overloads: getter, positional, and options-object) plus
  `HeatmapColor` and `WetnessHeatmapOptions`

The type smoke test (`tests/types-smoke.ts`) was extended to exercise all of these,
including a `@ts-expect-error` confirming an invalid mode is rejected.

Note: `current/washes.d.ts` (and the root `washes.d.ts`) were *also* stale — an
older 566-line types file missing `closed-gravity`, `radial-in`, and the
pause/quality types in addition to `brushMode`. They've been replaced with the
current, fully-typed declarations.

### 4. (Low) CITATION author was duplicated → fixed
Author was `family-names: "Stephanie"` + `given-names: "Stephanie"` (rendered as
"Stephanie, Stephanie"). Now a single `given-names: "Stephanie"`.

### 5. (Low) Test-harness hotspot count/print mismatch → fixed
The hotspot scan printed `${hs.length} hotspot(s)` but then sliced the list to 3,
so a 4-corner result reported "4" but listed only 3 coordinates. It now prints all
hotspots (capped at 8 with an `…` overflow marker so a real regression can't spam),
so the count always matches the list. Fixed in both the reference `.js` harness and
the packaged `.cjs` harness.

## Not changed (and why)

- **Placeholder repo URLs** (`github.com/yourusername/washes`) in `package.json`,
  `README.md`, and `CITATION.cff` are left as-is — I don't know the real repository
  URL. Replace `yourusername` once the repo exists.
- **GPU-sim subtree** (`gpu-sim/`) is untouched. Its `source/washes.d.ts` and
  `washes-uploaded.js` intentionally track the older (~v0.86) uploaded lib, as the
  bundle README documents. `gpuSim()` / `gpuSimContext()` remain an experimental,
  separately-typed track.

### 6. (Follow-up) In-app changelog updated
The canonical changelog lives in the playground HTML (`washes-v0.98.html`,
"Changelog" docs section), and its newest entry was **v0.97** — there was no
v0.98 entry at all, even though the texture-brush feature had shipped. Added:
- **v0.98 — texture brush modes**: the headline `brushMode()` feature
  (`wet`/`crayon`/`dryBrush`/`salt`/`splatter`) plus the `dryness` /
  `dryPaperReject` / `dryAnisotropy` / `dryBrushSkip` knobs, and notes on the
  demos and the experimental GPU-sim track.
- **v0.98.1 — packaging & types fixes**: the maintenance items above (fixes
  1–5), framed as a no-behavior-change release.

Both were added to the changelog body and the docs nav, matching the existing
entry format (`cl-tag` spans, `docs-code` blocks, reverse-chronological order).
The updated file is `current/washes-v0.98.html`.

Not done (offered): the npm package has no `CHANGELOG.md`. The in-app changelog
is the canonical one and is now current; a separate package `CHANGELOG.md` for
npm consumers could be generated from it if you want one.

## Where to drop each file

| Corrected file | Replaces in the bundle |
| --- | --- |
| `current/washes.js` | `current/washes.js` and the root `watercolor-lib.js` (they were identical) |
| `current/washes.d.ts` | `current/washes.d.ts` |
| `washes.d.ts` | the root `washes.d.ts` |
| `current/washes-pkg-v0.98.tar.gz` | `current/washes-pkg-v0.98.tar.gz` and the root `washes-pkg-v0.98.tar.gz` |
| `current/washes-v0.98.html` | `current/washes-v0.98.html` and the root `washes-v0.98.html` (identical; updated changelog) |
| `current/washes-v1.0.html` | v1.0 timeline: adds the `v1.0 — pluggable simulation backend` changelog entry (the gpu-migration work) on top of v0.98.1; title + version badge bumped to v1.0 |
| `reference/washes-test-harness.js` | `reference/washes-test-harness.js` and the root `washes-test-harness.js` |

The corrected npm tarball already contains the fixed `package.json`, `CITATION.cff`,
`src/washes.d.ts`, `tests/types-smoke.ts`, and `tests/washes-test-harness.cjs`.
