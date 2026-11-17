# Tag standard

Tags the dashboard reads or writes. Keys use PascalCase with a `:` namespace separator. The
`OpsDashboard` prefix is the default of the `TagPrefix` CloudFormation parameter.

## Tags written by the dashboard

| Key | Allowed values | Meaning |
|---|---|---|
| `<TagPrefix>:LastPatchCommandId` | SSM command ID | Last patch command sent to the instance by `patch-scheduler`. |
| `<TagPrefix>:LastPatchVerifiedDate` | `YYYY-MM-DD` (in `PatchTimezone`) | Date the last patch run was verified. |
| `<TagPrefix>:PendingAutoRightsize` | Target instance type | Auto-rightsize change waiting to be applied. |
| `<TagPrefix>:LastAutoRightsizeDate` | `YYYY-MM-DD` (in `PatchTimezone`) | Date of the last automatic rightsize. |

## Tags read by the dashboard (set by operators)

| Key | Allowed values | Meaning |
|---|---|---|
| `Department` | `SALE`, `MKT`, `HR`, `SERVICE`, `SHARED` | Cost allocation owner. `SHARED` cost is split across the other four in proportion to their direct cost. Key is configurable with `DEPARTMENT_TAG_KEY`. |
| `Schedule:Start` | Any value | Marks an EC2 instance as part of an external on/off schedule. Key is configurable with `ScheduleTagKey`. |
| `<TagPrefix>:NoAutoRightsize` | `true` | Excludes the instance from automatic rightsizing. |
| `<TagPrefix>:NoAutoSizing` | `true` | Excludes the instance from automatic time-of-day sizing. |
| `<TagPrefix>:MinInstanceType` | EC2 instance type | Lower bound for automatic sizing. |
| `<TagPrefix>:MaxInstanceType` | EC2 instance type | Upper bound for automatic sizing. |
| `<TagPrefix>:ScaleMarginPercent` | Integer percentage | Headroom margin used when choosing a size. |
| `OpsDashboard:MonitoringExempt` | `true` | Excludes a resource from monitoring thresholds and alerts. Reviewed by `governance-exemption-auditor`. |
| `SecurityException` | Free text reason | Marks a deliberate security exception. |
| `SecurityExceptionOwner` | Person or team | Owner of the exception. |
| `SecurityExceptionReviewDate` | `YYYY-MM-DD` | Date the exception must be reviewed. Flagged when past. |
| `DataClass` | For example `internal`, `public` | Data classification used by the public-bucket checks. |
| `Environment` | For example `Prod`, `UAT`, `NonProd`, `Shared` | Environment label shown for RDS instances. Matching is case-insensitive. |
| `BackupTier` | For example `Critical`, `Standard`, `Minimal`, `none` | Backup tier shown for RDS instances. Matching is case-insensitive. |

## Tags that opt resources into schedulers

| Key | Allowed values | Meaning |
|---|---|---|
| `IdleScheduler:Managed` | `true` | Load balancer participates in the idle scheduler. |
| `IdleScheduler:Ec2InstanceId` | EC2 instance ID | Instance stopped when the load balancer is idle. |
| `IdleScheduler:RdsInstanceId` | RDS instance ID | Database stopped when the load balancer is idle. |
| `IdleScheduler:IdleMinutes` | Integer | Idle time before resources are stopped. |
| `IdleScheduler:Hold` | `true` | Prevents the scheduler from stopping the group. |
| `RdsNightlyScheduler:Managed` | `true` | RDS instance is stopped and started by the nightly scheduler. |

## Rules

- Do not rename these keys on AWS without changing the code and the `aws:TagKeys` conditions in
  `infra/ops-dashboard.yaml` in the same release.
- Changing `TagPrefix` requires the same coordinated change.
- Tags with the `aws:` prefix and tags added by AWS services are ignored.
