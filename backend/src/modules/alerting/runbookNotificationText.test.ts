import { describe, it, expect } from 'vitest';
import type { RunbookEntry } from '@ops-dashboard/shared';
import { formatRunbookField } from './runbookNotificationText.js';

function makeEntry(overrides: Partial<RunbookEntry> = {}): RunbookEntry {
  return {
    title: 'High CPU utilization',
    symptom: 'CPU usage is sustained above threshold.',
    diagnosis: ['Check whether this is a spike or a gradual climb.'],
    remediation: ['Plan an EC2_Rightsize/instance-family change.', 'A second, less important step.'],
    escalateWhen: ['CPU stays pegged near 100% on a customer-facing service.'],
    defaultSeverity: 'warning',
    ...overrides,
  };
}

describe('formatRunbookField', () => {
  it('shows the title, the FIRST remediation step, and the FIRST escalation condition', () => {
    const field = formatRunbookField(makeEntry());
    expect(field.name).toBe('Runbook');
    expect(field.value).toContain('High CPU utilization');
    expect(field.value).toContain('Plan an EC2_Rightsize/instance-family change.');
    expect(field.value).not.toContain('A second, less important step.');
    expect(field.value).toContain('CPU stays pegged near 100% on a customer-facing service.');
  });

  it('defaults to a non-inline (full-width) field', () => {
    expect(formatRunbookField(makeEntry()).inline).toBe(false);
  });

  it('allows requesting an inline field', () => {
    expect(formatRunbookField(makeEntry(), { inline: true }).inline).toBe(true);
  });

  it('truncates a value longer than 1024 characters (Discord embed field limit)', () => {
    const longStep = 'x'.repeat(2000);
    const field = formatRunbookField(makeEntry({ remediation: [longStep] }));
    expect(field.value.length).toBeLessThanOrEqual(1024);
    expect(field.value.endsWith('…')).toBe(true);
  });
});
