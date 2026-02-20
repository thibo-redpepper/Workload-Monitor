#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_wrike_common.sh"

JSON="$(wrike_get "/contacts")"

if command -v jq >/dev/null 2>&1; then
  printf "%s\n" "$JSON" | jq -r '.data[] | [.id, .firstName, .lastName, (.primaryEmail // "")] | @tsv'
else
  printf "%s\n" "$JSON" | node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    const rows = (JSON.parse(input).data || []);
    for (const c of rows) {
      console.log([c.id || "", c.firstName || "", c.lastName || "", c.primaryEmail || ""].join("\t"));
    }
  '
fi
