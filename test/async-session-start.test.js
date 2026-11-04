import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager, EVENTS } from '../core.js';
import { bindEvents } from '../index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const completed = (stdout = '', exitCode = 0) => ({ status: 'completed', exitCode, stdout, stderr: '' });
const definition = { id: 'start', name: 'Session start notification', event: 'SessionStart', async: true, action: { type: 'command', executable: process.execPath } };

async function fixture(extra = {}, directory = () => process.cwd()) {
  const executions = [], listeners = new Map(), warnings = [];
  let reads = 0;
  const forbidden = () => { reads++; throw Error('private_session_start_read'); };
  const privateFields = { get message() { return forbidden(); }, get arguments() { return forbidden(); }, get input() { return forbidden(); } };
  const agent = Object.defineProperties({ id: 'session' }, Object.getOwnPropertyDescriptors(privateFields));
  const session = { id: agent.id, get snapshotEvents() { return forbidden(); }, get ownEvents() { return forbidden(); }, get header() { return forbidden(); }, get deriveMessages() { return forbidden(); } };
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[session.id, session]]);
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }),
    execute(_action, payload, { signal }) { return new Promise(resolve => executions.push({ payload, signal, resolve })); },
  });
  await manager.upsert({ ...definition, ...extra });
  await manager.trust(definition.id, (await manager.previewTrust(definition.id)).digest);
  await manager.toggle(definition.id, true);
  await manager.configure({ enabled: true });
  const dispatches = [];
  const dispatch = manager.dispatch.bind(manager);
  manager.dispatch = (...args) => { const promise = dispatch(...args); dispatches.push(promise); return promise; };
  const off = bindEvents({
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    agents: { list: () => [...agents.values()], get: id => agents.get(id) },
    sessions: { get: id => sessions.get(id) },
    workingDirectory: { get: value => { assert.equal(value, session); return directory(); } },
    logger: { warn: (...args) => warnings.push(args) },
  }, manager);
  return { manager, executions, listeners, warnings, agent, session, agents, sessions, reads: () => reads, settleDispatch: () => Promise.all(dispatches),
    emit(source = 'startup', signal) {
      const payload = Object.defineProperties({ agent, source, signal }, Object.getOwnPropertyDescriptors(privateFields));
      return listeners.get('agent/created')(payload);
    },
    async dispose() { off(); manager.dispose(); for (const execution of executions) execution.resolve(completed()); await tick(); },
  };
}

test('actual created binding returns undefined before deferred execution for all four metadata-only sources; output never injects or vetoes', async () => {
  const event = EVENTS.find(event => event.name === 'SessionStart');
  assert.equal(event.blocking, false);
  assert.ok(event.timing.includes('not an initialization barrier'));
  const f = await fixture();
  try {
    const sources = ['startup', 'resume', 'clear', 'compact'];
    const outputs = [
      completed('{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"do not inject"}}'),
      completed('{"continue":false,"stopReason":"do not stop"}'),
      completed('deny', 2),
      completed('{invalid json'),
    ];
    for (const [index, source] of sources.entries()) {
      assert.equal(f.emit(source), undefined);
      assert.equal(f.executions.length, index);
      await tick();
      assert.equal(f.executions.length, index + 1);
      const execution = f.executions[index];
      assert.deepEqual(Object.keys(execution.payload).sort(), ['hook_event_name', 'payload_version', 'session_id', 'session_source', 'source', 'timestamp', 'tool_name']);
      assert.equal(execution.payload.hook_event_name, 'SessionStart');
      assert.equal(execution.payload.session_source, source);
      assert.equal(execution.payload.session_id, f.session.id);
      assert.equal(execution.payload.source, 'dsh');
      assert.equal(f.manager.snapshot().records.length, index);
      execution.resolve(outputs[index]);
      await tick();
      const record = f.manager.snapshot().records[0];
      assert.equal(record.status, 'completed');
      assert.equal(record.exitCode, outputs[index].exitCode);
      assert.equal(Object.hasOwn(record, 'policyOutcome'), false);
    }
    assert.equal(f.reads(), 0);
    assert.deepEqual(f.warnings, []);
  } finally { await f.dispose(); }
});

test('three notification events share one bounded FIFO queue without reading private payloads', async () => {
  const f = await fixture();
  try {
    for (const event of ['Stop', 'UserPromptSubmit']) {
      const id = event.toLowerCase();
      await f.manager.upsert({ ...definition, id, event });
      await f.manager.trust(id, (await f.manager.previewTrust(id)).digest);
      await f.manager.toggle(id, true);
    }
    const expected = [];
    for (let i = 0; i < 37; i++) {
      const event = ['SessionStart', 'Stop', 'UserPromptSubmit'][i % 3];
      expected.push(event);
      if (event === 'SessionStart') assert.equal(f.emit('startup'), undefined);
      else assert.equal(f.listeners.get(event === 'Stop' ? 'agent/status' : 'agent/inbox/inserted')({ agent: f.agent, status: 'idle' }), undefined);
    }
    await f.settleDispatch();
    await waitFor(() => f.executions.length === 4);
    assert.deepEqual(f.executions.map(e => e.payload.hook_event_name), expected.slice(0, 4));
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'busy').length, 1);
    for (let index = 0; index < 32; index++) {
      f.executions[index].resolve(completed());
      await waitFor(() => f.executions.length === index + 5);
      assert.equal(f.executions[index + 4].payload.hook_event_name, expected[index + 4]);
    }
    assert.equal(f.executions.length, 36);
    for (const execution of f.executions.slice(32)) execution.resolve(completed());
    await tick(); await tick();
    assert.equal(f.executions.length, 36);
    assert.equal(f.reads(), 0);
    assert.deepEqual(f.warnings, []);
  } finally { await f.dispose(); }
});

test('SessionStart matcher selects source, serialized as session_source, not private fields', async () => {
  const f = await fixture({ matcher: 'res*' });
  try {
    for (const source of ['startup', 'resume', 'clear', 'compact']) assert.equal(f.emit(source), undefined);
    await tick(); await tick();
    assert.deepEqual(f.executions.map(e => e.payload.session_source), ['resume']);
    assert.equal(f.reads(), 0);
  } finally { await f.dispose(); }
});

test('SessionStart project scope uses the event-time Host directory snapshot', async () => {
  let current = process.cwd(), reads = 0;
  const f = await fixture({ scope: { kind: 'project', root: process.cwd() } }, () => { reads++; return current; });
  try {
    assert.equal(f.emit(), undefined);
    assert.equal(reads, 1);
    current = join(tmpdir(), 'never-used-after-event');
    await waitFor(() => f.executions.length === 1);
    assert.equal(f.executions.length, 1);
    assert.equal(reads, 1);
    f.executions[0].resolve(completed());
    await tick();
  } finally { await f.dispose(); }
});

test('SessionStart project mismatch and unavailable Host directory cannot execute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-start-scope-'));
  try {
    for (const unavailable of [false, true]) {
      const f = await fixture({ scope: { kind: 'project', root } }, () => unavailable ? undefined : process.cwd());
      try {
        assert.equal(f.emit(), undefined);
        await f.settleDispatch();
        assert.equal(f.executions.length, 0);
        const records = f.manager.snapshot().records;
        if (unavailable) assert.equal(records[0]?.status, 'scope_unavailable');
        else assert.deepEqual(records, []);
        assert.equal(f.reads(), 0);
      } finally { await f.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('factory signal abort cancels active and queued SessionStart without running queued commands', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    for (let i = 0; i < 6; i++) assert.equal(f.emit('startup', controller.signal), undefined);
    await tick();
    assert.equal(f.executions.length, 4);
    controller.abort();
    assert.ok(f.executions.every(e => e.signal.aborted));
    // External abort discards queued jobs when capacity next becomes available;
    // active capacity remains occupied until the executor actually settles.
    assert.equal(f.executions.length, 4);
    for (const execution of f.executions) execution.resolve({ ...completed(), status: 'cancelled' });
    await tick(); await tick();
    assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 6);
    assert.equal(f.reads(), 0);
  } finally { await f.dispose(); }
});

for (const identity of ['Agent', 'Session']) {
  test(`queued SessionStart rejects replaced ${identity} identity before execute`, async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 6; i++) f.emit();
      await tick();
      assert.equal(f.executions.length, 4);
      (identity === 'Agent' ? f.agents : f.sessions).set(f.agent.id, { id: f.agent.id });
      for (const execution of f.executions) execution.resolve(completed());
      await tick(); await tick();
      assert.equal(f.executions.length, 4);
      assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 2);
      assert.equal(f.reads(), 0);
    } finally { await f.dispose(); }
  });
}

for (const disposal of ['agent', 'manager']) {
  test(`${disposal} disposal cancels active and queued SessionStart; unbinding removes listeners`, async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 6; i++) f.emit();
      await tick();
      assert.equal(f.executions.length, 4);
      if (disposal === 'agent') assert.equal(f.listeners.get('agent/disposed')({ agent: f.agent }), undefined);
      else f.manager.dispose();
      assert.ok(f.executions.every(e => e.signal.aborted));
      assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 2);
      for (const execution of f.executions) execution.resolve({ ...completed(), status: 'cancelled' });
      await tick(); await tick();
      assert.equal(f.executions.length, 4);
      assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 6);
    } finally { await f.dispose(); }
    assert.equal(f.listeners.size, 0);
    assert.equal(f.reads(), 0);
  });
}
