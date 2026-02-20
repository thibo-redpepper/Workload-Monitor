#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${WRIKE_HOST:-}" ]]; then
  echo "WRIKE_HOST is empty in $ENV_FILE" >&2
  exit 1
fi

if [[ -z "${WRIKE_ACCESS_TOKEN:-}" ]]; then
  echo "WRIKE_ACCESS_TOKEN is empty in $ENV_FILE" >&2
  exit 1
fi

WRIKE_API_BASE="https://${WRIKE_HOST}/api/v4"

wrike_get() {
  local endpoint="$1"
  curl -sS -g \
    -H "Authorization: bearer ${WRIKE_ACCESS_TOKEN}" \
    "${WRIKE_API_BASE}${endpoint}"
}
