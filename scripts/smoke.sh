#!/usr/bin/env bash
# The deploy gate (M2-SPEC §6) against the live service, as the operator:
#   no credentials            -> Cloud Run's 403 (IAM invoker in front)
#   operator ID token /health -> 200 (the operator can invoke; health needs no member)
#   operator ID token on API  -> the relay's 401 (the operator is not on the allowlist)
# The token lives in a variable for the one curl and is never printed.
set -euo pipefail

# Deployment settings come from config/deploy.local.env (git-ignored; copy
# config/deploy.example.env) or the environment. Nothing about a particular project is
# hardcoded here.
cd "$(dirname "$0")/.."
if [[ -f config/deploy.local.env ]]; then
  # shellcheck disable=SC1091
  source config/deploy.local.env
fi
PROJECT="${PROJECT:?set PROJECT in config/deploy.local.env or the environment}"
REGION="${REGION:-europe-west3}"
TEAM="${TEAM:?set TEAM in config/deploy.local.env}"
URL="$(gcloud run services describe team-relay --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)')"

fail=0
check() {  # $1 label, $2 expected, $3 actual
  if [[ "$2" == "$3" ]]; then echo "ok    $1: $3"; else echo "FAIL  $1: expected $2, got $3"; fail=1; fi
}

check "unauthenticated /v1/health" 403 "$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/health")"
TOKEN="$(gcloud auth print-identity-token --audiences="$URL" 2>/dev/null)"
check "operator /v1/health" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$URL/v1/health")"
check "operator /v1/teams/${TEAM}/me" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$URL/v1/teams/${TEAM}/me")"
unset TOKEN
exit "$fail"
