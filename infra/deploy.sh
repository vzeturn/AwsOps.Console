#!/usr/bin/env bash
set -euo pipefail

# Deploy ops-dashboard with plain CloudFormation (no CDK).
#
# Bootstrap in 2 steps the first time (chicken-and-egg: SiteUrl needs the Function URL, the Function URL needs a deploy first):
#   1. Deploy #1 with a temporarily empty SITE_URL (wrong redirect_uri, empty ALLOWED_ORIGINS — acceptable, just to get the URL).
#   2. Get StaticServerFunctionUrl from Outputs, export SITE_URL=<that url>, deploy #2 — from then on only step 3 is needed.
#   3. Subsequent deploys: just run this script with SITE_URL already known.

: "${ORG:=abc}"
: "${PROJECT:=ops-dashboard}"
: "${ENVIRONMENT:=prod}"
# AWS_REGION has NO implicit default: a default region makes it easy to deploy to the wrong region
# when switching to a different account/org. It MUST be set explicitly (or left empty if the AWS
# CLI profile's default region is already what you want, see README).
: "${AWS_REGION:?Missing AWS_REGION (e.g. ap-southeast-1, us-east-1...) — there is no longer an implicit default, to avoid deploying to the wrong region when switching to a different AWS account/org}"
: "${ARTIFACT_BUCKET:=${ORG}-${PROJECT}-${ENVIRONMENT}-cfn-artifacts}"
: "${ENTRA_TENANT_ID:?Missing ENTRA_TENANT_ID}"
: "${ENTRA_CLIENT_ID:?Missing ENTRA_CLIENT_ID}"
: "${SITE_URL:=}"
: "${ALLOWED_GROUP_IDS:=}"
: "${OPERATOR_GROUP_IDS:=}"
# ADDITIONAL_ALLOWED_ORIGINS: CSV of extra origins allowed to call the router, on top of the one
# derived from SITE_URL. Needed to run a SECOND copy of the frontend in parallel with the
# static-server Lambda — currently the Cloudflare Workers deployment, see
# infra/deploy-frontend-cloudflare.sh. Empty = only SITE_URL's origin is allowed. Follows the same
# convention as the parameters below: leave unset on later deploys and CloudFormation reuses the
# previous value.
: "${ADDITIONAL_ALLOWED_ORIGINS:=}"
# TAG_PREFIX/SCHEDULE_TAG_KEY/PATCH_TIMEZONE: empty = use the CloudFormation Parameter default (see
# infra/ops-dashboard.yaml). Set these when deploying to a different org with its own
# tag/timezone convention, see README, "Deploying to a different AWS account/org".
: "${TAG_PREFIX:=}"
: "${SCHEDULE_TAG_KEY:=}"
: "${PATCH_TIMEZONE:=}"
# VPC_FLOW_LOGS_ENABLED/VPC_ID_PRIMARY/VPC_ID_SECONDARY: empty = use the CloudFormation Parameter
# default (VpcFlowLogsEnabled defaults to 'false', so Flow Logs stay OFF with no extra cost).
# Set VPC_FLOW_LOGS_ENABLED=true to turn on REJECT-only VPC Flow Logs for the two VPCs
# (VpcIdPrimary/VpcIdSecondary; their template defaults are placeholders, set the real vpc-* ids
# from `aws ec2 describe-vpcs` when you enable this). Billed per GB ingested, see the comment on
# VpcFlowLogsRole in the template.
: "${VPC_FLOW_LOGS_ENABLED:=}"
: "${VPC_ID_PRIMARY:=}"
: "${VPC_ID_SECONDARY:=}"
# AlertHookUrlParamName/Ec2StateManagerServiceTokenParamName no longer take a VALUE through
# this script at all: both are SecureString parameters that must be created/updated MANUALLY,
# once, outside of CloudFormation:
#   aws ssm put-parameter --name "/${ORG}/${PROJECT}/${ENVIRONMENT}/alert-hook-url" --type SecureString --value "<alert hook url>" --overwrite
#   aws ssm put-parameter --name "/${ORG}/${PROJECT}/${ENVIRONMENT}/ec2-state-manager-service-token" --type SecureString --value "<token>" --overwrite
# (the same pattern AgentClaudeApiKeyParamName uses). This script only needs the PARAMETER NAME,
# which has a default in ops-dashboard.yaml and never has to be overridden unless deploying to a
# different org, see AlertHookUrlParamName/Ec2StateManagerServiceTokenParamName in
# ops-dashboard.yaml.

STACK_NAME="${ORG}-${PROJECT}-${ENVIRONMENT}"
cd "$(dirname "$0")"

echo "== 1/5: running test suite + npm audit (mandatory gate, deploy stops on failure) =="
(cd .. && npm run test --workspaces --if-present)

# `npm audit` is still a HARD gate — this wrapper does NOT weaken it. It only distinguishes the two
# very different reasons the command can exit non-zero:
#
#   (a) it reached the advisory database and FOUND high/critical vulnerabilities
#           -> abort immediately, no retry. This is the gate doing its job.
#   (b) it never reached the advisory database at all
#           -> retry, because "we could not check" is not the same as "we checked and it is clean",
#              and a deploy must not proceed on either without a real answer.
#
# Case (b) happens on flaky networks: some requests to the advisory endpoint are accepted and then
# never answered. `fetch-retries` in the repo .npmrc is honored but npm does not appear to treat this
# read timeout as retryable, so the retry has to happen at the command level.
#
# WHY THIS MATTERS: before the wrapper, a network flake produced the opaque message
# "audit endpoint returned an error", aborted the deploy at step 1/5, and left whoever was deploying
# with the obvious temptation to delete the audit line — trading a real security control for a
# transient network fault. See RUNBOOK.md and STANDARDS.md 4b.
#
# `--omit=dev` SCOPES THE GATE TO WHAT ACTUALLY SHIPS. Without it, this gate blocks EVERY deploy
# whenever any devDependency (vitest, eslint, typescript-eslint, ...) has an unpatched transitive
# CVE, although those tools run on a developer's machine and are never bundled into a Lambda
# artifact (see infra/scripts/build-artifacts.mjs: only backend/shared/frontend `dist/` + production
# node_modules are zipped, never devDependencies). A finding purely in the test runner's own
# dependency tree is not a production vulnerability: it cannot reach anything that runs in AWS.
#
# This does NOT weaken the gate for anything that matters: a CVE in a package backend/shared/frontend
# actually import (aws-sdk, jose, etc.) still fails the gate exactly as before, because those are
# dependencies, not devDependencies, and `--omit=dev` only drops the latter.
#
# If this gate ever fails, the FIRST question is "is the flagged package a devDependency", via
# `npm ls <package>` or `npm audit --omit=dev` locally. Do NOT reach for `npm audit fix --force` on a
# devDependency-only finding without checking first: a test-runner major-version upgrade can change
# mock defaults and fail hundreds of previously-passing tests, so it is its own planned migration,
# not a side effect of an unrelated deploy.
audit_gate() {
  # 12 attempts, not 6. If a single attempt succeeds only about 20% of the time on a flaky network,
  # 6 attempts still leave a 26% chance of the whole gate failing on a healthy dependency tree
  # (0.8^6); 12 brings that to ~7% (0.8^12). Each attempt costs 30-60s of timeout, so the worst case
  # is a ~10 minute gate, but the alternative is a deploy blocked by a coin flip, which is how
  # security gates get deleted.
  local attempts=12 i output status
  for ((i = 1; i <= attempts; i++)); do
    set +e
    output="$(cd .. && npm audit --omit=dev --audit-level=high 2>&1)"
    status=$?
    set -e

    if [[ $status -eq 0 ]]; then
      echo "   npm audit: reached the advisory database, no high/critical vulnerabilities (attempt $i)"
      return 0
    fi

    if ! grep -qE 'audit endpoint returned an error|network timeout|ENOTFOUND|ECONNRESET|ETIMEDOUT' <<<"$output"; then
      echo "$output"
      echo "   npm audit FAILED with actual findings — fix the vulnerabilities, do not retry." >&2
      return 1
    fi

    echo "   npm audit could not reach the advisory endpoint (attempt $i/$attempts) — retrying..."
    sleep 5
  done

  echo "   npm audit never reached the advisory endpoint after $attempts attempts." >&2
  echo "   The deploy is BLOCKED on purpose: an unverifiable dependency tree is not a passing gate." >&2
  echo "   Durable fixes: allow POST to https://registry.npmjs.org/-/npm/v1/security/* through the" >&2
  echo "   network egress filter, or run this deploy from CI. Do NOT remove this gate." >&2
  return 1
}
audit_gate

echo "== 2/5: build backend + frontend =="
(cd .. && npm run build --workspace shared && npm run build --workspace backend && npm run build --workspace frontend)

echo "== 3/5: packaging artifacts (router/static-server/cost-collector) =="
node scripts/build-artifacts.mjs

echo "== 4/5: ensuring artifact bucket exists ($ARTIFACT_BUCKET) — near-zero cost, just a few MB of zips =="
if ! aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" 2>/dev/null; then
  aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION"
  aws s3api put-public-access-block --bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

echo "== 5/5: cloudformation package + deploy =="
aws cloudformation package \
  --template-file ops-dashboard.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --output-template-file out.yaml \
  --region "$AWS_REGION"

PARAM_OVERRIDES=(
  Org="$ORG"
  Project="$PROJECT"
  Environment="$ENVIRONMENT"
  EntraTenantId="$ENTRA_TENANT_ID"
  EntraClientId="$ENTRA_CLIENT_ID"
  AllowedGroupIds="$ALLOWED_GROUP_IDS"
  OperatorGroupIds="$OPERATOR_GROUP_IDS"
  SiteUrl="$SITE_URL"
)
# The 3 portability parameters (TagPrefix/ScheduleTagKey/PatchTimezone) — only added to overrides when
# the corresponding environment variable HAS a value; otherwise CloudFormation uses UsePreviousValue
# (keeping the previous deploy's default).
if [[ -n "$ADDITIONAL_ALLOWED_ORIGINS" ]]; then
  PARAM_OVERRIDES+=(AdditionalAllowedOrigins="$ADDITIONAL_ALLOWED_ORIGINS")
fi
if [[ -n "$TAG_PREFIX" ]]; then
  PARAM_OVERRIDES+=(TagPrefix="$TAG_PREFIX")
fi
if [[ -n "$SCHEDULE_TAG_KEY" ]]; then
  PARAM_OVERRIDES+=(ScheduleTagKey="$SCHEDULE_TAG_KEY")
fi
if [[ -n "$PATCH_TIMEZONE" ]]; then
  PARAM_OVERRIDES+=(PatchTimezone="$PATCH_TIMEZONE")
fi
# AlarmBaselineExcludedResources deliberately uses DIFFERENT semantics from every parameter above.
# Those use `-n` (non-empty), which means you can set them but never clear them back to empty — fine for
# a tag prefix, useless for a switch whose entire purpose is being turned back OFF.
#
# Here `${VAR+isset}` tests whether the variable is DEFINED, not whether it is non-empty:
#   unset                                   -> omitted, CloudFormation keeps the previous value
#   ALARM_BASELINE_EXCLUDED_RESOURCES=''    -> passed as empty, CLEARS the list and restores all alarms
#   ALARM_BASELINE_EXCLUDED_RESOURCES='a,b' -> excludes exactly a and b
#
# Note the consequence of "unset keeps the previous value": an exclusion PERSISTS across ordinary
# deploys. That is intended — a routine deploy silently re-enabling alarms someone deliberately
# silenced would be worse — but it also means an exclusion can be forgotten. alarm-baseline-manager
# therefore logs the full exclusion list on EVERY reconcile, so "why is nothing alarming on X" is always
# answerable from the logs.
if [[ -n "${ALARM_BASELINE_EXCLUDED_RESOURCES+isset}" ]]; then
  PARAM_OVERRIDES+=(AlarmBaselineExcludedResources="$ALARM_BASELINE_EXCLUDED_RESOURCES")
fi
if [[ -n "$VPC_FLOW_LOGS_ENABLED" ]]; then
  PARAM_OVERRIDES+=(VpcFlowLogsEnabled="$VPC_FLOW_LOGS_ENABLED")
fi
if [[ -n "$VPC_ID_PRIMARY" ]]; then
  PARAM_OVERRIDES+=(VpcIdPrimary="$VPC_ID_PRIMARY")
fi
if [[ -n "$VPC_ID_SECONDARY" ]]; then
  PARAM_OVERRIDES+=(VpcIdSecondary="$VPC_ID_SECONDARY")
fi

aws cloudformation deploy \
  --template-file out.yaml \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$AWS_REGION" \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --parameter-overrides "${PARAM_OVERRIDES[@]}"

aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs' --output table
