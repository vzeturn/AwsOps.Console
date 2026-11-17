import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import {
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
} from '@aws-sdk/client-ec2';
import { getEc2Client } from '../../core/aws-clients.js';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, notFound } from '../../shared-kernel/errors.js';
import { logger } from '../../shared-kernel/logger.js';

const ec2 = getEc2Client();

/**
 * `GET /ec2-instance-types?instanceId=...` — returns the list of instance types COMPATIBLE with
 * the instance's current architecture + virtualization type, within its exact AZ (Section 3 spec).
 * Read-only, NOT operator-gated — same access level as get-security-groups.ts / get-infra.ts.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const instanceId = event.queryStringParameters?.instanceId;
  if (!instanceId) {
    throw badRequest('Missing required parameter: instanceId');
  }

  const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = Reservations[0]?.Instances?.[0];
  if (!instance) {
    throw notFound(`EC2 instance ${instanceId} not found`);
  }

  const az = instance.Placement?.AvailabilityZone;
  const currentArch = instance.Architecture;
  const currentVirtType = instance.VirtualizationType;
  if (!az || !currentArch || !currentVirtType) {
    throw badRequest(`Missing architecture/virtualization/AZ information for instance ${instanceId}`);
  }

  // DescribeInstanceTypeOfferings is paginated (NextToken) — a typical AZ has 700+ types, so a
  // single call without NextToken would SILENTLY truncate to one page (default ~1000 but not
  // guaranteed to fetch everything). Loop until NextToken is exhausted so no type is missing from
  // the picker.
  const instanceTypeOfferings: string[] = [];
  let offeringsNextToken: string | undefined;
  do {
    const page = await ec2.send(
      new DescribeInstanceTypeOfferingsCommand({
        LocationType: 'availability-zone',
        Filters: [{ Name: 'location', Values: [az] }],
        NextToken: offeringsNextToken,
      }),
    );
    for (const o of page.InstanceTypeOfferings ?? []) {
      if (o.InstanceType) instanceTypeOfferings.push(o.InstanceType);
    }
    offeringsNextToken = page.NextToken;
  } while (offeringsNextToken);
  const candidateTypes = instanceTypeOfferings;
  if (candidateTypes.length === 0) {
    return ok(event, { compatibleTypes: [] });
  }

  // DescribeInstanceTypes accepts at most 100 types per call — chunk if exceeded (a typical AZ has
  // < 100 types so one call is usually enough in practice, but that is not assumed to always hold).
  const BATCH_SIZE = 100;
  const compatibleTypes: string[] = [];
  for (let i = 0; i < candidateTypes.length; i += BATCH_SIZE) {
    const batch = candidateTypes.slice(i, i + BATCH_SIZE);
    try {
      const { InstanceTypes = [] } = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: batch as never[] }));
      for (const t of InstanceTypes) {
        const archOk = (t.ProcessorInfo?.SupportedArchitectures ?? []).includes(currentArch as never);
        const virtOk = (t.SupportedVirtualizationTypes ?? []).includes(currentVirtType as never);
        if (archOk && virtOk && t.InstanceType) {
          compatibleTypes.push(t.InstanceType);
        }
      }
    } catch (err) {
      logger.error(`get-ec2-instance-types: DescribeInstanceTypes batch failed`, err);
      throw badRequest('Unable to load compatible instance types');
    }
  }

  return ok(event, { compatibleTypes: compatibleTypes.sort() });
}
