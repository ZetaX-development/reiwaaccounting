import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySignature } from '../../src/services/line-service.js';

describe('verifySignature', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"events":[]}');
  const correctSig = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');

  it('returns true for correct signature', () => {
    expect(verifySignature(secret, body, correctSig)).toBe(true);
  });

  it('returns false for incorrect signature', () => {
    expect(verifySignature(secret, body, 'wrong-signature')).toBe(false);
  });

  it('returns false for empty signature', () => {
    expect(verifySignature(secret, body, '')).toBe(false);
  });

  it('returns false for empty secret', () => {
    expect(verifySignature('', body, correctSig)).toBe(false);
  });
});
