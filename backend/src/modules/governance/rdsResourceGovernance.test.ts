import { describe, it, expect } from 'vitest';
import {
  detectEngineFamily,
  computeSqlServerTargetParameters,
  computePostgresTargetParameters,
  computeResourceGovernanceTargetParameters,
} from './rdsResourceGovernance.js';

describe('detectEngineFamily', () => {
  it('correctly recognizes every SQL Server variant (se/ee/web/ex) as "sqlserver"', () => {
    expect(detectEngineFamily('sqlserver-se')).toBe('sqlserver');
    expect(detectEngineFamily('sqlserver-ee')).toBe('sqlserver');
    expect(detectEngineFamily('sqlserver-web')).toBe('sqlserver');
    expect(detectEngineFamily('sqlserver-ex')).toBe('sqlserver');
  });

  it('correctly recognizes postgres/aurora-postgresql as "postgres"', () => {
    expect(detectEngineFamily('postgres')).toBe('postgres');
    expect(detectEngineFamily('aurora-postgresql')).toBe('postgres');
  });

  it('does not recognize an unsupported engine (mysql/mariadb/oracle) -> undefined', () => {
    expect(detectEngineFamily('mysql')).toBeUndefined();
    expect(detectEngineFamily('mariadb')).toBeUndefined();
    expect(detectEngineFamily('oracle-se2')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(detectEngineFamily('SQLServer-SE')).toBe('sqlserver');
    expect(detectEngineFamily('POSTGRES')).toBe('postgres');
  });
});

describe('computeSqlServerTargetParameters', () => {
  it('real acme-rds-production-env case (db.m8i.large = 2 vCPU/8 GiB) -> maxDop=2 (does not exceed the real vCPU count), maxServerMemory = 8GiB minus a 2GiB OS reservation (industry-standard formula, NOT a fixed 80%), queryGovernorCostLimit=50000', () => {
    const params = computeSqlServerTargetParameters(2, 8);

    const maxDop = params.find((p) => p.parameterName === 'max degree of parallelism')!;
    expect(maxDop.newValue).toBe('2');

    // Industry-standard formula (SQLskills/Microsoft): 8 GiB falls in the 4-16 GiB range -> OS
    // reservation = 1 + (8-4)/4 = 2 GiB -> max server memory = (8-2)*1024 = 6144 MB (NOT 6553 MB
    // from the old 80% formula — 20% of 8GiB leaves only 1.6GiB, thinner than the real
    // recommended 2GiB).
    const maxMem = params.find((p) => p.parameterName === 'max server memory (mb)')!;
    expect(maxMem.newValue).toBe(String(6144));

    // 50000 (NOT 300 from the initial version, and NOT 9000 from the earlier adjustment) — 300
    // caused a real incident (wrongly blocking valid application queries, cost 8628); 9000 would
    // wrongly block valid business reports later observed reaching a cost of ~30000 — see the
    // comment on computeSqlServerTargetParameters.
    const queryGovernor = params.find((p) => p.parameterName === 'query governor cost limit')!;
    expect(queryGovernor.newValue).toBe('50000');
  });

  it('a 16 GiB RAM instance (upper edge of the 4-16GB range) -> OS reservation = 4 GiB (1 + (16-4)/4), maxServerMemory = 12 GiB', () => {
    const params = computeSqlServerTargetParameters(2, 16);
    const maxMem = params.find((p) => p.parameterName === 'max server memory (mb)')!;
    expect(maxMem.newValue).toBe(String(12 * 1024));
  });

  it('a 32 GiB RAM instance (above 16GB) -> OS reservation = 6 GiB (1 + 3 + (32-16)/8), maxServerMemory = 26 GiB', () => {
    const params = computeSqlServerTargetParameters(4, 32);
    const maxMem = params.find((p) => p.parameterName === 'max server memory (mb)')!;
    expect(maxMem.newValue).toBe(String(26 * 1024));
  });

  it('an instance with <= 4 GiB RAM -> OS reservation floors at 1 GiB (never negative/never below the floor)', () => {
    const params = computeSqlServerTargetParameters(1, 4);
    const maxMem = params.find((p) => p.parameterName === 'max server memory (mb)')!;
    expect(maxMem.newValue).toBe(String(3 * 1024));
  });

  it('maxDop NEVER exceeds 8 even when the real vCPU count is higher (e.g. a 16 vCPU instance) — per the standard Microsoft recommendation', () => {
    const params = computeSqlServerTargetParameters(16, 64);
    const maxDop = params.find((p) => p.parameterName === 'max degree of parallelism')!;
    expect(maxDop.newValue).toBe('8');
  });

  it('maxDop NEVER exceeds the real vCPU count when the real vCPU count is below 8 (e.g. 1 vCPU)', () => {
    const params = computeSqlServerTargetParameters(1, 4);
    const maxDop = params.find((p) => p.parameterName === 'max degree of parallelism')!;
    expect(maxDop.newValue).toBe('1');
  });

  it('returns exactly 3 parameters, each with a non-empty reasonEn/reasonVi', () => {
    const params = computeSqlServerTargetParameters(2, 8);
    expect(params).toHaveLength(3);
    for (const p of params) {
      expect(p.reasonEn.length).toBeGreaterThan(0);
      expect(p.reasonVi.length).toBeGreaterThan(0);
    }
  });
});

describe('computePostgresTargetParameters', () => {
  it('real abc-prod-rds-postgres case (db.m7g.2xlarge = 8 vCPU/32 GiB) -> statementTimeout=300000ms, maxParallelWorkersPerGather=4 (50% of 8), workMem computed correctly via the /256 formula', () => {
    const params = computePostgresTargetParameters(8, 32);

    const timeout = params.find((p) => p.parameterName === 'statement_timeout')!;
    expect(timeout.newValue).toBe('300000');

    const parallel = params.find((p) => p.parameterName === 'max_parallel_workers_per_gather')!;
    expect(parallel.newValue).toBe('4');

    const workMem = params.find((p) => p.parameterName === 'work_mem')!;
    expect(workMem.newValue).toBe(String(Math.floor((32 * 1024 * 1024) / 256))); // 131072 KB = 128 MB
  });

  it('maxParallelWorkersPerGather is ALWAYS at least 2 even when vCPU count is very low (e.g. 1 vCPU)', () => {
    const params = computePostgresTargetParameters(1, 4);
    const parallel = params.find((p) => p.parameterName === 'max_parallel_workers_per_gather')!;
    expect(parallel.newValue).toBe('2');
  });

  it('returns exactly 3 parameters, each with a non-empty reasonEn/reasonVi', () => {
    const params = computePostgresTargetParameters(8, 32);
    expect(params).toHaveLength(3);
    for (const p of params) {
      expect(p.reasonEn.length).toBeGreaterThan(0);
      expect(p.reasonVi.length).toBeGreaterThan(0);
    }
  });
});

describe('computeResourceGovernanceTargetParameters — common dispatch', () => {
  it('engineFamily=sqlserver -> calls computeSqlServerTargetParameters CORRECTLY (results match)', () => {
    expect(computeResourceGovernanceTargetParameters('sqlserver', 2, 8)).toEqual(
      computeSqlServerTargetParameters(2, 8),
    );
  });

  it('engineFamily=postgres -> calls computePostgresTargetParameters CORRECTLY (results match)', () => {
    expect(computeResourceGovernanceTargetParameters('postgres', 8, 32)).toEqual(
      computePostgresTargetParameters(8, 32),
    );
  });
});
