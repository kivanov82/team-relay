#!/usr/bin/env bash
# Build and deploy the team relay to Cloud Run (docs/M2-SPEC.md §1). Run
# scripts/gcp-bootstrap.sh once first, and the gcloud-auth-refresh skill before this.
#
# Usage: bash scripts/deploy.sh
#
# Changing membership: edit config/team.local.yaml, run scripts/gcp-bootstrap.sh (it adds a
# secret version when the file changed), then this script (a revision pinned to that version,
# and the invoker bindings reconciled to exactly the members in the file).
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

# --update-env-vars, never --set-env-vars. RELAY_AUDIENCE holds a comma, so the list uses
# gcloud's alternate delimiter syntax (^;^).
echo "Deploying ${SERVICE} (${IMAGE_BY_DIGEST}, team config v${SECRET_VERSION})"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_BY_DIGEST" \
  --service-account="$RUNTIME_EMAIL" \
  --no-allow-unauthenticated \
  --min-instances=0 --max-instances=3 --cpu=1 --memory=512Mi --timeout=60 \
  --set-secrets="/secrets/team/team.yaml=${SECRET}:${SECRET_VERSION}" \
  --update-env-vars="^;^RELAY_AUTH_MODE=google;RELAY_AUDIENCE=${GCLOUD_CLIENT_ID},${URL};RELAY_FIRESTORE_DATABASE=${DATABASE};GOOGLE_CLOUD_PROJECT=${PROJECT};RELAY_TEAM_CONFIG=/secrets/team/team.yaml;RELAY_HOST=0.0.0.0;APP_VERSION=${SHA}" \
  --quiet

# Invokers: exactly the Google principals in the team config. Cloud Run IAM is the outer
# gate; the relay's allowlist still decides who a caller is.
# Members are users; read-only delegates (M3-SPEC §2, the hosted console) are service
# accounts and need to reach the relay too.
WANTED="$( {
  sed -n 's/^[[:space:]]*-[[:space:]]*"google:\([^"]*\)".*/user:\1/p' "$TEAM_CONFIG"
  sed -n 's/^[[:space:]]*-\{0,1\}[[:space:]]*principal:[[:space:]]*"google:\([^"]*\.gserviceaccount\.com\)".*/serviceAccount:\1/p' "$TEAM_CONFIG"
} | sort -u)"
CURRENT="$(gcloud run services get-iam-policy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' \
  | sed -n 's/^roles\/run.invoker,//p' | sort -u)"
for member in $WANTED; do
  if grep -qx "$member" <<<"$CURRENT"; then
    echo "   invoker ${member}: exists"
  else
    gcloud run services add-iam-policy-binding "$SERVICE" --project="$PROJECT" --region="$REGION" \
      --member="$member" --role=roles/run.invoker --quiet >/dev/null
    echo "   invoker ${member}: created"
  fi
done
for member in $CURRENT; do
  if ! grep -qx "$member" <<<"$WANTED"; then
    gcloud run services remove-iam-policy-binding "$SERVICE" --project="$PROJECT" \
      --region="$REGION" --member="$member" --role=roles/run.invoker --quiet >/dev/null
    echo "   invoker ${member}: removed"
  fi
done

echo
echo "Deployed ${SERVICE}: ${URL}"
echo "Members connect with RELAY_URL=${URL} RELAY_TEAM=<your team id> RELAY_AUTH=google"
