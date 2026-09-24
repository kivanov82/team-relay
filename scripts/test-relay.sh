#!/usr/bin/env bash
# Run the relay's whole test suite, the Firestore half included, against a throwaway
# Firestore emulator (Docker, 127.0.0.1:8681, container ma-fs-test). The emulator is
# stopped on any exit. Extra arguments are passed to pytest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8681
NAME=ma-fs-test

cleanup() { "$ROOT/scripts/emulator.sh" stop "$NAME" || true; }
trap cleanup EXIT

host="$("$ROOT/scripts/emulator.sh" start "$PORT" "$NAME")"

cd "$ROOT/relay"
PYTHON="${PYTHON:-$ROOT/relay/.venv/bin/python}"
FIRESTORE_EMULATOR_HOST="$host" GOOGLE_CLOUD_PROJECT=demo-relay \
  "$PYTHON" -m pytest -q "$@"
