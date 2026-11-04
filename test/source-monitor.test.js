import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm, realpath, rename, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { createSourceMonitor, parseSourceRegistrations } from '../source-monitor.js';
import { discoverCodexSources } from '../config-sources.js';
const hash = text => createHash('sha256').update(text).digest('hex');
const directory = path.resolve('selected');
const entry = (accepted = { 'hooks.json': hash('original') }) => ({ id: 'one', request: { kind: 'user', directory }, accepted });
const available = (sha256 = hash('original')) => ({ directory, kind: 'user', sources: [{ format: 'json', status: 'available', sha256 }] });

test('registration parsing is bounded closed data and never invokes getters', () => {
  let reads = 0;
  const accessor = { get id() { reads++; return 'one'; }, request: entry().request, accepted: entry().accepted };
  const sparse = new Array(1), indexed = [];
  Object.defineProperty(indexed, 0, { get() { reads++; return entry(); } });
  for (const input of [[accessor], sparse, indexed, Array(9).fill(entry()), [entry(), entry()], [{ ...entry(), other: true }], [entry({ 'other.json': hash('x') })], [entry({})], [entry({ 'hooks.json': 'bad' })]]) assert.throws(() => parseSourceRegistrations(input));
  assert.equal(reads, 0);
  const initial = [entry()]; const result = parseSourceRegistrations(initial);
  initial[0].accepted['hooks.json'] = hash('changed');
  assert.equal(result[0].accepted['hooks.json'], hash('original'));
});

test('checks are single-flight, selected-only, read-only and return no contents or paths', async () => {
  let release, calls = 0;
  const original = [entry()];
  const monitor = createSourceMonitor(original, { discover: (request, options) => {
    calls++;
    assert.deepEqual(request, entry().request);
    assert.deepEqual(options, { selectedNames: ['hooks.json'], requireCanonicalRoot: true });
    return new Promise(resolve => { release = resolve; });
  } });
  original[0].accepted['config.toml'] = hash('not selected');
  const first = monitor.check(); assert.equal(monitor.check(), first); assert.equal(calls, 1);
  release({ ...available(), sources: [...available().sources, { format: 'toml', status: 'available', sha256: hash('new sibling'), document: 'SECRET' }] });
  const results = await first;
  assert.deepEqual(results, [{ id: 'one', status: 'unchanged', files: [{ name: 'hooks.json', status: 'unchanged', sha256: hash('original') }] }]);
  assert.equal(JSON.stringify(results).includes('SECRET'), false);
  assert.equal(JSON.stringify(results).includes(directory), false);
  monitor.dispose(); assert.deepEqual(await monitor.check(), []);
});

test('changed, missing and rejected sources stay distinct; reader errors are sanitized', async () => {
  for (const [source, expected] of [[{ format: 'json', status: 'available', sha256: hash('changed') }, 'changed'], [{ format: 'json', status: 'missing' }, 'missing'], [{ format: 'json', status: 'rejected', code: 'path_redirected' }, 'rejected'], [{ format: 'json', status: 'available', sha256: 'invalid' }, 'unavailable']]) {
    const monitor = createSourceMonitor([entry()], { discover: async () => ({ ...available(), sources: [source] }) });
    assert.equal((await monitor.check())[0].status, expected); monitor.dispose();
  }
  const monitor = createSourceMonitor([entry()], { discover: async () => { throw new Error('SECRET PATH'); } });
  assert.deepEqual(await monitor.check(), [{ id: 'one', status: 'unavailable', files: [{ name: 'hooks.json', status: 'unavailable' }] }]);
  monitor.dispose();
});

test('moved roots and duplicate candidate formats are unavailable, not accepted deletion', async () => {
  for (const result of [{ ...available(), directory: path.join(directory, 'moved') }, { ...available(), sources: [available().sources[0], available().sources[0]] }, { ...available(), kind: 'project' }]) {
    const monitor = createSourceMonitor([entry()], { discover: async () => result });
    assert.equal((await monitor.check())[0].status, 'unavailable'); monitor.dispose();
  }
});

test('dispose suppresses late results and prevents subsequent selected roots being read', async () => {
  let release, calls = 0;
  const monitor = createSourceMonitor([entry(), { ...entry(), id: 'two' }], { discover: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const pending = monitor.check(); monitor.dispose(); release(available());
  assert.deepEqual(await pending, []); assert.equal(calls, 1);
  assert.deepEqual(await monitor.check(), []);
});

test('real selected reads detect change, deletion and reappearance without accepting new hashes', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-monitor-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary), filename = path.join(root, 'hooks.json');
  await writeFile(filename, 'original');
  await writeFile(path.join(root, 'config.toml'), 'invalid = [');
  const selected = { ...entry(), request: { kind: 'user', directory: root } };
  const monitor = createSourceMonitor([selected]); t.after(() => monitor.dispose());
  assert.equal((await monitor.check())[0].status, 'unchanged');
  const only = await discoverCodexSources(selected.request, { selectedNames: ['hooks.json'] });
  assert.equal(only.sources.length, 1);
  await writeFile(filename, 'changed'); assert.equal((await monitor.check())[0].status, 'changed');
  await rm(filename); assert.equal((await monitor.check())[0].status, 'missing');
  await writeFile(filename, 'changed'); assert.equal((await monitor.check())[0].status, 'changed');
  await writeFile(filename, 'original'); assert.equal((await monitor.check())[0].status, 'unchanged');
});

test('selected reader names are closed, dense and snapshotted before asynchronous IO', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-monitor-names-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary), request = { kind: 'user', directory: root };
  await writeFile(path.join(root, 'hooks.json'), 'original');
  await writeFile(path.join(root, 'config.toml'), '[hooks]\n');
  for (const selectedNames of [[], new Array(1), ['../elsewhere'], ['hooks.json', 'hooks.json'], ['config.toml', 'hooks.json', 'extra'], 'hooks.json']) await assert.rejects(discoverCodexSources(request, { selectedNames }), { code: 'invalid_request' });
  const selectedNames = ['hooks.json'];
  const pending = discoverCodexSources(request, { selectedNames });
  selectedNames[0] = 'config.toml';
  assert.deepEqual((await pending).sources.map(source => source.format), ['json']);
});

test('reader option getters and custom array iterators are rejected without invocation', async () => {
  let invoked = 0;
  const indexed = [];
  Object.defineProperty(indexed, 0, { enumerable: true, get() { invoked++; return 'hooks.json'; } });
  const iterated = ['hooks.json'];
  iterated[Symbol.iterator] = () => { invoked++; throw new Error('must not iterate'); };
  const options = { get selectedNames() { invoked++; return ['hooks.json']; } };
  for (const value of [{ selectedNames: indexed }, { selectedNames: iterated }, options, { requireCanonicalRoot: null }, { requireCanonicalRoot: undefined }, { other: true }]) await assert.rejects(discoverCodexSources(entry().request, value), { code: 'invalid_request' });
  assert.equal(invoked, 0);
});

test('a redirected registered root is rejected before opening files in its new target', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-monitor-redirect-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary), selected = path.join(root, 'selected'), other = path.join(root, 'other');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(selected); await mkdir(other);
  await writeFile(path.join(selected, 'hooks.json'), 'original');
  await writeFile(path.join(other, 'hooks.json'), 'SECRET');
  const monitor = createSourceMonitor([{ ...entry(), request: { kind: 'user', directory: selected } }]);
  t.after(() => monitor.dispose());
  assert.equal((await monitor.check())[0].status, 'unchanged');
  await rename(selected, path.join(root, 'original'));
  await symlink(other, selected, process.platform === 'win32' ? 'junction' : 'dir');
  let opens = 0;
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', (...args) => { opens++; return originalOpen(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await monitor.check())[0].status, 'unavailable');
  assert.equal(opens, 0);
  // Ordinary explicit discovery still resolves an owner-selected alias as before.
  assert.equal((await discoverCodexSources({ kind: 'user', directory: selected }, { selectedNames: ['hooks.json'] })).sources[0].status, 'available');
  assert.equal(opens, 1);
});

test('TOML non-hooks changes still require review because raw bytes changed', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-monitor-toml-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary), original = 'model = "first"\n[hooks]\n';
  await writeFile(path.join(root, 'config.toml'), original);
  const monitor = createSourceMonitor([{ id: 'toml', request: { kind: 'user', directory: root }, accepted: { 'config.toml': hash(original) } }]);
  t.after(() => monitor.dispose());
  assert.equal((await monitor.check())[0].status, 'unchanged');
  await writeFile(path.join(root, 'config.toml'), original.replace('first', 'second'));
  assert.equal((await monitor.check())[0].status, 'changed');
});
