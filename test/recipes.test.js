import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditRecord } from '../examples/audit.mjs';
import { evaluate } from '../examples/command-policy.mjs';
import { notification } from '../examples/notify.mjs';
import { readEvent } from '../examples/event.mjs';
import { createHookManager } from '../core.js';
const event = { source: 'dsh', payload_version: 1, hook_event_name: 'PreToolUse', session_id: 'fixture', tool_name: 'ops_bash', timestamp: 1 };
const script = name => fileURLToPath(new URL(`../examples/${name}.mjs`, import.meta.url));
function cli(name, payload, args = []) { return spawnSync(process.execPath, [script(name), ...args], { input: JSON.stringify(payload) + '\n', encoding: 'utf8', timeout: 5000, env: {} }); }
test('audit recipe uses explicit metadata allowlist, never echoing input or arbitrary properties', () => {
  const row = auditRecord({ ...event, tool_input: { command: 'private' }, content: 'secret', credential: 'token' });
  assert.deepEqual(row, eventWithoutVersion());
  function eventWithoutVersion() { const { payload_version, ...result } = event; return result; }
});
test('audit CLI writes only to explicit temporary absolute destination', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hooks-recipe-'));
  try { const file = path.join(dir, 'audit.jsonl'); const result = cli('audit', { ...event, tool_input: { secret: 'must-not-store' } }, [file]); assert.equal(result.status, 0, result.stderr); const text = await readFile(file, 'utf8'); assert.equal(JSON.parse(text).hook_event_name, 'PreToolUse'); assert.ok(!text.includes('must-not-store')); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('policy recipe denies explicit illustrative patterns and missing consent', () => {
  for (const command of ['rm -rf /example', 'rm -fr /example', 'git push origin main --force', 'git push -f', 'Remove-Item C:/example -Recurse -Force']) assert.equal(evaluate({ ...event, tool_input: { command } }).hookSpecificOutput.permissionDecision, 'deny', command);
  assert.equal(evaluate(event).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(evaluate({ ...event, tool_input: { command: 'git status' } }).hookSpecificOutput.permissionDecision, 'allow');
});
test('real policy CLI output blocks through actual manager command runner', async () => {
  const rule = { id: 'policy-fixture', name: 'Policy fixture', event: 'PreToolUse', enabled: true, matcher: '*', includeToolInput: true, action: { type: 'command', executable: process.execPath, argv: [script('command-policy')], timeoutMs: 5000, maxOutputBytes: 4096 } };
  const manager = createHookManager({ initial: { enabled: true, rules: [rule] }, persist: async () => {} });
  const preview = await manager.previewTrust(rule.id); await manager.trust(rule.id, preview.digest); await manager.toggle(rule.id, true);
  try { const result = await manager.dispatchDecision('PreToolUse', { toolName: 'ops_bash', getToolInput: () => ({ command: 'rm -rf /example' }) }); assert.equal(result.blocked, true); assert.match(result.reason, /manual review/); assert.equal(manager.snapshot().records[0].stdout, ''); }
  finally { manager.dispose(); }
});
test('notification recipe filters events and does not leak input into OS arguments', () => {
  assert.equal(notification('mac', event), null);
  for (const mode of ['mac', 'linux', 'windows-sound']) { const args = notification(mode, { ...event, hook_event_name: 'Stop', tool_input: { private: 'hidden' } }); assert.ok(args.length); assert.ok(!JSON.stringify(args).includes('hidden')); }
});
test('recipe parser bounds stdin and rejects foreign protocols', async () => {
  assert.equal((await readEvent(Readable.from([JSON.stringify(event)]))).source, 'dsh');
  await assert.rejects(readEvent(Readable.from(['{"source":"codex"}'])), /invalid_dsh_event/);
  await assert.rejects(readEvent(Readable.from(['x'.repeat(70001)])), /event_too_large/);
});
