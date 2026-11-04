import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { z } from 'zod';
import { createStateSchema } from '../index.js';
const schema = createStateSchema(z);
const registration = () => ({ id: 'selected', request: { kind: 'user', directory: path.resolve('selected') }, accepted: { 'hooks.json': 'a'.repeat(64) }, options: { scope: { kind: 'user' }, platform: process.platform, interpreter: { executable: process.execPath, argvPrefix: [] } }, revision: 1, owners: [], status: 'current' });

test('storage schema keeps legacy registry absence and legacy scope absence for manager migration', () => {
  const old = { enabled: false, rules: [{ id: 'old', name: 'Old', event: 'Stop', enabled: true, trust: { digest: 'a'.repeat(64) }, action: { type: 'command', executable: process.execPath, argv: [] } }] };
  const parsed = schema.parse(old);
  assert.equal(Object.hasOwn(parsed, 'sourceRegistrations'), false);
  assert.equal(Object.hasOwn(parsed.rules[0], 'scope'), false);
  assert.equal(parsed.rules[0].enabled, true);
  assert.deepEqual(parsed.rules[0].trust, old.rules[0].trust);
});

test('storage schema round-trips source registrations and rejects unknown top-level state', () => {
  const current = { enabled: false, rules: [], sourceRegistrations: [registration()] };
  const parsed = schema.parse(current);
  assert.deepEqual(parsed, current);
  assert.notEqual(parsed.sourceRegistrations, current.sourceRegistrations);
  assert.throws(() => schema.parse({ ...current, extra: true }));
  assert.throws(() => schema.parse({ ...current, sourceRegistrations: [{ ...registration(), revision: 0 }] }));
  assert.throws(() => schema.parse({ ...current, sourceRegistrations: [registration(), registration()] }));
});

test('storage registry validation rejects accessor fields without invoking them', () => {
  let calls = 0;
  const source = registration();
  Object.defineProperty(source, 'status', { enumerable: true, get() { calls++; return 'current'; } });
  assert.throws(() => schema.parse({ enabled: false, rules: [], sourceRegistrations: [source] }));
  assert.equal(calls, 0);
});
