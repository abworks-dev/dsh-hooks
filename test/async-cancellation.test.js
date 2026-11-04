import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncQueue } from '../async-queue.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('session cancellation is isolated and active capacity stays occupied until settlement', async () => {
  const queue = createAsyncQueue({ concurrency: 1, maxPending: 2 });
  let release, activeSignal, cancelled = 0;
  const starts = [];
  queue.enqueue({ sessionId: 'a', run: signal => { activeSignal = signal; starts.push('a'); return new Promise(resolve => { release = resolve; }); } });
  queue.enqueue({ sessionId: 'a', run: () => assert.fail('cancelled pending session ran'), cancel: () => cancelled++ });
  queue.enqueue({ sessionId: 'b', run: () => { starts.push('b'); } });
  await tick();
  queue.cancelSession('a');
  assert.equal(activeSignal.aborted, true);
  assert.equal(cancelled, 1);
  assert.deepEqual(queue.snapshot(), { active: 1, pending: 1 });
  await tick();
  assert.deepEqual(starts, ['a']);
  release(); await tick(); await tick();
  assert.deepEqual(starts, ['a', 'b']);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0 });
  queue.dispose();
});

test('a rejected task settles once and does not strand the next session', async () => {
  const queue = createAsyncQueue({ concurrency: 1, maxPending: 1 });
  let failures = 0, calls = 0;
  queue.enqueue({ sessionId: 'a', run: () => { throw new Error('fixture'); }, cancel: () => failures++ });
  queue.enqueue({ sessionId: 'b', run: () => { calls++; } });
  await tick(); await tick();
  assert.equal(failures, 1);
  assert.equal(calls, 1);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0 });
  queue.dispose();
});

test('externally aborted pending work is discarded without starting or blocking FIFO', async () => {
  const queue = createAsyncQueue({ concurrency: 1, maxPending: 2 });
  const controller = new AbortController();
  let release, cancelled = 0, calls = 0;
  queue.enqueue({ run: () => new Promise(resolve => { release = resolve; }) });
  queue.enqueue({ signal: controller.signal, run: () => assert.fail('aborted work ran'), cancel: () => cancelled++ });
  queue.enqueue({ run: () => { calls++; } });
  await tick(); controller.abort(); release();
  await tick(); await tick();
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0 });
  queue.dispose();
  assert.equal(queue.enqueue({ run: () => assert.fail('disposed queue ran') }), 'cancelled');
});
