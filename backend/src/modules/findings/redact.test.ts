import { describe, it, expect } from 'vitest';
import { redactEvidence, REDACTED } from './redact.js';

describe('redactEvidence', () => {
  it('redacts values under secret-looking keys, keeps the rest', () => {
    expect(redactEvidence({ password: 'x', apiKey: 'y', groupId: 'sg-1', port: 22 })).toEqual({
      password: REDACTED,
      apiKey: REDACTED,
      groupId: 'sg-1',
      port: 22,
    });
  });

  it('redacts Key/Value tag pairs whose key looks secret', () => {
    const data = { tags: [{ Key: 'DbPassword', Value: 'hunter2' }, { Key: 'Owner', Value: 'platform' }] };
    expect(redactEvidence(data)).toEqual({ tags: [{ Key: 'DbPassword', Value: REDACTED }, { Key: 'Owner', Value: 'platform' }] });
  });

  it('redacts secret-looking values under innocent keys, at any depth', () => {
    const data = { detail: { note: 'creds AKIAABCDEFGHIJKLMNOP leaked' }, list: ['Bearer abcdefghijklmnopqrstuvwxyz123456'] };
    expect(redactEvidence(data)).toEqual({ detail: { note: REDACTED }, list: [REDACTED] });
  });

  it('does not mutate its input', () => {
    const data = { token: 't' };
    redactEvidence(data);
    expect(data).toEqual({ token: 't' });
  });
});
