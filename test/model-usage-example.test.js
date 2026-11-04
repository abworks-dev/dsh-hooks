import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../examples/model-usage.mjs', import.meta.url));
const event = { source: 'dsh', hook_event_name: 'PostModelRequest', payload_version: 1, timestamp: 123, status: 'stop', token_usage: { inputTokens: 5, outputTokens: 3 } };
const run = (input, args) => spawnSync(process.execPath, [script, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-usage-example-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'usage.jsonl');
}
function success(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

test('usage example appends real JSONL containing only safe metadata/counts', async t => {
  const log = await fixture(t);
  const token_usage = { ...event.token_usage, totalTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 1, reasoningTokens: 2, private: 'SECRET', nested: { prompt: 'SECRET' } };
  success(run({ ...event, token_usage, prompt: 'SECRET', body: 'SECRET', response: 'SECRET', tool_input: 'SECRET', error: 'SECRET', provider: 'SECRET', model: 'SECRET', session_id: 'SECRET' }, [log]));
  success(run({ ...event, token_usage: null, status: 'SECRET' }, [log]));
  const text = await readFile(log, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.equal(text.includes('SECRET'), false);
  assert.deepEqual(text.trim().split('\n').map(JSON.parse), [
    { hook_event_name: 'PostModelRequest', source: 'dsh', token_usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 1, reasoningTokens: 2 }, payload_version: 1, timestamp: 123, status: 'stop' },
    { hook_event_name: 'PostModelRequest', source: 'dsh', token_usage: null, payload_version: 1, timestamp: 123 },
  ]);
});

test('usage example rejects invalid events/counts and oversized input without creating a log', async t => {
  const log = await fixture(t);
  const invalid = [
    '{"SECRET":', 'null', '[]', '',
    { ...event, source: 'other' }, { ...event, hook_event_name: 'PreModelRequest' },
    { ...event, token_usage: undefined }, { ...event, token_usage: [] },
    ...[{}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1.2, outputTokens: 1 }, { inputTokens: 'SECRET', outputTokens: 1 }, { inputTokens: 1, outputTokens: Number.MAX_SAFE_INTEGER + 1 }, { ...event.token_usage, reasoningTokens: null }].map(token_usage => ({ ...event, token_usage })),
    JSON.stringify({ ...event, prompt: 'SECRET'.repeat(12000) }),
  ];
  for (const input of invalid) {
    const result = run(input, [log]);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'model_usage_failed\n');
    await assert.rejects(stat(log), { code: 'ENOENT' });
  }
});

test('usage example requires one explicit absolute destination and hides filesystem errors', async t => {
  const log = await fixture(t);
  for (const args of [[], ['relative-SECRET.jsonl'], [log, 'SECRET'], [join(log, 'SECRET')]]) {
    const result = run(event, args);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'model_usage_failed\n');
    await assert.rejects(stat(log), { code: 'ENOENT' });
  }
});
