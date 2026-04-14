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
PAUSE_FILE="$SCRIPT_DIR/../.discord-paused"

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

# ─── Pause gate ──────────────────────────────────────────────────────────────
# If .discord-paused exists, swallow all messages silently.
# Use !start in Discord to resume.
if [[ -f "$PAUSE_FILE" ]]; then
  echo "Discord notifications paused — message suppressed [${ALERT_TYPE}]"
  exit 0
fi

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

# Append ?wait=true so Discord returns the full message object (with ID)
WEBHOOK_URL="${DISCORD_WEBHOOK_URL}?wait=true"

HTTP_STATUS=$(curl -s -o /tmp/discord_response.txt -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$WEBHOOK_URL")

if [[ "$HTTP_STATUS" == "200" ]]; then
  # Extract and echo message ID — callers can capture this for reaction polling
  MSG_ID=$(python3 -c "import sys,json; d=json.load(open('/tmp/discord_response.txt')); print(d.get('id',''))" 2>/dev/null || true)
  echo "Discord notification sent [${ALERT_TYPE}] id=${MSG_ID}"
  # Print ID on its own line so callers can parse it unambiguously
  if [[ -n "$MSG_ID" ]]; then echo "MSG_ID:${MSG_ID}"; fi
else
  echo "ERROR: Discord webhook returned HTTP $HTTP_STATUS" >&2
  cat /tmp/discord_response.txt >&2
  exit 1
fi
