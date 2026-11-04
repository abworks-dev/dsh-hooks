import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../examples/project-check.mjs', import.meta.url));
function run(args, event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ source: 'dsh', ...event }));
  });
}
test('project check executes explicit native argv in explicit cwd and records only outcome', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hooks-check-'));
  try {
    const fixture = path.join(dir, 'fixture.mjs');
    const log = path.join(dir, 'result.jsonl');
    await writeFile(fixture, 'process.exit(process.cwd() === process.argv[2] ? Number(process.argv[3]) : 99)');
    for (const status of [0, 7]) {
      const result = await run([dir, log, process.execPath, fixture, dir, String(status)], { hook_event_name: 'Stop', content: 'PRIVATE', command: 'NEVER EXECUTE' });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {});
      assert.equal(result.stderr, '');
    }
    const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows, [0, 7].map(code => ({ hook_event_name: 'Stop', exit_code: code, passed: code === 0 })));
    assert.equal((await run([dir, log, process.execPath, fixture], { hook_event_name: 'PreToolUse' })).code, 1);
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2);
    assert.equal((await run([dir, log, 'relative-node'], { hook_event_name: 'Stop' })).code, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
