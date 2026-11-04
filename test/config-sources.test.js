import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoverCodexSources, parseSourceRequest } from '../config-sources.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('strict closed requests reject accessors without invoking them', () => {
  let invoked = false;
  const getter = { kind: 'user', get directory() { invoked = true; return '/'; } };
  for (const value of [null, [], {}, getter, { kind: 'user', directory: 'relative' },
    { kind: 'other', directory: '/' }, { kind: 'user', directory: '/', extra: true },
    { kind: 'user', directory: '/'.repeat(4097) }, { kind: 'user', directory: '/\0' },
    Object.assign(Object.create({}), { kind: 'user', directory: '/' }),
    { kind: 'user', directory: '/', [Symbol()]: true }]) {
    assert.throws(() => parseSourceRequest(value), { message: 'invalid_request' });
  }
  assert.equal(invoked, false);
  assert.deepEqual(parseSourceRequest({ kind: 'user', directory: path.resolve('/') }), { kind: 'user', directory: path.resolve('/') });
});

test('Windows device namespaces, reserved devices and alternate data streams are rejected', { skip: process.platform !== 'win32' }, () => {
  for (const directory of [String.raw`\\?\C:\selected`, String.raw`\\.\C:\selected`,
    '/selected', String.raw`\selected`, '//server', 'C:/selected:stream', 'C:/NUL', 'C:/COM1.txt']) {
    assert.throws(() => parseSourceRequest({ kind: 'user', directory }), { code: 'invalid_request' });
  }
  assert.equal(parseSourceRequest({ kind: 'user', directory: 'C:/selected' }).directory, 'C:/selected');
  assert.equal(parseSourceRequest({ kind: 'user', directory: '//server/share/selected' }).directory, '//server/share/selected');
});

test('user means selected CODEX_HOME itself; only two fixed candidates and exact content hash', async (t) => {
  const root = await fixture(t);
  const document = '{"hooks": {"danger": "never executed"}}\n';
  await writeFile(path.join(root, 'hooks.json'), document);
  await mkdir(path.join(root, '.codex'));
  await writeFile(path.join(root, '.codex', 'hooks.json'), 'wrong location');
  await writeFile(path.join(root, 'unrelated.json'), 'ignore');
  const result = await discoverCodexSources({ kind: 'user', directory: root });
  assert.equal(result.directory, await realpath(root));
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources[0], { path: path.join(result.directory, 'hooks.json'), format: 'json', status: 'available', document,
    sha256: createHash('sha256').update(document).digest('hex') });
  assert.deepEqual(result.sources[1], { path: path.join(result.directory, 'config.toml'), format: 'toml', status: 'missing' });
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('Windows case-insensitive fixed candidates remain available', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.CODEX'));
  await writeFile(path.join(root, '.CODEX', 'HOOKS.JSON'), 'case-insensitive document');
  const result = await discoverCodexSources({ kind: 'project', directory: root });
  assert.equal(result.sources[0].status, 'available');
  assert.equal(result.sources[0].document, 'case-insensitive document');
});

test('project probes .codex only; TOML shares bounded file reads', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'hooks.json'), 'not selected');
  await mkdir(path.join(root, '.codex'));
  await writeFile(path.join(root, '.codex', 'hooks.json'), 'not even parsed as JSON');
  await writeFile(path.join(root, '.codex', 'config.toml'), Buffer.alloc(300000, 255));
  const { sources } = await discoverCodexSources({ kind: 'project', directory: root });
  assert.equal(sources[0].document, 'not even parsed as JSON');
  assert.deepEqual(sources[1], { path: path.join(await realpath(root), '.codex', 'config.toml'), format: 'toml', status: 'rejected', code: 'too_large' });
});

test('missing roots fail; missing candidates stay nonfatal', async (t) => {
  const root = await fixture(t);
  assert.deepEqual((await discoverCodexSources({ kind: 'project', directory: root })).sources.map(s => s.status), ['missing', 'missing']);
  await assert.rejects(discoverCodexSources({ kind: 'user', directory: path.join(root, 'missing') }), { message: 'invalid_directory' });
  await writeFile(path.join(root, 'file'), 'x');
  await assert.rejects(discoverCodexSources({ kind: 'user', directory: path.join(root, 'file') }), { message: 'invalid_directory' });
});

test('JSON byte boundary, invalid UTF8, nonregular candidates', async (t) => {
  const root = await fixture(t);
  const request = { kind: 'user', directory: root };
  await writeFile(path.join(root, 'hooks.json'), Buffer.alloc(256 * 1024, 32));
  assert.equal((await discoverCodexSources(request)).sources[0].status, 'available');
  await writeFile(path.join(root, 'hooks.json'), Buffer.alloc(256 * 1024 + 1, 32));
  assert.equal((await discoverCodexSources(request)).sources[0].code, 'too_large');
  await writeFile(path.join(root, 'hooks.json'), Buffer.from([0xc3, 0x28]));
  const rejected = (await discoverCodexSources(request)).sources[0];
  assert.equal(rejected.code, 'invalid_utf8');
  assert.equal('document' in rejected, false);
  assert.equal('sha256' in rejected, false);
  await mkdir(path.join(root, 'config.toml'));
  assert.equal((await discoverCodexSources(request)).sources[1].code, 'not_regular_file');
});

test('rejects a file mutated during bounded fd reading', async (t) => {
  const root = await fixture(t);
  const filename = path.join(root, 'hooks.json');
  await writeFile(filename, 'original');
  const originalOpen = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      await writeFile(filename, 'changed content with a different size');
      return result;
    };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const source = (await discoverCodexSources({ kind: 'user', directory: root })).sources[0];
  assert.equal(source.status, 'rejected');
  assert.equal(source.code, 'file_changed');
  assert.equal('document' in source, false);
});

test('refuses .codex junction/link escape and direct file links', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(path.join(outside, 'hooks.json'), 'outside');
  await symlink(outside, path.join(root, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await discoverCodexSources({ kind: 'project', directory: root })).sources.map(s => s.code), ['path_redirected', 'path_redirected']);
  try { await symlink(path.join(outside, 'hooks.json'), path.join(root, 'hooks.json'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('File symlink privilege unavailable; junction assertions passed'); return; } throw error; }
  const source = (await discoverCodexSources({ kind: 'user', directory: root })).sources[0];
  assert.equal(source.code, 'path_redirected');
  assert.equal('document' in source, false);
});
