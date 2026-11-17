import { describe, it, expect } from 'vitest';
import { conflict, HttpError } from './errors.js';

describe('conflict()', () => {
  it('builds a 409 HttpError', () => {
    const err = conflict('Finding is acknowledged, only open findings can be acknowledged');
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Finding is acknowledged, only open findings can be acknowledged');
  });
});
