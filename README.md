# ops-dashboard

Internal operations dashboard for a single AWS account — realtime monitoring, infra (EC2/RDS/ALB/ECS),
backup & compliance (AWS Backup/DLM/Config), and cost (Cost Explorer). Serverless, near-$0 to run,
deployed with plain CloudFormation (no CDK). All account ID, region, operating timezone, and tag
conventions are read from CloudFormation Parameters/pseudo-params — **there is no hardcoded value
specific to any one account/org** in the code or templates; see "Deploying to a different AWS account/org"
below.

> **This dashboard is NOT read-only.** The stack exposes mutating `POST /actions/*` routes (EC2/RDS lifecycle, instance-type
> and security-group changes, SSM Run Command, scheduled actions) and runs several Lambdas that change
> resources on their own (`patch-scheduler`, `ec2-rightsize-applier`, time-of-day sizing). Mutating
> routes are gated by `OperatorGroupIds` on top of the login gate, and every execution is written to
> `action-audit/` in S3. Treat this as a control plane, not a viewer.

## Architecture

- **No API Gateway/Cognito/DynamoDB.** Two Function URLs (`static-server`, `router`) plus a set of
  scheduled/event-driven Lambdas. The full inventory lives in `infra/ops-dashboard.yaml`; the ones that
  matter for understanding the data flow are:
  - `static-server` — Function URL (authType NONE) serving the pre-built React SPA.
  - `router` — Function URL (authType NONE), verifies JWT itself (Entra ID) + implements CORS itself, and
    routes itself (see `backend/src/router.ts` for the full route list).
  - `infra-collector` — schedule, default `rate(5 minutes)`. Writes `infra-cache.json`,
    `compliance-cache.json` and `monitoring-cache.json` to the S3 bucket.
  - `cost-collector` — schedule, default `rate(6 hours)`, is the ONLY place that calls Cost Explorer.
  - `infra-review-collector` — schedule, default `rate(1 day)`, writes `assessment-report.json`.

- **No paid AWS API is ever called directly on the request path.** This is the core cost rule of the
  project: the bill must never be a function of how many people have the dashboard open or how fast the
  browser polls. There are two ways this is achieved, and which one applies depends on expected usage:
  - **Scheduled collector** (`/infra`, `/compliance`, `/cost`, `/assessment`) — a Lambda refreshes an
    S3/SSM snapshot on a timer and the route only reads it. Cost is a function of the schedule.
  - **Lazy write-through cache with a TTL** (`/monitoring`) — the route serves the cached snapshot and
    only rebuilds it when older than the TTL. Cost is a function of real usage, with the TTL as a hard
    ceiling. Used here because `GetMetricData` is billed per metric and a fixed 5-minute
    schedule would pay for refreshes nobody reads.

  If you add a feature that needs a paid API, pick one of these two. Do not call it inline.
- **Sign-in**: Microsoft Entra ID, Authorization Code + PKCE, using `id_token`. The backend verifies via
  JWKS (`jose`), accepting `audience = [clientId, api://clientId]` so the ID token's `aud` matches.

  The scope sent to Entra ID **must** include `offline_access` (hardcoded in `infra/static-server/index.ts`).
  Without it, Entra won't issue a refresh token, `automaticSilentRenew` has to renew via a hidden iframe and
  gets blocked by third-party cookie restrictions in the browser — the result is every tab reporting `Unauthorized`
  after ~60 minutes.

  **Do not** add `api://<clientId>/access_as_user` to that scope. Combining the API scope with
  `openid profile email offline_access` requests a token for two resources in a single call; Entra
  will only issue an access token for one resource, picks Microsoft Graph, and silently drops the API scope — the
  backend then rejects every request. This was tried and reverted; see the comment in `infra/static-server/index.ts`
  and `frontend/src/hooks/useApi.ts` for details.

  The App Registration still keeps the expose-API configuration ([`infra/entra-expose-api.json`](infra/entra-expose-api.json))
  for later use if we switch to acquiring an access token via a separate token request.
- **Frontend**: React + Vite + TailwindCSS SPA (no react-router — tab state lives in `App.tsx`), dark/light/
  system theme, auto-refresh (React Query), red/yellow thresholds, CSV export (server) + PDF (browser print).
  Tabs: Monitoring (default), Assessment, Infra, Compliance, Cost, Scheduled Actions, Logs, Security Groups,
  Run Command — all `React.lazy`-loaded.

## Structure

```
shared/    Shared data types (API contract) — built first.
backend/   3 Lambda handlers (router, cost-collector) + services + auth.
frontend/  React SPA.
infra/     static-server Lambda, CloudFormation template, artifact build + deploy scripts.
```

## Development

```bash
npm install
npm run build      # builds shared → backend → frontend, in that order
npm run typecheck
```

## Deployment

See [RUNBOOK.md](RUNBOOK.md) for the alarm/DLQ handling process during operations.

Prerequisite: a dedicated **App Registration** created in Microsoft Entra ID for `ops-dashboard` (separate
from any external state-manager service) — needs `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, redirect URI = the `static-server`
Function URL (known after the first deploy, see `infra/deploy.sh`).

```bash
export ENTRA_TENANT_ID=...
export ENTRA_CLIENT_ID=...
export ALLOWED_GROUP_IDS=...   # optional, CSV of group object IDs allowed access

# First time (bootstrap with empty SITE_URL to obtain the Function URL):
bash infra/deploy.sh
# Get StaticServerFunctionUrl from Outputs, redeploy with SITE_URL:
export SITE_URL=https://xxxx.lambda-url.ap-southeast-1.on.aws/
bash infra/deploy.sh
```

### Running costs

Two AWS APIs used by this stack are billed from the first call and are NOT covered by any free tier.
Everything else (Lambda, Function URL, SSM Parameter Store `String`, S3 at these volumes, basic CloudWatch
Logs, `PutMetricAlarm`/`DescribeAlarms`, SNS to Lambda) stays inside the Free Tier.

| Billed API | Called by | Cadence | Estimated cost |
|---|---|---|---|
| Cost Explorer `GetCostAndUsage` | `cost-collector` | `rate(6 hours)` = 4 runs/day, 5 calls/run | ~$0.20/day |
| CloudWatch `GetMetricData` | `GET /monitoring`, on a cache miss | at most 1 rebuild / 4 min | Scales with real usage, bounded by the TTL |
| CloudWatch `GetMetricData` | `infra-review-collector` | `rate(1 day)` | negligible |

Estimated from public pricing, the Cost Explorer line is roughly $6/month, plus the monitoring line
(which depends on usage) and a few MB in the artifact bucket.

`GetMetricData` is explicitly excluded from the CloudWatch free tier: the 1M free API requests do not
cover it, and it is billed per *metric requested* (~$0.01 per 1,000) rather than per call — see
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/). Neither line item scales with the number
of users or browser tabs; the monitoring one is bounded by `MONITORING_CACHE_TTL_MS`, the Cost Explorer one
by `CostCollectorScheduleExpression`.

## Frontend on Cloudflare Workers (in test, running in parallel with the Lambda)

The SPA is being moved off the `static-server` Lambda onto Cloudflare Workers static assets. Both are
deployed at the same time right now — the Lambda is the fallback, and rolling back means simply
continuing to use its Function URL.

Why: `static-server` is a Lambda whose only job is to serve `frontend/dist`. It hand-rolls MIME
mapping, re-runs `gzipSync` on every request, sets cache headers, and implements SPA fallback — all of
which a CDN does natively, from the nearest edge location instead of one region. Cloudflare serves it
with no Worker script, so there are no billable invocations, and a stable URL also removes the
two-pass `SITE_URL` bootstrap that `infra/deploy.sh` needs today.

```bash
export AWS_REGION=ap-southeast-1
export ENTRA_TENANT_ID=...          # same values as infra/deploy.sh
export ENTRA_CLIENT_ID=...
export CLOUDFLARE_SITE_URL=https://ops-dashboard.<your-subdomain>.workers.dev

npx wrangler login                  # once
bash infra/deploy-frontend-cloudflare.sh
```

On the very first deploy you do not yet know the workers.dev URL. Run it once with a placeholder
(`CLOUDFLARE_SITE_URL=https://example.invalid`), read the URL wrangler prints, then re-run with the
real value — the same chicken-and-egg as the existing `SITE_URL` bootstrap.

Two things the script deliberately does NOT do, because they live outside its blast radius:

1. **Entra ID**: add the Cloudflare URL to the App Registration's SPA Redirect URIs. Missing this gives
   `AADSTS50011`.
2. **Router CORS**: redeploy the stack so the origin is allowed alongside the Lambda's:
   ```bash
   ADDITIONAL_ALLOWED_ORIGINS=https://ops-dashboard.<your-subdomain>.workers.dev bash infra/deploy.sh
   ```
   `ALLOWED_ORIGINS` is then a CSV of both origins, so both frontends work simultaneously.

Notes on how it is wired:

- `config.js` (`window.__APP_CONFIG__`) is the one thing a static host cannot do the way the Lambda did
  — the Lambda built it per request from its environment. It is now generated at build time by
  `frontend/scripts/generate-config.mjs`, with `apiBaseUrl` read from the live `RouterFunctionUrl` stack
  output rather than hardcoded. `frontend/scripts/generate-config.test.mjs` pins the output against the
  Lambda's version so the two cannot drift while both exist.
- Caching/security headers live in `frontend/public/_headers` (Vite copies `public/` into `dist/`).
  Cloudflare's default `max-age=0, must-revalidate` + ETag is kept for `index.html`/`config.js`; only
  the content-hashed `assets/*` get a 1-year immutable cache.
- Source maps are no longer published: `vite.config.ts` uses `sourcemap: 'hidden'` and the deploy script
  deletes `*.map` before upload. Previously the full TypeScript source was downloadable from the
  `authType NONE` Function URL.

Cleanup once this is trusted: delete `infra/static-server/`, its Lambda/LogGroup/FunctionUrl/alarm
resources from `infra/ops-dashboard.yaml`, the `copy frontend/dist` step in
`infra/scripts/build-artifacts.mjs`, and the parity tests.

Cleanup trigger: run both deployments in parallel for at least 2-4 weeks of normal usage with zero rollbacks to the Lambda origin, then do the cleanup. If a rollback happens in that window, restart the clock from the fix.

## Deploying to a different AWS account/org

This stack does NOT depend on a VPC/subnet/security group (every Lambda uses a Function URL, no dedicated
network), does NOT hardcode the account ID (every ARN uses the CloudFormation pseudo-params `${AWS::AccountId}`/
`${AWS::Region}`), and does NOT hardcode timezone/tag names in code — everything is read via CloudFormation
Parameters. To deploy into a brand-new AWS account/org, just set the right environment variables when running
`infra/deploy.sh` — no code or template changes needed:

| Environment variable (`deploy.sh`) | CloudFormation Parameter | Required? | Meaning |
|---|---|---|---|
| `AWS_REGION` | *(pseudo-param, not a Parameter)* | **Yes** | Deploy region — no longer has an implicit default (previously defaulted to `ap-southeast-1`, which made it easy to deploy to the wrong region if you forgot to set it). |
| `ENTRA_TENANT_ID` | `EntraTenantId` | Yes | Microsoft Entra ID tenant ID for the new org. |
| `ENTRA_CLIENT_ID` | `EntraClientId` | Yes | Client ID of the dedicated App Registration for `ops-dashboard` on the new tenant. |
| `ORG` | `Org` | No (default `abc`) | Resource naming prefix (`${Org}-${Project}-${Environment}-...`) — change it to avoid resource name clashes when deploying multiple orgs into the same account. |
| `ALLOWED_GROUP_IDS` | `AllowedGroupIds` | No | CSV of Entra ID group Object IDs allowed to use the app — empty = any authenticated user. |
| `TAG_PREFIX` | `TagPrefix` | No (default `OpsDashboard`) | Namespace prefix for the EC2 tags the stack itself writes (`<TagPrefix>:LastPatchCommandId`, `<TagPrefix>:LastPatchVerifiedDate`, ...). Change it if the new org already has tags with the same name. |
| `SCHEDULE_TAG_KEY` | `ScheduleTagKey` | No (default `schedule:start`) | Tag key set on EC2 instances by an on/off scheduling system **external to** this stack, marking an instance as participating in the automated on/off schedule — change it if the new org's on/off scheduling convention uses a different tag name. |
| `PATCH_TIMEZONE` | `PatchTimezone` | No (default `Asia/Ho_Chi_Minh`) | IANA timezone (e.g. `America/New_York`) used to compute "today's date" when comparing patch/auto-rightsize date tags — MUST match the new org's actual operating hours, otherwise an instance could get patched/rightsized twice within one business day due to a UTC date mismatch. |
| `DISCORD_WEBHOOK_URL_VALUE` | `DiscordWebhookUrlValue` | First deploy only | Discord webhook that receives CloudWatch Alarm/finding notifications — the new org needs to create its own webhook. |
| `ADDITIONAL_ALLOWED_ORIGINS` | `AdditionalAllowedOrigins` | No | CSV of extra origins allowed to call the router, on top of the one derived from `SITE_URL` — used to run the Cloudflare-hosted frontend in parallel with the Lambda one. Each origin must also be a Redirect URI on the Entra App Registration. |
| `Ec2StateManagerFunctionUrl`/`Ec2StateManagerServiceTokenValue` | *(same names)* | Yes, if using the EC2 Start/Stop action | URL + shared secret of an optional external state-manager service, deployed independently (read by the `EC2_STATE_MANAGER_*` environment variables). |

Example of deploying to a new org (region `us-east-1`, US timezone, custom tag prefix):

```bash
export AWS_REGION=us-east-1
export ORG=contoso
export ENTRA_TENANT_ID=...
export ENTRA_CLIENT_ID=...
export PATCH_TIMEZONE=America/New_York
export TAG_PREFIX=contoso-ops

bash infra/deploy.sh
```

Things that **still need manual adjustment** when switching orgs (not automated via Parameters, since they
depend on each org's own infrastructure/operational processes):
- The external EC2 on/off scheduling system (if the new org wants to use `patch-scheduler`/`EC2_AutoRightsize`)
  must set the `ScheduleTagKey` tag (default `schedule:start`) on whichever instances should participate in the schedule.
- The optional external state-manager service (start/stop EC2 via a 1-click action) is a separate app,
  deployed independently — it is not part of this template.
- Alert thresholds (CPU/storage/cost, etc.) in `backend/src/lib/thresholds.ts`/`monitoringThresholds.ts`
  are shared business constants, not values specific to any one deployment — other orgs use the same reasonable
  defaults for any infrastructure scale; edit them directly in code if you need something different.
