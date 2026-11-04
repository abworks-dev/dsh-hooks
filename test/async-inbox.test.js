import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager } from '../core.js';
import { bindEvents } from '../index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const definition = { id: 'inbox', name: 'Inbox notification', event: 'UserPromptSubmit', async: true, action: { type: 'command', executable: process.execPath } };
const completed = stdout => ({ status: 'completed', exitCode: 0, stdout, stderr: '' });

async function fixture() {
  const executions = [], warnings = [], listeners = new Map();
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }),
    execute(_action, payload, { signal }) { return new Promise(resolve => executions.push({ payload, signal, resolve })); },
  });
  await manager.upsert(definition);
  await manager.trust(definition.id, (await manager.previewTrust(definition.id)).digest);
  await manager.toggle(definition.id, true);
  await manager.configure({ enabled: true });
  const agent = { id: 'session' }, session = { id: 'session' };
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[session.id, session]]);
  const off = bindEvents({
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    agents: { list: () => [...agents.values()], get: id => agents.get(id) },
    sessions: { get: id => sessions.get(id) },
    workingDirectory: { get: () => process.cwd() },
    logger: { warn: (...args) => warnings.push(args) },
  }, manager);
  let reads = 0;
  const forbidden = () => { reads++; throw new Error('private_input_read'); };
  const payload = { agent, get message() { return forbidden(); }, get arguments() { return forbidden(); }, get input() { return forbidden(); } };
  return { manager, executions, warnings, listeners, agent, session, agents, sessions, payload, reads: () => reads,
    emit: (value = payload) => listeners.get('agent/inbox/inserted')(value),
    async dispose() { off(); manager.dispose(); for (const execution of executions) execution.resolve(completed('')); await tick(); },
  };
}

test('actual inbox binding returns immediately, executes metadata only, and ignores all asynchronous output controls', async () => {
  const f = await fixture();
  try {
    const outputs = [
      completed('{"decision":"block","reason":"deny"}'),
      completed('{"continue":false,"stopReason":"stop"}'),
      completed('{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"secret"}}'),
      completed('{invalid json'),
      { ...completed('deny'), exitCode: 2 },
    ];
    for (const [index, output] of outputs.entries()) {
      assert.equal(f.emit(), undefined); // Host emission does not await a queued command.
      assert.equal(f.executions.length, index);
      await tick();
      assert.equal(f.executions.length, index + 1);
      const execution = f.executions[index];
      assert.equal(execution.signal.aborted, false);
      assert.deepEqual(Object.keys(execution.payload).sort(), ['hook_event_name', 'payload_version', 'session_id', 'source', 'timestamp', 'tool_name']);
      assert.equal(execution.payload.hook_event_name, 'UserPromptSubmit');
      assert.equal(execution.payload.session_id, f.session.id);
      assert.equal(f.manager.snapshot().records.length, index); // Still pending after emission returned.
      execution.resolve(output);
      await tick();
      const record = f.manager.snapshot().records[0];
      assert.equal(record.status, 'completed'); // No output parsing, even for invalid JSON or context.
      assert.equal(record.exitCode, output.exitCode);
      assert.equal(Object.hasOwn(record, 'policyOutcome'), false);
    }
    assert.equal(f.reads(), 0);
    assert.deepEqual(f.warnings, []);
  } finally { await f.dispose(); }
});

test('inbox notifications share the bounded queue and disposal cancels active and pending work', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 37; i++) assert.equal(f.emit(), undefined);
    await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(record => record.status === 'busy').length, 1);
    f.manager.dispose();
    assert.ok(f.executions.every(execution => execution.signal.aborted));
    assert.equal(f.manager.snapshot().records.filter(record => record.status === 'cancelled').length, 32);
    for (const execution of f.executions) execution.resolve({ status: 'cancelled', exitCode: null, stdout: '', stderr: '' });
    await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(record => record.status === 'cancelled').length, 36);
    assert.equal(f.reads(), 0);
  } finally { await f.dispose(); }
});

test('Stop and inbox bindings share one four-active thirty-two-pending budget', async () => {
  const f = await fixture();
  try {
    const stop = { ...definition, id: 'stop', event: 'Stop' };
    await f.manager.upsert(stop);
    await f.manager.trust(stop.id, (await f.manager.previewTrust(stop.id)).digest);
    await f.manager.toggle(stop.id, true);
    for (let i = 0; i < 37; i++) {
      if (i % 2) assert.equal(f.listeners.get('agent/status')({ agent: f.agent, status: 'idle' }), undefined);
      else assert.equal(f.emit(), undefined);
    }
    await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.executions.filter(e => e.payload.hook_event_name === 'Stop').length, 2);
    assert.equal(f.executions.filter(e => e.payload.hook_event_name === 'UserPromptSubmit').length, 2);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'busy').length, 1);
    f.manager.dispose();
    assert.ok(f.executions.every(e => e.signal.aborted));
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 32);
    for (const execution of f.executions) execution.resolve(completed(''));
    await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.reads(), 0);
  } finally { await f.dispose(); }
});

test('disposing one session preserves another session mixed-event work', async () => {
  const f = await fixture();
  try {
    await f.manager.upsert({ ...definition, id: 'stop', event: 'Stop' });
    await f.manager.trust('stop', (await f.manager.previewTrust('stop')).digest);
    await f.manager.toggle('stop', true);
    const other = { id: 'other' };
    f.agents.set(other.id, other); f.sessions.set(other.id, { id: other.id });
    f.listeners.get('agent/created')({ agent: other }); // Establish exact Agent/Session binding, as the Host does.
    const emit = i => {
      const agent = i % 2 ? other : f.agent;
      if (i % 4 === 1 || i % 4 === 2) f.listeners.get('agent/status')({ agent, status: 'idle' });
      else f.emit({ agent });
    };
    for (let i = 0; i < 8; i++) emit(i);
    await tick();
    assert.equal(f.executions.length, 4);
    f.listeners.get('agent/disposed')({ agent: f.agent });
    for (const e of f.executions) assert.equal(e.signal.aborted, e.payload.session_id === f.agent.id);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 2);
    for (const e of [...f.executions]) e.resolve(completed(''));
    await tick(); await tick();
    assert.equal(f.executions.length, 6);
    const continued = f.executions.slice(4);
    assert.ok(continued.every(e => e.payload.session_id === other.id && !e.signal.aborted));
    assert.deepEqual(continued.map(e => e.payload.hook_event_name).sort(), ['Stop', 'UserPromptSubmit']);
    for (const e of continued) e.resolve(completed(''));
    await tick();
    assert.equal(f.reads(), 0);
  } finally { await f.dispose(); }
});

test('configuration writes invalidate both queued event types but fresh notifications still execute', async () => {
  const f = await fixture();
  try {
    await f.manager.upsert({ ...definition, id: 'stop', event: 'Stop' });
    await f.manager.trust('stop', (await f.manager.previewTrust('stop')).digest);
    await f.manager.toggle('stop', true);
    const emit = i => i % 2 ? f.listeners.get('agent/status')({ agent: f.agent, status: 'idle' }) : f.emit();
    for (let i = 0; i < 6; i++) emit(i);
    await tick();
    assert.equal(f.executions.length, 4);
    await f.manager.configure({ enabled: true }); // Even an unchanged write conservatively replaces captured identities.
    for (const e of [...f.executions]) e.resolve(completed(''));
    await tick(); await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'trust_error').length, 2);
    emit(0); emit(1);
    await tick();
    assert.equal(f.executions.length, 6);
    assert.deepEqual(f.executions.slice(4).map(e => e.payload.hook_event_name).sort(), ['Stop', 'UserPromptSubmit']);
    for (const e of f.executions.slice(4)) e.resolve(completed(''));
    await tick();
  } finally { await f.dispose(); }
});

for (const replacement of ['Agent', 'Session']) {
  test(`queued inbox notification rejects reused ${replacement} identity`, async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 5; i++) f.emit();
      await tick();
      assert.equal(f.executions.length, 4);
      if (replacement === 'Agent') f.agents.set(f.agent.id, { id: f.agent.id });
      else f.sessions.set(f.session.id, { id: f.session.id });
      for (const execution of f.executions) execution.resolve(completed(''));
      await tick(); await tick();
      assert.equal(f.executions.length, 4);
      assert.equal(f.manager.snapshot().records.filter(record => record.status === 'cancelled').length, 1);
      f.emit(); // Stale Agent cannot enqueue another notification against a reused ID.
      await tick();
      assert.equal(f.executions.length, 4);
      assert.equal(f.reads(), 0);
    } finally { await f.dispose(); }
  });
}

test('agent disposal binding aborts active inbox commands and cancels pending notifications', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) f.emit();
    await tick();
    f.listeners.get('agent/disposed')({ agent: f.agent });
    assert.ok(f.executions.every(execution => execution.signal.aborted));
    assert.equal(f.manager.snapshot().records.filter(record => record.status === 'cancelled').length, 1);
    for (const execution of f.executions) execution.resolve({ status: 'cancelled', exitCode: null, stdout: '', stderr: '' });
    await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.reads(), 0);
  } finally { await f.dispose(); }
});
