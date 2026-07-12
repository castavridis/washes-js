// context-recovery.test.mjs
import { createContextRecovery } from '../backend/context-recovery.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL ' + msg); } }

// Fake canvas event target.
function makeCanvas() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    emit(type, ev) { (listeners[type] || []).forEach(fn => fn(ev)); },
    _count(type) { return (listeners[type] || []).length; },
  };
}

// Controllable clock.
let t = 0;
const now = () => t;

let snapshots = 0;
let restoredWith = undefined;
const canvas = makeCanvas();
const rec = createContextRecovery({
  canvas,
  now,
  snapshotIntervalMs: 1000,
  snapshot: () => { snapshots++; return { tag: 'state@' + t }; },
  restore: (snap) => { restoredWith = snap; },
});

// maybeSnapshot is cheap between intervals: first call snapshots, next (same t) does not.
rec.maybeSnapshot(); ok(snapshots === 1, 'first maybeSnapshot takes a snapshot');
rec.maybeSnapshot(); ok(snapshots === 1, 'no extra snapshot within interval');
t = 1000; rec.maybeSnapshot(); ok(snapshots === 2, 'snapshot after interval elapses');

// forceSnapshot always snapshots.
t = 1200; rec.forceSnapshot(); ok(snapshots === 3, 'forceSnapshot ignores cadence');

// Context loss: must preventDefault (or browsers never fire restore) and set lost.
let prevented = false;
canvas.emit('webglcontextlost', { preventDefault() { prevented = true; } });
ok(prevented, 'context loss is preventDefault-ed');
ok(rec.isLost() === true, 'backend marked lost');

// While lost, snapshots are suppressed (GL is unusable).
const before = snapshots;
t = 5000; rec.maybeSnapshot(); rec.forceSnapshot();
ok(snapshots === before, 'no snapshots while context is lost');

// Restore: re-seeds from the last good shadow and clears lost.
canvas.emit('webglcontextrestored', {});
ok(restoredWith && restoredWith.tag === 'state@1200', 'restored from last good shadow');
ok(rec.isLost() === false, 'lost cleared after restore');

// dispose unhooks listeners.
rec.dispose();
ok(canvas._count('webglcontextlost') === 0 && canvas._count('webglcontextrestored') === 0,
   'dispose removes listeners');

console.log(`\ncontext-recovery: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
