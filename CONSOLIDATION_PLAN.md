# Washes — consolidation plan

*Written 2026-07-12 after a full review of the three ZIPs in `archive/26-7-12 archive/`.
Goal: bring the repo up to the latest implementation — the demo, the changelog in the
demo, and the engine `.js` files — plus everything else worth porting.*

---

## 1. Where things stand

| | Repo today | Latest (in the June 19 archive) |
|---|---|---|
| **Demo** | `/index.html` — byte-identical to `washes-v0.98.html`, but titled **v0.97** (the v0.98 changelog entry was never added; documented in FIXES.md §6) | `playground-v1.0.16.html` — titled v1.0.16, embeds **engine 1.12.1**, fully self-contained |
| **In-demo changelog** | 81 entries, stops at **v0.97** | **100 entries** (v1.0.16 → "earlier") — verified a **strict superset** of the repo's 81 anchors; newest entry documents engine 1.10–1.12.1 (pigments, masks, transparent, timeline) |
| **Engine .js** | none in repo (only inside archived v0.98 bundle) | `washes-pkg` **v1.12.1** — `washes.js`, `washes-gpu-sim.js`, `washes-timeline.js` + `.d.ts` for each, shader, tests |
| **Engine changelog** | none | `CHANGELOG.md` covering 0.98.0 → 1.12.1 |

**Canonical source of truth** (everything below verified byte-identical against the
`washes-all-files.zip` working tree, and nothing in that tree post-dates it):

```
archive/26-7-12 archive/washes-api-expansion-all.zip
  └── washes-latest.zip          ← THE curated "latest deliverables" bundle
        ├── README.md
        ├── demos/    playground-v1.0.16.html · snake.html · mask-reveal.html
        ├── engine/   washes-pkg-v1.12.1.tar.gz · CHANGELOG.md · washes.d.ts
        │             washes-timeline.js · washes-timeline.d.ts
        ├── presets/  rainbow-spray.preset.js · reveal-blue.preset.js
        └── docs/     WASHES_ROADMAP_5_FEATURES.md · BACKDROP_COMPOSITING_SCOPE.md
```

**Engine v1.12.1 verified working here** (Node 20): regression harness
(`node tests/washes-test-harness.cjs src/washes.js all`) exits 0;
`texture-parity` 12/12 passed.

### Version lineage (orientation)

```
watercolor v0.1 … v0.27, v1.0          (May — single-canvas prototypes → factory refactor)
washes v0.61 / v0.64 / v0.65 / v0.98   (May 21 — current repo index.html = v0.98 build)
washes demo v1.0 → v1.0.16             (June — playground HTML iterations)
washes-pkg 1.0.1 → 1.12.1              (June — npm engine package, its own semver)
```

Since June there are **two version tracks**: the demo HTML (v1.0.x, tracked by the
in-demo changelog) and the engine package (1.x.y, tracked by `CHANGELOG.md`). Both
are current in the archive; nothing needs merging — but the split should be
documented in the root README (step 9).

---

## 2. Target layout

```
/workspace
├── index.html                  ← GitHub Pages landing page          [step 1]
├── demos/playground.html       ← playground-v1.0.16.html            [step 1]
├── engine/                     ← washes-pkg v1.12.1, unpacked       [step 2]
│   ├── package.json · README.md · CHANGELOG.md · LICENSE · CITATION.cff
│   ├── src/   index.js · washes.js · washes-gpu-sim.js · washes-timeline.js
│   │          (+ .d.ts each) · shaders/brush_stamp.frag
│   └── tests/ washes-test-harness.cjs · texture-parity.test.mjs
│              types-smoke.ts · brush-texture-deposit.js
├── demos/                      ← + snake.html · mask-reveal.html    [step 4]
├── presets/                    ← rainbow-spray · reveal-blue        [step 4]
├── docs/                       ← roadmap · backdrop scope · FIXES · gpu-migration/  [step 5]
├── showcase/                   ← pages/ · studio/ · personality/ · labs/           [step 6]
├── reference/papers/           ← the 7 paper-visualization demos    [step 7]
└── archive/                    ← unchanged, plus 1 new transcript   [step 8]
```

---

## 3. Steps

### Step 1 — Demo: playground v1.0.16 to `demos/playground.html`; landing page at `/index.html`
*(Amended per answers to the open questions: the repo is a GitHub Pages site, so
the root `index.html` becomes a small landing page and the playground lives at
`demos/playground.html`.)*
- Copy `washes-latest.zip → demos/playground-v1.0.16.html` to `demos/playground.html`.
  Safe: its in-demo changelog is a verified superset of the old root demo's; the
  file is self-contained (the only `<script src=` hits are inside a JS comment).
  This delivers the **demo** and the **changelog in the demo** in one move: the
  changelog nav runs v1.0.16 → v0.1, including the v0.98/v0.98.1 entries the
  repo's old copy was missing. (The old root demo remains preserved as
  `washes-v0.98.html` in the archives.)
- Cosmetic fix while here: the `<title>` suffix "GPU texture parity" was stale
  carry-over (unchanged since v1.0.14); updated to the v1.0.16 headline
  "pigments, masks, transparent & timeline".
- New landing page at `/index.html`: watercolor-paper aesthetic matching the
  playground's typefaces, a **live paintable hero running the actual engine**
  (ESM import of `engine/src/index.js` + the `reveal-blue` preset, with a static
  CSS-wash fallback if module loading fails), and navigation to demos, showcase,
  engine, paper references, and history. Added `.nojekyll` for Pages.

### Step 2 — Engine: unpack washes-pkg v1.12.1 to `engine/`
Source: `washes-latest.zip → engine/washes-pkg-v1.12.1.tar.gz`.
These are the canonical **.js files**: `washes.js` (603 KB, June 10),
`washes-gpu-sim.js`, `washes-timeline.js`, plus matching `.d.ts`, the
`brush_stamp.frag` shader, and the four test files.

Cleanups to apply after unpacking:
- `package.json` `files` array omits `washes-timeline.js`/`.d.ts` and
  `src/shaders/brush_stamp.frag` even though the tarball ships them — add them,
  and add a `"./timeline"` entry to the `exports` map.
- `repository`/`homepage`/`bugs` still point at placeholder
  `github.com/yourusername/washes` — set the real URL (flagged in FIXES.md too).
- Optional: generate `engine/dist/washes.standalone.js` for classic
  `<script>`-tag use by stripping the 4 trailing ESM `export` lines from
  `src/washes.js` (the package is `type: module`; a classic script throws on
  `export`). This is the exact procedure FIXES.md §1 used for the v0.98 build.

**Trap — do not port:** `washes-all-files.zip → washes-fixes/current/washes.js`
is the **stale v0.98** standalone (415 KB, June 6), and
`washes-fixes/current/washes.d.ts` is an older 1,077-line declaration file
(missing `'auto'` quality preset and `PigmentSpec`). The 1.12.1 package versions
supersede both.

### Step 3 — Changelogs: nothing to merge, document the two tracks
- **In-demo changelog** (demo versions v0.1 → v1.0.16): ships inside the new
  `index.html`; complete.
- **Engine `CHANGELOG.md`** (pkg 0.98.0 → 1.12.1): ships inside `engine/`;
  complete, and byte-identical between the curated bundle and the working tree.
- Convention going forward (put this in the README): a demo release adds an
  entry to the in-demo changelog; an engine release adds an entry to
  `engine/CHANGELOG.md`; a demo that embeds a new engine references it
  ("v1.0.16 — engine 1.12.1: …"), as v1.0.16 already does.

### Step 4 — Supporting demos and presets
- `demos/snake.html` ("Serpentine") and `demos/mask-reveal.html` ("Develop") from
  `washes-latest.zip` — both self-contained, both embed engine 1.12.1 (verified
  identical to the copies in `washes-games/` and `washes-pages/`).
- `presets/rainbow-spray.preset.js`, `presets/reveal-blue.preset.js` — the saved
  palette + technique modules (identical copies exist in `washes-pages/presets/`).

### Step 5 — Docs worth porting to `docs/`
- `WASHES_ROADMAP_5_FEATURES.md` — the five-feature engineering plan. Annotate
  status when porting: features shipped as 1.10 (palettes), 1.11 (masks),
  1.12 (transparent) are done; note what remains.
- `BACKDROP_COMPOSITING_SCOPE.md` — scoping for the next feature (June 10, the
  newest doc in the tree).
- `washes-fixes/FIXES.md` — the QA record of the v0.98-bundle fixes; historically
  useful (documents the standalone-build procedure reused in step 2).
- `washes-fixes/gpu-migration/` → `docs/gpu-migration/` — the CPU→GPU migration
  scaffold: `MIGRATION.md`, the typed backend seam, CPU adapter, stamp batcher,
  context-loss recovery, texture-deposit port, and their tests. The
  headless-verifiable phases are done; the GPU-dependent phases are specified but
  unbuilt — this is the working plan for future GPU work. (Its `vendor/washes.js`
  is a pinned v0.98 copy its tests load — keep it inside that folder only.)

### Step 6 — Showcase pages to `showcase/`
All self-contained art/product pieces from `washes-all-files.zip`:
- `pages/` — brand.html (GRAIN) · dolphin.html (Surfacing) · vantage.html (VANTAGE)
- `studio/` — ramp-burn (BURN) · rippling-current (CURRENT) · runway-fields
  (FIELDS) · shopify-handmade (HANDMADE) · stripe-meridian (Meridian) ·
  vercel-prerender (prerender)
- `personality/` — the ten experiments; use the descriptively-named set from
  `washes-personality-experiments.zip` (v1-three-studies … v10-five-channel-recording;
  verified byte-identical to the `washes-personality-v*.html` copies, so port one set only)
- `labs/` — washes-lab-1 (physics) · washes-lab-2 (experimental) · washes-gallery
  (v1.0.1 demo gallery) · washes-two-layer (animated backdrop) ·
  washes-v1.1-features (v1.1 ergonomics showcase)

### Step 7 — Paper-reference demos to `reference/papers/`
The whole third ZIP (`watercolor-paper-visualization-all.zip`) — seven
self-contained "Washes reference gallery" educational demos of the papers the
engine is built on: Curtis watercolor · Kubelka-Munk glazing · Mixbox pigment
mixing · Foster–Metaxas MAC grid · Stam stable fluids · Bridson advection ·
CFL condition. They double as design references for the gpu-migration work.

### Step 8 — Archive hygiene (no deletions)
- Keep all three ZIPs in `archive/26-7-12 archive/` untouched.
- `washes-a-watercolor-library-all.zip` is a superset of the repo's existing
  `archive/26-5-21 archive/washes-bundle/` — the only *new* items are the version
  museum (watercolor v0.1 → v1.0, washes v0.61/v0.64/v0.65) and
  `washes-gpu-sim-demo.html`. Optional: extract to `archive/versions/` for a
  browsable lineage; otherwise leave zipped.
- Its `washes-conversation.zip` contains exactly **one transcript the repo lacks**:
  `2026-05-26-16-17-13-washes-v098-gpu-sim-refactor.txt` — extract it into
  `archive/26-5-21 archive/washes-conversation/`.
- Per-version engine tarballs (v0.98 → v1.12.1) and per-version `.d.ts` files in
  `washes-all-files.zip` stay zipped — museum material.

### Step 9 — Root `README.md`
Small map of the repo: what `index.html` is, the two changelog tracks, where the
engine lives and how to run its tests, what's in demos/showcase/reference/archive.

### Step 10 — Verify
- `cd engine && node tests/washes-test-harness.cjs src/washes.js all` → exit 0
  (baseline established during this review) and `node tests/texture-parity.test.mjs`
  → 12/12.
- `tsc --strict` on `tests/types-smoke.ts` (needs a TypeScript install).
- Open `index.html`, `demos/*.html`, and a sample of showcase pages in a browser:
  paint, switch palette (the 1.12.1 swatch-refresh fix), toggle mask shapes,
  transparent mode, and the timeline flourish; confirm the changelog nav shows
  v1.0.16 → earlier.

---

## 4. Explicitly not ported (and why)

| Item | Why not |
|---|---|
| `washes-fixes/current/washes.js` | stale v0.98 standalone build — superseded by pkg 1.12.1 |
| `washes-fixes/current/washes.d.ts` (and root `washes-fixes/washes.d.ts`) | older declarations, superseded by pkg 1.12.1 `src/washes.d.ts` |
| `washes-latest/engine/washes.d.ts` | byte-identical duplicate of the pkg file |
| per-version `.d.ts` / tarballs / `washes-v1.0.x.html` iterations | version museum — stays in the archive |
| `watercolor-lib.js` (May) | the early pre-texture-brush extraction FIXES.md §1 flags as the wrong build |
| duplicate copies of snake / mask-reveal / presets / personality pages | one canonical copy each, verified identical |

## 5. Open questions — answered 2026-07-12

1. **GitHub Pages: yes.** Landing page created at `/index.html`; playground moved
   to `demos/playground.html`; `.nojekyll` added.
2. **Repository URL:** `https://github.com/castavridis/washes-js` — applied to
   `engine/package.json`, `engine/README.md`, and `engine/CITATION.cff`.
3. **Version museum: extract.** 72 runnable snapshots extracted to
   `archive/versions/` (watercolor v0.1 → v1.0, washes v0.61/v0.64/v0.65, and
   the May-era `washes-gpu-sim-demo.html`).

## 6. Execution log (2026-07-12)

All ten steps executed:

- **Demo & changelog** — `demos/playground.html` (v1.0.16, title fixed) +
  landing page at `/index.html` with live engine hero; `demos/snake.html`,
  `demos/mask-reveal.html`.
- **Engine** — `engine/` = washes-pkg v1.12.1 unpacked. `package.json`: added
  `washes-timeline.js`/`.d.ts` + `shaders/brush_stamp.frag` to `files`, added a
  `"./timeline"` export, real repo URLs. `CITATION.cff`: version 1.0.1 → 1.12.1,
  date-released → 2026-06-10, real URL. New `scripts/build-standalone.cjs`
  generates `dist/washes.standalone.js` (verifies classic-script parse + global
  attach; asserts the expected export-block tail before stripping).
- **Docs** — roadmap (annotated: features 1–4 shipped, 5 = deterministic seed
  unbuilt), backdrop scope, FIXES.md, `gpu-migration/` scaffold.
- **Showcase** — 3 pages + 6 studio + 10 personality + 5 labs.
- **Reference** — 7 paper explainers in `reference/papers/`.
- **Archive** — 72 snapshots in `archive/versions/`; the missing
  `2026-05-26 …gpu-sim-refactor.txt` transcript added to the 26-5-21
  conversation folder; source ZIPs untouched.
- **Root** — `README.md` (layout map, changelog convention, usage, tests),
  `.nojekyll`.
- **Verified** — engine harness exit 0 + texture-parity 12/12 from the new
  `engine/` location; standalone build parse/attach check; hero API calls
  checked against `washes.d.ts`; all landing-page links resolve (see below).
