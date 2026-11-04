import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('runtime relative imports and worker entrypoints remain inside the published allowlist', async () => {
  const manifest = await json('package.json');
  const published = new Set(manifest.files);
  const seen = new Set();
  for (const name of manifest.files.filter(value => value.endsWith('.js'))) {
    const source = await readFile(new URL(name, root), 'utf8');
    const references = source.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g);
    for (const [, reference] of references) {
      const resolved = new URL(reference, new URL(name, root));
      assert.ok(resolved.href.startsWith(root.href), `runtime reference escapes package: ${name} -> ${reference}`);
      const relative = decodeURIComponent(resolved.href.slice(root.href.length));
      seen.add(relative);
      assert.ok(published.has(relative), `runtime reference absent from package: ${name} -> ${reference}`);
      assert.ok((await stat(resolved)).isFile(), `runtime reference is not a file: ${relative}`);
    }
  }
  assert.ok(seen.has('core.js'), 'static imports were not inspected');
  assert.ok(seen.has('toml-worker.js'), 'worker URL references were not inspected');
});
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));

test('published display resources are localized, exported and included without external icon assets', async () => {
  const manifest = await json('package.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*'], './locale/*.json');
  assert.ok(manifest.files.includes('icon.svg'));
  assert.ok(manifest.files.includes('locale'));
  const en = await json('locale/en.json');
  const zh = await json('locale/zh-CN.json');
  for (const locale of [en, zh]) {
    assert.equal(typeof locale.name, 'string');
    assert.ok(locale.name.trim().length > 0);
    assert.equal(typeof locale.description, 'string');
    assert.ok(locale.description.trim().length > 0);
  }
  assert.notEqual(en.name, zh.name);
  assert.notEqual(en.description, zh.description);
  const icon = await readFile(new URL('icon.svg', root), 'utf8');
  assert.match(icon, /<svg\b/);
  assert.match(icon, /viewBox=/);
  assert.doesNotMatch(icon, /<(?:script|image|foreignObject)\b|\bon\w+\s*=|(?:href|src)\s*=/i);
});

test('release allowlist includes every runtime module and public verification documentation', async () => {
  const manifest = await json('package.json');
  const required = ['index.js', 'core.js', 'async-queue.js', 'rpc.js', 'client.js', 'matcher.js', 'trust.js', 'codex-import.js', 'scope.js', 'config-sources.js', 'source-monitor.js', 'source-registry.js', 'source-poller.js', 'toml-config.js', 'toml-worker.js', 'cordis.patch.yml', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/codex-alignment.md', 'docs/verification.md', 'docs/recipes.md', 'docs/upgrade-and-rollback.md', 'docs/host-contract-requests.md', 'LICENSE'];
  for (const name of required) {
    assert.ok(manifest.files.includes(name), `not in release allowlist: ${name}`);
    assert.ok((await stat(new URL(name, root))).isFile(), `missing release file: ${name}`);
  }
  assert.ok(!manifest.files.some(name => /^(?:Temp|test|node_modules|dist)(?:\/|$)/.test(name)));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  const loader = await readFile(new URL('client.js', root), 'utf8');
  assert.ok(loader.includes(`id: '${manifest.name}'`));
});
