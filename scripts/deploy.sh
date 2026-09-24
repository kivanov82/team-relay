#!/usr/bin/env bash
# Build and deploy the team relay to Cloud Run (docs/M2-SPEC.md §1). Run
# scripts/gcp-bootstrap.sh once first, and the gcloud-auth-refresh skill before this.
#
# Usage: bash scripts/deploy.sh
#
# Membership lives in the relay's roster and owners change it in the console (M6-SPEC).
# config/team.local.yaml holds the teams, their seed members (at least one owner each),
# limits and delegates; after changing it, run scripts/gcp-bootstrap.sh (a new secret
# version) and then this script (a revision pinned to that version).
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
SERVICE="team-relay"
DATABASE="team-relay"
SECRET="team-relay-team-config"
RUNTIME_EMAIL="team-relay-runtime@${PROJECT}.iam.gserviceaccount.com"
BUILDER_EMAIL="team-relay-builder@${PROJECT}.iam.gserviceaccount.com"
BUILD_BUCKET="${BUILD_BUCKET:-${PROJECT}-team-relay-build}"
# gcloud's own OAuth client id: the audience of `gcloud auth print-identity-token` for a user
# account, which is how members authenticate (M2-SPEC §2).
GCLOUD_CLIENT_ID="32555940559.apps.googleusercontent.com"

TEAM_CONFIG="${TEAM_CONFIG:-config/team.local.yaml}"

if [[ -n "$(git status --porcelain -- relay schema)" ]]; then
  echo "error: relay/ or schema/ has uncommitted changes; the image is tagged by commit" >&2
  exit 1
fi
SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/team-relay-images/${SERVICE}:${SHA}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"

echo "Building ${IMAGE}"
gcloud builds submit \
  --project="$PROJECT" \
  --region="$REGION" \
  --service-account="projects/${PROJECT}/serviceAccounts/${BUILDER_EMAIL}" \
  --gcs-source-staging-dir="gs://${BUILD_BUCKET}/source" \
  --gcs-log-dir="gs://${BUILD_BUCKET}/logs" \
  --config=relay/cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" .

# The team config's current numeric version, pinned on the revision: every instance of one
# revision runs the same allowlist, and a membership change is a new secret version plus a
# redeploy (M2-SPEC §7.9), never instances drifting apart on `:latest`.
SECRET_VERSION="$(gcloud secrets versions list "$SECRET" --project="$PROJECT" \
  --filter='state:ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())')"
if [[ -z "$SECRET_VERSION" ]]; then
  echo "error: no enabled version of ${SECRET}; run scripts/gcp-bootstrap.sh" >&2
  exit 1
fi

# The digest, so the revision runs exactly what was built.
DIGEST="$(gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT" \
  --format='value(image_summary.digest)')"
IMAGE_BY_DIGEST="${IMAGE%:*}@${DIGEST}"

OAUTH_SECRET="team-relay-oauth-client"
OAUTH_VERSION="$(gcloud secrets versions list "$OAUTH_SECRET" --project="$PROJECT" \
  --filter='state:ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())')"
if [[ -z "$OAUTH_VERSION" ]]; then
  echo "error: no enabled version of ${OAUTH_SECRET}; run OAUTH_CLIENT_FILE=... scripts/gcp-bootstrap.sh" >&2
  exit 1
fi

# Reachable without Cloud Run IAM (M5-SPEC §5): the browser has to reach the sign-in pages
# before anyone is signed in. Every other endpoint authenticates in the app (a device
# credential, a Google ID token or a delegate), against the team's roster.
#
# --update-env-vars, never --set-env-vars. RELAY_AUDIENCE holds a comma, so the list uses
# gcloud's alternate delimiter syntax (^;^).
echo "Deploying ${SERVICE} (${IMAGE_BY_DIGEST}, team config v${SECRET_VERSION}, oauth v${OAUTH_VERSION})"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_BY_DIGEST" \
  --service-account="$RUNTIME_EMAIL" \
  --allow-unauthenticated \
  --min-instances=0 --max-instances=3 --cpu=1 --memory=512Mi --timeout=60 \
  --set-secrets="/secrets/team/team.yaml=${SECRET}:${SECRET_VERSION},/secrets/oauth/client.json=${OAUTH_SECRET}:${OAUTH_VERSION}" \
  --update-env-vars="^;^RELAY_AUTH_MODE=google;RELAY_AUDIENCE=${GCLOUD_CLIENT_ID},${URL};RELAY_FIRESTORE_DATABASE=${DATABASE};GOOGLE_CLOUD_PROJECT=${PROJECT};RELAY_TEAM_CONFIG=/secrets/team/team.yaml;RELAY_OAUTH_CLIENT_FILE=/secrets/oauth/client.json;RELAY_PUBLIC_URL=${URL};RELAY_HOST=0.0.0.0;APP_VERSION=${SHA}" \
  --quiet

echo
echo "Deployed ${SERVICE}: ${URL}"
echo "Members install the plugin and run /team-relay:login (relay ${URL})."
