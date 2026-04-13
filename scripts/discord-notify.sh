#!/bin/bash
# Discord webhook notification script
# Usage: ./discord-notify.sh <type> <message>
#
# Types:
#   approaching  ⚠️  yellow  — price nearing a zone, full analysis incoming
#   long         🟢  green   — confirmed long setup with trade plan
#   short        🔴  red     — confirmed short setup with trade plan
#   info         📊  blue    — general status / no setup found
#   error        ❌  dark red — system error with fix instructions

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [[ -z "${DISCORD_WEBHOOK_URL:-}" ]]; then
  echo "ERROR: DISCORD_WEBHOOK_URL not set in .env" >&2
  exit 1
fi

ALERT_TYPE="${1:-info}"
MESSAGE="${2:-}"

if [[ -z "$MESSAGE" ]]; then
  echo "ERROR: No message provided" >&2
  echo "Usage: $0 <type> <message>" >&2
  exit 1
fi

case "$ALERT_TYPE" in
  approaching)
    COLOR=16776960    # yellow
    ;;
  long)
    COLOR=5763719     # green
    ;;
  short)
    COLOR=15548997    # red
    ;;
  error)
    COLOR=10038562    # dark red
    ;;
  info)
    COLOR=3447003     # blue
    ;;
  *)
    COLOR=3447003
    ;;
esac

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Escape message for JSON — replace special chars that break the payload
SAFE_MESSAGE=$(printf '%s' "$MESSAGE" | python3 -c "
import sys, json
msg = sys.stdin.read()
print(json.dumps(msg)[1:-1])
")

PAYLOAD=$(cat <<EOF
{
  "embeds": [{
    "description": "${SAFE_MESSAGE}",
    "color": ${COLOR},
    "footer": {
      "text": "Ace \u2022 BINANCE:BTCUSDT.P \u2022 $(date -u '+%H:%M UTC')"
    },
    "timestamp": "${TIMESTAMP}"
  }]
}
EOF
)

HTTP_STATUS=$(curl -s -o /tmp/discord_response.txt -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$DISCORD_WEBHOOK_URL")

if [[ "$HTTP_STATUS" == "204" ]]; then
  echo "Discord notification sent [${ALERT_TYPE}]"
else
  echo "ERROR: Discord webhook returned HTTP $HTTP_STATUS" >&2
  cat /tmp/discord_response.txt >&2
  exit 1
fi
