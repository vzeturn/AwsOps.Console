import { describe, it, expect } from 'vitest';
import { allocateDepartmentCost, type RawDepartmentCostEntry } from './costAllocation.js';

describe('allocateDepartmentCost', () => {
  it('splits the SHARED pool proportionally across the 4 business units by their direct-cost share', () => {
    const entries: RawDepartmentCostEntry[] = [
      { tagValue: 'SALE', amountUsd: 300 },
      { tagValue: 'MKT', amountUsd: 100 },
      { tagValue: 'HR', amountUsd: 50 },
      { tagValue: 'SERVICE', amountUsd: 50 },
      { tagValue: 'SHARED', amountUsd: 100 },
    ];

    const result = allocateDepartmentCost(entries);

    // Total direct = 500. SALE=60% -> +60, MKT=20% -> +20, HR=10% -> +10, SERVICE=10% -> +10.
    expect(result.sharedPoolUsd).toBe(100);
    expect(result.unallocatedUsd).toBe(0);
    const byDept = new Map(result.byDepartment.map((d) => [d.department, d]));
    expect(byDept.get('SALE')).toEqual({ department: 'SALE', directUsd: 300, sharedShareUsd: 60, totalUsd: 360 });
    expect(byDept.get('MKT')).toEqual({ department: 'MKT', directUsd: 100, sharedShareUsd: 20, totalUsd: 120 });
    expect(byDept.get('HR')).toEqual({ department: 'HR', directUsd: 50, sharedShareUsd: 10, totalUsd: 60 });
    expect(byDept.get('SERVICE')).toEqual({ department: 'SERVICE', directUsd: 50, sharedShareUsd: 10, totalUsd: 60 });

    // 100% of every $ is accounted for: sum of totalUsd + unallocatedUsd == sum of all input amounts.
    const grandTotal = result.byDepartment.reduce((sum, d) => sum + d.totalUsd, 0) + result.unallocatedUsd;
    const inputTotal = entries.reduce((sum, e) => sum + e.amountUsd, 0);
    expect(grandTotal).toBeCloseTo(inputTotal, 6);
  });

  it('matches Department tag values case-insensitively (SALE tag written in exact-case, but tolerant of variation)', () => {
    const entries: RawDepartmentCostEntry[] = [
      { tagValue: 'sale', amountUsd: 100 },
      { tagValue: 'Shared', amountUsd: 50 },
    ];

    const result = allocateDepartmentCost(entries);

    const sale = result.byDepartment.find((d) => d.department === 'SALE')!;
    expect(sale.directUsd).toBe(100);
    expect(sale.sharedShareUsd).toBe(50); // SALE is the only unit with direct cost -> gets 100% of the shared pool
    expect(result.sharedPoolUsd).toBe(50);
  });

  it('routes untagged cost ("" tag value) and legacy/unrecognized tag values (e.g. "Sales", "IT") into unallocatedUsd, never guessed into a business unit', () => {
    const entries: RawDepartmentCostEntry[] = [
      { tagValue: '', amountUsd: 40 },
      { tagValue: 'Sales', amountUsd: 30 }, // legacy pre-migration tag value, NOT the same as the new "SALE"
      { tagValue: 'IT', amountUsd: 20 },
      { tagValue: 'SALE', amountUsd: 10 },
    ];

    const result = allocateDepartmentCost(entries);

    expect(result.unallocatedUsd).toBe(90);
    const sale = result.byDepartment.find((d) => d.department === 'SALE')!;
    expect(sale.directUsd).toBe(10);
    expect(result.sharedPoolUsd).toBe(0);
  });

  it('when every business unit has $0 direct cost, the SHARED pool is NOT distributed (nothing to be proportional to)', () => {
    const entries: RawDepartmentCostEntry[] = [{ tagValue: 'SHARED', amountUsd: 200 }];

    const result = allocateDepartmentCost(entries);

    expect(result.sharedPoolUsd).toBe(200);
    for (const d of result.byDepartment) {
      expect(d.directUsd).toBe(0);
      expect(d.sharedShareUsd).toBe(0);
      expect(d.totalUsd).toBe(0);
    }
  });

  it('empty input -> all-zero summary, does not throw (used when the GetCostAndUsage TAG call itself failed)', () => {
    const result = allocateDepartmentCost([]);

    expect(result.sharedPoolUsd).toBe(0);
    expect(result.unallocatedUsd).toBe(0);
    expect(result.byDepartment).toHaveLength(4);
    for (const d of result.byDepartment) {
      expect(d.totalUsd).toBe(0);
    }
  });

  it('a business unit with $0 direct cost gets $0 of the shared pool even when other units have direct cost', () => {
    const entries: RawDepartmentCostEntry[] = [
      { tagValue: 'SALE', amountUsd: 100 },
      { tagValue: 'SHARED', amountUsd: 30 },
    ];

    const result = allocateDepartmentCost(entries);

    const mkt = result.byDepartment.find((d) => d.department === 'MKT')!;
    expect(mkt.directUsd).toBe(0);
    expect(mkt.sharedShareUsd).toBe(0);
    const sale = result.byDepartment.find((d) => d.department === 'SALE')!;
    expect(sale.sharedShareUsd).toBe(30); // SALE is the only unit with direct cost -> gets 100% of shared
  });
});
