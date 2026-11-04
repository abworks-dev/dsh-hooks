import { spawn } from 'node:child_process';
import { appendFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isMain, readEvent } from './event.mjs';

// Explicit executable/argv only. Never execute an event's command or inherit its cwd.
export async function main() {
  const [directory, destination, executable, ...argv] = process.argv.slice(2);
  if (![directory, destination, executable].every(value => typeof value === 'string' && isAbsolute(value)) || /\.(cmd|bat)$/i.test(executable)) throw new Error('absolute_check_paths_required');
  const event = await readEvent();
  if (event.hook_event_name !== 'Stop') throw new Error('stop_event_required');
  const cwd = await realpath(directory);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, shell: false, env: {}, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 10000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('check_spawn_failed')); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ exit_code: code, passed: code === 0 && !signal }); });
  });
  await appendFile(destination, JSON.stringify({ hook_event_name: 'Stop', ...result }) + '\n', { encoding: 'utf8', mode: 0o600 });
  // Informational only: Stop cannot veto completion or make the agent continue.
  process.stdout.write('{}\n');
}
if (isMain(import.meta.url)) main().catch(() => { console.error('project_check_failed'); process.exitCode = 1; });
