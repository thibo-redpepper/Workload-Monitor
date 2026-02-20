#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env/.env.local"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${WRIKE_CLIENT_ID:-}" || -z "${WRIKE_CLIENT_SECRET:-}" || -z "${WRIKE_REDIRECT_URI:-}" ]]; then
  echo "WRIKE_CLIENT_ID, WRIKE_CLIENT_SECRET en WRIKE_REDIRECT_URI moeten ingesteld zijn (shell env of .env/.env.local)." >&2
  exit 1
fi

ENC_REDIRECT="$(node -p "encodeURIComponent(process.argv[1])" "$WRIKE_REDIRECT_URI")"
AUTH_URL="https://login.wrike.com/oauth2/authorize/v4?client_id=${WRIKE_CLIENT_ID}&response_type=code&redirect_uri=${ENC_REDIRECT}"

echo
echo "1) Open deze URL in je browser en geef toestemming:"
echo "$AUTH_URL"
echo
echo "2) Plak daarna de volledige callback-URL OF alleen de code."
read -r -p "Callback URL of code: " CALLBACK_INPUT

AUTH_CODE="$CALLBACK_INPUT"
if [[ "$CALLBACK_INPUT" == *"code="* ]]; then
  AUTH_CODE="$(node -e '
const input = process.argv[1];
try {
  const u = new URL(input);
  console.log(u.searchParams.get("code") || "");
} catch {
  const q = input.split("code=")[1] || "";
  console.log((q.split("&")[0] || "").trim());
}
' "$CALLBACK_INPUT")"
fi

if [[ -z "$AUTH_CODE" ]]; then
  echo "Geen code gevonden. Probeer opnieuw." >&2
  exit 1
fi

TOKENS="$(curl -sS -X POST "https://login.wrike.com/oauth2/token" \
  --data-urlencode "client_id=$WRIKE_CLIENT_ID" \
  --data-urlencode "client_secret=$WRIKE_CLIENT_SECRET" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "redirect_uri=$WRIKE_REDIRECT_URI")"

ACCESS="$(printf '%s' "$TOKENS" | node -e 'const fs=require("fs");const t=fs.readFileSync(0,"utf8");const j=JSON.parse(t);process.stdout.write(j.access_token||"");')"
REFRESH="$(printf '%s' "$TOKENS" | node -e 'const fs=require("fs");const t=fs.readFileSync(0,"utf8");const j=JSON.parse(t);process.stdout.write(j.refresh_token||"");')"
HOST="$(printf '%s' "$TOKENS" | node -e 'const fs=require("fs");const t=fs.readFileSync(0,"utf8");const j=JSON.parse(t);process.stdout.write(j.host||"");')"

if [[ -z "$ACCESS" || -z "$REFRESH" || -z "$HOST" ]]; then
  echo "Token exchange mislukt:"
  echo "$TOKENS"
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  perl -0777 -i -pe \
    "s/^WRIKE_HOST=.*$/WRIKE_HOST=$HOST/m;
     s/^WRIKE_TOKEN=.*$/WRIKE_TOKEN=$ACCESS/m;
     s/^WRIKE_ACCESS_TOKEN=.*$/WRIKE_ACCESS_TOKEN=$ACCESS/m;
     s/^WRIKE_REFRESH_TOKEN=.*$/WRIKE_REFRESH_TOKEN=$REFRESH/m;" \
    "$ENV_FILE"
  echo
  echo "Tokens bijgewerkt in $ENV_FILE"
fi

echo
echo "Zet deze values in je secrets store:"
echo "WRIKE_HOST=$HOST"
echo "WRIKE_ACCESS_TOKEN=$ACCESS"
echo "WRIKE_REFRESH_TOKEN=$REFRESH"

echo "Testen..."
curl -sS -H "Authorization: bearer $ACCESS" \
  "https://$HOST/api/v4/contacts?me=true" \
  | node -e 'const fs=require("fs");const t=fs.readFileSync(0,"utf8");const j=JSON.parse(t);if(j.error){console.error("Auth test failed:", j.error, j.errorDescription||"");process.exit(1);}console.log("Auth OK voor:", j.data?.[0]?.firstName || "unknown");'

echo "Klaar."
