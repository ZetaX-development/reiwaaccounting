import test from 'node:test';
import assert from 'node:assert/strict';
import { readDemoCredentials } from './demo-credentials.ts';

for (const source of [{}, { DEMO_EMAIL: 'demo@example.com' }, { DEMO_PASSWORD: 'test-only-value' }, { DEMO_EMAIL: ' ', DEMO_PASSWORD: 'test-only-value' }, { DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: '  ' }]) {
  test('rejects missing or blank credentials without exposing supplied values', () => {
    assert.throws(() => readDemoCredentials(source), { message: 'DEMO_EMAIL and DEMO_PASSWORD must both be explicitly set' });
  });
}
test('returns explicitly supplied credentials and preserves password whitespace', () => {
  assert.deepEqual(readDemoCredentials({ DEMO_EMAIL: ' demo@example.com ', DEMO_PASSWORD: ' test-only-value ' }), { email: 'demo@example.com', password: ' test-only-value ' });
});
