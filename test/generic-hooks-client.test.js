import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function fixture(snapshot, fail = false) {
  let plugin, Component, cursor = 0;
  const states = [], effects = [], calls = [];
  const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useEffect(fn) { effects.push(fn); } };
  const ctx = { slots: { inject(name, effect) { assert.equal(name, 'settings.section'); effect(); }, register(options, view) { assert.equal(options.id, 'dsh-hooks'); Component = view; return () => {}; } }, connection: { rpc: { async call(path, method, body) { calls.push({ path, method, body }); return fail ? { ok: false, error: { message: 'owner required' } } : { ok: true, value: structuredClone(snapshot) }; } } } };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value.factory(() => React); } } }, crypto: { randomUUID: () => 'fixture-id' } });
  plugin.apply(ctx);
  return { calls, effects, render() { cursor = 0; return Component(); } };
}
function all(node, predicate) { if (!node || typeof node !== 'object') return []; return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => all(child, predicate))]; }
const snapshot = { enabled: false, rules: [], records: [], events: [{ name: 'PreToolUse', blocking: true }] };
test('settings loads snapshot and writes exact owner RPC contract without auto-running commands', async () => {
  const view = fixture(snapshot);
  view.render(); await view.effects[0](); await new Promise(resolve => setImmediate(resolve));
  let tree = view.render();
  const toggle = all(tree, n => n.props['aria-label'] === '启用钩子执行')[0];
  assert.equal(toggle.props.checked, false);
  await toggle.props.onChange({ target: { checked: true } });
  const call = view.calls.find(c => c.method === 'genericHooks/configure');
  assert.equal(JSON.stringify(call.body), '{"args":{"configuration":{"enabled":true}}}');
  assert.equal(call.path, '/api');
  const add = all(tree, n => n.type === 'button' && n.children.includes('＋ 添加'))[0];
  add.props.onClick(); tree = view.render();
  const form = all(tree, n => n.type === 'form')[0];
  assert.ok(form);
  await form.props.onSubmit({ preventDefault() {} });
  const upsert = view.calls.find(c => c.method === 'genericHooks/upsert');
  assert.equal(upsert.body.args.rule.enabled, false);
  assert.equal(upsert.body.args.rule.event, 'PreToolUse');
  assert.ok(view.calls.every(c => !/run|execute|test/i.test(c.method)));
});
test('settings surfaces RPC denial rather than pretending configuration loaded', async () => {
  const view = fixture(snapshot, true); view.render(); await view.effects[0](); await new Promise(resolve => setImmediate(resolve));
  const alerts = all(view.render(), n => n.props.role === 'alert');
  assert.equal(alerts[0].children[0], 'owner required');
});
