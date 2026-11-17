import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import type { ThresholdLevel } from '@ops-dashboard/shared';

// Feature: realtime-monitoring-dashboard, Property 4: Boundary threshold monotonicity
//
// For any metric with a defined (warn, critical) boundary pair and any measured value, the assigned
// Threshold_Level SHALL be critical if the value crosses the critical boundary in the configured
// direction, else warn if it crosses the warn boundary, else ok — and increasing severity of the
// input (further past the boundary) SHALL never decrease the assigned level. This applies uniformly
// to: EC2 CPUUtilization (80/95), EC2 StatusCheckFailed (critical-only, ≠0), EC2 CWAgent mem/disk %
// (80/90), EBS VolumeQueueLength (warn-only, >1), RDS CPUUtilization (80/90), RDS FreeableMemory
// used% (80/90), RDS FreeStorageSpace free% (below 20/10), RDS SwapUsage (>0 warn / ≥10% critical),
// RDS Read/WriteLatency (20ms/50ms), ALB TargetResponseTime (2s/5s).
//
// Validates: Requirements 1.2, 1.3, 1.4, 2.5, 2.6, 3.3, 4.2, 4.3, 4.4, 4.5, 4.6, 5.4

// monitoring-service.ts (Task 3.10) imports `threshold-history-service.ts`, which throws at module
// scope if ASSESSMENT_BUCKET_NAME is missing — set before import even though this test never calls
// recordIfChanged/getHistory. Following the exact minimal-mocking pattern used in
// monitoring-service.property5.test.ts (evalMonitoringThreshold is a pure function — no AWS SDK
// client mocks needed, only the config.js/env setup required for the module import chain to resolve).
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// `monitoring-service.ts` imports `loadAlb` from `infra-service.ts`, which imports `config.ts`
// (module singleton that throws if any required env var, e.g. ENTRA_TENANT_ID, is missing) at
// module scope. This test never calls `loadAlb`/AWS APIs — mock `config.js` so the import chain
// resolves, following the exact pattern used in `monitoring-service.property5.test.ts`.
vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
  },
  corsHeaders: () => ({}),
}));

const { evalMonitoringThreshold, RDS_INSTANCE_RAM_GIB } = await import('./monitoring-service.js');

/** Severity ordering used to assert "increasing severity of the input SHALL never decrease the
 * assigned level" — ok < warn < critical. */
const severityRank: Record<ThresholdLevel, number> = { ok: 0, warn: 1, critical: 2 };

function rank(level: ThresholdLevel | undefined): number {
  if (level === undefined) throw new Error('expected a defined ThresholdLevel for this metric');
  return severityRank[level];
}

const RAM_BYTES = RDS_INSTANCE_RAM_GIB['db.m8i.large'] * 1024 ** 3;
const ALLOCATED_STORAGE_GB = 100;
const ALLOCATED_STORAGE_BYTES = ALLOCATED_STORAGE_GB * 1024 ** 3;

describe('Property 4: Boundary threshold monotonicity', () => {
  // ---- EC2 CPUUtilization (Requirement 1.2, 1.3) — warn>=80, critical>=95, direction 'above' ----
  it('EC2 CPUUtilization: critical>=95, warn>=80 (else ok), monotonic as value increases', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 300, noNaN: true }),
        (value, nonNegativeDelta) => {
          const worseValue = value + nonNegativeDelta; // worseValue >= value, further past boundary in the 'above' direction.
          const level = evalMonitoringThreshold('ec2', 'CPUUtilization', value)!.level;
          const worseLevel = evalMonitoringThreshold('ec2', 'CPUUtilization', worseValue)!.level;

          if (value >= 95) expect(level).toBe('critical');
          else if (value >= 80) expect(level).toBe('warn');
          else expect(level).toBe('ok');

          expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---- EC2 StatusCheckFailed (Requirement 1.4) — critical-only, ≠0 ----
  it('EC2 StatusCheckFailed: critical iff value !== 0, else ok, monotonic by increasing magnitude', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (value) => {
        const level = evalMonitoringThreshold('ec2', 'StatusCheckFailed', value)!.level;
        expect(level).toBe(value === 0 ? 'ok' : 'critical');
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), (a, b) => {
        const [smaller, larger] = a <= b ? [a, b] : [b, a];
        const smallerLevel = evalMonitoringThreshold('ec2', 'StatusCheckFailed', smaller)!.level;
        const largerLevel = evalMonitoringThreshold('ec2', 'StatusCheckFailed', larger)!.level;
        expect(rank(largerLevel)).toBeGreaterThanOrEqual(rank(smallerLevel));
      }),
      { numRuns: 100 },
    );
  });

  // ---- EC2 CWAgent mem_used_percent / disk_used_percent (Requirement 2.5, 2.6) — warn>=80, critical>=90 ----
  for (const metricName of ['mem_used_percent', 'disk_used_percent'] as const) {
    it(`EC2 CWAgent ${metricName}: critical>=90, warn>=80 (else ok), monotonic as value increases`, () => {
      fc.assert(
        fc.property(
          fc.double({ min: -50, max: 200, noNaN: true }),
          fc.double({ min: 0, max: 300, noNaN: true }),
          (value, nonNegativeDelta) => {
            const worseValue = value + nonNegativeDelta;
            const level = evalMonitoringThreshold('ec2', metricName, value)!.level;
            const worseLevel = evalMonitoringThreshold('ec2', metricName, worseValue)!.level;

            if (value >= 90) expect(level).toBe('critical');
            else if (value >= 80) expect(level).toBe('warn');
            else expect(level).toBe('ok');

            expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
          },
        ),
        { numRuns: 100 },
      );
    });
  }

  // ---- EBS VolumeQueueLength (Requirement 3.3) — warn-only, >1, no critical tier ----
  it('EBS VolumeQueueLength: warn when >1 else ok (no critical), monotonic as value increases', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (value, nonNegativeDelta) => {
          const worseValue = value + nonNegativeDelta;
          const level = evalMonitoringThreshold('ebs', 'VolumeQueueLength', value)!.level;
          const worseLevel = evalMonitoringThreshold('ebs', 'VolumeQueueLength', worseValue)!.level;

          expect(level).toBe(value > 1 ? 'warn' : 'ok');
          expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---- RDS CPUUtilization (Requirement 4.2) — warn>=80, critical>=90, direction 'above' ----
  it('RDS CPUUtilization: critical>=90, warn>=80 (else ok), monotonic as value increases', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 300, noNaN: true }),
        (value, nonNegativeDelta) => {
          const worseValue = value + nonNegativeDelta;
          const level = evalMonitoringThreshold('rds', 'CPUUtilization', value)!.level;
          const worseLevel = evalMonitoringThreshold('rds', 'CPUUtilization', worseValue)!.level;

          if (value >= 90) expect(level).toBe('critical');
          else if (value >= 80) expect(level).toBe('warn');
          else expect(level).toBe('ok');

          expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---- RDS FreeableMemory (Requirement 4.3) — used% = 1 - value/totalRAM; warn>=80% used,
  // critical>=90% used ⇒ in raw bytes, LOWER value (less free memory) is worse. ----
  it('RDS FreeableMemory: critical when used%>=90, warn when used%>=80 (else ok), monotonic as free bytes decrease', () => {
    const criticalBoundaryBytes = RAM_BYTES * 0.1; // used% = 90 <=> free bytes = ram * 0.1
    const warnBoundaryBytes = RAM_BYTES * 0.2; // used% = 80 <=> free bytes = ram * 0.2
    const context = { dbInstanceClass: 'db.m8i.large' };

    fc.assert(
      fc.property(
        fc.double({ min: 0, max: RAM_BYTES * 1.5, noNaN: true }),
        fc.double({ min: 0, max: RAM_BYTES * 1.5, noNaN: true }),
        (value, nonNegativeDelta) => {
          const worseValue = value - nonNegativeDelta; // fewer free bytes = further past boundary (worse).
          const level = evalMonitoringThreshold('rds', 'FreeableMemory', value, context)!.level;
          const worseLevel = evalMonitoringThreshold('rds', 'FreeableMemory', worseValue, context)!.level;

          if (value <= criticalBoundaryBytes) expect(level).toBe('critical');
          else if (value <= warnBoundaryBytes) expect(level).toBe('warn');
          else expect(level).toBe('ok');

          expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---- RDS FreeStorageSpace (Requirement 4.4) — free% below 20 warn, below 10 critical ⇒ in raw
  // bytes, LOWER value (less free storage) is worse. ----
  it('RDS FreeStorageSpace: critical when free%<=10, warn when free%<=20 (else ok), monotonic as free bytes decrease', () => {
    const criticalBoundaryBytes = ALLOCATED_STORAGE_BYTES * 0.1; // free% = 10
    const warnBoundaryBytes = ALLOCATED_STORAGE_BYTES * 0.2; // free% = 20
    const context = { allocatedStorageGb: ALLOCATED_STORAGE_GB };

    fc.assert(
      fc.property(
        fc.double({ min: 0, max: ALLOCATED_STORAGE_BYTES * 1.5, noNaN: true }),
        fc.double({ min: 0, max: ALLOCATED_STORAGE_BYTES * 1.5, noNaN: true }),
        (value, nonNegativeDelta) => {
          const worseValue = value - nonNegativeDelta; // fewer free bytes = further past boundary (worse).
          const level = evalMonitoringThreshold('rds', 'FreeStorageSpace', value, context)!.level;
          const worseLevel = evalMonitoringThreshold('rds', 'FreeStorageSpace', worseValue, context)!.level;

          if (value <= criticalBoundaryBytes) expect(level).toBe('critical');
          else if (value <= warnBoundaryBytes) expect(level).toBe('warn');
          else expect(level).toBe('ok');

          expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---- RDS SwapUsage (Requirement 4.5) — warn at >=1% of RAM, critical at >=10% of RAM,
  // direction 'above' (more swap = worse).
  //
  // Warn used to be "> 0". That was changed on 2026-09-07 because it produced a warn that could never
  // clear: `abc-prod-rds-postgres` sits at a stable ~0.5 MB of swap on a 16 GiB instance (peak 1.47 MB
  // = 0.009% of RAM) with a DAILY MINIMUM OF ZERO and 9.00 GB of FreeableMemory at its worst — i.e. no
  // memory pressure at all. Linux pages out idle memory opportunistically; "swap > 0" is not a signal
  // on this platform. See RDS_SWAP_WARN_PERCENT_OF_RAM for the full 14-day measurement. ----
  it('RDS SwapUsage: critical at >=10% RAM, warn at >=1% RAM, ok below that, monotonic as value increases', () => {
    const warnBoundaryBytes = RAM_BYTES * 0.01;
    const criticalBoundaryBytes = RAM_BYTES * 0.1;
    const context = { dbInstanceClass: 'db.m8i.large' };

    fc.assert(
      fc.property(
        fc.double({ min: 0, max: RAM_BYTES * 1.5, noNaN: true }),
        fc.double({ min: 0, max: RAM_BYTES * 1.5, noNaN: true }),
        (value, nonNegativeDelta) => {
          const worseValue = value + nonNegativeDelta;
          const level = evalMonitoringThreshold('rds', 'SwapUsage', value, context)!.level;
          const worseLevel = evalMonitoringThreshold('rds', 'SwapUsage', worseValue, context)!.level;

          if (value >= criticalBoundaryBytes) expect(level).toBe('critical');
          else if (value >= warnBoundaryBytes) expect(level).toBe('warn');
          else expect(level).toBe('ok');

          expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
        },
      ),
      { numRuns: 100 },
    );

    expect(evalMonitoringThreshold('rds', 'SwapUsage', 0, context)!.level).toBe('ok');
  });

  // Regression guard tied to the real production numbers, not to abstract boundaries: if warn ever
  // drifts back towards zero, THIS is the case that starts crying wolf again.
  it('RDS SwapUsage: the measured production value on abc-prod-rds-postgres evaluates to ok', () => {
    // 16 GiB class; the exact value that raised the alert, and the 14-day peak.
    const context = { dbInstanceClass: 'db.m7g.xlarge' };

    expect(evalMonitoringThreshold('rds', 'SwapUsage', 1_294_336, context)!.level).toBe('ok');
    expect(evalMonitoringThreshold('rds', 'SwapUsage', 1_541_406, context)!.level).toBe('ok');

    // ...but a genuinely large amount of swap on the same instance still escalates.
    const gib16 = 16 * 1024 ** 3;
    expect(evalMonitoringThreshold('rds', 'SwapUsage', gib16 * 0.02, context)!.level).toBe('warn');
    expect(evalMonitoringThreshold('rds', 'SwapUsage', gib16 * 0.15, context)!.level).toBe('critical');
  });

  // ---- RDS ReadLatency / WriteLatency (Requirement 4.6) — metric value in seconds; warn>=20ms,
  // critical>=50ms, direction 'above'. ----
  for (const metricName of ['ReadLatency', 'WriteLatency'] as const) {
    it(`RDS ${metricName}: critical when >=50ms, warn when >=20ms (else ok), monotonic as value increases`, () => {
      const warnBoundarySeconds = 0.02;
      const criticalBoundarySeconds = 0.05;

      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 0.5, noNaN: true }),
          fc.double({ min: 0, max: 0.5, noNaN: true }),
          (value, nonNegativeDelta) => {
            const worseValue = value + nonNegativeDelta;
            const level = evalMonitoringThreshold('rds', metricName, value)!.level;
            const worseLevel = evalMonitoringThreshold('rds', metricName, worseValue)!.level;

            if (value >= criticalBoundarySeconds) expect(level).toBe('critical');
            else if (value >= warnBoundarySeconds) expect(level).toBe('warn');
            else expect(level).toBe('ok');

            expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
          },
        ),
        { numRuns: 100 },
      );
    });
  }

  // ---- ALB TargetResponseTime (Requirement 5.4) — warn>=2s, critical>=5s, direction 'above'. ----
  it('ALB TargetResponseTime: critical when >=5s, warn when >=2s (else ok), monotonic as value increases', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        (value, nonNegativeDelta) => {
          const worseValue = value + nonNegativeDelta;
          const level = evalMonitoringThreshold('alb', 'TargetResponseTime', value)!.level;
          const worseLevel = evalMonitoringThreshold('alb', 'TargetResponseTime', worseValue)!.level;

          if (value >= 5) expect(level).toBe('critical');
          else if (value >= 2) expect(level).toBe('warn');
          else expect(level).toBe('ok');

          expect(rank(worseLevel)).toBeGreaterThanOrEqual(rank(level));
        },
      ),
      { numRuns: 100 },
    );
  });
});
