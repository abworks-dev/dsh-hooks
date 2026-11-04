import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EVENTS, supportsAsyncEvent } from '../core.js';
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('current alignment capability summaries enumerate the implemented async whitelist', async () => {
  const text = await read('docs/codex-alignment.md');
  const sections = ['| Handler |', '| 调度 |', '导入 JSON 的 command 必须', '**插件层可推进**'];
  for (const prefix of sections) {
    const line = text.split('\n').find(value => value.startsWith(prefix));
    assert.ok(line, prefix);
    const words = new Set(line.match(/[A-Za-z]+/g));
    for (const event of EVENTS.filter(value => supportsAsyncEvent(value.name))) {
      assert.ok(words.has(event.name), `${prefix} omits supported ${event.name}`);
    }
  }
});

test('README import whitelist tracks every implemented async event', async () => {
  const text = await read('README.md');
  const line = text.split('\n').find(value => value.startsWith('Codex JSON 支持'));
  assert.ok(line, 'missing import compatibility summary');
  const words = new Set(line.match(/[A-Za-z]+/g));
  for (const event of EVENTS.filter(value => supportsAsyncEvent(value.name))) {
    assert.ok(words.has(event.name), `README import summary omits supported ${event.name}`);
  }
});

test('current install instructions use the package version without treating unpublished as published', async () => {
  const { version } = JSON.parse(await read('package.json'));
  const readme = await read('README.md');
  const rollback = await read('docs/upgrade-and-rollback.md');
  assert.ok(readme.includes(`abworks-dsh-hooks-${version}.tgz`));
  assert.ok(rollback.includes(`${version} 已本地安装`) || rollback.includes(`${version} 正在准备发布`));
  assert.ok(rollback.includes('尚未发布到 npm 或插件市场'));
});

test('alignment separates delivered selected-source checks from outstanding live recovery evidence', async () => {
  const alignment = await read('docs/codex-alignment.md');
  assert.ok(alignment.includes('当前只自动监测所有者显式登记的固定来源'));
  assert.ok(alignment.includes('冲突与信任撤销策略已交付'));
  assert.ok(alignment.includes('空与非空来源的安全登记/更新/解除页面路径已验证'));
  assert.ok(alignment.includes('授信/执行、全部冲突恢复和后端备份恢复仍待现场验收'));
  const contracts = await read('docs/host-contract-requests.md');
  assert.ok(contracts.includes('均未执行命令'));
  assert.ok(contracts.includes('不以 fixture JSON 往返替代'));
  assert.ok(alignment.includes('不表示完整 Codex 兼容'));
  assert.ok(alignment.includes('不因压缩日志伪造 source:compact'));
  assert.ok(alignment.includes('事件命名相同不证明触发范围相同'));
  assert.ok(!alignment.includes('以上是实现约束，不是已交付能力'));
  assert.ok(!alignment.includes('后续插件层仍可单独推进的工作是自动配置来源'));
});
