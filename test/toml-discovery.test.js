import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoverCodexSources } from '../config-sources.js';

test('TOML discovery exposes only hooks JSON and hashes original bytes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-toml-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = 'model = "private-model"\n[credentials]\napi_key = "NEVER_EXPOSE_SENTINEL"\n[[hooks.PreToolUse]]\nmatcher = "Edit"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "echo inspect"\ntimeout = 10\n';
  await writeFile(path.join(directory, 'config.toml'), document);
  const result = await discoverCodexSources({ kind: 'user', directory });
  const source = result.sources[1];
  assert.equal(source.status, 'available');
  assert.deepEqual(Object.keys(JSON.parse(source.document)), ['hooks']);
  assert.equal(JSON.parse(source.document).hooks.PreToolUse[0].hooks[0].command, 'echo inspect');
  assert.equal(source.sha256, createHash('sha256').update(document).digest('hex'));
  assert.ok(!JSON.stringify(result).includes('NEVER_EXPOSE_SENTINEL'));
  assert.ok(!JSON.stringify(result).includes('private-model'));
});

test('missing or invalid TOML hooks return only fixed rejection codes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-toml-reject-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [document, code] of [['secret = "NEVER_EXPOSE_SENTINEL"', 'toml_hooks_missing'], ['secret = "NEVER_EXPOSE_SENTINEL', 'toml_invalid_document']]) {
    await writeFile(path.join(directory, 'config.toml'), document);
    const result = await discoverCodexSources({ kind: 'user', directory });
    assert.equal(result.sources[1].status, 'rejected');
    assert.equal(result.sources[1].code, code);
    assert.equal(result.sources[1].document, undefined);
    assert.equal(result.sources[1].sha256, undefined);
    assert.ok(!JSON.stringify(result).includes('NEVER_EXPOSE_SENTINEL'));
  }
});
