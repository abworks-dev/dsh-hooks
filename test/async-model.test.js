import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager, sanitizeTokenUsage } from '../core.js';
import { bindEvents } from '../index.js';

test('usage sanitizer accepts only own safe count data and never invokes getters', () => {
  const valid = { inputTokens: -0, outputTokens: Number.MAX_SAFE_INTEGER, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3, reasoningTokens: 4 };
  Object.defineProperty(valid, 'unknown', { get() { throw Error('unknown getter'); } });
  const snapshot = sanitizeTokenUsage(valid);
  assert.deepEqual(snapshot, { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3, reasoningTokens: 4 });
  assert.ok(Object.isFrozen(snapshot));
  assert.notEqual(snapshot, valid);
  assert.deepEqual(sanitizeTokenUsage(Object.assign(Object.create(null), { inputTokens: 1, outputTokens: 2 })), { inputTokens: 1, outputTokens: 2 });
  const getter = { outputTokens: 2 };
  Object.defineProperty(getter, 'inputTokens', { get() { throw Error('count getter'); } });
  const optionalGetter = { inputTokens: 1, outputTokens: 2 };
  Object.defineProperty(optionalGetter, 'totalTokens', { get() { throw Error('optional getter'); } });
  for (const value of [null, [], new Date(), 1, {}, { inputTokens: 1 }, getter, optionalGetter, Object.create({ inputTokens: 1, outputTokens: 2 }), new Proxy({}, { getPrototypeOf() { throw Error('proxy'); } }), new Proxy({}, { getOwnPropertyDescriptor() { throw Error('descriptor'); } })]) assert.equal(sanitizeTokenUsage(value), null);
  for (const key of Object.keys(snapshot)) for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, 1n]) assert.equal(sanitizeTokenUsage({ inputTokens: 1, outputTokens: 2, [key]: value }), null);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = (stdout = '', exitCode = 0) => ({ status: 'completed', exitCode, stdout, stderr: '' });
async function fixture() {
  const listeners = new Map(), executions = [], dispatches = [];
  let reads = 0;
  const forbidden = () => { reads++; throw Error('private_model_body_read'); };
  const protect = value => Object.defineProperties(value, Object.fromEntries(['messages', 'system', 'tools', 'history', 'text', 'content', 'block', 'body'].map(key => [key, { get: forbidden }])));
  const agent = { id: 'model-session' }, session = protect({ id: agent.id });
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[session.id, session]]);
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }),
    execute(_action, payload, { signal }) { return new Promise(resolve => executions.push({ payload, signal, resolve })); },
  });
  for (const event of ['PreModelRequest', 'PostModelRequest']) {
    await manager.upsert({ id: event, name: event, event, async: true, action: { type: 'command', executable: process.execPath } });
    await manager.trust(event, (await manager.previewTrust(event)).digest);
    await manager.toggle(event, true);
  }
  await manager.configure({ enabled: true });
  const dispatch = manager.dispatch.bind(manager);
  manager.dispatch = (...args) => { const pending = dispatch(...args); dispatches.push(pending); return pending; };
  const off = bindEvents({ on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    agents: { list: () => [...agents.values()], get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) },
    workingDirectory: { get: value => { assert.equal(value, session); return process.cwd(); } },
  }, manager);
  return { manager, executions, agents, sessions, agent, session, protect, reads: () => reads,
    options(extra = {}) { return Object.freeze(protect({ sessionId: agent.id, provider: 'fixture', model: 'fake', ...extra })); },
    stream(options, next) { return listeners.get('llm/stream').call({ privateRuntime: true }, options, next); },
    settle: () => Promise.all(dispatches),
    async dispose() { off(); manager.dispose(); for (const execution of executions) execution.resolve(completed()); await tick(); assert.equal(reads, 0); },
  };
}

for (const outcome of ['success', 'error', 'abort', 'close']) {
  test(`actual model waterfall preserves ${outcome} while deferred notification output cannot control it`, async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(), error = Error('original_stream_error');
      const chunk = f.protect({ type: 'text-delta', index: 0 }), finish = f.protect({ type: 'finish', reason: { kind: 'stop' } });
      let calls = 0, finalized = 0;
      const options = f.options({ signal: controller.signal });
      const next = async function* () { calls++; try { yield chunk; if (outcome === 'error' || outcome === 'abort') { if (outcome === 'abort') controller.abort(); throw error; } yield finish; } finally { finalized++; } };
      const stream = f.stream(options, next);
      assert.equal(calls, 0);
      assert.deepEqual(await stream.next(), { value: chunk, done: false });
      if (outcome === 'close') assert.deepEqual(await stream.return('original-return'), { value: 'original-return', done: true });
      else if (outcome === 'error' || outcome === 'abort') await assert.rejects(stream.next(), value => value === error);
      else { assert.deepEqual(await stream.next(), { value: finish, done: false }); assert.deepEqual(await stream.next(), { value: undefined, done: true }); }
      assert.equal(calls, 1); assert.equal(finalized, 1);
      await f.settle(); await tick();
      const post = f.executions.find(e => e.payload.hook_event_name === 'PostModelRequest');
      assert.ok(post);
      assert.equal(post.payload.token_usage, null);
      assert.ok(f.executions.filter(e => e.payload.hook_event_name === 'PreModelRequest').every(e => !Object.hasOwn(e.payload, 'token_usage')));
      assert.equal(post.payload.status, { success: 'stop', error: 'error', abort: 'aborted', close: 'closed' }[outcome]);
      for (const execution of f.executions) {
        assert.equal(execution.payload.session_id, f.session.id);
        for (const key of ['messages', 'system', 'tools', 'history', 'text', 'content', 'body']) assert.equal(Object.hasOwn(execution.payload, key), false);
        execution.resolve(completed('{"continue":false,"decision":"block","additionalContext":"must not inject"}', 2));
      }
      await tick();
      assert.equal(f.reads(), 0);
      assert.ok(f.manager.snapshot().records.every(record => !Object.hasOwn(record, 'policyOutcome')));
    } finally { await f.dispose(); }
  });
}

for (const outcome of ['success', 'error', 'abort', 'close', 'throw']) {
  test(`usage snapshots survive ${outcome}, mutation and invalid overwrite without changing chunks`, async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(), error = Error('usage-stream-error');
      const counts = { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER, totalTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 };
      const expected = { ...counts }, chunk = f.protect({ type: 'usage', usage: counts });
      const invalid = { type: 'usage', usage: { inputTokens: 9, outputTokens: 10, reasoningTokens: -1 } };
      const hostile = Object.defineProperty({ type: 'usage' }, 'usage', { get() { throw Error('usage getter invoked'); } });
      const descriptorTrap = new Proxy({ type: 'usage' }, { getOwnPropertyDescriptor() { throw Error('chunk descriptor'); } });
      let calls = 0, closed = 0;
      const stream = f.stream(f.options({ signal: controller.signal }), async function* () {
        calls++;
        try {
          yield { type: 'usage', usage: { inputTokens: 77, outputTokens: 88, totalTokens: 99 } };
          yield chunk;
          yield invalid; yield hostile; yield descriptorTrap;
          if (outcome === 'abort') controller.abort();
          if (outcome === 'error' || outcome === 'abort') throw error;
        } finally { closed++; }
      });
      await stream.next();
      assert.equal((await stream.next()).value, chunk);
      counts.inputTokens = 999; chunk.usage = { inputTokens: 888, outputTokens: 888 };
      if (outcome === 'close') await stream.return('closed');
      else if (outcome === 'throw') await assert.rejects(stream.throw(error), e => e === error);
      else {
        assert.equal((await stream.next()).value, invalid);
        assert.equal((await stream.next()).value, hostile);
        assert.equal((await stream.next()).value, descriptorTrap);
        if (outcome === 'success') assert.equal((await stream.next()).done, true);
        else await assert.rejects(stream.next(), e => e === error);
      }
      await f.settle(); await tick();
      const post = f.executions.find(e => e.payload.hook_event_name === 'PostModelRequest');
      assert.deepEqual(post.payload.token_usage, expected);
      assert.equal(calls, 1); assert.equal(closed, 1);
      assert.ok(f.executions.filter(e => e.payload.hook_event_name === 'PreModelRequest').every(e => !Object.hasOwn(e.payload, 'token_usage')));
      assert.ok(f.manager.snapshot().records.every(record => !Object.hasOwn(record, 'tokenUsage') && !Object.hasOwn(record, 'token_usage')));
    } finally { await f.dispose(); }
  });
}

test('model wrapper reads each chunk type only once', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const chunk = { get type() { reads++; return 'usage'; }, usage: { inputTokens: 1, outputTokens: 2 } };
    const stream = f.stream(f.options(), async function* () { yield chunk; });
    assert.equal((await stream.next()).value, chunk);
    assert.equal(reads, 1);
    assert.equal((await stream.next()).done, true);
    await f.settle(); await tick();
    assert.equal(reads, 1);
    assert.deepEqual(f.executions.find(e => e.payload.hook_event_name === 'PostModelRequest').payload.token_usage, { inputTokens: 1, outputTokens: 2 });
  } finally { await f.dispose(); }
});

test('queued usage is isolated per iterator and immutable while waiting', async () => {
  const f = await fixture();
  try {
    const originals = [];
    for (let i = 0; i < 4; i++) {
      const usage = { inputTokens: i, outputTokens: i + 1 }; originals.push(usage);
      await Array.fromAsync(f.stream(f.options(), async function* () {
        yield { type: 'usage', usage: { inputTokens: 99, outputTokens: 99, totalTokens: 198 } };
        yield { type: 'usage', usage };
      }));
    }
    await f.settle(); await tick(); assert.equal(f.executions.length, 4);
    originals.forEach(usage => { usage.inputTokens = 999; });
    f.executions.slice().forEach(e => e.resolve(completed()));
    await tick(); await tick(); await tick();
    assert.deepEqual(f.executions.filter(e => e.payload.hook_event_name === 'PostModelRequest').map(e => e.payload.token_usage), originals.map((_, i) => ({ inputTokens: i, outputTokens: i + 1 })));
  } finally { await f.dispose(); }
});

test('missing session and non-agent purpose preserve next without notification', async () => {
  const f = await fixture();
  try {
    for (const extra of [{ sessionId: '' }, { purpose: 'session-title' }, { purpose: 'compaction' }]) {
      const chunk = f.protect({ type: 'text-delta', index: 0 }); let calls = 0;
      const options = f.options(extra);
      assert.deepEqual(await Array.fromAsync(f.stream(options, async function* () { calls++; yield chunk; })), [chunk]);
      assert.equal(calls, 1);
    }
    await f.settle(); await tick(); assert.equal(f.executions.length, 0);
  } finally { await f.dispose(); }
});

test('model event pairs share the existing four-active thirty-two-pending queue', async () => {
  const f = await fixture();
  try {
    const chunk = f.protect({ type: 'text-delta', index: 0 });
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(await Array.fromAsync(f.stream(f.options(), async function* () { yield chunk; })), [chunk]);
    }
    await f.settle(); await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(record => record.status === 'busy').length, 4);
    let released = 0;
    for (let turns = 0; turns < 50 && released < 36; turns++) {
      while (released < f.executions.length) f.executions[released++].resolve(completed());
      await tick(); await tick();
    }
    assert.equal(released, 36);
    assert.equal(f.executions.length, 36);
    assert.equal(f.reads(), 0);
    assert.ok(f.executions.some(execution => execution.payload.hook_event_name === 'PreModelRequest'));
    assert.ok(f.executions.some(execution => execution.payload.hook_event_name === 'PostModelRequest'));
  } finally { await f.dispose(); }
});

for (const change of ['abort', 'agent-replacement', 'session-replacement', 'agent-absent', 'dispose']) {
  test(`queued model work rejects ${change} without changing yielded values`, async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(), chunk = f.protect({ type: 'text-delta', index: 0 });
      for (let i = 0; i < 4; i++) assert.deepEqual(await Array.fromAsync(f.stream(f.options({ signal: controller.signal }), async function* () { yield chunk; })), [chunk]);
      await f.settle(); await tick(); assert.equal(f.executions.length, 4);
      if (change === 'abort') controller.abort();
      else if (change === 'agent-replacement') f.agents.set(f.agent.id, { id: f.agent.id });
      else if (change === 'session-replacement') f.sessions.set(f.session.id, { id: f.session.id });
      else if (change === 'agent-absent') f.agents.delete(f.agent.id);
      else f.manager.cancelSession(f.session.id);
      for (const execution of f.executions) execution.resolve(completed());
      await tick(); await tick(); await tick();
      // Post notifications deliberately outlive the aborted request signal; only
      // queued Pre notifications inherit it. Session invalidation cancels both.
      assert.equal(f.executions.length, change === 'abort' ? 6 : 4);
      if (change === 'abort') assert.ok(f.executions.slice(4).every(execution => execution.payload.hook_event_name === 'PostModelRequest'));
      assert.ok(f.manager.snapshot().records.some(record => record.status === 'cancelled'));
    } finally { await f.dispose(); }
  });
}

test('captured session identity cannot be retargeted by mutable hand-built options', async () => {
  const f = await fixture();
  try {
    const options = { sessionId: f.session.id, provider: 'fixture', model: 'fake' };
    const chunk = f.protect({ type: 'text-delta', index: 0 });
    const stream = f.stream(options, async function* () { yield chunk; });
    assert.equal((await stream.next()).value, chunk);
    options.sessionId = 'submitted-other-session';
    assert.equal((await stream.next()).done, true);
    await f.settle(); await tick();
    assert.equal(f.executions.length, 2);
    assert.ok(f.executions.every(execution => execution.payload.session_id === f.session.id));
    f.agents.set(f.session.id, { id: f.session.id });
    for (const execution of f.executions) execution.resolve(completed());
  } finally { await f.dispose(); }
});

test('model request with no current live Agent cannot run async notifications', async () => {
  const f = await fixture();
  try {
    f.agents.clear();
    const chunk = f.protect({ type: 'text-delta', index: 0 });
    assert.deepEqual(await Array.fromAsync(f.stream(f.options(), async function* () { yield chunk; })), [chunk]);
    await f.settle(); await tick(); assert.equal(f.executions.length, 0);
  } finally { await f.dispose(); }
});
