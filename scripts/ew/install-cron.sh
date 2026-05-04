#!/bin/bash
# scripts/ew/install-cron.sh — install all six EW cron entries
# Idempotent: re-running is safe; existing entries are detected by script path
# and skipped. Errors out if any single entry fails to install.

set -euo pipefail

NODE="${NODE:-$(which node)}"
TRADING="${TRADING:-$(cd "$(dirname "$0")/../.." && pwd)}"
NODEDIR="$(dirname "$NODE")"
PATH_PREFIX="$NODEDIR:/usr/local/bin:/usr/bin:/bin"

LOGDIR="$TRADING/logs"
mkdir -p "$LOGDIR"

# Each entry: schedule | script | log | description
ENTRIES=(
  "5 0,4,8,12,16,20 * * *|scripts/ew/run.js|ew-run.log|EW run (6x/day at 4H bar close +5min)"
  "10 0,4,8,12,16,20 * * *|scripts/ew/backtest.js|ew-backtest.log|EW backtest (6x/day +5min after run)"
  "55 23 * * *|scripts/ew/daily-summary.js|ew-summary.log|EW daily summary (23:55 UTC)"
  "15 12 * * *|scripts/ew/daily-brief.js|ew-brief.log|EW daily brief (12:15 UTC)"
  "0 22 * * 0|scripts/ew/weekly-outlook.js|ew-outlook.log|EW weekly outlook (Sunday 22:00 UTC)"
  "0 14 1 * *|scripts/ew/monthly-review.js|ew-review.log|EW monthly review (1st of month 14:00 UTC)"
)

# Snapshot existing crontab (if any)
EXISTING="$(crontab -l 2>/dev/null || true)"

# Build the new crontab in a tmp file so we only call `crontab` once.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

printf '%s\n' "$EXISTING" > "$TMP"

ADDED=0
for entry in "${ENTRIES[@]}"; do
  SCHEDULE="$(echo "$entry" | cut -d'|' -f1)"
  SCRIPT="$(echo   "$entry" | cut -d'|' -f2)"
  LOG="$(echo      "$entry" | cut -d'|' -f3)"
  DESC="$(echo     "$entry" | cut -d'|' -f4)"

  if echo "$EXISTING" | grep -Fq "$SCRIPT"; then
    echo "[skip] $DESC -- already installed"
    continue
  fi

  CRON_LINE="$SCHEDULE PATH=$PATH_PREFIX $NODE $TRADING/$SCRIPT >> $TRADING/logs/$LOG 2>&1"
  COMMENT="# $DESC"

  printf '\n%s\n%s\n' "$COMMENT" "$CRON_LINE" >> "$TMP"
  ADDED=$((ADDED + 1))
  echo "[add ] $DESC"
done

if [ "$ADDED" -eq 0 ]; then
  echo "All six EW entries already installed -- nothing to do."
  exit 0
fi

# Validate by piping the candidate crontab through `crontab -` and checking
# the exit code. crontab will refuse to install on parse error.
if ! crontab "$TMP"; then
  echo "ERROR: crontab refused the new file. Your existing crontab is unchanged."
  echo "Inspect the candidate file at: $TMP (it will be removed on exit unless you copy it now)"
  exit 1
fi

echo "Installed $ADDED EW cron entries. Run 'crontab -l' to verify."
