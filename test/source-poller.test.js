import test from 'node:test';
import assert from 'node:assert/strict';
import { startSourceChecks } from '../source-poller.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clock() {
  let now = 0, unrefs = 0, clears = 0;
  const timers = new Map();
  return {
    timers,
    get now() { return now; },
    get unrefs() { return unrefs; },
    get clears() { return clears; },
    setTimeout(callback, delay) {
      const handle = { unref() { unrefs++; } };
      timers.set(handle, { callback, at: now + delay });
      return handle;
    },
    clearTimeout(handle) { clears++; timers.delete(handle); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
const options = (c, extra = {}) => ({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, ...extra });

test('startup is a barrier with no pending timer until the first check completes', async () => {
  const c = clock(), first = deferred(); let calls = 0;
  const starting = startSourceChecks({ checkSources() { calls++; return first.promise; } }, options(c));
  assert.equal(calls, 1); assert.equal(c.timers.size, 0);
  await c.advance(90000); assert.equal(calls, 1);
  first.resolve(); const stop = await starting;
  assert.equal(typeof stop, 'function'); assert.equal(c.timers.size, 1);
  assert.equal([...c.timers.values()][0].at, 120000);
  stop();
});

test('initial rejection propagates unchanged without a timer or error notification', async () => {
  const c = clock(), failure = new Error('private path'); let errors = 0;
  await assert.rejects(startSourceChecks({ checkSources() { throw failure; } }, options(c, { onError() { errors++; } })), error => error === failure);
  assert.equal(c.timers.size, 0); assert.equal(errors, 0);
});

test('validates manager, bounded safe integer interval, and injected functions before checking', async () => {
  let calls = 0; const manager = { checkSources() { calls++; } };
  for (const value of [NaN, Infinity, -Infinity, 0, 999, 1000.5, 3600001, Number.MAX_SAFE_INTEGER + 1, '30000', null]) {
    await assert.rejects(startSourceChecks(manager, { intervalMs: value }), RangeError);
  }
  for (const manager of [null, {}, { checkSources: 1 }]) await assert.rejects(startSourceChecks(manager), TypeError);
  for (const name of ['setTimeout', 'clearTimeout', 'onError']) await assert.rejects(startSourceChecks(manager, { [name]: null }), TypeError);
  assert.equal(calls, 0);
  for (const intervalMs of [1000, 3600000]) {
    const c = clock(); const stop = await startSourceChecks(manager, options(c, { intervalMs }));
    assert.equal([...c.timers.values()][0].at, intervalMs); stop();
  }
});

test('normal fake time uses the default interval and unrefs every timeout', async () => {
  const c = clock(); let calls = 0;
  const stop = await startSourceChecks({ checkSources() { calls++; } }, options(c));
  assert.equal(c.unrefs, 1);
  await c.advance(29999); assert.equal(calls, 1);
  await c.advance(1); assert.equal(calls, 2); assert.equal(c.timers.size, 1);
  await c.advance(60000); assert.equal(calls, 4); assert.equal(c.unrefs, 4);
  stop();
});

test('pending checks never overlap or catch up and next interval starts at completion', async () => {
  const c = clock(), pending = deferred(); let calls = 0;
  const manager = { checkSources() { calls++; return calls === 2 ? pending.promise : undefined; } };
  const stop = await startSourceChecks(manager, options(c, { intervalMs: 1000 }));
  const stale = [...c.timers.values()][0].callback;
  await c.advance(1000); assert.equal(calls, 2); assert.equal(c.timers.size, 0);
  await stale(); assert.equal(calls, 2);
  await c.advance(10000); assert.equal(calls, 2);
  pending.resolve(); await flush();
  assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].at, 12000);
  // The manager, not the poller, selects the latest registrations on every call.
  manager.checkSources = () => { calls += 10; };
  await c.advance(999); assert.equal(calls, 2);
  await c.advance(1); assert.equal(calls, 12); stop();
});

test('poll errors use a zero-argument notification and recover at full interval despite throwing reporter', async () => {
  for (const asyncReporter of [false, true]) {
    const c = clock(); let calls = 0, errors = 0;
    const stop = await startSourceChecks({ checkSources() { if (++calls === 2) throw new Error('SECRET'); } }, options(c, {
      intervalMs: 1000,
      onError(...args) { errors++; assert.deepEqual(args, []); if (asyncReporter) return Promise.reject(new Error('reporter')); throw new Error('reporter'); },
    }));
    await c.advance(1000); assert.equal(errors, 1); assert.equal(c.timers.size, 1);
    await c.advance(999); assert.equal(calls, 2);
    await c.advance(1); assert.equal(calls, 3); assert.equal(errors, 1); stop();
  }
});

test('stop is synchronous and idempotent, clears pending timer, and stale callback does nothing', async () => {
  const c = clock(); let calls = 0;
  const stop = await startSourceChecks({ checkSources() { calls++; } }, options(c));
  const stale = [...c.timers.values()][0].callback;
  assert.equal(stop(), undefined); stop();
  assert.equal(c.clears, 1); assert.equal(c.timers.size, 0);
  await stale(); await c.advance(90000); assert.equal(calls, 1);
});

test('stop during a pending check suppresses rescheduling and late failure notifications', async () => {
  for (const fails of [false, true]) {
    const c = clock(), pending = deferred(); let calls = 0, errors = 0;
    const stop = await startSourceChecks({ checkSources() { return ++calls === 2 ? pending.promise : undefined; } }, options(c, { intervalMs: 1000, onError() { errors++; } }));
    await c.advance(1000); stop(); stop();
    if (fails) pending.reject(new Error('SECRET')); else pending.resolve();
    await flush(); await c.advance(90000);
    assert.equal(calls, 2); assert.equal(errors, 0); assert.equal(c.timers.size, 0);
  }
});

test('numeric timer handles need no unref method', async () => {
  let callback, cleared;
  const stop = await startSourceChecks({ checkSources() {} }, { setTimeout(fn) { callback = fn; return 7; }, clearTimeout(id) { cleared = id; } });
  assert.equal(typeof callback, 'function'); stop(); assert.equal(cleared, 7);
});
