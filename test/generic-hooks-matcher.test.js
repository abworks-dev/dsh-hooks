import test from 'node:test';
import assert from 'node:assert/strict';
import { matchEvent, validateMatcher } from '../matcher.js';

const tool = (pattern, toolName, mode = 'regex', signal) => matchEvent({ event: 'PreToolUse', pattern, mode, metadata: { toolName }, signal });

test('validation is synchronous, bounded and checks syntax without executing regex', () => {
  assert.equal(validateMatcher('(a+)+$', 'regex'), '(a+)+$');
  for (const pattern of ['', '*', 'Read|Write']) assert.equal(validateMatcher(pattern, 'regex'), pattern);
  for (const pattern of [null, {}, 1, 'a'.repeat(513)]) assert.throws(() => validateMatcher(pattern, 'regex'), /invalid_hook_matcher/);
  assert.throws(() => validateMatcher('[' , 'regex'), /invalid_hook_matcher/);
  assert.throws(() => validateMatcher('*', 'other'), /invalid_hook_matcher_mode/);
  assert.throws(() => validateMatcher('Read|Write'), /invalid_hook_matcher/);
});

test('regex alternation is unanchored and match-all sentinels work', async () => {
  assert.equal(await tool('Read|Write', 'fsReadFile'), true);
  assert.equal(await tool('^Read$', 'fsReadFile'), false);
  assert.equal(await tool('Read|Write', 'Bash'), false);
  for (const pattern of ['', '*']) assert.equal(await tool(pattern, 'Bash'), true);
});

test('tool aliases include both original names and Codex names', async () => {
  for (const [name, patterns] of [['apply_patch', ['^apply_patch$', '^Edit$', '^Write$']], ['spawn_agent', ['^spawn_agent$', '^Agent$']]]) {
    for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
      for (const pattern of patterns) assert.equal(await matchEvent({ event, pattern, mode: 'regex', metadata: { toolName: name } }), true);
    }
  }
  assert.equal(await tool('Agent', 'apply_patch'), false);
  assert.equal(await tool('Edit', 'apply_patch', 'glob'), true);
});

test('event-specific matching fields and unmatched/unknown events', async () => {
  const fields = { SessionStart: 'source', SessionEnd: 'reason', PreCompact: 'trigger', PostCompact: 'trigger', SubagentStart: 'agentType', SubagentStop: 'agentType' };
  for (const [event, field] of Object.entries(fields)) {
    assert.equal(await matchEvent({ event, pattern: '^expected$', mode: 'regex', metadata: { [field]: 'expected', toolName: 'wrong' } }), true);
    assert.equal(await matchEvent({ event, pattern: '^expected$', mode: 'regex', metadata: { [field]: 'wrong', toolName: 'expected' } }), false);
  }
  for (const event of ['UserPromptSubmit', 'Stop', 'Interrupt', 'PreModelRequest', 'PostModelRequest']) {
    assert.equal(await matchEvent({ event, pattern: 'never', mode: 'regex' }), true);
  }
  assert.equal(await matchEvent({ event: 'unknown', pattern: '*' }), false);
  await assert.rejects(tool('*', 'a'.repeat(513)), /invalid_hook_matcher_target/);
});

test('legacy glob is whole-string DP with literal dots and no regex alternation', async () => {
  for (const [pattern, name, expected] of [['*', '', true], ['read*', 'read_file', true], ['read?', 'reads', true], ['read?', 'read', false], ['a.b', 'axb', false], ['a.b', 'a.b', true], ['Read', 'xRead', false], ['*a*b?', 'xaaybz', true]]) {
    assert.equal(await tool(pattern, name, 'glob'), expected, `${pattern}: ${name}`);
  }
});

test('catastrophic regex times out while main thread stays responsive; workers stop', { timeout: 8000 }, async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 20);
  try {
    await assert.rejects(tool('^(a+)+$', `${'a'.repeat(500)}!`), error => error.code === 'hook_matcher_timeout');
    assert.equal(ticked, true);
    assert.equal(await tool('Read', 'Read'), true);
  } finally { clearTimeout(timer); }
});

test('abort before and during worker execution rejects and cleans up', { timeout: 8000 }, async () => {
  const early = new AbortController(); early.abort();
  await assert.rejects(tool('Read', 'Read', 'regex', early.signal), { name: 'AbortError' });
  const active = new AbortController();
  const timer = setTimeout(() => active.abort(), 50);
  try { await assert.rejects(tool('^(a+)+$', `${'a'.repeat(500)}!`, 'regex', active.signal), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert.equal(await tool('Read', 'Read'), true);
});
