import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { isMain, readEvent } from './event.mjs';
// No prompt text or command arguments enter notifications.
export function notification(mode, event) {
  if (!['Stop', 'SubagentStop'].includes(event.hook_event_name)) return null;
  const message = event.hook_event_name === 'Stop' ? 'DSH agent is idle.' : 'DSH subagent finished.';
  if (mode === 'mac') return ['-e', `display notification "${message}" with title "DSH Hooks"`];
  if (mode === 'linux') return ['DSH Hooks', message];
  if (mode === 'windows-sound') return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 500'];
  throw new Error('supported_mode_required');
}
export async function main() {
  const [mode, executable] = process.argv.slice(2);
  if (!executable || !isAbsolute(executable)) throw new Error('absolute_notifier_path_required');
  const args = notification(mode, await readEvent()); if (!args) return;
  const result = spawnSync(executable, args, { shell: false, windowsHide: true, env: {}, timeout: 3000, maxBuffer: 4096 });
  if (result.error || result.status !== 0) throw new Error('notifier_failed');
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
