import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { previewCodexImport } from '../codex-import.js';
import { parseRule } from '../core.js';

const interpreter = { executable: path.resolve('trusted-interpreter'), argvPrefix: ['-NoProfile', '-NonInteractive', '-Command'] };
const options = { interpreter };
const command = 'echo "spaces; $(dangerous-command)" && echo \'unchanged\'';
const handler = extra => ({ type: 'command', command, timeout: 3, ...extra });
const doc = (handlers = [handler()], event = 'PreToolUse', matcher = '^Bash$') => ({ description: 'Review me', hooks: { [event]: [{ matcher, hooks: handlers }] } });

test('preview preserves shell text as one explicitly interpreted argument and never enables rules', () => {
  const original = doc();
  const result = previewCodexImport(original, options);
  assert.equal(result.rules.length, 1);
  assert.equal(result.unsupported.length, 0);
  const rule = result.rules[0];
  assert.deepEqual(rule.action.argv, [...interpreter.argvPrefix, command]);
  assert.equal(rule.enabled, false);
  assert.equal(rule.matcherMode, 'regex');
  assert.equal(rule.payloadMode, 'metadata');
  assert.equal(rule.source, 'codex-import');
  assert.equal(rule.review.pointer, '/hooks/PreToolUse/0/hooks/0');
  assert.equal(rule.review.definition.handler.command, command);
  assert.equal(rule.action.timeoutMs, 3000);
  assert.deepEqual(original, doc());
  assert.deepEqual(result, previewCodexImport(JSON.stringify(original), options));
  rule.review.definition.handler.command = 'changed';
  assert.equal(original.hooks.PreToolUse[0].hooks[0].command, command);
});

test('Stop true async imports explicitly and false/missing preserve legacy review IDs', () => {
  const result = previewCodexImport(JSON.stringify(doc([handler({ async: true, timeout: undefined })], 'Stop')), options);
  assert.deepEqual(result.unsupported, []);
  const rule = result.rules[0];
  assert.equal(rule.async, true); assert.equal(rule.payloadMode, 'metadata'); assert.equal(rule.enabled, false);
  assert.equal(rule.action.timeoutMs, 600000); assert.equal(Object.hasOwn(rule, 'trust'), false);
  assert.equal(rule.review.definition.handler.async, true);
  assert.equal(Object.hasOwn(rule.action, 'async'), false);
  for (const event of ['SessionEnd', 'SubagentStop']) {
    const rejected = previewCodexImport(doc([handler({ async: true })], event), options);
    assert.deepEqual(rejected.rules, []); assert.ok(rejected.unsupported[0].reasons.includes('unsupported_async'));
  }
  for (const value of [null, 0, 1, 'true', 'false', {}, []]) {
    const rejected = previewCodexImport(doc([handler({ async: value })], 'Stop'), options);
    assert.deepEqual(rejected.rules, []); assert.ok(rejected.unsupported[0].reasons.includes('unsupported_async'));
  }
  const ids = [];
  for (const extra of [{}, { async: false }]) {
    const legacy = previewCodexImport(doc([handler(extra)], 'Stop'), options).rules[0];
    assert.equal(Object.hasOwn(legacy, 'async'), false);
    assert.deepEqual(legacy.review.definition.handler, handler(extra));
    const expected = createHash('sha256').update(JSON.stringify({ review: legacy.review, scope: legacy.scope })).digest('hex').slice(0, 32);
    assert.equal(legacy.id, expected); ids.push(legacy.id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('requires explicit native absolute interpreter and does not silently split shell strings', () => {
  const result = previewCodexImport(doc());
  assert.equal(result.rules.length, 0);
  assert.ok(result.unsupported[0].reasons.includes('explicit_interpreter_required'));
  assert.equal(result.unsupported[0].definition.handler.command, command);
  for (const invalid of [{ executable: 'relative', argvPrefix: [] }, { executable: path.resolve('x.cmd'), argvPrefix: [] }, { executable: path.resolve('x.bat'), argvPrefix: [] }, { executable: interpreter.executable, argvPrefix: 'bad' }, { executable: interpreter.executable, argvPrefix: [1] }]) assert.throws(() => previewCodexImport(doc(), { interpreter: invalid }), /invalid_interpreter/);
});

test('platform defaults to the Host, selects its Windows override and rejects cross-platform previews', () => {
  const input = doc([handler({ commandWindows: 'Write-Output "windows"' })]);
  const expected = process.platform === 'win32' ? 'Write-Output "windows"' : command;
  assert.equal(previewCodexImport(input, options).rules[0].action.argv.at(-1), expected);
  assert.equal(previewCodexImport(input, { ...options, platform: process.platform }).rules[0].action.argv.at(-1), expected);
  const foreign = process.platform === 'win32' ? 'linux' : 'win32';
  assert.throws(() => previewCodexImport(input, { ...options, platform: foreign }), /platform_mismatch/);
  if (process.platform !== 'darwin') assert.throws(() => previewCodexImport(input, { ...options, platform: 'darwin' }), /platform_mismatch/);
  for (const platform of ['unexpected', '', null, 123]) assert.throws(() => previewCodexImport(input, { ...options, platform }), /invalid_platform/);
});

test('source identity participates in deterministic IDs and description survives every review outcome', () => {
  const input = doc([handler(), handler({ async: true })], 'SessionEnd');
  const first = previewCodexImport(input, { ...options, source: 'project-a' });
  const repeat = previewCodexImport(JSON.stringify(input), { ...options, source: 'project-a' });
  const second = previewCodexImport(input, { ...options, source: 'project-b' });
  assert.equal(first.rules[0].id, repeat.rules[0].id);
  assert.notEqual(first.rules[0].id, second.rules[0].id);
  assert.match(first.rules[0].id, /^[a-f0-9]{32}$/);
  assert.equal(first.rules[0].source, 'project-a');
  assert.equal(first.rules[0].review.source, 'project-a');
  assert.equal(first.rules[0].review.description, 'Review me');
  assert.equal(first.unsupported[0].source, 'project-a');
  assert.equal(first.unsupported[0].description, 'Review me');
  assert.equal(first.rules[0].enabled, false);
  assert.equal(previewCodexImport(input, options).rules[0].source, 'codex-import');
  const noDescription = { hooks: input.hooks };
  assert.equal(Object.hasOwn(previewCodexImport(noDescription, options).rules[0].review, 'description'), false);
  for (const source of ['', '   ', 'x'.repeat(257), null, 7, 'x\0y']) assert.throws(() => previewCodexImport(input, { ...options, source }), /invalid_source/);
});

test('options and interpreter are closed data objects and prefix arguments must be dense', () => {
  for (const invalid of [null, [], { future: true }, { interpreter, source: 'x', future: true }, Object.create({ source: 'inherited' })]) assert.throws(() => previewCodexImport(doc(), invalid), /invalid_options/);
  const getter = { get source() { throw new Error('getter must not run'); } };
  assert.throws(() => previewCodexImport(doc(), getter), /invalid_options/);
  const symbol = { [Symbol('hidden')]: true };
  assert.throws(() => previewCodexImport(doc(), symbol), /invalid_options/);
  const nonEnumerable = {}; Object.defineProperty(nonEnumerable, 'source', { value: 'hidden' });
  assert.throws(() => previewCodexImport(doc(), nonEnumerable), /invalid_options/);
  class ExecutingArray extends Array { *[Symbol.iterator]() { throw new Error('iterator must not run'); } }
  const customIterator = new ExecutingArray('-c');
  const decorated = ['-c']; decorated.extra = 'unreviewed';
  const accessed = ['-c']; Object.defineProperty(accessed, '0', { enumerable: true, get() { throw new Error('getter must not run'); } });
  for (const argvPrefix of [Array(1), ['-c', ...Array(1)], decorated, accessed, customIterator, Array(64).fill('-c'), ['x\0y']]) assert.throws(() => previewCodexImport(doc(), { interpreter: { ...interpreter, argvPrefix } }), /invalid_interpreter/);
  const interpreterGetter = { get executable() { throw new Error('getter must not run'); }, argvPrefix: [] };
  assert.throws(() => previewCodexImport(doc(), { interpreter: interpreterGetter }), /invalid_interpreter/);
  assert.throws(() => previewCodexImport(doc(), { interpreter: { ...interpreter, unknown: true } }), /invalid_interpreter/);
  const foreignPath = process.platform === 'win32' ? '/usr/bin/sh' : 'C:/Windows/System32/cmd.exe';
  assert.throws(() => previewCodexImport(doc(), { interpreter: { executable: foreignPath, argvPrefix: [] } }), /invalid_interpreter/);
  const maximal = previewCodexImport(doc(), { interpreter: { ...interpreter, argvPrefix: Array(63).fill('-c') } });
  assert.equal(maximal.rules[0].action.argv.length, 64);
});

test('accounts for every handler with pointers, rejecting unsupported fields and handler types', () => {
  const input = doc([handler(), handler({ async: true }), { type: 'mcp_tool', server: 'scanner', tool: 'scan' }, handler({ futureField: true }), { type: 'prompt', prompt: 'review' }, handler({ additionalContextLimit: 5000 }), handler({ statusMessage: 'Checking command' })]);
  const result = previewCodexImport(input, options);
  assert.equal(result.rules.length, 3);
  assert.equal(result.unsupported.length, 4);
  assert.equal(new Set([...result.rules.map(rule => rule.review.pointer), ...result.unsupported.map(item => item.pointer)]).size, 7);
  assert.ok(result.warnings.some(item => item.code === 'status_message_review_only'));
  assert.equal(result.rules[1].async, true);
  assert.equal(result.rules[1].enabled, false);
  assert.equal(result.rules[2].review.definition.handler.statusMessage, 'Checking command');
});

test('rejects unsupported event and group fields without dropping contained handlers', () => {
  const input = doc([handler(), handler()], 'NotAnEvent');
  input.hooks.NotAnEvent[0].future = true;
  const result = previewCodexImport(input, options);
  assert.equal(result.unsupported.length, 2);
  assert.ok(result.unsupported.every(item => item.reasons.includes('unsupported_event') && item.reasons.includes('unsupported_group_field:future')));
});

test('preserves Codex default 600 seconds and bounds imported event timeouts without truncation', () => {
  for (const timeout of [undefined, 31, 600]) {
    const result = previewCodexImport(JSON.stringify(doc([handler({ timeout })])), options);
    assert.equal(result.unsupported.length, 0);
    assert.equal(result.rules[0].action.timeoutMs, (timeout ?? 600) * 1000);
    assert.equal(result.rules[0].enabled, false);
  }
  for (const timeout of [601, 0, 1.5, '3']) {
    const result = previewCodexImport(JSON.stringify(doc([handler({ timeout })])), options);
    assert.ok(result.unsupported[0].reasons.includes('unsupported_timeout'));
  }
  for (const event of ['SessionEnd', 'Interrupt']) {
    assert.equal(previewCodexImport(JSON.stringify(doc([handler({ timeout: undefined })], event)), options).rules[0].action.timeoutMs, 1000);
    assert.equal(previewCodexImport(doc([handler({ timeout: 3 })], event), options).rules[0].action.timeoutMs, 3000);
    assert.ok(previewCodexImport(doc([handler({ timeout: 4 })], event), options).unsupported[0].reasons.includes('unsupported_timeout'));
  }
});

test('enforces JSON object shape, size and handler limit', () => {
  for (const input of ['{bad', '[]', null, { hooks: [] }, { hooks: {}, unknown: true }, { hooks: { PreToolUse: {} } }, { hooks: { PreToolUse: [{}] } }]) assert.throws(() => previewCodexImport(input, options));
  assert.throws(() => previewCodexImport(' '.repeat(256 * 1024 + 1)), /size_limit/);
  assert.throws(() => previewCodexImport({ hooks: {}, description: 'x'.repeat(256 * 1024) }), /size_limit/);
  assert.throws(() => previewCodexImport(doc(Array.from({ length: 101 }, () => handler())), options), /handler_limit/);
  assert.equal(previewCodexImport(doc(Array.from({ length: 100 }, () => handler())), options).rules.length, 100);
  const cyclic = {}; cyclic.hooks = cyclic;
  assert.throws(() => previewCodexImport(cyclic), /depth_limit/);
  assert.throws(() => previewCodexImport({ hooks: {}, get description() { throw Error('must not execute getter'); } }), /json_required/);
  class ExecutingArray extends Array { toJSON() { throw new Error('serializer must not run'); } }
  assert.throws(() => previewCodexImport({ hooks: { PreToolUse: new ExecutingArray() } }), /json_required/);
});

test('imports native-length regex matchers without altering review or granting trust', () => {
  const boundary = `^${'a'.repeat(510)}$`;
  const alternation = Array.from({ length: 24 }, (_, index) => `^Tool${index}$`).join('|');
  assert.equal(boundary.length, 512);
  assert.ok(alternation.length > 128 && alternation.length < 512);
  for (const matcher of [boundary, alternation]) {
    const input = doc([handler()], 'PreToolUse', matcher);
    const result = previewCodexImport(JSON.stringify(input), options);
    assert.deepEqual(result.unsupported, []);
    assert.equal(result.rules.length, 1);
    const rule = result.rules[0];
    assert.equal(rule.matcher, matcher);
    assert.deepEqual(rule.review, {
      source: 'codex-import', pointer: '/hooks/PreToolUse/0/hooks/0',
      definition: { event: 'PreToolUse', matcher, handler: handler() }, description: input.description,
    });
    const parsed = parseRule(JSON.parse(JSON.stringify(rule)));
    assert.equal(parsed.matcher, matcher);
    assert.equal(parsed.matcherMode, 'regex');
    assert.equal(parsed.enabled, false);
    assert.equal(Object.hasOwn(rule, 'trust'), false);
    assert.equal(Object.hasOwn(parsed, 'trust'), false);
    // Native parsing sanitizes review objects to null prototypes without changing JSON data.
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.review)), rule.review);
  }
});

test('rejects a 513-character matcher with its complete original review and no rules', () => {
  const matcher = `^${'a'.repeat(511)}$`;
  assert.equal(matcher.length, 513);
  const result = previewCodexImport(doc([handler()], 'PreToolUse', matcher), options);
  assert.deepEqual(result.rules, []);
  assert.deepEqual(result.unsupported, [{
    source: 'codex-import', pointer: '/hooks/PreToolUse/0/hooks/0',
    definition: { event: 'PreToolUse', matcher, handler: handler() },
    description: 'Review me', reasons: ['invalid_matcher'],
  }]);
});

test('matcher text checks reject real NUL but preserve an escaped regex NUL', () => {
  const actualNul = String.fromCharCode(0);
  const rejected = previewCodexImport(doc([handler()], 'PreToolUse', actualNul), options);
  assert.deepEqual(rejected.rules, []);
  assert.deepEqual(rejected.unsupported[0].reasons, ['invalid_matcher']);
  assert.equal(rejected.unsupported[0].definition.matcher, actualNul);
  const escapedNul = String.fromCharCode(92, 48);
  const accepted = previewCodexImport(doc([handler()], 'PreToolUse', escapedNul), options);
  assert.deepEqual(accepted.unsupported, []);
  assert.equal(accepted.rules[0].matcher, escapedNul);
});

test('oversized matchers are not compiled and syntax validation compiles only once', () => {
  const NativeRegExp = globalThis.RegExp;
  const compiled = [];
  globalThis.RegExp = function (pattern, flags) {
    compiled.push(pattern);
    return new NativeRegExp(pattern, flags);
  };
  try {
    for (const matcher of ['a'.repeat(513), '['.repeat(200000)]) {
      const result = previewCodexImport(doc([handler()], 'PreToolUse', matcher), options);
      assert.deepEqual(result.rules, []);
      assert.deepEqual(result.unsupported[0].reasons, ['invalid_matcher']);
    }
    assert.deepEqual(compiled, []);
    const invalid = previewCodexImport(doc([handler()], 'PreToolUse', '['), options);
    assert.deepEqual(invalid.unsupported[0].reasons, ['invalid_matcher_regex']);
    assert.deepEqual(compiled, ['[']);
    assert.equal(previewCodexImport(doc(), options).rules.length, 1);
    assert.deepEqual(compiled, ['[', '^Bash$']);
  } finally {
    globalThis.RegExp = NativeRegExp;
  }
});

test('empty/missing/all matcher accepts; invalid regex remains unsupported', () => {
  for (const matcher of ['', '*', '^Bash$|^mcp__.*$']) assert.equal(previewCodexImport(doc([handler()], 'PreToolUse', matcher), options).rules.length, 1);
  const missing = doc();
  delete missing.hooks.PreToolUse[0].matcher;
  assert.equal(previewCodexImport(missing, options).rules[0].matcher, '*');
  const invalid = previewCodexImport(doc([handler()], 'PreToolUse', '['), options);
  assert.deepEqual(invalid.rules, []);
  assert.deepEqual(invalid.unsupported[0].reasons, ['invalid_matcher_regex']);
  assert.equal(invalid.unsupported[0].definition.matcher, '[');
});
