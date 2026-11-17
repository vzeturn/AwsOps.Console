import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { chooseEc2Action } from './action-catalog.js';

// Feature: resource-actions-and-aurora-ui, Property 2: EC2 action button selection is total and mutually exclusive
//
// For any string currentState (including values outside the known running/stopped vocabulary),
// chooseEc2Action(currentState) SHALL return exactly one of 'EC2_Start' or 'EC2_Stop' —
// 'EC2_Start' if and only if currentState === 'stopped', 'EC2_Stop' otherwise — and no input SHALL
// ever cause both to be considered applicable simultaneously.
//
// Validates: Requirements 1.5, 1.6

describe('chooseEc2Action (Property 2)', () => {
  it('returns EC2_Start iff currentState === "stopped", otherwise EC2_Stop, and is always total (never both/neither)', () => {
    fc.assert(
      fc.property(fc.string(), (currentState) => {
        const result = chooseEc2Action(currentState);

        // Totality: the result must always be exactly one of the two known literals.
        expect(['EC2_Start', 'EC2_Stop']).toContain(result);

        // Exact, case-sensitive match against 'stopped' — no other casing/whitespace variant
        // (e.g. 'Stopped', 'STOPPED', ' stopped', 'stopped ') should be treated as a match.
        if (currentState === 'stopped') {
          expect(result).toBe('EC2_Start');
        } else {
          expect(result).toBe('EC2_Stop');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('never matches case-insensitive or whitespace-padded variants of "stopped"', () => {
    const nonExactVariants = ['Stopped', 'STOPPED', ' stopped', 'stopped ', 'stoppeD', ''];

    for (const variant of nonExactVariants) {
      expect(chooseEc2Action(variant)).toBe('EC2_Stop');
    }

    expect(chooseEc2Action('stopped')).toBe('EC2_Start');
  });

  it('is mutually exclusive: the two possible outcomes never coexist for the same input', () => {
    fc.assert(
      fc.property(fc.string(), (currentState) => {
        const result = chooseEc2Action(currentState);
        const isStart = result === 'EC2_Start';
        const isStop = result === 'EC2_Stop';

        // Exactly one of the two must be true — never both, never neither.
        expect(isStart !== isStop).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
