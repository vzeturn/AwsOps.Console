import type { MonitoringResourceType, ThresholdMeta } from '@ops-dashboard/shared';
import { logger } from '../../../shared-kernel/logger.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../ec2-management/index.js`.
// This file is re-exported by `monitoring-service.ts`, which is imported by `alert-service.ts`,
// which is used by `health-report-fn` (a lean standalone Lambda) — the ec2-management barrel
// also re-exports handler files that import `config.ts` at module scope (see
// `lambda-boot.test.ts`).
import { evalThreshold, evalRangeThreshold } from '../../ec2-management/thresholds.js';
import {
  EC2_CPU_WARN_PERCENT,
  EC2_CPU_CRITICAL_PERCENT,
  EC2_CWAGENT_WARN_PERCENT,
  EC2_CWAGENT_CRITICAL_PERCENT,
  RDS_CPU_WARN_PERCENT,
  RDS_CPU_CRITICAL_PERCENT,
  RDS_FREE_STORAGE_WARN_PERCENT,
  RDS_FREE_STORAGE_CRITICAL_PERCENT,
  RDS_FREEABLE_MEMORY_USED_WARN_PERCENT,
  RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT,
  RDS_SWAP_WARN_PERCENT_OF_RAM,
  RDS_SWAP_CRITICAL_PERCENT_OF_RAM,
  RDS_LATENCY_WARN_MS,
  RDS_LATENCY_CRITICAL_MS,
  RDS_SQLSERVER_FREEABLE_MEMORY_WARN_BYTES,
  RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES,
  RDS_INSTANCE_RAM_GIB,
  isSqlServerEngine,
  ALB_RESPONSE_TIME_WARN_SECONDS,
  ALB_RESPONSE_TIME_CRITICAL_SECONDS,
  ALB_UNHEALTHY_HOST_WARN_COUNT,
  ECS_CPU_WARN_PERCENT,
  ECS_CPU_CRITICAL_PERCENT,
  ECS_MEMORY_WARN_PERCENT,
  ECS_MEMORY_CRITICAL_PERCENT,
} from '../monitoringThresholds.js';

// ---- evalMonitoringThreshold (Requirement 1.2, 1.3, 1.4, 2.5, 2.6, 3.3, 4.2, 4.3, 4.4, 4.5, 4.6, 5.4) ----

const GIB_IN_BYTES = 1024 ** 3;

// RDS_INSTANCE_RAM_GIB is now the SINGLE SOURCE OF TRUTH in `monitoringThresholds.ts` (shared
// with `alarm-baseline-manager.ts`) — re-exported here to keep the old API for existing
// tests/consumers (`monitoring-service.test.ts` imports directly from this module).
export { RDS_INSTANCE_RAM_GIB };

export interface MonitoringThresholdContext {
  /** RDS: `DBInstanceClass` — used to look up `RDS_INSTANCE_RAM_GIB` for FreeableMemory/SwapUsage. */
  dbInstanceClass?: string;
  /**
   * RDS: `Engine` (`DBInstance.Engine`) — needed for FreeableMemory because SQL Server uses a
   * COMPLETELY DIFFERENT threshold model than engines that rely on OS page cache. When `engine`
   * is missing, defaults to the % model (safe for PostgreSQL/MySQL) — see `rds.FreeableMemory`.
   */
  engine?: string;
  /** RDS: `AllocatedStorage` (GiB) — used to compute the free % for FreeStorageSpace. */
  allocatedStorageGb?: number;
  /** ALB: total registered targets — needed for UnHealthyHostCount (reuses `evalThreshold`). */
  totalTargets?: number;
}

/**
 * Applies the full threshold table from design.md (Data Models — "Metric & threshold definition
 * table") to one specific (resourceType, metricName, value). Returns `undefined` for
 * "measured-only" metrics (no universally sensible Threshold_Level — Property 5) AND when
 * `RDS_INSTANCE_RAM_GIB`/`allocatedStorageGb` doesn't provide enough data to compute one (Design
 * Error Handling — fall back to measured-only, don't throw).
 */
export function evalMonitoringThreshold(
  resourceType: MonitoringResourceType,
  metricName: string,
  value: number,
  context: MonitoringThresholdContext = {},
): ThresholdMeta | undefined {
  switch (`${resourceType}.${metricName}`) {
    // ---- EC2 (Requirement 1.2, 1.3, 1.4) ----
    case 'ec2.CPUUtilization':
      return evalRangeThreshold(value, { warnAt: EC2_CPU_WARN_PERCENT, criticalAt: EC2_CPU_CRITICAL_PERCENT, direction: 'above' });

    case 'ec2.StatusCheckFailed':
      return value !== 0
        ? { level: 'critical', reason: `StatusCheckFailed = ${value}` }
        : { level: 'ok', reason: 'StatusCheckFailed = 0' };

    // ---- EC2 CWAgent (Requirement 2.5, 2.6) ----
    case 'ec2.mem_used_percent':
    case 'ec2.disk_used_percent':
      return evalRangeThreshold(value, { warnAt: EC2_CWAGENT_WARN_PERCENT, criticalAt: EC2_CWAGENT_CRITICAL_PERCENT, direction: 'above' });

    // ---- EBS (Requirement 3.3) — warn-only, no critical tier ----
    case 'ebs.VolumeQueueLength':
      return value > 1
        ? { level: 'warn', reason: `VolumeQueueLength = ${value} > 1` }
        : { level: 'ok', reason: `VolumeQueueLength = ${value}` };

    // ---- RDS (Requirement 4.2, 4.3, 4.4, 4.5, 4.6) ----
    case 'rds.CPUUtilization':
      return evalRangeThreshold(value, { warnAt: RDS_CPU_WARN_PERCENT, criticalAt: RDS_CPU_CRITICAL_PERCENT, direction: 'above' });

    case 'rds.FreeableMemory': {
      // SQL Server does NOT use the % used model: `max server memory` caps the buffer pool, SQL
      // Server fills it up and then HOLDS ONTO it, so the normal operating point always sits
      // around 89% used. A % threshold would produce permanent false alarms. Use an absolute
      // free-byte floor instead — see the measured evidence in `RDS_SQLSERVER_FREEABLE_MEMORY_*_BYTES`
      // in monitoringThresholds.ts. This model does NOT need a RAM_GIB lookup, so it can still
      // score a threshold even when the class isn't in the table.
      if (isSqlServerEngine(context.engine)) {
        return evalRangeThreshold(value, {
          warnAt: RDS_SQLSERVER_FREEABLE_MEMORY_WARN_BYTES,
          criticalAt: RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES,
          direction: 'below',
        });
      }

      // Engines that rely on OS page cache (PostgreSQL/MySQL/MariaDB): FreeableMemory accurately
      // reflects remaining headroom, so % used is a sensible signal.
      const ramGib = context.dbInstanceClass ? RDS_INSTANCE_RAM_GIB[context.dbInstanceClass] : undefined;
      if (ramGib === undefined) {
        logger.warn(
          `RDS_INSTANCE_RAM_GIB lookup miss for DBInstanceClass=${context.dbInstanceClass ?? '(unknown)'} — FreeableMemory falls back to measured-only`,
        );
        return undefined;
      }
      const usedPercent = (1 - value / (ramGib * GIB_IN_BYTES)) * 100;
      return evalRangeThreshold(usedPercent, {
        warnAt: RDS_FREEABLE_MEMORY_USED_WARN_PERCENT,
        criticalAt: RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT,
        direction: 'above',
      });
    }

    case 'rds.SwapUsage': {
      const ramGib = context.dbInstanceClass ? RDS_INSTANCE_RAM_GIB[context.dbInstanceClass] : undefined;
      if (ramGib === undefined) {
        logger.warn(
          `RDS_INSTANCE_RAM_GIB lookup miss for DBInstanceClass=${context.dbInstanceClass ?? '(unknown)'} — SwapUsage falls back to measured-only`,
        );
        return undefined;
      }
      // Warn is a % of RAM, NOT "> 0". A small stable swap figure is normal on Linux and means
      // nothing — see RDS_SWAP_WARN_PERCENT_OF_RAM for the 14 days of measurements behind this.
      const criticalBytes = ramGib * GIB_IN_BYTES * (RDS_SWAP_CRITICAL_PERCENT_OF_RAM / 100);
      const warnBytes = ramGib * GIB_IN_BYTES * (RDS_SWAP_WARN_PERCENT_OF_RAM / 100);
      if (value >= criticalBytes) {
        return {
          level: 'critical',
          reason: `SwapUsage = ${value} bytes >= ${RDS_SWAP_CRITICAL_PERCENT_OF_RAM}% RAM`,
        };
      }
      if (value >= warnBytes) {
        return {
          level: 'warn',
          reason: `SwapUsage = ${value} bytes >= ${RDS_SWAP_WARN_PERCENT_OF_RAM}% RAM`,
        };
      }
      return {
        level: 'ok',
        reason: `SwapUsage = ${value} bytes (below ${RDS_SWAP_WARN_PERCENT_OF_RAM}% RAM)`,
      };
    }

    case 'rds.FreeStorageSpace': {
      if (context.allocatedStorageGb === undefined || context.allocatedStorageGb <= 0) return undefined;
      const freePercent = (value / (context.allocatedStorageGb * GIB_IN_BYTES)) * 100;
      return evalRangeThreshold(freePercent, {
        warnAt: RDS_FREE_STORAGE_WARN_PERCENT,
        criticalAt: RDS_FREE_STORAGE_CRITICAL_PERCENT,
        direction: 'below',
      });
    }

    case 'rds.ReadLatency':
    case 'rds.WriteLatency': {
      // CloudWatch RDS latency metric unit = Seconds — thresholds are designed in ms (20ms/50ms).
      const valueMs = value * 1000;
      return evalRangeThreshold(valueMs, { warnAt: RDS_LATENCY_WARN_MS, criticalAt: RDS_LATENCY_CRITICAL_MS, direction: 'above' });
    }

    // ---- ECS_Service — matches the target-tracking autoscaling already in place on
    // abc-prod-ecs-cluster (target CPU 50-75%, target Memory 80%) — warn slightly ahead of the
    // autoscaling target so operators know BEFORE autoscaling has to step in, critical when well
    // past the target. ----
    case 'ecs.CPUUtilization':
      return evalRangeThreshold(value, { warnAt: ECS_CPU_WARN_PERCENT, criticalAt: ECS_CPU_CRITICAL_PERCENT, direction: 'above' });

    case 'ecs.MemoryUtilization':
      return evalRangeThreshold(value, { warnAt: ECS_MEMORY_WARN_PERCENT, criticalAt: ECS_MEMORY_CRITICAL_PERCENT, direction: 'above' });

    // ---- ALB (Requirement 5.4, and 5.2/5.3 reuse evalThreshold — Property 6) ----
    case 'alb.TargetResponseTime':
      return evalRangeThreshold(value, {
        warnAt: ALB_RESPONSE_TIME_WARN_SECONDS,
        criticalAt: ALB_RESPONSE_TIME_CRITICAL_SECONDS,
        direction: 'above',
      });

    case 'alb.UnHealthyHostCount': {
      const totalTargets = context.totalTargets ?? 0;
      return evalThreshold(value, {
        warnAt: ALB_UNHEALTHY_HOST_WARN_COUNT,
        criticalAt: totalTargets,
        direction: 'above',
        okReason: 'All targets healthy',
        warnReason: `${value}/${totalTargets} targets unhealthy`,
        criticalReason: 'All targets unhealthy',
      });
    }

    // ---- Measured-only (Requirement 1.5, 3.4, 4.7 — Property 5): EC2 NetworkIn/NetworkOut, EBS
    // Read/WriteOps/Bytes/ThroughputPercentage, RDS DatabaseConnections/ReadIOPS/WriteIOPS/
    // ReadThroughput/WriteThroughput/DiskQueueDepth/NetworkReceiveThroughput/NetworkTransmitThroughput.
    default:
      return undefined;
  }
}
