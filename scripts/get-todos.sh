#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <TEAM_ID>" >&2
  echo "Example: $0 KUATSHWP" >&2
  exit 1
fi

TEAM_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_wrike_common.sh"

ENDPOINT="/tasks?responsibles=[\"${TEAM_ID}\"]&status=Active&sortField=Importance&sortOrder=Asc"
JSON="$(wrike_get "$ENDPOINT")"

if command -v jq >/dev/null 2>&1; then
  printf "%s\n" "$JSON" | jq -r '.data[] | [.id, .title, (.dates.due // "-"), .status] | @tsv'
else
  printf "%s\n" "$JSON" | node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    const rows = (JSON.parse(input).data || []);
    for (const t of rows) {
      const due = (t.dates && t.dates.due) ? t.dates.due : "-";
      console.log([t.id || "", t.title || "", due, t.status || ""].join("\t"));
    }
  '
fi
