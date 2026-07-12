// stamp-batcher.test.mjs
import { batchStamps, flushStamps, DEFAULT_MAX_STAMPS } from '../backend/stamp-batcher.js';

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`  FAIL ${msg}\n    expected ${e}\n    got      ${a}`); }
}

// Default cap is 32.
eq(DEFAULT_MAX_STAMPS, 32, 'default cap is 32');

// Empty input → no batches.
eq(batchStamps([]), [], 'empty → no batches');
eq(batchStamps(null), [], 'null → no batches');

// Under the cap → single batch.
eq(batchStamps([1, 2, 3], 32).length, 1, 'under cap → 1 batch');

// Exactly the cap → single full batch.
const n32 = Array.from({ length: 32 }, (_, i) => i);
eq(batchStamps(n32, 32).map(b => b.length), [32], 'exactly cap → 1 batch of 32');

// Over the cap → correct split (70 → 32,32,6).
const n70 = Array.from({ length: 70 }, (_, i) => i);
const b = batchStamps(n70, 32);
eq(b.map(x => x.length), [32, 32, 6], '70 stamps → [32,32,6]');
// No stamp lost or duplicated.
eq(b.flat(), n70, 'no stamp lost or duplicated');

// flushStamps dispatches one pass per batch, in order.
const seen = [];
const passes = flushStamps(n70, (batch) => seen.push(batch.length), 32);
eq(passes, 3, '70 stamps → 3 passes');
eq(seen, [32, 32, 6], 'passes dispatched in order');

// Invalid cap throws.
let threw = false;
try { batchStamps([1], 0); } catch (e) { threw = e instanceof RangeError; }
eq(threw, true, 'cap < 1 throws RangeError');

console.log(`\nstamp-batcher: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
