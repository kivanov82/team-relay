#!/usr/bin/env bash
# Build and deploy the hosted console (docs/M3-SPEC.md) to Cloud Run behind IAP. Run
# scripts/gcp-bootstrap.sh and scripts/deploy.sh first (the relay must list the console's
# service account as a read-only delegate and grant it run.invoker), and the
# gcloud-auth-refresh skill before this.
#
# Usage: bash scripts/deploy-console.sh
#        OAUTH_CLIENT_FILE=~/Downloads/client_secret_....json bash scripts/deploy-console.sh
#        OAUTH_CLIENT_ID=<id> OAUTH_CLIENT_SECRET_FILE=<file holding only the secret> \
#          bash scripts/deploy-console.sh
#
# OAUTH_CLIENT_FILE is the Web OAuth client JSON Kiril creates in the Cloud Console (the members
# are outside the project's organisation, so IAP's Google-managed client cannot admit them).
# It is read here and handed to IAP for this one service; its secret is never printed.
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
SERVICE="team-relay-console"
RELAY_SERVICE="team-relay"
TEAM="${TEAM:?set TEAM (the team id the console shows) in config/deploy.local.env}"
CONSOLE_EMAIL="team-relay-console@${PROJECT}.iam.gserviceaccount.com"
BUILDER_EMAIL="team-relay-builder@${PROJECT}.iam.gserviceaccount.com"
BUILD_BUCKET="${BUILD_BUCKET:-${PROJECT}-team-relay-build}"

TEAM_CONFIG="${TEAM_CONFIG:-config/team.local.yaml}"

if [[ -n "$(git status --porcelain -- plugin/dist plugin/Dockerfile.console plugin/cloudbuild.console.yaml)" ]]; then
  echo "error: the console bundle or its build files have uncommitted changes" >&2
  exit 1
fi
SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/team-relay-images/${SERVICE}:${SHA}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
RELAY_URL="https://${RELAY_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
IAP_AUDIENCE="${IAP_AUDIENCE:-/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE}}"

echo "Building ${IMAGE}"
gcloud builds submit \
  --project="$PROJECT" \
  --region="$REGION" \
  --service-account="projects/${PROJECT}/serviceAccounts/${BUILDER_EMAIL}" \
  --gcs-source-staging-dir="gs://${BUILD_BUCKET}/source" \
  --gcs-log-dir="gs://${BUILD_BUCKET}/logs" \
  --ignore-file=.gcloudignore.console \
  --config=plugin/cloudbuild.console.yaml \
  --substitutions="_IMAGE=${IMAGE}" .

DIGEST="$(gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT" \
  --format='value(image_summary.digest)')"

CONSOLE_ENV="^;^CONSOLE_MODE=hosted;CONSOLE_PUBLIC_HOST=${URL#https://};IAP_AUDIENCE=${IAP_AUDIENCE};RELAY_URL=${RELAY_URL};RELAY_TEAM=${TEAM};RELAY_AUTH=metadata"
if [[ -n "${JOIN_REPO_URL:-}" ]]; then
  CONSOLE_ENV="${CONSOLE_ENV};JOIN_REPO_URL=${JOIN_REPO_URL}"
fi

echo "Deploying ${SERVICE}"
gcloud beta run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="${IMAGE%:*}@${DIGEST}" \
  --service-account="$CONSOLE_EMAIL" \
  --no-allow-unauthenticated \
  --iap \
  --min-instances=0 --max-instances=2 --cpu=1 --memory=256Mi --timeout=60 \
  --update-env-vars="$CONSOLE_ENV" \
  --quiet

# IAP invokes the service as its service agent; nothing else may.
gcloud run services add-iam-policy-binding "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --member="serviceAccount:${IAP_AGENT}" --role=roles/run.invoker --quiet >/dev/null
echo "   run.invoker for the IAP service agent: set"

# Who may pass IAP: exactly the members in the team config.
WANTED="$(sed -n 's/^[[:space:]]*-[[:space:]]*"google:\([^"]*\)".*/user:\1/p' "$TEAM_CONFIG" | sort -u)"
CURRENT="$(gcloud beta iap web get-iam-policy --project="$PROJECT" --region="$REGION" \
  --resource-type=cloud-run --service="$SERVICE" \
  --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' \
  2>/dev/null | sed -n 's/^roles\/iap.httpsResourceAccessor,//p' | sort -u)"
for member in $WANTED; do
  if ! grep -qx "$member" <<<"$CURRENT"; then
    gcloud beta iap web add-iam-policy-binding --project="$PROJECT" --region="$REGION" \
      --resource-type=cloud-run --service="$SERVICE" --member="$member" \
      --role=roles/iap.httpsResourceAccessor --quiet >/dev/null
    echo "   iap access ${member}: created"
  else
    echo "   iap access ${member}: exists"
  fi
done
for member in $CURRENT; do
  if ! grep -qx "$member" <<<"$WANTED"; then
    gcloud beta iap web remove-iam-policy-binding --project="$PROJECT" --region="$REGION" \
      --resource-type=cloud-run --service="$SERVICE" --member="$member" \
      --role=roles/iap.httpsResourceAccessor --quiet >/dev/null
    echo "   iap access ${member}: removed"
  fi
done

# The custom OAuth client, on this service only.
if [[ -n "${OAUTH_CLIENT_FILE:-}" || -n "${OAUTH_CLIENT_SECRET_FILE:-}" ]]; then
  SETTINGS_DIR="$(mktemp -d)"
  chmod 700 "$SETTINGS_DIR"
  trap 'rm -rf "$SETTINGS_DIR"' EXIT
  python3 - "${OAUTH_CLIENT_FILE:-}" "$SETTINGS_DIR/iap_settings.yaml" \
      "${OAUTH_CLIENT_ID:-}" "${OAUTH_CLIENT_SECRET_FILE:-}" <<'PYEOF'
import json, os, re, sys
client_file, out_path, client_id, secret_file = sys.argv[1:5]
if client_file:
    with open(client_file, encoding="utf-8") as handle:
        web = json.load(handle).get("web") or {}
    client_id, secret = web.get("client_id"), web.get("client_secret")
else:
    with open(secret_file, encoding="utf-8") as handle:
        secret = handle.read().strip()
if not client_id or not re.fullmatch(r"[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com", client_id):
    sys.exit("error: no valid Web OAuth client id")
if not secret or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", secret):
    sys.exit("error: the secret is missing or not shaped like an OAuth client secret")
fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as out:
    out.write("access_settings:\n  oauth_settings:\n")
    out.write(f"    client_id: {json.dumps(client_id)}\n")
    out.write(f"    client_secret: {json.dumps(secret)}\n")
print(client_id)
PYEOF
  gcloud beta iap settings set "$SETTINGS_DIR/iap_settings.yaml" --project="$PROJECT" \
    --resource-type=cloud-run --region="$REGION" --service="$SERVICE" --quiet >/dev/null
  rm -rf "$SETTINGS_DIR"
  echo "   custom OAuth client: set on ${SERVICE} only"
fi

echo
echo "Deployed ${SERVICE}: ${URL}"
