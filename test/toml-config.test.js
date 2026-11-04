import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { extractTomlHooks } from '../toml-config.js';

const rejectsCode = (document, code) => assert.rejects(extractTomlHooks(document), error => {
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  return true;
});

test('real parser extracts only hooks, including nested array tables', async () => {
  const result = await extractTomlHooks(`credential = "CREDENTIAL_SENTINEL"
created = 2025-01-01T00:00:00Z
[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "echo no-execution"
`);
  assert.equal(typeof result, 'string');
  assert.deepEqual(JSON.parse(result), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo no-execution' }] }] } });
  assert.ok(!result.includes('CREDENTIAL_SENTINEL'));
  assert.equal(await extractTomlHooks('[hooks]'), '{"hooks":{}}');
});

test('missing, invalid syntax and invalid hooks produce fixed errors', async () => {
  await rejectsCode('credential="PRIVATE_VALUE"', 'toml_hooks_missing');
  await rejectsCode('[hooks]\nsecret = "PRIVATE_VALUE', 'toml_invalid_document');
  for (const source of ['hooks = 1', 'hooks = []', 'hooks = "text"', 'hooks = 2025-01-01']) {
    await rejectsCode(source, 'toml_hooks_invalid');
  }
  await rejectsCode(null, 'toml_invalid_document');
  await rejectsCode(Buffer.from('[hooks]'), 'toml_invalid_document');
});

test('UTF-8 input and serialized output are independently bounded', async () => {
  await rejectsCode('#' + 'é'.repeat(131072), 'toml_document_too_large');
  const atLimit = '[hooks]\n#' + 'x'.repeat(262144 - 9);
  assert.equal(Buffer.byteLength(atLimit), 262144);
  assert.equal(await extractTomlHooks(atLimit), '{"hooks":{}}');
  // Literal backslashes are cheap TOML input but each doubles in JSON output.
  await rejectsCode("[hooks]\nvalue = '" + '\\'.repeat(140000) + "'", 'toml_hooks_too_large');
});

test('depth and node budgets are enforced before serialization', async () => {
  const nested = count => '[hooks]\nvalue = ' + '['.repeat(count) + '0' + ']'.repeat(count);
  await extractTomlHooks(nested(63));
  await rejectsCode(nested(64), 'toml_hooks_too_deep');
  await rejectsCode('[hooks]\nvalues = [' + Array(32768).fill('0').join(',') + ']', 'toml_hooks_too_many_nodes');
});

test('non-JSON TOML values and prototype hazard keys are rejected', async () => {
  for (const value of ['inf', '-inf', 'nan', '2025-01-01', '2025-01-01T00:00:00Z', '12:34:56', '9223372036854775807']) {
    await rejectsCode('[hooks]\nvalue = ' + value, 'toml_hooks_non_json');
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    await rejectsCode(`[hooks]\n"${key}" = "blocked"`, 'toml_hooks_unsafe_key');
  }
  assert.equal({}.blocked, undefined);
});

test('real workers leave no handles after successes and errors', () => {
  const moduleUrl = new URL('../toml-config.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { extractTomlHooks } from ${JSON.stringify(moduleUrl)};
    for (let i = 0; i < 3; i++) {
      await extractTomlHooks('[hooks]');
      try { await extractTomlHooks('[hooks'); } catch {}
    }
  `], { timeout: 8000, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});

test('hard timeout sanitizes failures and awaits worker cleanup', () => {
  // Inject only the Worker boundary in an isolated child: a real parser cannot be
  // made reliably slow without a flaky adversarial fixture or machine assumptions.
  const moduleUrl = new URL('../toml-config.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import threads from 'node:worker_threads';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    let terminated = false;
    threads.Worker = class extends EventEmitter {
      constructor(url, options) {
        super();
        assert.ok(options.resourceLimits.maxOldGenerationSizeMb <= 32);
        assert.ok(options.resourceLimits.stackSizeMb <= 2);
      }
      async terminate() {
        await new Promise(resolve => setTimeout(resolve, 20));
        terminated = true;
      }
    };
    syncBuiltinESMExports();
    const { extractTomlHooks } = await import(${JSON.stringify(moduleUrl)});
    const start = Date.now();
    await assert.rejects(extractTomlHooks('[hooks]'), { code: 'toml_timeout', message: 'toml_timeout' });
    assert.ok(Date.now() - start >= 2000);
    assert.ok(terminated);
  `], { timeout: 8000, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
