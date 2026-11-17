import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.12: unit test for savings-plans-collector.ts
// Mocks @aws-sdk/client-cost-explorer. This client calls `send` for both GetSavingsPlansCoverageCommand
// and GetReservationCoverageCommand through the same CostExplorerClient instance, so sendMock
// needs to tell which command is being sent (marked via __type on the object returned from the mock constructor).
const ceSendMock = vi.fn();

vi.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: vi.fn().mockImplementation(() => ({ send: ceSendMock })),
  GetSavingsPlansCoverageCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'savingsPlans', input })),
  GetReservationCoverageCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'reservation', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { collectSavingsPlansCoverage } = await import('./savings-plans-collector.js');

beforeEach(() => {
  ceSendMock.mockReset();
});

describe('collectSavingsPlansCoverage', () => {
  it('correctly merges onDemandUsd/coveredUsd/coveragePercent from both GetSavingsPlansCoverage and GetReservationCoverage for one service', async () => {
    ceSendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'savingsPlans') {
        return Promise.resolve({
          SavingsPlansCoverages: [
            {
              Attributes: { SERVICE: 'Amazon Elastic Compute Cloud - Compute' },
              Coverage: { OnDemandCost: '100', SpendCoveredBySavingsPlans: '400' },
            },
          ],
        });
      }
      return Promise.resolve({
        CoveragesByTime: [
          {
            Groups: [
              {
                Attributes: { SERVICE: 'Amazon Elastic Compute Cloud - Compute' },
                Coverage: { CoverageCost: { OnDemandCost: '50' } },
              },
            ],
          },
        ],
      });
    });

    const result = await collectSavingsPlansCoverage();

    expect(result).toHaveLength(1);
    expect(result[0].service).toBe('Amazon Elastic Compute Cloud - Compute');
    expect(result[0].onDemandUsd).toBe(150);
    expect(result[0].coveredUsd).toBe(400);
    expect(result[0].coveragePercent).toBeCloseTo((400 / 550) * 100, 5);
  });

  it('still returns results from GetSavingsPlansCoverage when GetReservationCoverage fails, without throwing entirely', async () => {
    ceSendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'savingsPlans') {
        return Promise.resolve({
          SavingsPlansCoverages: [
            {
              Attributes: { SERVICE: 'Amazon Relational Database Service' },
              Coverage: { OnDemandCost: '20', SpendCoveredBySavingsPlans: '80' },
            },
          ],
        });
      }
      return Promise.reject(new Error('AccessDenied: ce:GetReservationCoverage'));
    });

    const result = await collectSavingsPlansCoverage();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      service: 'Amazon Relational Database Service',
      onDemandUsd: 20,
      coveredUsd: 80,
    });
    expect(result[0].coveragePercent).toBeCloseTo(80, 5);
  });
});
