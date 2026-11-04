import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink, open, mkdir, realpath, lstat } from 'node:fs/promises';
import { fingerprintAction } from '../trust.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-trust-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'binary'), script = path.join(root, 'script');
  await writeFile(executable, Buffer.from([0, 255, 13, 10]));
  await writeFile(script, 'not executed');
  return { root, executable, script, action: { executable, argv: [script] } };
}

test('hashes exact binary bytes, explicit files only; deterministic canonical parameters', async t => {
  const { executable, script, action } = await fixture(t);
  const first = await fingerprintAction(action);
  assert.equal(first.files.length, 1);
  assert.deepEqual(first.files[0], { path: executable, size: 4, sha256: createHash('sha256').update(Buffer.from([0, 255, 13, 10])).digest('hex') });
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await fingerprintAction({ argv: action.argv, executable }), first);
  assert.equal((await fingerprintAction({ ...action, timeoutMs: 5000, maxOutputBytes: 4096, async: false })).digest, first.digest);
  await writeFile(script, 'changed but not explicitly trusted');
  assert.equal((await fingerprintAction(action)).digest, first.digest);
  const trusted = { ...action, trustFiles: [script] }, before = await fingerprintAction(trusted);
  assert.equal(before.files.length, 2);
  await writeFile(script, 'changed again');
  assert.notEqual((await fingerprintAction(trusted)).digest, before.digest);
  await writeFile(executable, 'different binary');
  assert.notEqual((await fingerprintAction(action)).digest, first.digest);
});

test('paths and all execution parameters affect fingerprint', async t => {
  const { root, executable, script, action } = await fixture(t);
  const first = await fingerprintAction(action), other = path.join(root, 'other');
  await writeFile(other, Buffer.from([0, 255, 13, 10]));
  for (const change of [{ executable: other }, { argv: [] }, { timeoutMs: 6000 }, { maxOutputBytes: 5000 }, { trustFiles: [script] }]) {
    assert.notEqual((await fingerprintAction({ ...action, ...change })).digest, first.digest);
  }
  assert.equal(action.executable, executable);
});

test('Windows forward and mixed separators work but raw spelling stays fingerprint-bound', { skip: process.platform !== 'win32' }, async t => {
  const { action, executable, script, root } = await fixture(t);
  const native = await fingerprintAction({ ...action, trustFiles: [script] });
  const forward = executable.replaceAll('\\', '/'), forwardScript = script.replaceAll('\\', '/');
  for (const value of [forward, root.replaceAll('\\', '/') + '\\binary']) {
    const result = await fingerprintAction({ ...action, executable: value, trustFiles: [forwardScript] });
    assert.equal(result.files[0].path, value);
    assert.equal(result.files[1].path, forwardScript);
    assert.equal(result.files[0].sha256, native.files[0].sha256);
    assert.notEqual(result.digest, native.digest);
  }
  for (const value of [root + '/./binary', root + '/../binary', executable + '.', executable + ' ', executable + ':stream', '\\\\?\\' + executable]) {
    await assert.rejects(fingerprintAction({ ...action, executable: value }), /noncanonical/);
  }
  const alias = path.join(root, 'alias-forward');
  await symlink(root, alias, 'junction');
  await assert.rejects(fingerprintAction({ ...action, executable: path.join(alias, 'binary').replaceAll('\\', '/') }), /symlink_rejected/);
});

test('invalid configuration is rejected before reading files', async t => {
  const { action, executable } = await fixture(t);
  for (const change of [{ executable: 'relative' }, { executable: executable + '\0' }, { argv: [null] }, { argv: new Array(1) }, { argv: ['a\0b'] }, { argv: Array(65).fill('') }, { trustFiles: null }, { trustFiles: ['relative'] }, { trustFiles: Array(17).fill(executable) }, { timeoutMs: null }, { timeoutMs: 99 }, { maxOutputBytes: Infinity }, { async: 1 }, { async: true }, { surprise: true }]) {
    await assert.rejects(fingerprintAction({ ...action, ...change }), /invalid_hook_trust/);
  }
  await assert.rejects(fingerprintAction(null), /invalid_hook_trust_action/);
  await assert.rejects(fingerprintAction({ ...action, executable: path.dirname(executable) + path.sep + '.' + path.sep + path.basename(executable) }), /noncanonical/);
});

test('rejects missing, nonregular, symbolic links and ancestor junctions', async t => {
  const { root, action, executable } = await fixture(t);
  await assert.rejects(fingerprintAction({ ...action, executable: root }), /regular_file_required/);
  await assert.rejects(fingerprintAction({ ...action, trustFiles: [path.join(root, 'missing')] }), /ENOENT/);
  const link = path.join(root, 'link');
  try { await symlink(executable, link, 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('file symlink creation unavailable; junction coverage still runs'); }
  if (await lstat(link).then(() => true, () => false)) await assert.rejects(fingerprintAction({ ...action, trustFiles: [link] }), /symlink_rejected/);
  const directory = path.join(root, 'directory'), alias = path.join(root, 'alias');
  await mkdir(directory); await writeFile(path.join(directory, 'file'), 'bytes');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(fingerprintAction({ ...action, trustFiles: [path.join(alias, 'file')] }), /symlink_rejected/);
});

test('detects mutation during reading and closes the file descriptor', async t => {
  const { action, executable } = await fixture(t);
  const probe = await open(executable, 'r'), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  let mutated = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await read.apply(this, args);
    if (!mutated) { mutated = true; await writeFile(executable, 'replacement bytes'); }
    return result;
  });
  await assert.rejects(fingerprintAction(action), /hook_trust_file_changed/);
  await rm(executable);
});

test('enforces 128 MiB per-file and 256 MiB total including executable', async t => {
  const { root, action } = await fixture(t);
  const large = path.join(root, 'large'), handle = await open(large, 'w');
  try { await handle.truncate(128 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(fingerprintAction({ ...action, trustFiles: [large] }), /hook_trust_file_limit/);
  const resized = await open(large, 'r+');
  try { await resized.truncate(128 * 1024 * 1024); } finally { await resized.close(); }
  await assert.rejects(fingerprintAction({ ...action, trustFiles: [large, large] }), /hook_trust_total_limit/);
  const allowed = await fingerprintAction({ executable: large, argv: [], trustFiles: [large] });
  assert.equal(allowed.files.reduce((n, file) => n + file.size, 0), 256 * 1024 * 1024);
});
