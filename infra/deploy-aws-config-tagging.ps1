<#
.SYNOPSIS
  Deploys infra/aws-config-tagging.yaml - AWS Config (scoped resource types, DAILY/periodic
  recording) + the REQUIRED_TAGS managed rule. Independent stack from ops-dashboard.yaml (see that
  template's own header comment) - this is account-level governance/tagging-enforcement
  infrastructure, deployed/updated/torn down on its own.

.USAGE
  Validate only (no deploy):
    ./deploy-aws-config-tagging.ps1 -ValidateOnly

  Deploy:
    ./deploy-aws-config-tagging.ps1

.REQUIRES
  AWS CLI configured with a profile allowed to deploy CloudFormation/AWS Config/IAM/S3 (pass it with -Profile).
#>

[CmdletBinding()]
param(
  [switch]$ValidateOnly,
  [string]$Profile = 'default',
  [string]$Region = 'ap-southeast-1',
  [string]$Org = 'abc',
  [string]$Project = 'ops-dashboard',
  [string]$Environment = 'prod'
)

$ErrorActionPreference = 'Stop'
$templatePath = Join-Path $PSScriptRoot 'aws-config-tagging.yaml'
$stackName = "$Org-$Project-$Environment-config-tagging"

Write-Host "=== AWS Config tagging-enforcement stack - profile=$Profile region=$Region stack=$stackName ===" -ForegroundColor Cyan

Write-Host "Validating template..."
aws cloudformation validate-template --profile $Profile --region $Region --template-body "file://$templatePath" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Template validation failed" }
Write-Host "Template is valid." -ForegroundColor Green

if ($ValidateOnly) {
  Write-Host "ValidateOnly set - stopping here without deploying."
  return
}

Write-Host "Deploying stack (this creates AWS Config + an S3 bucket + IAM role - see the template's cost-note comment for expected AWS Config charges)..."
aws cloudformation deploy `
  --profile $Profile --region $Region `
  --template-file $templatePath `
  --stack-name $stackName `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides Org=$Org Project=$Project Environment=$Environment
if ($LASTEXITCODE -ne 0) { throw "Stack deploy failed" }

Write-Host ""
Write-Host "=== Outputs ===" -ForegroundColor Cyan
aws cloudformation describe-stacks --profile $Profile --region $Region --stack-name $stackName --query 'Stacks[0].Outputs' --output table
