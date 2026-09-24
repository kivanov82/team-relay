#!/usr/bin/env bash
# The deploy gate (M2-SPEC §6, M5-SPEC §5) against the live service:
#   no credentials, /v1/health        -> 200 (reachable: the sign-in pages must be)
#   no credentials, the API           -> the relay's own 401
#   /v1/login/start without params    -> 400
#   operator ID token on the API      -> 401 (the operator is on no roster)
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

check "unauthenticated /v1/health" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/health")"
check "unauthenticated /v1/teams/${TEAM}/me" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/teams/${TEAM}/me")"
check "bare /v1/login/start" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/login/start")"
TOKEN="$(gcloud auth print-identity-token --audiences="$URL" 2>/dev/null)"
check "operator /v1/teams/${TEAM}/me" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$URL/v1/teams/${TEAM}/me")"
unset TOKEN
exit "$fail"
