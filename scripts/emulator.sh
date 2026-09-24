#!/usr/bin/env bash
# Start or stop a local Firestore emulator in Docker, bound to 127.0.0.1 only.
#
#   scripts/emulator.sh start [port] [name]   # prints the FIRESTORE_EMULATOR_HOST value on stdout
#   scripts/emulator.sh stop  [name]
#
# Defaults: port 8681, container name ma-firestore-emulator. Progress goes to stderr, so
#   export FIRESTORE_EMULATOR_HOST="$(scripts/emulator.sh start 8681 ma-fs-test)"
# works. The image is pinned by digest (google-cloud-cli:emulators); bump it on purpose.
set -euo pipefail

IMAGE="gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:7617d937e9360d769de4ef66266a8caae503c1dbbd050c93404d3f30045c5125"
LABEL="multiagent.emulator=firestore"
DEFAULT_NAME="ma-firestore-emulator"
DEFAULT_PORT=8681
WAIT_SECONDS=90

usage() {
  echo "usage: $0 start [port] [name] | stop [name]" >&2
  exit 2
}

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]]; }

# Removes the named container only if this script started it (it carries our label).
remove_ours() {
  local name="$1" label
  if ! label="$(docker inspect --format '{{ index .Config.Labels "multiagent.emulator" }}' "$name" 2>/dev/null)"; then
    return 0
  fi
  if [[ "$label" != "firestore" ]]; then
    echo "emulator: container '$name' exists and was not started by this script; refusing to touch it" >&2
    exit 1
  fi
  docker rm -f "$name" >/dev/null
}

cmd="${1:-}"
case "$cmd" in
  start)
    port="${2:-$DEFAULT_PORT}"
    name="${3:-$DEFAULT_NAME}"
    [[ "$port" =~ ^[0-9]{2,5}$ ]] && (( port >= 1024 && port <= 65535 )) || { echo "emulator: bad port '$port'" >&2; exit 2; }
    valid_name "$name" || { echo "emulator: bad container name '$name'" >&2; exit 2; }
    remove_ours "$name"
    docker run -d --rm --name "$name" --label "$LABEL" \
      -p "127.0.0.1:${port}:${port}" \
      "$IMAGE" \
      gcloud emulators firestore start "--host-port=0.0.0.0:${port}" >/dev/null
    echo "emulator: waiting for Firestore on 127.0.0.1:${port} (container $name)" >&2
    for _ in $(seq 1 "$WAIT_SECONDS"); do
      if [[ "$(curl -s --max-time 2 "http://127.0.0.1:${port}" || true)" == Ok* ]]; then
        echo "emulator: ready" >&2
        echo "127.0.0.1:${port}"
        exit 0
      fi
      if ! docker inspect "$name" >/dev/null 2>&1; then
        echo "emulator: container '$name' exited before becoming ready" >&2
        exit 1
      fi
      sleep 1
    done
    echo "emulator: not ready after ${WAIT_SECONDS}s; logs follow" >&2
    docker logs "$name" >&2 || true
    docker rm -f "$name" >/dev/null 2>&1 || true
    exit 1
    ;;
  stop)
    name="${2:-$DEFAULT_NAME}"
    valid_name "$name" || { echo "emulator: bad container name '$name'" >&2; exit 2; }
    remove_ours "$name"
    echo "emulator: stopped $name" >&2
    ;;
  *)
    usage
    ;;
esac
