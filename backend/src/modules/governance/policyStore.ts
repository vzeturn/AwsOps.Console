// backend/src/lib/policyStore.ts
import type { Tag } from '@aws-sdk/client-ec2';
import type { TeamPolicyOverride, TimeOfDaySizingDecision } from './timeOfDayPolicy.js';

/**
 * A thin interface, decoupled from the concrete implementation (`s3PolicyStore.ts`) so it can be
 * swapped for DynamoDB later (at much larger scale — hundreds of instances with complex
 * schedules) without touching `timeOfDayPolicy.ts` or the callers already using this interface.
 */
export interface PolicyStore {
  getComputedSchedule(instanceId: string): Promise<TimeOfDaySizingDecision | undefined>;
  putComputedSchedule(instanceId: string, decision: TimeOfDaySizingDecision): Promise<void>;
  /** Reads directly from the `tags` param (no separate API round-trip — the caller already has
   * tags from DescribeInstances). */
  getTeamOverride(instanceId: string, tags: Tag[]): Promise<TeamPolicyOverride>;
}
