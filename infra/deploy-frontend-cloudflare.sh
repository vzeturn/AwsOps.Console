#!/usr/bin/env bash
set -euo pipefail

# Deploy the frontend to Cloudflare Workers (static assets, no Worker script).
#
# This deploys ONLY the frontend. The backend stays on AWS exactly as it is — this script does not
# touch CloudFormation. It is safe to run repeatedly and it does not take the existing Lambda-hosted
# frontend down: both can serve the same SPA at the same time (see "PARALLEL RUN" below).
#
# PARALLEL RUN / ROLLBACK
#   The `static-server` Lambda is intentionally still deployed. Rollback = just keep using the Lambda
#   Function URL; nothing needs to be undone on the AWS side. For BOTH origins to work at once, the
#   router's CORS allowlist and the Entra App Registration must each list both:
#     1. CloudFormation: pass ADDITIONAL_ALLOWED_ORIGINS=<cloudflare origin> to infra/deploy.sh
#        (parameter AdditionalAllowedOrigins).
#     2. Entra ID App Registration -> Authentication -> Single-page application -> Redirect URIs:
#        add the Cloudflare URL. Without this, sign-in fails with AADSTS50011.
#   Neither is done by this script — 1 changes AWS infrastructure, 2 is outside AWS entirely.
#
# PREREQUISITES
#   - Cloudflare: `npx wrangler login` once (or CLOUDFLARE_API_TOKEN in the environment for CI).
#   - AWS: a valid session for the profile below, because API_BASE_URL is read from the live stack.

: "${ORG:=abc}"
: "${PROJECT:=ops-dashboard}"
: "${ENVIRONMENT:=prod}"
: "${AWS_REGION:?Missing AWS_REGION (e.g. ap-southeast-1) — same value used by infra/deploy.sh}"
# Every AWS call in this script goes through this profile. Set AWS_PROFILE explicitly when your default
# credentials point at a different account: a wrong-account query returns an EMPTY result rather than
# an error, which reads as "the stack does not exist" instead of "you are looking in the wrong place".
: "${AWS_PROFILE:=default}"
export AWS_PROFILE

# Wrangler is interactive by default and will sit waiting on a prompt forever when its output is being
# captured (which it is, below — the workers.dev URL has to be parsed out of it). Observed symptom: the
# script printed "6/6: deploying to Cloudflare" and then hung with no output at all.
#   CI=true                     -> wrangler takes the non-interactive path and never prompts
#   WRANGLER_SEND_METRICS=false -> suppresses the first-run "help us improve by sending metrics?" prompt
export CI=true
export WRANGLER_SEND_METRICS=false

STACK_NAME="${ORG}-${PROJECT}-${ENVIRONMENT}"
cd "$(dirname "$0")/.."

echo "== 1/6: reading the router URL from the CloudFormation stack outputs =="
# API_BASE_URL is NOT hardcoded and NOT passed in by hand on purpose. It is the router's Lambda
# Function URL, which changes if the function is ever replaced; baking a stale value into config.js
# produces an SPA that loads perfectly and then fails every API call with an opaque network error.
API_BASE_URL="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='RouterFunctionUrl'].OutputValue | [0]" \
  --output text)"

if [[ -z "$API_BASE_URL" || "$API_BASE_URL" == "None" ]]; then
  echo "ERROR: could not read RouterFunctionUrl from stack '$STACK_NAME' in $AWS_REGION." >&2
  echo "       If the AWS CLI reported ExpiredToken/AccessDenied above, the MFA session for profile" >&2
  echo "       '$AWS_PROFILE' has expired — re-authenticate and re-run. Do NOT work around this by" >&2
  echo "       hardcoding the URL." >&2
  exit 1
fi
echo "   API_BASE_URL = $API_BASE_URL"

echo "== 2/6: resolving the Cloudflare URL that the SPA will use as its own origin =="
# SITE_URL becomes `redirectUri` in config.js, so it must be the origin the browser is actually on.
# On workers.dev that is https://<worker>.<your-subdomain>.workers.dev, and the subdomain belongs to
# the Cloudflare account — it cannot be derived offline.
#
# Rather than make the operator do the two-pass bootstrap by hand (the way infra/deploy.sh still does
# for SITE_URL), this script discovers the URL from the account and, if that fails, falls back to
# deploying once and reading the URL out of wrangler's own output. Set CLOUDFLARE_SITE_URL explicitly
# to skip discovery entirely — for example once a custom domain is in front of it.
SITE_URL="${CLOUDFLARE_SITE_URL:-}"
SITE_URL="${SITE_URL%/}"

if [[ -z "$SITE_URL" ]]; then
  echo "   CLOUDFLARE_SITE_URL not set — discovering the workers.dev subdomain..."
  WORKER_NAME="$(grep -E '^name\s*=' frontend/wrangler.toml | head -1 | sed -E 's/.*"(.*)".*/\1/')"
  SUBDOMAIN="$(npx --yes wrangler@latest subdomain get 2>/dev/null \
    | grep -oE '[a-z0-9-]+\.workers\.dev' | head -1 | sed 's/\.workers\.dev//')" || true

  if [[ -n "${SUBDOMAIN:-}" && -n "${WORKER_NAME:-}" ]]; then
    SITE_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
    echo "   discovered: $SITE_URL"
  else
    echo "   could not read the subdomain from the account — will deploy once with a placeholder,"
    echo "   read the real URL from wrangler's output, then rebuild config.js and redeploy."
    SITE_URL="__DISCOVER_AFTER_FIRST_DEPLOY__"
  fi
fi
echo "   SITE_URL     = $SITE_URL"

echo "== 3/6: Entra ID values =="
: "${ENTRA_TENANT_ID:?Missing ENTRA_TENANT_ID (same value as infra/deploy.sh)}"
: "${ENTRA_CLIENT_ID:?Missing ENTRA_CLIENT_ID (same value as infra/deploy.sh)}"

echo "== 4/6: building shared + frontend =="
npm run build --workspace shared
npm run build --workspace frontend

echo "== 5/6: generating dist/config.js and stripping source maps =="
API_BASE_URL="$API_BASE_URL" \
SITE_URL="$SITE_URL" \
ENTRA_TENANT_ID="$ENTRA_TENANT_ID" \
ENTRA_CLIENT_ID="$ENTRA_CLIENT_ID" \
  node frontend/scripts/generate-config.mjs frontend/dist

# vite is configured with sourcemap:'hidden', so the bundles carry no sourceMappingURL comment, but the
# .map files are still written to dist. Cloudflare uploads whatever is in the assets directory, and
# these would be world-readable on the CDN — delete them so the original TypeScript is not published.
find frontend/dist -name '*.map' -type f -delete

echo "== 6/6: deploying to Cloudflare =="
# --cwd keeps wrangler.toml's relative `directory = "./dist/"` resolving against frontend/.
# Captured rather than streamed because the workers.dev URL has to be parsed back out of it below.
# Deliberately NOT `| tee /dev/stderr`: that fails with "Device or resource busy" under Git-for-Windows'
# bash, which is how this script actually gets run on the maintainer's machine.
DEPLOY_OUT="$(npx --yes wrangler@latest deploy --cwd frontend 2>&1)"
echo "$DEPLOY_OUT"

# Second pass, only when the URL had to be discovered from the deploy itself. config.js embeds
# redirectUri, so a placeholder value would make Entra reject the sign-in with AADSTS50011 — the
# frontend must be rebuilt and redeployed once the real origin is known.
if [[ "$SITE_URL" == "__DISCOVER_AFTER_FIRST_DEPLOY__" ]]; then
  DISCOVERED="$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$DEPLOY_OUT" | head -1)"
  if [[ -z "$DISCOVERED" ]]; then
    echo "ERROR: deployed, but could not find the workers.dev URL in wrangler's output." >&2
    echo "       Read it from the output above and re-run with CLOUDFLARE_SITE_URL=<that url>." >&2
    exit 1
  fi
  echo ""
  echo "== 6b/6: discovered $DISCOVERED — regenerating config.js and redeploying =="
  SITE_URL="${DISCOVERED%/}"
  API_BASE_URL="$API_BASE_URL" \
  SITE_URL="$SITE_URL" \
  ENTRA_TENANT_ID="$ENTRA_TENANT_ID" \
  ENTRA_CLIENT_ID="$ENTRA_CLIENT_ID" \
    node frontend/scripts/generate-config.mjs frontend/dist
  find frontend/dist -name '*.map' -type f -delete
  npx --yes wrangler@latest deploy --cwd frontend
fi

cat <<EOF

Done. Checklist before this URL will actually work end to end:
  [ ] Entra App Registration -> Authentication -> SPA Redirect URIs contains: $SITE_URL
  [ ] Router CORS allows it — redeploy the stack with:
        ADDITIONAL_ALLOWED_ORIGINS=$SITE_URL bash infra/deploy.sh
      (verify afterwards: the router's ALLOWED_ORIGINS env var should list BOTH origins)
  [ ] Hard-reload the page and confirm in devtools that config.js shows apiBaseUrl=$API_BASE_URL

The Lambda-hosted frontend is untouched and still serving. Once this version has been verified for a
while, the cleanup is: delete infra/static-server/, its Lambda/LogGroup/FunctionUrl/alarm resources
from infra/ops-dashboard.yaml, the copy step in infra/scripts/build-artifacts.mjs, and the parity
tests in frontend/scripts/generate-config.test.mjs.
EOF
