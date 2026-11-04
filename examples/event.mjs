import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const isMain = url => Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === url);
export async function readEvent(stream = process.stdin) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 70000) throw new Error('event_too_large'); chunks.push(buffer); }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!event || event.source !== 'dsh' || typeof event.hook_event_name !== 'string') throw new Error('invalid_dsh_event');
  return event;
}
