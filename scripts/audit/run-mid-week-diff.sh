#!/bin/sh
# run-mid-week-diff.sh — invoked by the audit-cron Docker service every
# Wednesday 13:00 UTC. Writes the win-rate diff against the active baseline
# to notes/audits/. Both a timestamped history file and a `latest.txt`
# overwrite are produced so the user can find the most recent without
# listing the directory.
#
# Manual run (host or container):
#   ./scripts/audit/run-mid-week-diff.sh
#
# Override the baseline:
#   BASELINE=refactors/btc-baseline-FOO.json ./scripts/audit/run-mid-week-diff.sh

set -e

BASELINE="${BASELINE:-refactors/btc-baseline-2026-05-15-pre-tf-fix.json}"
SINCE="${SINCE:-2026-05-15}"
ROOT="${ROOT:-/app}"   # /app in the container, override on host if needed
OUTPUT_DIR="$ROOT/notes/audits"
TS=$(date -u +%Y-%m-%dT%H%M%SZ)
LOG_FILE="$OUTPUT_DIR/mid-week-diff-$TS.txt"
LATEST="$OUTPUT_DIR/latest.txt"

mkdir -p "$OUTPUT_DIR"

{
  echo "=== Mid-week diff ==="
  echo "Run at:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "Baseline:  $BASELINE"
  echo "--since:   $SINCE"
  echo ""
  cd "$ROOT"
  node scripts/audit/win-rate-diff.js --diff "$BASELINE" --since "$SINCE" 2>&1
} > "$LOG_FILE"

# Atomic copy to latest
cp "$LOG_FILE" "$LATEST.tmp"
mv "$LATEST.tmp" "$LATEST"

echo "Wrote $LOG_FILE"
echo "Updated $LATEST"
