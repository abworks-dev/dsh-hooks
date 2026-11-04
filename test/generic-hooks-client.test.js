import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function fixture(snapshot, fail = false) {
  let plugin, Component, registration, cursor = 0;
  const states = [], effects = [], calls = [], listeners = new Map();
  const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect(fn) { effects.push(fn); } };
  const ctx = { slots: { inject(name, effect) { assert.equal(name, 'settings.section'); effect(); }, register(options, view) { assert.equal(options.id, 'dsh-hooks'); registration = options; Component = view; return () => {}; } }, connection: { rpc: { async call(path, method, body) { calls.push({ path, method, body }); return fail ? { ok: false, error: { message: 'owner required' } } : { ok: true, value: structuredClone(typeof snapshot === 'function' ? await snapshot(method, body) : snapshot) }; } } } };
  vm.runInNewContext(source, { window: { addEventListener(name, handler, capture) { assert.equal(capture, true); listeners.set(name, handler); }, removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); }, confirm: () => true, __ModuleLoader__: { load(value) { plugin = value.factory(() => React); } } }, crypto: { randomUUID: () => 'fixture-id' } });
  plugin.apply(ctx);
  return { calls, effects, registration, listeners, render(props) { cursor = 0; return Component(props); } };
}
function all(node, predicate) { if (!node || typeof node !== 'object') return []; return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => all(child, predicate))]; }
function find(tree, label) { return all(tree, n => n.props['aria-label'] === label)[0]; }
async function loaded(snapshot) { const view = fixture(snapshot); view.render(); await view.effects[0](); await new Promise(resolve => setImmediate(resolve)); return view; }
const snapshot = { enabled: false, rules: [], records: [], events: [{ name: 'PreToolUse', blocking: true }] };
async function registrationFixture(options = {}) {
  const candidate = { path: '/codex/hooks.json', format: 'json', status: 'available', document: '{"hooks":{}}', sha256: 'a'.repeat(64) };
  let snapshots = 0;
  const view = await loaded(async method => {
    if (method === 'genericHooks/snapshot' && ++snapshots > 1 && options.snapshotFailure) throw new Error('snapshot unavailable');
    if (method === 'genericHooks/discoverSources') return { kind: 'user', directory: '/canonical/codex', sources: [candidate] };
    if (method === 'genericHooks/previewSourceImports') return { rules: options.rules || [], unsupported: options.unsupported || [], warnings: [] };
    if (method === 'genericHooks/registerSource') { if (options.commit) await options.commit(); return {}; }
    return snapshot;
  });
  let tree = openImport(view);
  find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  await button(tree, '发现配置').props.onClick(); tree = view.render();
  find(tree, '导入命令解释器').props.onChange({ target: { value: '/bin/sh' } }); tree = view.render();
  await button(tree, '预览全部来源').props.onClick(); tree = view.render();
  find(tree, '来源登记 ID').props.onChange({ target: { value: options.id || 'owner_source' } }); tree = view.render();
  button(tree, '核对新来源登记').props.onClick();
  return { view, candidate };
}
test('settings form stays compact, theme-scoped and keyboard/narrow friendly', async () => {
  const view = await permissionEditor(permissionRule), tree = view.render();
  const css = all(tree, node => node.type === 'style')[0].children.join('');
  assert.ok(css.includes('.dsh-hooks input[type=checkbox]:not([role=switch]){display:inline-block;width:auto;'));
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) minmax(0,1fr)'));
  assert.ok(css.includes('@media(max-width:600px)'));
  assert.ok(css.includes('.dsh-hooks .grid{grid-template-columns:1fr}'));
  assert.ok(css.includes('.dsh-hooks :focus-visible{outline:2px solid var(--dsw-alias-brand-primary)'));
  assert.ok(css.includes('resize:vertical'));
  assert.ok(css.includes('.dsh-hooks .grid>label{min-width:0}'));
  const editor = find(tree, '编辑钩子');
  assert.equal(editor.type, 'form');
  const pairedFields = all(editor, node => node.props.className === 'grid')[0];
  assert.deepEqual(pairedFields.children.map(node => node.children[0]), ['名称', '匹配条件']);
  assert.equal(all(pairedFields, node => node.type === 'input')[0].props.autoFocus, true);
  assert.equal(all(tree, node => node.type === 'dialog')[0].props['aria-labelledby'], 'dsh-hooks-source-title');
});
test('trimmed editor copy retains execution, privacy and reapproval risks', async () => {
  const view = await permissionEditor(permissionRule), text = JSON.stringify(find(view.render(), '编辑钩子'));
  for (const warning of ['不会自动批准', '执行或协议失败时拒绝', '不读取私有审批理由', '完整载荷可能含命令、文件内容或密钥', '脚本仍可自行写文件或联网', '命令在 Host 本机运行，可访问本机资源', '保存会关闭此钩子并清除旧信任', '重新审阅后需单独启用']) assert.ok(text.includes(warning), warning);
  assert.ok(!text.includes('事件 JSON 经 stdin 传入'));
});
test('source selection and registration consent checkboxes retain inline intrinsic width', async () => {
  const { view, candidate } = await registrationFixture();
  const tree = view.render();
  for (const label of [`选择来源 ${candidate.path}`, '所有者明确同意登记来源']) {
    const control = find(tree, label);
    assert.equal(control.props.style.display, 'inline');
    assert.equal(control.props.style.width, 'auto');
  }
  assert.equal(find(tree, '所有者明确同意登记来源').props.checked, false);
  assert.equal(button(tree, '确认登记新来源').props.disabled, true);
  assert.ok(!view.calls.some(call => call.method === 'genericHooks/registerSource'));
});
test('new registration requires owner consent, reuses combined preview and sends canonical exact hash-bound request once', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const { view } = await registrationFixture({ commit: () => pending }); let tree = view.render();
  assert.ok(find(tree, '确认新来源登记')); assert.ok(JSON.stringify(tree).includes('登记 0 条'));
  await button(tree, '确认登记新来源').props.onClick(); assert.ok(!view.calls.some(c => c.method === 'genericHooks/registerSource'));
  find(tree, '所有者明确同意登记来源').props.onChange({ target: { checked: true } }); tree = view.render();
  const submit = button(tree, '确认登记新来源').props.onClick; const first = submit(); await submit();
  assert.equal(view.calls.filter(c => c.method === 'genericHooks/registerSource').length, 1);
  assert.equal(JSON.stringify(view.calls.at(-1).body), JSON.stringify({ args: { request: { id: 'owner_source', request: { kind: 'user', directory: '/canonical/codex' }, accepted: { 'hooks.json': 'a'.repeat(64) }, options: { interpreter: { executable: '/bin/sh', argvPrefix: [] }, scope: { kind: 'user' } } } } }));
  release(); await first; tree = view.render(); assert.equal(find(tree, '确认新来源登记'), undefined);
  assert.equal(view.calls.filter(c => c.method === 'genericHooks/previewSourceImports').length, 1);
  assert.ok(!view.calls.some(c => /importSources|trust|toggle|configure/.test(c.method)));
});
test('registration synchronously blocks captured ordinary import and disables pending cancellation', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const rule = { id: 'new_rule', enabled: false, action: { executable: '/bin/sh', argv: ['-c', 'echo ok'] } };
  const { view } = await registrationFixture({ rules: [rule], commit: () => pending }); let tree = view.render();
  const ordinary = button(tree, '导入全部来源').props.onClick;
  find(tree, '所有者明确同意登记来源').props.onChange({ target: { checked: true } }); tree = view.render();
  const registration = button(tree, '确认登记新来源').props.onClick();
  await ordinary();
  assert.equal(view.calls.filter(call => call.method === 'genericHooks/registerSource').length, 1);
  assert.ok(!view.calls.some(call => call.method === 'genericHooks/importSources'));
  tree = view.render(); assert.equal(button(tree, '取消登记').props.disabled, true);
  release(); await registration;
});
test('registration reports owner denial, changed file, unsupported and post-commit snapshot failure without success', async () => {
  for (const [code, message] of [['local_owner_client_required', '仅本地所有者'], ['source_registration_changed', '来源文件已变化'], ['source_import_unsupported', '不支持'], ['snapshot', '登记可能已提交']]) {
    const { view } = await registrationFixture(code === 'snapshot' ? { snapshotFailure: true } : { commit: () => { throw new Error(code); } }); let tree = view.render();
    find(tree, '所有者明确同意登记来源').props.onChange({ target: { checked: true } }); tree = view.render();
    await button(tree, '确认登记新来源').props.onClick(); tree = view.render();
    assert.ok(all(tree, n => n.props.role === 'alert').some(n => JSON.stringify(n).includes(message)), code);
    assert.equal(find(tree, '确认新来源登记'), undefined);
    assert.ok(!JSON.stringify(tree).includes('已登记来源；新规则'));
  }
});
test('new registration rejects invalid IDs and unsupported preview without a registration RPC', async () => {
  for (const options of [{ id: 'bad.id' }, { id: 'a'.repeat(65) }, { unsupported: ['unsupported'] }]) {
    const { view } = await registrationFixture(options); const tree = view.render();
    assert.equal(find(tree, '确认新来源登记'), undefined);
    assert.ok(!view.calls.some(c => c.method === 'genericHooks/registerSource'));
  }
});
test('registration captures expire synchronously on every preview input, fixed file selection and close', async () => {
  for (const label of ['配置来源目录', '配置来源类型', '导入命令解释器', '解释器参数前缀', '导入适用范围', '选择来源 /codex/hooks.json', '来源登记 ID', 'close', 'nativeclose', 'unmount']) {
    const { view } = await registrationFixture(); let tree = view.render();
    find(tree, '所有者明确同意登记来源').props.onChange({ target: { checked: true } }); tree = view.render();
    const submit = button(tree, '确认登记新来源').props.onClick;
    if (label === 'close') find(tree, '关闭用户配置').props.onClick();
    else if (label === 'nativeclose') all(tree, n => n.type === 'dialog')[0].props.onClose();
    else if (label === 'unmount') view.effects[0]()();
    else find(tree, label).props.onChange({ target: { value: label === '配置来源类型' || label === '导入适用范围' ? 'project' : '/changed', checked: false } });
    await submit(); assert.ok(!view.calls.some(c => c.method === 'genericHooks/registerSource'), label);
  }
});
test('record summaries show per-rule policy outcomes with safe observational and unknown fallbacks', async () => {
  const records = [
    { event: 'PermissionRequest', status: 'completed', policyOutcome: 'deny' },
    { event: 'PermissionRequest', status: 'protocol_error', policyOutcome: 'deny' },
    { event: 'PermissionRequest', status: 'completed', policyOutcome: 'abstain' },
    { event: 'PermissionRequest', status: 'completed', policyOutcome: 'cancelled' },
    { event: 'PermissionRequest', status: 'completed' },
    { event: 'PermissionRequest', status: 'timeout', policyOutcome: 'approved' },
    { event: 'PermissionRequest', status: 'completed', policyOutcome: 'toString' },
    { event: 'PermissionRequest', status: 'scope_unavailable' },
    { event: 'PostToolUse', status: 'completed', policyOutcome: 'deny' },
  ];
  const view = await loaded({ ...snapshot, records });
  let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render();
  const summaries = all(all(tree, n => n.props.className === 'records')[0], n => n.type === 'summary').map(n => n.children[0]);
  assert.deepEqual(summaries, [
    'PermissionRequest · 本条钩子拒绝 · 0 ms',
    'PermissionRequest · 本条钩子拒绝 · 0 ms',
    'PermissionRequest · 本条钩子未拒绝 · 0 ms',
    'PermissionRequest · 本条钩子取消 · 0 ms',
    'PermissionRequest · completed · 0 ms',
    'PermissionRequest · timeout · 0 ms',
    'PermissionRequest · completed · 0 ms',
    'PermissionRequest · 跳过：会话目录不可用 · 0 ms',
    'PostToolUse · completed · 0 ms',
  ]);
  assert.ok(summaries.every(text => !/已批准|已授权|approval|approved/.test(text)));
  assert.deepEqual(view.calls.map(call => call.method), ['genericHooks/snapshot']);
});
const permissionRule = { id: 'permission', name: '权限钩子', event: 'PermissionRequest', enabled: true, matcher: '*', trust: { digest: 'old' }, action: { executable: '/usr/bin/node', argv: [], timeoutMs: 1000 } };
async function permissionEditor(rule) {
  const view = await loaded({ ...snapshot, rules: rule ? [rule] : [], events: [...snapshot.events, { name: 'PermissionRequest' }, { name: 'Stop' }, { name: 'UserPromptSubmit' }, { name: 'SessionStart' }, { name: 'Interrupt' }, { name: 'PreModelRequest' }, { name: 'PostModelRequest' }, { name: 'SubagentStart' }, { name: 'PostToolUse' }] });
  let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render();
  if (rule) { find(tree, `展开 ${rule.name}`).props.onClick(); tree = view.render(); all(tree, n => n.type === 'button' && n.children.includes('编辑钩子'))[0].props.onClick(); }
  else find(tree, '添加 PermissionRequest 钩子').props.onClick();
  return view;
}
test('PermissionRequest opt-in is conditional, unchecked by default and makes no automatic calls', async () => {
  const view = await permissionEditor(); let tree = view.render();
  assert.equal(find(tree, '允许此钩子拒绝审批').props.checked, false);
  assert.ok(JSON.stringify(tree).includes('仅拒绝或继续正常审批，不会自动批准；执行或协议失败时拒绝。'));
  find(tree, '钩子事件').props.onChange({ target: { value: 'PreToolUse' } }); tree = view.render();
  assert.equal(find(tree, '允许此钩子拒绝审批'), undefined);
  assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot']);
});
test('save emits only root true opt-in and always disables and removes trust', async () => {
  for (const flag of [undefined, false, true]) {
    const view = await permissionEditor({ ...permissionRule, ...(flag === undefined ? {} : { denyPermissionRequest: flag }) }); let tree = view.render();
    assert.equal(find(tree, '允许此钩子拒绝审批').props.checked, flag === true);
    await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
    assert.equal(Object.hasOwn(saved, 'denyPermissionRequest'), flag === true);
    if (flag === true) assert.equal(saved.denyPermissionRequest, true);
    assert.equal(saved.enabled, false); assert.equal(Object.hasOwn(saved, 'trust'), false);
    assert.equal(Object.hasOwn(saved, 'async'), false);
    assert.equal(Object.hasOwn(saved.action, 'denyPermissionRequest'), false);
    assert.ok(view.calls.every(c => !/configure|toggle|trust|execute|run/i.test(c.method)));
  }
});
test('new opt-in saves true, unchecking or changing away removes it permanently', async () => {
  for (const mode of ['true', 'false', 'event', 'away']) {
    const view = await permissionEditor(); let tree = view.render();
    find(tree, '允许此钩子拒绝审批').props.onChange({ target: { checked: true } }); tree = view.render();
    if (mode === 'false') find(tree, '允许此钩子拒绝审批').props.onChange({ target: { checked: false } });
    if (mode === 'away') find(tree, '钩子事件').props.onChange({ target: { value: 'PreToolUse' } });
    if (mode === 'event') { find(tree, '钩子事件').props.onChange({ target: { value: 'PreToolUse' } }); tree = view.render(); find(tree, '钩子事件').props.onChange({ target: { value: 'PermissionRequest' } }); }
    tree = view.render(); await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
    assert.equal(Object.hasOwn(saved, 'denyPermissionRequest'), mode === 'true');
  }
});
test('imported PermissionRequest remains observe-only until explicit manual opt-in', async () => {
  const { trust, ...imported } = permissionRule;
  const view = await permissionEditor({ ...imported, enabled: false, source: 'codex-import' });
  const tree = view.render(); assert.equal(find(tree, '允许此钩子拒绝审批').props.checked, false);
  await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
  assert.equal(Object.hasOwn(saved, 'denyPermissionRequest'), false);
  assert.equal(saved.enabled, false);
  assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot', 'genericHooks/upsert', 'genericHooks/snapshot']);
});
test('non-PermissionRequest saves omit stale opt-in', async () => {
  const view = await permissionEditor({ ...permissionRule, event: 'PreToolUse', denyPermissionRequest: true });
  const tree = view.render(); assert.equal(find(tree, '允许此钩子拒绝审批'), undefined);
  await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(Object.hasOwn(view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule, 'denyPermissionRequest'), false);
});
test('review refusal risk uses exact Host rule rather than stale snapshot in either direction', async () => {
  for (const hostFlag of [true, false]) {
    const rule = { ...permissionRule, denyPermissionRequest: !hostFlag };
    const hostRule = { ...permissionRule, denyPermissionRequest: hostFlag };
    const view = await loaded(method => method === 'genericHooks/previewTrust' ? { id: rule.id, rule: hostRule, digest: 'a'.repeat(64), files: [] } : { ...snapshot, rules: [rule], events: [{ name: 'PermissionRequest' }] });
    let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render(); find(tree, `展开 ${rule.name}`).props.onClick(); tree = view.render();
    const details = all(tree, n => n.props.className === 'rule-detail')[0];
    assert.equal(JSON.stringify(details).includes('执行或协议失败时拒绝'), !hostFlag);
    await all(tree, n => n.type === 'button' && n.children.includes('审阅文件'))[0].props.onClick(); tree = view.render();
    const review = find(tree, '审阅文件'); assert.ok(review);
    assert.equal(JSON.stringify(review).includes('执行或协议失败时拒绝'), hostFlag);
    const displayed = JSON.parse(all(review, n => n.type === 'pre')[0].children[0]);
    assert.equal(displayed.denyPermissionRequest, hostFlag ? true : undefined);
    assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot', 'genericHooks/previewTrust']);
  }
});
const permissionObserverWarning = '后台通知仅观察权限请求，不批准或拒绝审批；忽略后台输出，不读取私有审批理由。';
test('PermissionRequest background defaults off and mutual exclusion survives same-tick stale handlers in both directions', async () => {
  for (const last of ['后台通知', '允许此钩子拒绝审批']) {
    const view = await permissionEditor(); const initial = view.render();
    assert.equal(find(initial, '后台通知').props.checked, false);
    assert.equal(find(initial, '允许此钩子拒绝审批').props.checked, false);
    const first = last === '后台通知' ? '允许此钩子拒绝审批' : '后台通知';
    find(initial, first).props.onChange({ target: { checked: true } });
    find(initial, last).props.onChange({ target: { checked: true } });
    const tree = view.render();
    assert.equal(find(tree, last).props.checked, true);
    assert.equal(find(tree, first).props.checked, false);
    assert.equal(JSON.stringify(find(tree, '编辑钩子')).includes('执行或协议失败时拒绝'), last === '允许此钩子拒绝审批');
    await find(tree, '编辑钩子').props.onSubmit({ preventDefault() {} });
    const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
    assert.equal(saved.async === true, last === '后台通知');
    assert.equal(saved.denyPermissionRequest === true, last === '允许此钩子拒绝审批');
    assert.equal(saved.enabled, false); assert.equal(Object.hasOwn(saved, 'trust'), false);
  }
});
test('PermissionRequest imported observer remains background across compatible events and never becomes policy on save', async () => {
  for (const mode of ['keep', 'off', 'full', 'input', 'switch', 'unsupported', 'malformed']) {
    const view = await permissionEditor({ ...permissionRule, source: 'codex-import', async: true, ...(mode === 'malformed' ? { denyPermissionRequest: true } : {}), ...(mode === 'input' ? { includeToolInput: true } : {}) });
    let tree = view.render(); assert.equal(find(tree, '后台通知').props.checked, true);
    assert.equal(find(tree, '后台通知').props.disabled, mode === 'input');
    if (mode === 'off') find(tree, '后台通知').props.onChange({ target: { checked: false } });
    if (mode === 'full') find(tree, '事件载荷').props.onChange({ target: { value: 'full' } });
    if (mode === 'switch' || mode === 'unsupported') {
      find(tree, '钩子事件').props.onChange({ target: { value: mode === 'switch' ? 'Stop' : 'SessionEnd' } }); tree = view.render();
      find(tree, '钩子事件').props.onChange({ target: { value: 'PermissionRequest' } });
    }
    tree = view.render();
    assert.equal(find(tree, '后台通知').props.checked, ['keep', 'input', 'switch', 'malformed'].includes(mode));
    await find(tree, '编辑钩子').props.onSubmit({ preventDefault() {} });
    const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
    assert.equal(saved.async === true, ['keep', 'switch', 'malformed'].includes(mode));
    assert.equal(Object.hasOwn(saved, 'denyPermissionRequest'), false);
    assert.equal(saved.enabled, false); assert.equal(Object.hasOwn(saved, 'trust'), false);
  }
});
test('PermissionRequest observer review warning and async flag use exact Host rule, not stale snapshot or draft', async () => {
  for (const hostAsync of [true, false]) {
    const rule = { ...permissionRule, async: !hostAsync };
    const hostRule = { ...permissionRule, async: hostAsync };
    const view = await loaded(method => method === 'genericHooks/previewTrust' ? { id: rule.id, rule: hostRule, digest: 'a'.repeat(64), files: [] } : { ...snapshot, rules: [rule], events: [{ name: 'PermissionRequest' }] });
    let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render(); find(tree, `展开 ${rule.name}`).props.onClick(); tree = view.render();
    button(tree, '编辑钩子').props.onClick(); tree = view.render();
    find(tree, '后台通知').props.onChange({ target: { checked: !hostAsync } }); tree = view.render();
    await button(tree, '审阅文件').props.onClick(); tree = view.render();
    const review = find(tree, '审阅文件');
    assert.equal(JSON.stringify(review).includes(permissionObserverWarning), hostAsync);
    const displayed = JSON.parse(all(review, n => n.type === 'pre')[0].children[0]);
    assert.equal(displayed.async, hostAsync ? true : undefined);
    assert.ok(!view.calls.some(c => /upsert|trust$|toggle|configure/.test(c.method)));
  }
});
test('overview exposes a real configuration source, not device controls or fake plugin sources', async () => {
  const view = await loaded(snapshot); const tree = view.render();
  assert.equal(view.registration.children, undefined);
  assert.equal(view.registration.label(), '钩子');
  assert.ok(find(tree, '打开用户配置'));
  const rendered = JSON.stringify(tree);
  for (const redundant of ['通过配置管理会话生命周期钩子', '了解更多', '来自配置']) assert.ok(!rendered.includes(redundant));
  assert.ok(rendered.includes('不会自动批准'));
  assert.ok(rendered.includes('不绕过权限检查'));
  assert.ok(!rendered.includes('尚无钩子'));
  assert.ok(find(tree, '添加 PreToolUse 钩子'));
  assert.ok(find(tree, 'PreToolUse'));
  assert.equal(all(tree, n => n.type === 'dialog').length, 1);
  assert.equal(all(tree, n => n.type === 'dialog')[0].props.open, undefined);
  assert.ok(!source.includes('abworks.hooks.device'));
  assert.ok(!source.includes('AU05'));
  assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot']);
});
test('source opens a modal with event groups and closes via Escape without command execution', async () => {
  const view = await loaded(snapshot); let tree = view.render();
  find(tree, '打开用户配置').props.onClick(); tree = view.render();
  const dialog = all(tree, n => n.type === 'dialog')[0];
  const node = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  dialog.props.ref.current = node;
  const effectCleanup = view.effects.at(-1)();
  assert.equal(node.open, true);
  assert.ok(find(tree, 'PreToolUse'));
  let prevented = false, stopped = false;
  view.listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  dialog.props.onCancel({ preventDefault() {} });
  view.render(); view.effects.at(-1)();
  assert.equal(node.open, false);
  effectCleanup();
  assert.equal(view.calls.length, 1);
});
test('settings writes exact owner RPC contract and saves disabled rules without running them', async () => {
  const view = await loaded(snapshot); let tree = view.render();
  find(tree, '打开用户配置').props.onClick(); tree = view.render();
  const toggle = find(tree, '启用钩子执行');
  assert.equal(toggle.props.checked, false);
  await toggle.props.onChange({ target: { checked: true } });
  const call = view.calls.find(c => c.method === 'genericHooks/configure');
  assert.equal(JSON.stringify(call.body), '{"args":{"configuration":{"enabled":true}}}');
  assert.equal(call.path, '/api');
  find(tree, '添加 PreToolUse 钩子').props.onClick(); tree = view.render();
  const form = all(tree, n => n.type === 'form')[0]; assert.ok(form);
  await form.props.onSubmit({ preventDefault() {} });
  const upsert = view.calls.find(c => c.method === 'genericHooks/upsert');
  assert.equal(upsert.body.args.rule.enabled, false);
  assert.equal(upsert.body.args.rule.event, 'PreToolUse');
  assert.ok(view.calls.every(c => !/run|execute|test/i.test(c.method)));
});
test('timeout editor exposes the 600-second bound and saves its exact value disabled', async () => {
  const view = await loaded(snapshot); let tree = view.render();
  find(tree, '打开用户配置').props.onClick(); tree = view.render();
  find(tree, '添加 PreToolUse 钩子').props.onClick(); tree = view.render();
  const timeout = all(tree, n => n.type === 'input' && n.props.type === 'number' && n.props.min === 100)[0];
  assert.equal(timeout.props.max, 600000);
  timeout.props.onChange({ target: { value: '600000' } });
  await all(view.render(), n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
  assert.equal(saved.action.timeoutMs, 600000);
  assert.equal(saved.enabled, false);
  assert.equal(view.calls.filter(c => !['genericHooks/snapshot', 'genericHooks/upsert'].includes(c.method)).length, 0);
});
test('rule details collapse independently of enable switch and offer edit and delete', async () => {
  const rule = { id: 'r1', name: '检查命令', event: 'PreToolUse', enabled: false, matcher: '*', action: { type: 'command', executable: '/usr/bin/node', argv: ['--version'], timeoutMs: 1000, maxOutputBytes: 4096 } };
  const view = await loaded({ ...snapshot, rules: [rule] }); let tree = view.render();
  find(tree, '打开用户配置').props.onClick(); tree = view.render();
  assert.equal(find(tree, '展开 检查命令').props['aria-expanded'], false);
  assert.equal(all(tree, n => n.props.className === 'rule-detail').length, 0);
  find(tree, '展开 检查命令').props.onClick(); tree = view.render();
  assert.equal(find(tree, '展开 检查命令').props['aria-expanded'], true);
  assert.equal(all(tree, n => n.props.className === 'rule-detail').length, 1);
  await find(tree, '启用 检查命令').props.onChange({ target: { checked: true } });
  assert.equal(view.calls.find(c => c.method === 'genericHooks/toggle').body.args.id, 'r1');
  const remove = all(tree, n => n.type === 'button' && n.children.includes('删除钩子'))[0];
  await remove.props.onClick();
  assert.equal(view.calls.find(c => c.method === 'genericHooks/remove').body.args.id, 'r1');
});
test('invalid argv stays in editor and does not write configuration', async () => {
  const view = await loaded(snapshot); let tree = view.render();
  find(tree, '打开用户配置').props.onClick(); tree = view.render();
  find(tree, '添加 PreToolUse 钩子').props.onClick(); tree = view.render();
  all(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: '[1]' } }); tree = view.render();
  await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  tree = view.render(); assert.ok(all(tree, n => n.props.role === 'alert').length);
  assert.ok(!view.calls.some(c => c.method === 'genericHooks/upsert'));
});
test('review is two phase, keeps execution disabled and sends the displayed digest', async () => {
  const rule = { id: 'r1', name: '审阅脚本', event: 'PreToolUse', enabled: false, matcher: '*', action: { executable: '/usr/bin/node', argv: [], timeoutMs: 1000 } };
  const digest = 'a'.repeat(64);
  const view = await loaded(method => method === 'genericHooks/previewTrust' ? { id: 'r1', digest, files: [], rule } : { ...snapshot, rules: [rule] });
  let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render();
  find(tree, '展开 审阅脚本').props.onClick(); tree = view.render();
  await all(tree, n => n.type === 'button' && n.children.includes('审阅文件'))[0].props.onClick(); tree = view.render();
  assert.ok(find(tree, '审阅文件'));
  assert.ok(!view.calls.some(c => c.method === 'genericHooks/trust'));
  assert.equal(all(tree, n => n.type === 'button' && n.children.includes('信任这些文件'))[0].props.disabled, true);
  find(tree, '确认信任审阅文件').props.onChange({ target: { checked: true } }); tree = view.render();
  assert.ok(JSON.stringify(tree).includes('/usr/bin/node'));
  await all(tree, n => n.type === 'button' && n.children.includes('信任这些文件'))[0].props.onClick();
  assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/trust').body), JSON.stringify({ args: { id: 'r1', digest } }));
  assert.ok(!view.calls.some(c => /toggle|configure|execute/.test(c.method)));
});
test('Codex import requires preview and invalidates preview when source changes', async () => {
  const view = await loaded(method => method === 'genericHooks/previewImport' ? { rules: [{ id: 'i1' }], unsupported: [], warnings: [] } : snapshot);
  let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render();
  find(tree, 'Codex 配置 JSON').props.onChange({ target: { value: '{"hooks":{}}' } }); tree = view.render();
  find(tree, '导入命令解释器').props.onChange({ target: { value: '/usr/bin/sh' } }); tree = view.render();
  await all(tree, n => n.type === 'button' && n.children.includes('预览导入'))[0].props.onClick(); tree = view.render();
  assert.ok(find(tree, '导入预览'));
  assert.ok(!view.calls.some(c => c.method === 'genericHooks/importCodex'));
  find(tree, 'Codex 配置 JSON').props.onChange({ target: { value: '{"hooks":{"Stop":[]}}' } }); tree = view.render();
  assert.equal(find(tree, '导入预览'), undefined);
});
test('narrow tool-input consent remains distinct from explicit full payload and saves disabled', async () => {
  const view = await loaded(snapshot); let tree = view.render();
  find(tree, '打开用户配置').props.onClick(); tree = view.render();
  find(tree, '添加 PreToolUse 钩子').props.onClick(); tree = view.render();
  assert.equal(find(tree, '向此脚本发送工具参数').props.checked, false);
  assert.equal(find(tree, '事件载荷').props.value, 'metadata');
  find(tree, '向此脚本发送工具参数').props.onChange({ target: { checked: true } }); tree = view.render();
  await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const rule = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
  assert.equal(JSON.stringify(rule.scope), '{"kind":"user"}'); assert.equal(rule.includeToolInput, true); assert.equal(rule.payloadMode, 'metadata'); assert.equal(rule.matcherMode, 'glob'); assert.equal(rule.enabled, false);
});
test('import uses exact request wrapper and interpreter edits invalidate preview', async () => {
  const view = await loaded(method => method === 'genericHooks/previewImport' ? { rules: [{ id: 'valid' }], unsupported: [], warnings: ['review'] } : snapshot);
  let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render();
  assert.equal(find(tree, '导入命令解释器').props.value, ''); assert.equal(find(tree, '解释器参数前缀').props.value, '[]');
  find(tree, 'Codex 配置 JSON').props.onChange({ target: { value: '{}' } }); tree = view.render();
  await all(tree, n => n.type === 'button' && n.children.includes('预览导入'))[0].props.onClick(); tree = view.render();
  const request = { document: '{}', options: { interpreter: { executable: '', argvPrefix: [] }, scope: { kind: 'user' } } };
  assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/previewImport').body), JSON.stringify({ args: { request } }));
  await all(tree, n => n.type === 'button' && n.children.includes('导入关闭的规则'))[0].props.onClick();
  assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/importCodex').body), JSON.stringify({ args: { request } }));
  tree = view.render(); await all(tree, n => n.type === 'button' && n.children.includes('预览导入'))[0].props.onClick(); tree = view.render();
  find(tree, '解释器参数前缀').props.onChange({ target: { value: '["-c"]' } }); tree = view.render(); assert.equal(find(tree, '导入预览'), undefined);
});
test('unsupported or empty import previews cannot commit even through direct handler invocation', async () => {
  for (const result of [{ rules: [{ id: 'r' }], unsupported: ['x'], warnings: [] }, { rules: [], unsupported: [], warnings: [] }]) {
    const view = await loaded(method => method === 'genericHooks/previewImport' ? result : snapshot);
    let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render();
    await all(tree, n => n.type === 'button' && n.children.includes('预览导入'))[0].props.onClick(); tree = view.render();
    const commit = all(tree, n => n.type === 'button' && n.children.includes('导入关闭的规则'))[0]; assert.equal(commit.props.disabled, true); await commit.props.onClick();
    assert.ok(!view.calls.some(c => c.method === 'genericHooks/importCodex'));
  }
});
test('editor round-trips action.trustFiles and explicit full payload without root trustFiles', async () => {
  const rule = { id: 'r1', name: '依赖', event: 'PreToolUse', enabled: true, matcher: 'shell', matcherMode: 'regex', payloadMode: 'full', action: { executable: '/usr/bin/node', argv: [], trustFiles: ['/tmp/script.js'], timeoutMs: 1000 } };
  const view = await loaded({ ...snapshot, rules: [rule] }); let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render(); find(tree, '展开 依赖').props.onClick(); tree = view.render();
  all(tree, n => n.type === 'button' && n.children.includes('编辑钩子'))[0].props.onClick(); tree = view.render();
  assert.equal(find(tree, '信任文件').props.value, '[\n  "/tmp/script.js"\n]');
  await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
  assert.equal(saved.trustFiles, undefined); assert.equal(JSON.stringify(saved.action.trustFiles), '["/tmp/script.js"]'); assert.equal(saved.payloadMode, 'full'); assert.equal(saved.matcherMode, 'regex'); assert.equal(saved.enabled, false);
  assert.ok(!source.includes('含提示、工具参数与结果'));
});
test('project scope round-trips through editor and is visible in details and trust review', async () => {
  const scope = { kind: 'project', root: '/work/project' };
  const rule = { id: 'project', name: '项目规则', event: 'PreToolUse', enabled: true, scope, matcher: '*', action: { executable: '/usr/bin/node', argv: [], trustFiles: [], timeoutMs: 1000 } };
  const view = await loaded(method => method === 'genericHooks/previewTrust' ? { id: rule.id, digest: 'digest', files: [], rule } : { ...snapshot, rules: [rule] });
  let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render(); find(tree, '展开 项目规则').props.onClick(); tree = view.render();
  assert.ok(JSON.stringify(all(tree, n => n.props.className === 'rule-detail')[0]).includes(scope.root));
  await all(tree, n => n.type === 'button' && n.children.includes('审阅文件'))[0].props.onClick(); tree = view.render();
  assert.ok(JSON.stringify(find(tree, '审阅文件')).includes(scope.root));
  all(tree, n => n.type === 'button' && n.children.includes('编辑钩子'))[0].props.onClick(); tree = view.render();
  assert.equal(find(tree, '适用范围').props.value, 'project'); assert.equal(find(tree, '适用范围项目目录').props.value, scope.root);
  await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
  assert.equal(JSON.stringify(saved.scope), JSON.stringify(scope)); assert.equal(saved.enabled, false);
  assert.ok(!view.calls.some(c => /toggle|configure|execute/.test(c.method)));
});
test('project import target is explicit, sent in exact request and invalidates preview on scope edits', async () => {
  const view = await loaded(method => method === 'genericHooks/previewImport' ? { rules: [{ id: 'r' }], unsupported: [], warnings: [] } : snapshot);
  let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render();
  find(tree, '导入适用范围').props.onChange({ target: { value: 'project' } }); tree = view.render();
  find(tree, '导入适用范围项目目录').props.onChange({ target: { value: '/work/project' } }); tree = view.render();
  await all(tree, n => n.type === 'button' && n.children.includes('预览导入'))[0].props.onClick(); tree = view.render();
  const request = { document: '', options: { interpreter: { executable: '', argvPrefix: [] }, scope: { kind: 'project', root: '/work/project' } } };
  assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/previewImport').body), JSON.stringify({ args: { request } }));
  await all(tree, n => n.type === 'button' && n.children.includes('导入关闭的规则'))[0].props.onClick();
  assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/importCodex').body), JSON.stringify({ args: { request } }));
  tree = view.render(); await all(tree, n => n.type === 'button' && n.children.includes('预览导入'))[0].props.onClick(); tree = view.render();
  find(tree, '导入适用范围项目目录').props.onChange({ target: { value: '/work/other' } }); assert.equal(find(view.render(), '导入预览'), undefined);
});
test('invalid trust file JSON stays in editor without saving', async () => {
  const view = await loaded(snapshot); let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render(); find(tree, '添加 PreToolUse 钩子').props.onClick(); tree = view.render();
  find(tree, '信任文件').props.onChange({ target: { value: '[1]' } }); tree = view.render(); await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(!view.calls.some(c => c.method === 'genericHooks/upsert')); assert.ok(all(view.render(), n => n.props.role === 'alert').length);
});
test('trust review displays server-bound current definition instead of stale snapshot and fails closed without it', async () => {
  const stale = { id: 'r1', name: '旧规则', event: 'PreToolUse', enabled: false, payloadMode: 'metadata', scope: { kind: 'user' }, matcher: '*', action: { executable: '/old/node', argv: [] } };
  const current = { ...stale, name: '当前规则', payloadMode: 'full', scope: { kind: 'project', root: '/current/project' }, matcher: 'current*', action: { executable: '/current/node', argv: ['current.js'], trustFiles: ['/current/script.js'] } };
  for (const serverRule of [current, undefined]) {
    const view = await loaded(method => method === 'genericHooks/previewTrust' ? { id: 'r1', digest: 'current-digest', files: [], ...(serverRule ? { rule: serverRule } : {}) } : { ...snapshot, rules: [stale] });
    let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render(); find(tree, '展开 旧规则').props.onClick(); tree = view.render();
    await all(tree, n => n.type === 'button' && n.children.includes('审阅文件'))[0].props.onClick(); tree = view.render();
    const panel = find(tree, '审阅文件');
    if (serverRule) { const text = JSON.stringify(panel); for (const expected of ['full', '/current/project', '/current/node', 'current*', '/current/script.js']) assert.ok(text.includes(expected)); assert.ok(!text.includes('/old/node')); }
    else { assert.equal(panel, undefined); assert.equal(find(tree, '确认信任审阅文件'), undefined); assert.ok(all(tree, n => n.props.role === 'alert').length); }
    assert.ok(!view.calls.some(c => c.method === 'genericHooks/trust'));
  }
});
test('scope skip records have actionable labels without running any hook', async () => {
  const view = await loaded({ ...snapshot, records: [
    { id: 'missing', event: 'PreToolUse', status: 'scope_unavailable' },
    { id: 'invalid', event: 'PreToolUse', status: 'scope_invalid' },
  ] });
  const text = JSON.stringify(view.render());
  assert.ok(text.includes('跳过：会话目录不可用'));
  assert.ok(text.includes('跳过：项目目录失效'));
  assert.deepEqual(view.calls.map(call => call.method), ['genericHooks/snapshot']);
});
function button(tree, text) { return all(tree, n => n.type === 'button' && n.children.includes(text))[0]; }
function openImport(view) { let tree = view.render(); find(tree, '打开用户配置').props.onClick(); return view.render(); }
const discovered = { path: '/codex/hooks.json', format: 'json', status: 'available', document: '{"hooks":{"Stop":[]}}', sha256: 'a'.repeat(64) };
test('discovery is explicit, uses exact owner RPC and never loads document automatically', async () => {
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { kind: 'user', directory: '/codex', sources: [discovered] } : snapshot);
  let tree = openImport(view);
  assert.equal(find(tree, '配置来源目录').props.value, '');
  assert.equal(find(tree, '配置来源类型').props.value, 'user');
  find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot']);
  await button(tree, '发现配置').props.onClick(); tree = view.render();
  assert.equal(JSON.stringify(view.calls.at(-1)), JSON.stringify({ path: '/api', method: 'genericHooks/discoverSources', body: { args: { request: { kind: 'user', directory: '/codex' } } } }));
  assert.equal(find(tree, 'Codex 配置 JSON').props.value, '');
  assert.ok(!JSON.stringify(find(tree, '发现的配置')).includes(discovered.document));
  assert.ok(button(tree, '载入 JSON'));
  assert.ok(!view.calls.some(c => /configure|toggle|trust|importCodex/.test(c.method)));
});
test('available JSON loads snapshot provenance, preserves import scope, and manual edits clear provenance and preview', async () => {
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered] } : method === 'genericHooks/previewImport' ? { rules: [{ id: 'r' }], unsupported: [], warnings: [] } : snapshot);
  let tree = openImport(view);
  find(tree, '导入适用范围').props.onChange({ target: { value: 'project' } }); tree = view.render();
  find(tree, '导入适用范围项目目录').props.onChange({ target: { value: '/target' } }); tree = view.render();
  find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  await button(tree, '发现配置').props.onClick(); tree = view.render();
  await button(tree, '预览导入').props.onClick(); tree = view.render(); assert.ok(find(tree, '导入预览'));
  button(tree, '载入 JSON').props.onClick(); tree = view.render();
  assert.equal(find(tree, '导入预览'), undefined);
  assert.equal(find(tree, 'Codex 配置 JSON').props.value, discovered.document);
  assert.equal(find(tree, '已选来源').props.value, discovered.path); assert.equal(find(tree, '已选来源').props.readOnly, true);
  await button(tree, '预览导入').props.onClick(); tree = view.render();
  const request = view.calls.at(-1).body.args.request;
  assert.equal(request.options.source, `codex-file:${discovered.sha256}`);
  assert.equal(JSON.stringify(request.options.scope), '{"kind":"project","root":"/target"}');
  await button(tree, '导入关闭的规则').props.onClick();
  assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/importCodex').body.args.request), JSON.stringify(request));
  tree = view.render(); await button(tree, '预览导入').props.onClick(); tree = view.render();
  find(tree, 'Codex 配置 JSON').props.onChange({ target: { value: '{}' } }); tree = view.render();
  assert.equal(find(tree, '已选来源'), undefined); assert.equal(find(tree, '导入预览'), undefined);
  await button(tree, '预览导入').props.onClick(); assert.equal(view.calls.at(-1).body.args.request.options.source, undefined);
  assert.ok(!view.calls.some(c => /configure|toggle|trust/.test(c.method)));
});
test('root edits ignore pending discovery responses and clear selected provenance', async () => {
  for (const label of ['配置来源目录', '配置来源类型']) {
    let resolveDiscovery;
    const view = await loaded(method => method === 'genericHooks/discoverSources' ? new Promise(resolve => { resolveDiscovery = resolve; }) : snapshot);
    let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/old' } }); tree = view.render();
    const pending = button(tree, '发现配置').props.onClick(); tree = view.render();
    find(tree, label).props.onChange({ target: { value: label === '配置来源目录' ? '/new' : 'project' } });
    resolveDiscovery({ sources: [discovered] }); await pending; tree = view.render();
    assert.equal(find(tree, '发现的配置'), undefined); assert.equal(button(tree, '载入 JSON'), undefined);
  }
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered] } : snapshot);
  let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  await button(tree, '发现配置').props.onClick(); tree = view.render(); button(tree, '载入 JSON').props.onClick(); tree = view.render();
  find(tree, '配置来源类型').props.onChange({ target: { value: 'project' } }); tree = view.render();
  assert.equal(find(tree, '已选来源'), undefined); assert.equal(find(tree, '发现的配置'), undefined);
  assert.equal(find(tree, '导入适用范围').props.value, 'user'); assert.ok(JSON.stringify(tree).includes('项目根目录'));
});
test('missing, rejected and unsupported TOML candidates have truthful statuses without load buttons', async () => {
  const sources = [{ path: '/missing.json', format: 'json', status: 'missing' }, { path: '/denied.json', format: 'json', status: 'rejected', code: 'permission_denied' }, { path: '/config.toml', format: 'toml', status: 'unsupported_format' }];
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources } : snapshot);
  let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  await button(tree, '发现配置').props.onClick(); tree = view.render();
  const text = JSON.stringify(find(tree, '发现的配置'));
  for (const expected of ['/missing.json', '/denied.json', '/config.toml', '文件不存在', '已拒绝', '不支持 TOML']) assert.ok(text.includes(expected));
  assert.equal(button(tree, '载入 JSON'), undefined); assert.ok(!view.calls.some(c => /configure|toggle|trust/.test(c.method)));
});
test('discovery validation failures explain how to correct the directory', async () => {
  for (const code of ['invalid_request', 'invalid_directory']) {
    const view = await loaded(method => { if (method === 'genericHooks/discoverSources') throw new Error(code); return snapshot; });
    let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: 'relative' } }); tree = view.render();
    await button(tree, '发现配置').props.onClick(); tree = view.render();
    const alert = all(tree, n => n.props.role === 'alert')[0];
    assert.ok(JSON.stringify(alert).includes('绝对路径')); assert.ok(!JSON.stringify(alert).includes(code));
  }
});
test('both close paths ignore late discovery responses and allow fresh discovery after reopening', async () => {
  for (const native of [false, true]) {
    let resolveDiscovery;
    const view = await loaded(method => method === 'genericHooks/discoverSources' ? new Promise(resolve => { resolveDiscovery = resolve; }) : snapshot);
    let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
    const pending = button(tree, '发现配置').props.onClick(); tree = view.render();
    if (native) all(tree, n => n.type === 'dialog')[0].props.onClose(); else find(tree, '关闭用户配置').props.onClick();
    resolveDiscovery({ sources: [discovered] }); await pending; tree = openImport(view);
    assert.equal(find(tree, '发现的配置'), undefined); assert.equal(button(tree, '发现配置').props.disabled, false);
  }
});
test('captured JSON load handlers cannot restore provenance after root changes or dialog close', async () => {
  for (const change of ['directory', 'kind', 'close']) {
    const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered] } : snapshot);
    let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
    await button(tree, '发现配置').props.onClick(); tree = view.render(); const staleLoad = button(tree, '载入 JSON').props.onClick;
    if (change === 'close') find(tree, '关闭用户配置').props.onClick();
    else find(tree, change === 'kind' ? '配置来源类型' : '配置来源目录').props.onChange({ target: { value: change === 'kind' ? 'project' : '/new' } });
    staleLoad(); tree = view.render();
    assert.equal(find(tree, '已选来源'), undefined); assert.equal(find(tree, 'Codex 配置 JSON').props.value, '');
    assert.equal(find(tree, '导入适用范围').props.value, 'user');
  }
});
test('available TOML loads only extracted hooks JSON with original-byte hash provenance and no inferred settings', async () => {
  const candidate = { ...discovered, path: '/codex/config.toml', format: 'toml', document: '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo review"}]}]}}', sha256: 'b'.repeat(64) };
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [candidate] } : method === 'genericHooks/previewImport' ? { rules: [{ id: 'r' }], unsupported: [], warnings: [] } : snapshot);
  let tree = openImport(view);
  find(tree, '配置来源类型').props.onChange({ target: { value: 'project' } }); tree = view.render();
  find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  await button(tree, '发现配置').props.onClick(); tree = view.render();
  assert.equal(find(tree, 'Codex 配置 JSON').props.value, '');
  assert.ok(JSON.stringify(find(tree, '发现的配置')).includes('可载入钩子'));
  assert.equal(button(tree, '载入 JSON'), undefined);
  button(tree, '载入钩子 JSON').props.onClick(); tree = view.render();
  assert.equal(find(tree, 'Codex 配置 JSON').props.value, candidate.document);
  assert.equal(find(tree, '已选来源').props.value, candidate.path);
  assert.equal(find(tree, '导入适用范围').props.value, 'user');
  assert.equal(find(tree, '导入命令解释器').props.value, '');
  assert.equal(find(tree, '解释器参数前缀').props.value, '[]');
  assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot', 'genericHooks/discoverSources']);
  await button(tree, '预览导入').props.onClick(); tree = view.render();
  const request = view.calls.at(-1).body.args.request;
  assert.equal(request.document, candidate.document);
  assert.equal(request.options.source, `codex-file:${candidate.sha256}`);
  assert.equal(JSON.stringify(request.options.scope), '{"kind":"user"}');
  find(tree, 'Codex 配置 JSON').props.onChange({ target: { value: '{}' } }); tree = view.render();
  assert.equal(find(tree, '已选来源'), undefined); assert.equal(find(tree, '导入预览'), undefined);
  await button(tree, '预览导入').props.onClick();
  assert.equal(view.calls.at(-1).body.args.request.options.source, undefined);
  assert.ok(!view.calls.some(c => /configure|toggle|trust|importCodex|execute/.test(c.method)));
});
test('malformed available documents and rejected TOML never offer load actions', async () => {
  const codes = ['toml_hooks_missing', 'toml_invalid_document', 'toml_document_too_large', 'toml_hooks_invalid', 'toml_hooks_too_large', 'toml_hooks_too_deep', 'toml_hooks_too_many_nodes', 'toml_hooks_non_json', 'toml_hooks_unsafe_key', 'toml_timeout', 'toml_worker_failed'];
  const sources = codes.map(code => ({ ...discovered, format: 'toml', status: 'rejected', code }));
  for (const format of ['json', 'toml']) for (const document of ['', '   ', 'not JSON']) sources.push({ ...discovered, format, document });
  sources.push({ ...discovered, format: 'toml', sha256: 'invalid' });
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources } : snapshot);
  let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  await button(tree, '发现配置').props.onClick(); tree = view.render();
  assert.equal(button(tree, '载入 JSON'), undefined); assert.equal(button(tree, '载入钩子 JSON'), undefined);
  const text = JSON.stringify(find(tree, '发现的配置'));
  for (const expected of ['未找到 hooks', '语法无效', '解析超时', '非 JSON 值', '文件过大', '过于复杂', '格式无效', '内容过大', '嵌套过深', '不安全键名', '解析失败']) assert.ok(text.includes(expected));
});
test('captured TOML load handler cannot restore stale provenance', async () => {
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [{ ...discovered, format: 'toml' }] } : snapshot);
  let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render();
  await button(tree, '发现配置').props.onClick(); tree = view.render(); const staleLoad = button(tree, '载入钩子 JSON').props.onClick;
  find(tree, '配置来源目录').props.onChange({ target: { value: '/new' } }); staleLoad(); tree = view.render();
  assert.equal(find(tree, '已选来源'), undefined); assert.equal(find(tree, 'Codex 配置 JSON').props.value, '');
});
const tomlSource = { ...discovered, name: 'config.toml', path: '/codex/config.toml', format: 'toml', sha256: 'b'.repeat(64), document: '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo review"}]}]}}' };
const combinedResult = { rules: [{ id: 'json' }, { id: 'toml' }], unsupported: [], warnings: ['review both'] };
async function discoverImport(view) { let tree = openImport(view); find(tree, '配置来源目录').props.onChange({ target: { value: '/codex' } }); tree = view.render(); await button(tree, '发现配置').props.onClick(); return view.render(); }
test('combined JSON and TOML preview preserves both byte provenances and exact atomic owner wrapper', async () => {
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered, tomlSource] } : method === 'genericHooks/previewSourceImports' ? combinedResult : snapshot);
  let tree = await discoverImport(view);
  assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot', 'genericHooks/discoverSources']);
  assert.equal(find(tree, 'Codex 配置 JSON').props.value, '');
  assert.equal(button(tree, '导入全部来源'), undefined);
  find(tree, '导入命令解释器').props.onChange({ target: { value: '/bin/sh' } }); tree = view.render();
  find(tree, '解释器参数前缀').props.onChange({ target: { value: '["-c"]' } }); tree = view.render();
  await button(tree, '预览全部来源').props.onClick(); tree = view.render();
  const request = { documents: [discovered, tomlSource].map(s => ({ document: s.document, source: `codex-file:${s.sha256}` })), options: { interpreter: { executable: '/bin/sh', argvPrefix: ['-c'] }, scope: { kind: 'user' } } };
  assert.equal(JSON.stringify(view.calls.at(-1)), JSON.stringify({ path: '/api', method: 'genericHooks/previewSourceImports', body: { args: { request } } }));
  const review = JSON.stringify(find(tree, '导入预览')); for (const value of ['hooks.json', 'config.toml', discovered.path, tomlSource.path, discovered.sha256, tomlSource.sha256]) assert.ok(review.includes(value));
  assert.equal(find(tree, 'Codex 配置 JSON').props.value, ''); assert.equal(find(tree, '导入适用范围').props.value, 'user');
  await button(tree, '导入全部来源').props.onClick();
  assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/importSources').body), JSON.stringify({ args: { request } }));
  assert.ok(!view.calls.some(c => /trust|toggle|configure|execute|importCodex/.test(c.method)));
});
test('combined preview blocks rejected or malformed existing sources, permits missing, and guards direct handlers', async () => {
  for (const candidate of [{ ...tomlSource, status: 'rejected' }, { ...tomlSource, status: 'unsupported_format' }, { ...tomlSource, document: 'bad' }, { ...tomlSource, sha256: 'bad' }, { ...tomlSource, sha256: discovered.sha256 }, { ...tomlSource, status: 'missing' }]) {
    const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered, candidate] } : method === 'genericHooks/previewSourceImports' ? combinedResult : snapshot);
    let tree = await discoverImport(view); const preview = button(tree, '预览全部来源'); const allowed = candidate.status === 'missing';
    assert.equal(preview.props.disabled, !allowed); await preview.props.onClick();
    const call = view.calls.find(c => c.method === 'genericHooks/previewSourceImports'); assert.equal(Boolean(call), allowed);
    if (allowed) assert.equal(call.body.args.request.documents.length, 1);
  }
  const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [{ ...discovered, status: 'missing' }] } : snapshot);
  assert.equal(button(await discoverImport(view), '预览全部来源'), undefined);
});
test('unsupported or empty combined preview never commits even via direct handler', async () => {
  for (const result of [{ ...combinedResult, unsupported: ['unsupported'] }, { ...combinedResult, rules: [] }]) {
    const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered, tomlSource] } : method === 'genericHooks/previewSourceImports' ? result : snapshot);
    let tree = await discoverImport(view); await button(tree, '预览全部来源').props.onClick(); tree = view.render();
    const commit = button(tree, '导入全部来源'); assert.equal(commit.props.disabled, true); await commit.props.onClick(); assert.ok(!view.calls.some(c => c.method === 'genericHooks/importSources'));
  }
});
function mutateImport(view, tree, mutation) {
  if (mutation === 'nativeClose') all(tree, n => n.type === 'dialog')[0].props.onClose();
  else if (mutation === 'close') find(tree, '关闭用户配置').props.onClick();
  else if (mutation === 'discovery') return button(tree, '发现配置').props.onClick();
  else find(tree, mutation).props.onChange({ target: { value: ({ '配置来源类型': 'project', '导入适用范围': 'project', '解释器参数前缀': '["-c"]', 'Codex 配置 JSON': '{}' })[mutation] || '/changed' } });
}
test('combined pending responses and captured preview/commit handlers fail closed after every input or close', async () => {
  const mutations = ['配置来源目录', '配置来源类型', '导入命令解释器', '解释器参数前缀', '导入适用范围', '导入适用范围项目目录', 'Codex 配置 JSON', 'discovery', 'close', 'nativeClose'];
  for (const mutation of mutations) {
    let resolvePreview;
    const view = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered, tomlSource] } : method === 'genericHooks/previewSourceImports' ? new Promise(resolve => { resolvePreview = resolve; }) : snapshot);
    let tree = await discoverImport(view);
    find(tree, '导入适用范围').props.onChange({ target: { value: 'project' } }); tree = view.render();
    const stalePreview = button(tree, '预览全部来源').props.onClick;
    const pending = stalePreview(); tree = view.render();
    // Pending close uses native close: normal close deliberately remains blocked while busy.
    await mutateImport(view, tree, mutation === 'close' ? 'nativeClose' : mutation);
    resolvePreview(combinedResult); await pending; tree = view.render();
    assert.equal(find(tree, '导入预览'), undefined, mutation);
    const count = view.calls.length; await stalePreview(); assert.equal(view.calls.length, count, mutation);
    const ready = await loaded(method => method === 'genericHooks/discoverSources' ? { sources: [discovered, tomlSource] } : method === 'genericHooks/previewSourceImports' ? combinedResult : snapshot);
    tree = await discoverImport(ready); find(tree, '导入适用范围').props.onChange({ target: { value: 'project' } }); tree = ready.render();
    await button(tree, '预览全部来源').props.onClick(); tree = ready.render(); const staleCommit = button(tree, '导入全部来源').props.onClick;
    await mutateImport(ready, tree, mutation); await staleCommit();
    assert.ok(!ready.calls.some(c => c.method === 'genericHooks/importSources'), mutation);
  }
});
test('combined preview and commit errors give concise Chinese recovery', async () => {
  for (const stage of ['previewSourceImports', 'importSources']) for (const code of ['codex_sources_invalid_request', 'codex_import_handler_limit']) {
    const view = await loaded(method => { if (method === `genericHooks/${stage}`) throw new Error(code); return method === 'genericHooks/discoverSources' ? { sources: [discovered, tomlSource] } : method === 'genericHooks/previewSourceImports' ? combinedResult : snapshot; });
    let tree = await discoverImport(view); await button(tree, '预览全部来源').props.onClick(); tree = view.render();
    if (stage === 'importSources') { await button(tree, '导入全部来源').props.onClick(); tree = view.render(); }
    const text = JSON.stringify(all(tree, n => n.props.role === 'alert')); assert.ok(text.includes(code === 'codex_sources_invalid_request' ? '重新发现配置' : '最多 100 个处理器')); assert.ok(!text.includes(code));
  }
});
test('Stop and inbox background notifications are explicit, metadata-only and clear on incompatible edits', async () => {
  for (const event of ['Stop', 'UserPromptSubmit', 'SessionStart', 'Interrupt', 'PreModelRequest', 'PostModelRequest', 'SubagentStart', 'PostToolUse', 'PreToolUse']) for (const mode of ['default', 'true', 'false', 'event', 'payload']) {
    const view = await permissionEditor({ ...permissionRule, event }); let tree = view.render();
    assert.equal(find(tree, '后台通知').props.checked, false);
    assert.ok(JSON.stringify(tree).includes(event === 'UserPromptSubmit' ? '消息入队后通知，不读取消息正文、不阻止提交；智能体释放时请求取消。' : event === 'SessionStart' ? '仅通知会话创建，不等待初始化、不注入上下文；智能体释放时请求取消。' : event === 'Interrupt' ? '用户中断已记录后通知，不阻止或重启任务；默认 1 秒，最长 3 秒。' : event === 'PreToolUse' ? '后台通知不是安全门禁，工具可能先于通知执行；不等待或采纳输出，不读取参数。' : event === 'PostToolUse' ? '工具执行后仅发送通知，不读取工具输入或结果，不反馈或改写结果；智能体释放时请求取消。' : event === 'SubagentStart' ? '仅通知本地子智能体发布，不读取提示或回复；子智能体释放时请求取消。' : ['PreModelRequest', 'PostModelRequest'].includes(event) ? '仅通知模型请求状态，不读取正文、不改写请求或注入上下文；智能体释放时请求取消。' : '仅发送通知，不控制结束；智能体释放时请求取消。'));
    if (mode !== 'default') { find(tree, '后台通知').props.onChange({ target: { checked: true } }); tree = view.render(); }
    if (mode === 'false') find(tree, '后台通知').props.onChange({ target: { checked: false } });
    if (mode === 'event') { find(tree, '钩子事件').props.onChange({ target: { value: 'SessionEnd' } }); tree = view.render(); assert.equal(find(tree, '后台通知'), undefined); find(tree, '钩子事件').props.onChange({ target: { value: event } }); }
    if (mode === 'payload') { find(tree, '事件载荷').props.onChange({ target: { value: 'full' } }); tree = view.render(); assert.equal(find(tree, '后台通知').props.checked, false); assert.equal(find(tree, '后台通知').props.disabled, true); find(tree, '事件载荷').props.onChange({ target: { value: 'metadata' } }); }
    tree = view.render(); await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
    assert.equal(Object.hasOwn(saved, 'async'), mode === 'true');
    if (mode === 'true') assert.equal(saved.async, true);
    assert.equal(saved.enabled, false); assert.equal(Object.hasOwn(saved, 'trust'), false);
    assert.ok(view.calls.every(c => !/configure|toggle|trust|execute|run/i.test(c.method)));
  }
});
test('sharing tool input visibly clears incompatible background mode before save', async () => {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const view = await permissionEditor({ ...permissionRule, event }); let tree = view.render();
    find(tree, '后台通知').props.onChange({ target: { checked: true } }); tree = view.render();
    find(tree, '向此脚本发送工具参数').props.onChange({ target: { checked: true } }); tree = view.render();
    assert.equal(find(tree, '后台通知').props.checked, false);
    assert.equal(find(tree, '后台通知').props.disabled, true);
    find(tree, '向此脚本发送工具参数').props.onChange({ target: { checked: false } }); tree = view.render();
    assert.equal(find(tree, '后台通知').props.checked, false);
    await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
    assert.equal(Object.hasOwn(saved, 'async'), false);
    assert.equal(saved.enabled, false);
    assert.equal(Object.hasOwn(saved, 'trust'), false);
  }
});

test('Interrupt opt-in selects a short timeout without changing saved legacy rules automatically', async () => {
  for (const previous of [5000, 2000]) {
    const view = await permissionEditor({ ...permissionRule, event: 'Interrupt', action: { ...permissionRule.action, timeoutMs: previous } });
    let tree = view.render();
    assert.equal(all(tree, n => n.type === 'input' && n.props.max === 600000)[0].props.value, previous);
    assert.equal(view.calls.some(c => c.method === 'genericHooks/upsert'), false);
    find(tree, '后台通知').props.onChange({ target: { checked: true } }); tree = view.render();
    assert.equal(all(tree, n => n.type === 'input' && n.props.max === 3000)[0].props.value, previous > 3000 ? 1000 : previous);
    await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    const saved = view.calls.find(c => c.method === 'genericHooks/upsert').body.args.rule;
    assert.equal(saved.async, true); assert.equal(saved.enabled, false);
    assert.equal(saved.action.timeoutMs, previous > 3000 ? 1000 : previous);
    assert.equal(Object.hasOwn(saved, 'trust'), false);
  }
  const view = await permissionEditor({ ...permissionRule, event: 'Stop' }); let tree = view.render();
  find(tree, '后台通知').props.onChange({ target: { checked: true } }); tree = view.render();
  find(tree, '钩子事件').props.onChange({ target: { value: 'Interrupt' } }); tree = view.render();
  assert.equal(all(tree, n => n.type === 'input' && n.props.max === 3000)[0].props.value, 1000);
});

test('async trust review uses exact Host root flag instead of snapshot or draft', async () => {
  for (const hostFlag of [true, false]) {
    const rule = { ...permissionRule, event: 'Stop', async: !hostFlag };
    const hostRule = { ...rule, async: hostFlag };
    const view = await loaded(method => method === 'genericHooks/previewTrust' ? { id: rule.id, rule: hostRule, digest: 'a'.repeat(64), files: [] } : { ...snapshot, rules: [rule], events: [{ name: 'Stop' }] });
    let tree = view.render(); find(tree, '打开用户配置').props.onClick(); tree = view.render(); find(tree, `展开 ${rule.name}`).props.onClick(); tree = view.render();
    await all(tree, n => n.type === 'button' && n.children.includes('审阅文件'))[0].props.onClick(); tree = view.render();
    const review = find(tree, '审阅文件'); const displayed = JSON.parse(all(review, n => n.type === 'pre')[0].children[0]);
    assert.equal(displayed.async, hostFlag ? true : undefined);
    assert.equal(JSON.stringify(review).includes('仅发送通知，不控制结束；智能体释放时请求取消。'), hostFlag);
    assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot', 'genericHooks/previewTrust']);
  }
});
const registeredSource = { id: 'source-1', revision: 3, status: 'current', request: { kind: 'user', directory: '/exact/codex' }, accepted: { 'hooks.json': 'a'.repeat(64) }, options: { scope: { kind: 'project', root: '/exact/project' }, interpreter: { executable: '/bin/sh', argvPrefix: ['-c'] } } };
const refreshPreview = { request: { id: 'source-1', revision: 3, accepted: { 'hooks.json': 'b'.repeat(64) }, previewToken: '12345678-1234-4123-8123-123456789abc' }, rules: [{ id: 'new-rule', name: '新命令', event: 'PreToolUse', enabled: false, action: { executable: '/bin/sh', argv: ['new command'] } }], unsupported: [], warnings: ['review warning'] };
const sourceButton = (tree, text) => all(tree, n => n.type === 'button' && n.children.includes(text))[0];
async function sourceView(response) { const view = await loaded(response); find(view.render(), '打开用户配置').props.onClick(); return view; }
test('source registry stays absent on old snapshots and shows exact review data with safe statuses', async () => {
  const old = await sourceView(snapshot); assert.equal(find(old.render(), '已登记来源'), undefined);
  for (const [status, label] of [['current', '已接受快照'], ['review', '需重新审阅'], ['conflict', '规则冲突'], ['toString', '状态未知，请检查来源']]) {
    const view = await sourceView({ ...snapshot, sourceRegistrations: [{ ...registeredSource, status }] });
    const tree = view.render(), text = JSON.stringify(find(tree, '已登记来源'));
    for (const value of ['/exact/codex', 'hooks.json', '/exact/project', '/bin/sh', 'a'.repeat(64), label]) assert.ok(text.includes(value));
    assert.ok(!/已同步|实时/.test(text)); assert.equal(view.calls.length, 1);
  }
});
test('source check is explicit and pending clicks are gated before rerender', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const view = await sourceView(async method => { if (method === 'genericHooks/checkSources') await pending; return { ...snapshot, sourceRegistrations: [registeredSource] }; });
  const click = sourceButton(view.render(), '检查来源').props.onClick;
  const first = click(); await click(); assert.equal(view.calls.filter(c => c.method === 'genericHooks/checkSources').length, 1);
  assert.equal(JSON.stringify(view.calls.at(-1).body), '{"args":{}}');
  release(); await first;
  assert.deepEqual(view.calls.map(c => c.method), ['genericHooks/snapshot', 'genericHooks/checkSources', 'genericHooks/snapshot']);
});
test('detach requires inline confirmation, captures only id revision and gates duplicate pending clicks', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const view = await sourceView(async method => { if (method === 'genericHooks/detachSource') await pending; return { ...snapshot, sourceRegistrations: method === 'genericHooks/snapshot' ? [registeredSource] : [] }; });
  find(view.render(), '解除登记 source-1').props.onClick(); let tree = view.render();
  assert.equal(view.calls.length, 1); assert.ok(JSON.stringify(find(tree, '确认解除来源登记')).includes('本地编辑不覆盖，不删除原文件'));
  const click = sourceButton(tree, '确认解除登记').props.onClick, first = click(); await click();
  assert.equal(view.calls.filter(c => c.method === 'genericHooks/detachSource').length, 1);
  assert.equal(JSON.stringify(view.calls.at(-1).body), JSON.stringify({ args: { request: { id: 'source-1', revision: 3 } } }));
  release(); await first;
  assert.ok(view.calls.every(c => !/toggle|configure|trust|import|refreshSource|execute/.test(c.method)));
});
test('cancel, close reopen and refreshed revision invalidate captured detach handlers', async () => {
  for (const action of ['cancel', 'close', 'native-close', 'refresh']) {
    let revision = 3;
    const view = await sourceView(() => ({ ...snapshot, sourceRegistrations: [{ ...registeredSource, revision }] }));
    const begin = find(view.render(), '解除登记 source-1').props.onClick; begin();
    const stale = sourceButton(view.render(), '确认解除登记').props.onClick;
    if (action === 'cancel') sourceButton(view.render(), '取消解除').props.onClick();
    if (action === 'close') { find(view.render(), '关闭用户配置').props.onClick(); find(view.render(), '打开用户配置').props.onClick(); begin(); }
    if (action === 'native-close') { all(view.render(), n => n.type === 'dialog')[0].props.onClose(); find(view.render(), '打开用户配置').props.onClick(); begin(); }
    if (action === 'refresh') { revision = 4; await find(view.render(), '刷新钩子配置').props.onClick(); }
    await stale(); assert.equal(view.calls.filter(c => c.method === 'genericHooks/detachSource').length, 0);
    assert.equal(find(view.render(), '确认解除来源登记'), undefined);
  }
});
test('detach denial and snapshot failure never report success and require a new confirmation', async () => {
  for (const failure of ['detach', 'snapshot']) {
    let snapshots = 0;
    const view = await sourceView(method => {
      if (method === 'genericHooks/detachSource' && failure === 'detach') throw new Error('local_owner_client_required');
      if (method === 'genericHooks/snapshot' && ++snapshots > 1 && failure === 'snapshot') throw new Error('offline');
      return { ...snapshot, sourceRegistrations: [registeredSource] };
    });
    find(view.render(), '解除登记 source-1').props.onClick();
    const click = sourceButton(view.render(), '确认解除登记').props.onClick; await click(); await click();
    const text = JSON.stringify(view.render()); assert.ok(!text.includes('已解除来源登记。')); assert.ok(text.includes('请刷新核实后重试'));
    assert.ok(text.includes(failure === 'snapshot' ? '操作可能已提交' : 'local_owner_client_required'));
    assert.equal(find(view.render(), '确认解除来源登记'), undefined);
    assert.equal(view.calls.filter(c => c.method === 'genericHooks/detachSource').length, 1);
  }
});
test('unmount invalidates captured source check and detach handlers without new RPC', async () => {
  const view = fixture({ ...snapshot, sourceRegistrations: [registeredSource] });
  view.render(); const cleanup = view.effects[0](); await new Promise(resolve => setImmediate(resolve));
  find(view.render(), '打开用户配置').props.onClick();
  const begin = find(view.render(), '解除登记 source-1').props.onClick; begin();
  const tree = view.render(), check = sourceButton(tree, '检查来源').props.onClick, confirm = sourceButton(tree, '确认解除登记').props.onClick;
  cleanup(); const count = view.calls.length;
  await check(); await confirm(); begin();
  assert.equal(view.calls.length, count);
});
test('source refresh previews real rules and returns exact server request with token only on explicit acceptance', async () => {
  for (const rules of [refreshPreview.rules, []]) {
    const result = { ...refreshPreview, rules };
    const view = await sourceView(method => method === 'genericHooks/previewSourceRefresh' ? result : { ...snapshot, sourceRegistrations: [registeredSource] });
    await find(view.render(), '预览更新 source-1').props.onClick(); let tree = view.render();
    assert.equal(JSON.stringify(view.calls.at(-1)), JSON.stringify({ path: '/api', method: 'genericHooks/previewSourceRefresh', body: { args: { request: { id: 'source-1', revision: 3 } } } }));
    const text = JSON.stringify(find(tree, '来源更新预览')); assert.ok(text.includes(`将替换为 ${rules.length} 条规则`)); assert.ok(text.includes('关闭且未信任')); assert.ok(text.includes('review warning'));
    if (rules.length) assert.ok(text.includes('new command'));
    assert.ok(!view.calls.some(c => /checkSources|refreshSource$/.test(c.method)));
    const accept = sourceButton(tree, '接受来源更新').props.onClick; await accept(); await accept();
    assert.equal(view.calls.filter(c => c.method === 'genericHooks/refreshSource').length, 1);
    assert.equal(JSON.stringify(view.calls.find(c => c.method === 'genericHooks/refreshSource').body), JSON.stringify({ args: { request: result.request } }));
  }
});
test('source refresh rejects malformed tokens identities digests and unsupported previews', async () => {
  for (const request of [{ ...refreshPreview.request, previewToken: undefined }, { ...refreshPreview.request, previewToken: 'bad' }, { ...refreshPreview.request, id: 'other' }, { ...refreshPreview.request, revision: 4 }, { ...refreshPreview.request, accepted: {} }, { ...refreshPreview.request, accepted: { 'config.toml': 'b'.repeat(64) } }, { ...refreshPreview.request, accepted: { ...refreshPreview.request.accepted, 'config.toml': 'b'.repeat(64) } }, { ...refreshPreview.request, accepted: { 'hooks.json': 'bad' } }]) {
    const view = await sourceView(method => method === 'genericHooks/previewSourceRefresh' ? { ...refreshPreview, request } : { ...snapshot, sourceRegistrations: [registeredSource] });
    await find(view.render(), '预览更新 source-1').props.onClick(); assert.equal(find(view.render(), '来源更新预览'), undefined); assert.ok(JSON.stringify(view.render()).includes('刷新后重试'));
  }
  const view = await sourceView(method => method === 'genericHooks/previewSourceRefresh' ? { ...refreshPreview, unsupported: [{}] } : { ...snapshot, sourceRegistrations: [registeredSource] });
  await find(view.render(), '预览更新 source-1').props.onClick(); const accept = sourceButton(view.render(), '接受来源更新'); assert.equal(accept.props.disabled, true); await accept.props.onClick(); assert.ok(!view.calls.some(c => c.method === 'genericHooks/refreshSource'));
});
test('source refresh malformed executable definitions never become reviewable', async () => {
  for (const rule of [{}, null, { ...refreshPreview.rules[0], enabled: true }, { ...refreshPreview.rules[0], trust: {} }, { ...refreshPreview.rules[0], action: { executable: '/bin/sh', argv: [1] } }]) {
    const view = await sourceView(method => method === 'genericHooks/previewSourceRefresh' ? { ...refreshPreview, rules: [rule] } : { ...snapshot, sourceRegistrations: [registeredSource] });
    await find(view.render(), '预览更新 source-1').props.onClick(); assert.equal(find(view.render(), '来源更新预览'), undefined); assert.ok(!view.calls.some(c => c.method === 'genericHooks/refreshSource'));
  }
});
test('source refresh pending same-tick, cancellation, close, snapshot identity and unmount reject stale captures', async () => {
  for (const mutation of ['cancel', 'close', 'native', 'snapshot', 'unmount']) {
    let release;
    const view = fixture(method => method === 'genericHooks/previewSourceRefresh' ? new Promise(resolve => { release = resolve; }) : { ...snapshot, sourceRegistrations: [registeredSource, { ...registeredSource, id: 'other' }] });
    view.render(); const cleanup = view.effects[0](); await new Promise(resolve => setImmediate(resolve)); find(view.render(), '打开用户配置').props.onClick();
    const stale = find(view.render(), '预览更新 source-1').props.onClick, first = stale(); await stale(); await find(view.render(), '预览更新 other').props.onClick();
    assert.equal(view.calls.filter(c => c.method === 'genericHooks/previewSourceRefresh').length, 1);
    if (mutation === 'cancel') sourceButton(view.render(), '取消更新预览').props.onClick();
    if (mutation === 'close') find(view.render(), '关闭用户配置').props.onClick();
    if (mutation === 'native') all(view.render(), n => n.type === 'dialog')[0].props.onClose();
    if (mutation === 'snapshot') await find(view.render(), '刷新钩子配置').props.onClick();
    if (mutation === 'unmount') cleanup();
    release(refreshPreview); await first; assert.equal(find(view.render(), '来源更新预览'), undefined);
    const count = view.calls.length; await stale(); assert.equal(view.calls.length, count);
  }
});
test('source refresh acceptance captures expire on cancel close check detach and ABA snapshots', async () => {
  for (const mutation of ['cancel', 'close', 'native', 'snapshot', 'check', 'detach']) {
    const view = await sourceView(method => method === 'genericHooks/previewSourceRefresh' ? refreshPreview : { ...snapshot, sourceRegistrations: [registeredSource] });
    await find(view.render(), '预览更新 source-1').props.onClick(); const tree = view.render(), stale = sourceButton(tree, '接受来源更新').props.onClick;
    if (mutation === 'cancel') sourceButton(tree, '取消更新预览').props.onClick();
    if (mutation === 'close') { find(tree, '关闭用户配置').props.onClick(); find(view.render(), '打开用户配置').props.onClick(); }
    if (mutation === 'native') all(tree, n => n.type === 'dialog')[0].props.onClose();
    if (mutation === 'snapshot') await find(tree, '刷新钩子配置').props.onClick();
    if (mutation === 'check') await sourceButton(tree, '检查来源').props.onClick();
    if (mutation === 'detach') find(tree, '解除登记 source-1').props.onClick();
    await stale(); assert.ok(!view.calls.some(c => c.method === 'genericHooks/refreshSource'), mutation);
  }
});
test('pending source acceptance is same-tick gated and does not fetch snapshot after cancellation or unmount', async () => {
  for (const mutation of ['cancel', 'native', 'unmount']) {
    let release; const view = fixture(method => method === 'genericHooks/previewSourceRefresh' ? refreshPreview : method === 'genericHooks/refreshSource' ? new Promise(resolve => { release = resolve; }) : { ...snapshot, sourceRegistrations: [registeredSource] });
    view.render(); const cleanup = view.effects[0](); await new Promise(resolve => setImmediate(resolve)); find(view.render(), '打开用户配置').props.onClick();
    await find(view.render(), '预览更新 source-1').props.onClick(); const accept = sourceButton(view.render(), '接受来源更新').props.onClick, first = accept(); await accept();
    assert.equal(view.calls.filter(c => c.method === 'genericHooks/refreshSource').length, 1);
    assert.equal(all(view.render(), n => n.type === 'button' && n.children.includes('取消更新预览')).length, 1);
    if (mutation === 'cancel') sourceButton(view.render(), '取消更新预览').props.onClick();
    if (mutation === 'native') all(view.render(), n => n.type === 'dialog')[0].props.onClose();
    if (mutation === 'unmount') cleanup();
    release({}); await first; assert.equal(view.calls.filter(c => c.method === 'genericHooks/snapshot').length, 1); assert.ok(!JSON.stringify(view.render()).includes('已接受来源更新；'));
  }
});
test('source refresh read denial and after-commit snapshot failure offer safe recovery without success', async () => {
  for (const stage of ['previewSourceRefresh', 'refreshSource', 'snapshot']) {
    let snapshots = 0;
    const view = await sourceView(method => { if (method === 'genericHooks/snapshot') { if (++snapshots > 1 && stage === 'snapshot') throw new Error('secret path'); } if (method === `genericHooks/${stage}` && stage !== 'snapshot') throw new Error('local_owner_client_required'); return method === 'genericHooks/previewSourceRefresh' ? refreshPreview : { ...snapshot, sourceRegistrations: [registeredSource] }; });
    await find(view.render(), '预览更新 source-1').props.onClick(); if (stage !== 'previewSourceRefresh') await sourceButton(view.render(), '接受来源更新').props.onClick();
    const text = JSON.stringify(view.render()); assert.ok(!text.includes('已接受来源更新；')); assert.ok(!text.includes('secret path')); assert.ok(text.includes(stage === 'snapshot' ? '操作可能已提交' : '刷新后')); assert.equal(find(view.render(), '来源更新预览'), undefined);
  }
});
test('settings surfaces RPC denial rather than pretending configuration loaded', async () => {
  const view = fixture(snapshot, true); view.render(); await view.effects[0](); await new Promise(resolve => setImmediate(resolve));
  const tree = view.render();
  assert.equal(find(tree, '打开用户配置').props.disabled, true);
  assert.equal(all(tree, n => n.props.role === 'alert')[0].children[0], 'owner required');
});
