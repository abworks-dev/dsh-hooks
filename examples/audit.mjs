import { appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isMain, readEvent } from './event.mjs';
// Explicit allowlist: never persist tool_input, command output or assistant content.
export function auditRecord(event) {
  return Object.fromEntries(['hook_event_name', 'session_id', 'tool_name', 'timestamp', 'source', 'child_id', 'provider', 'stop_reason'].filter(key => ['string', 'number', 'boolean'].includes(typeof event[key])).map(key => [key, event[key]]));
}
export async function main() {
  const destination = process.argv[2];
  if (!destination || !isAbsolute(destination)) throw new Error('absolute_audit_path_required');
  await appendFile(destination, JSON.stringify(auditRecord(await readEvent())) + '\n', { encoding: 'utf8', mode: 0o600 });
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
