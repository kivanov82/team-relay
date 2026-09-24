#!/usr/bin/env bash
# The M1 end-to-end gate (docs/M1-SPEC.md §9), and the plugin side of the M2 scenarios
# (docs/M2-SPEC.md §6) when the relay serves them. Starts a throwaway Firestore emulator
# (Docker, 127.0.0.1:8682, container ma-fs-e2e), writes a throwaway team config for team
# "demo" (alice, bob, carol, each with a fresh random static token stored only as its
# SHA-256), starts the relay on a free 127.0.0.1 port with RELAY_AUTH_MODE=static, builds
# the plugin bundles, runs the e2e vitest suite, and tears everything down on any exit.
# The M2 scenarios (test/e2e/m2.test.ts) run only when the relay answers GET /v1/health and
# GET /v1/teams/demo/activity; otherwise they are skipped and this script says so. They
# include M4 (docs/M4-SPEC.md §2, §3): a permission request's `waiting` tool event shows on
# the activity feed and the next event for that tool follows it, and the answering channel's
# shared folder names come back in the directory.
# Extra arguments are passed to vitest. The tokens are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMULATOR_PORT=8682
EMULATOR_NAME=ma-fs-e2e
PYTHON="${PYTHON:-$ROOT/relay/.venv/bin/python}"
STARTED=$SECONDS

WORK=""
RELAY_PID=""
EMULATOR_STARTED=0

cleanup() {
  local status=$?
  set +e
  if [[ -n "$RELAY_PID" ]] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill -TERM "$RELAY_PID" 2>/dev/null
    for _ in $(seq 1 50); do
      kill -0 "$RELAY_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$RELAY_PID" 2>/dev/null
    wait "$RELAY_PID" 2>/dev/null
  fi
  if [[ "$status" -ne 0 && -n "$WORK" && -s "$WORK/relay.log" ]]; then
    # The relay logs no tokens (M1-SPEC §2); its log helps with a failure.
    echo "e2e: last lines of the relay log:" >&2
    tail -n 40 "$WORK/relay.log" >&2
  fi
  if [[ "$EMULATOR_STARTED" -eq 1 ]]; then
    "$ROOT/scripts/emulator.sh" stop "$EMULATOR_NAME" || true
  fi
  if [[ -n "$WORK" ]]; then
    rm -rf "$WORK"
  fi
  echo "e2e: $([[ "$status" -eq 0 ]] && echo passed || echo FAILED) in $((SECONDS - STARTED)) s" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for tool in docker openssl curl pnpm; do
  command -v "$tool" >/dev/null || { echo "e2e: $tool is required" >&2; exit 1; }
done
[[ -x "$PYTHON" ]] || { echo "e2e: no relay venv at $PYTHON (see relay/README.md)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ma-e2e.XXXXXX")"
chmod 700 "$WORK"

# Throwaway identities: a random token per member, only its hash goes into the config.
new_token() { openssl rand -hex 24; }
sha256() { printf %s "$1" | openssl dgst -sha256 -r | cut -d' ' -f1; }
TOKEN_ALICE="$(new_token)"
TOKEN_BOB="$(new_token)"
TOKEN_CAROL="$(new_token)"
cat >"$WORK/team.yaml" <<EOF
teams:
  - id: demo
    members:
      - id: alice
        principals: ["token:sha256:$(sha256 "$TOKEN_ALICE")"]
      - id: bob
        principals: ["token:sha256:$(sha256 "$TOKEN_BOB")"]
      - id: carol
        principals: ["token:sha256:$(sha256 "$TOKEN_CAROL")"]
limits:
  min_ack_timeout_seconds: 2
  min_answer_timeout_seconds: 2
  # The M2 scenarios poll /activity and /directory in tight loops (M2-SPEC §7.3's budget is
  # 120 a minute by default; the relay allows up to 10000).
  reads_per_minute: 10000
EOF

EMULATOR_STARTED=1
FIRESTORE_HOST="$("$ROOT/scripts/emulator.sh" start "$EMULATOR_PORT" "$EMULATOR_NAME")"

RELAY_PORT="$("$PYTHON" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
RELAY_URL="http://127.0.0.1:${RELAY_PORT}"

# The tokens are shell variables, not exported, so the relay's environment never holds them.
(
  cd "$ROOT/relay"
  exec env -u K_SERVICE \
    RELAY_AUTH_MODE=static \
    RELAY_TEAM_CONFIG="$WORK/team.yaml" \
    RELAY_HOST=127.0.0.1 \
    PORT="$RELAY_PORT" \
    FIRESTORE_EMULATOR_HOST="$FIRESTORE_HOST" \
    GOOGLE_CLOUD_PROJECT=demo-e2e \
    RELAY_LOG_LEVEL=warning \
    "$PYTHON" -m relay
) >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!

echo "e2e: waiting for the relay on $RELAY_URL" >&2
ready=0
for _ in $(seq 1 150); do
  if [[ "$(curl -s --max-time 2 "$RELAY_URL/healthz" || true)" == '{"ok":true}' ]]; then
    ready=1
    break
  fi
  kill -0 "$RELAY_PID" 2>/dev/null || { echo "e2e: the relay exited during startup" >&2; exit 1; }
  sleep 0.2
done
[[ "$ready" -eq 1 ]] || { echo "e2e: the relay did not become ready" >&2; exit 1; }
echo "e2e: relay ready" >&2

# Does the relay serve M2 (docs/M2-SPEC.md §1 /v1/health, §3.5 /activity)? The probe's bearer
# header goes through a mode-600 file, never the command line.
E2E_M2=0
health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$RELAY_URL/v1/health" || true)"
printf 'Authorization: Bearer %s\n' "$TOKEN_ALICE" >"$WORK/probe.header"
chmod 600 "$WORK/probe.header"
activity="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H @"$WORK/probe.header" "$RELAY_URL/v1/teams/demo/activity?limit=1" || true)"
rm -f "$WORK/probe.header"
if [[ "$health" == "200" && "$activity" == "200" ]]; then
  E2E_M2=1
  echo "e2e: the relay serves /v1/health and /activity: running the M1 and M2 scenarios" >&2
else
  echo "e2e: SKIPPING the M2 scenarios: the relay does not serve them yet (GET /v1/health: $health, GET /activity: $activity); running the M1 scenarios only" >&2
fi

pnpm -C "$ROOT/plugin" build

export RELAY_URL E2E=1 E2E_M2
export E2E_TOKEN_ALICE="$TOKEN_ALICE" E2E_TOKEN_BOB="$TOKEN_BOB" E2E_TOKEN_CAROL="$TOKEN_CAROL"
pnpm -C "$ROOT/plugin" test:e2e "$@"
