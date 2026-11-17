import type { InfraData } from '@ops-dashboard/shared';
import { readCachedJson } from '../../shared-kernel/s3Cache.js';
import { INFRA_CACHE_S3_KEY } from './infraCacheKey.js';
import { getInfraData } from '../infra/index.js';
import { forbidden } from '../../shared-kernel/errors.js';

/** EC2 instance id: `i-` + 8 or 17 hex characters (AWS's old and new formats). */
export const EC2_INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8,17}$/;

/**
 * The CORE SAFETY BOUNDARY of sub-project #4: commands may only run on an instance the dashboard
 * is ACTIVELY monitoring, not an arbitrary instance id the caller typed in.
 *
 * Uses the exact same read path as `GET /infra` (S3 cache, falling back to
 * `ec2:DescribeInstances`), so it needs NO new IAM — `RouterRole` already has both
 * `s3:GetObject` on `infra-cache.json` and `ec2:DescribeInstances`.
 *
 * The fallback does NOT fail open: when the cache errors or doesn't exist yet, we call AWS
 * Describe directly, and the result is still the REAL instance list for this account/region —
 * it never degrades into "let everything through".
 */
export async function assertInstanceInInfraCache(instanceId: string): Promise<void> {
  const cached = await readCachedJson<InfraData>(INFRA_CACHE_S3_KEY);
  const data = cached ?? (await getInfraData());
  if (!data.ec2.some((instance) => instance.instanceId === instanceId)) {
    throw forbidden(`Instance ${instanceId} is not in the infrastructure list the dashboard is monitoring`);
  }
}
