#!/usr/bin/env bash
# Runs every migration test that can execute headlessly.
set -e
cd "$(dirname "$0")"
echo "== stamp-batcher =="      && node tests/stamp-batcher.test.mjs
echo "== context-recovery =="   && node tests/context-recovery.test.mjs
echo "== cpu-backend (Phase 0 seam) ==" && node tests/cpu-backend.test.mjs
echo "== texture-parity (CPU deposit-factor match) ==" && node texture/texture-parity.test.mjs
echo "== type checks =="
tsc --noEmit --strict --lib ES2020,DOM --moduleResolution bundler --module ESNext --target ES2020 tests/backend.smoke.ts && echo "  backend.smoke.ts OK"
tsc --noEmit --allowJs --checkJs --strict --lib ES2020,DOM --moduleResolution bundler --module ESNext --target ES2020 \
  backend/cpu-backend.js backend/select-backend.js backend/stamp-batcher.js backend/context-recovery.js && echo "  backend/*.js (checkJs) OK"
echo ""
echo "All verifiable migration tests passed."
