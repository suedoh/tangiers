# notes/

Operational notes, weekly plans, and audit outputs. Different from `refactors/` (decision records) and `docs/` (system documentation). Things here are running guidance and time-stamped artifacts.

## Structure

| Path | What |
|---|---|
| `notes/YYYY-MM-DD-<scope>-<slug>.md` | Weekly plans, ad-hoc operational notes |
| `notes/audits/latest.txt` | Most recent automated diff output (overwritten each run) |
| `notes/audits/mid-week-diff-<ts>.txt` | Per-run history of mid-week diff cron output |

## The mid-week diff cron

A Docker service (`ace_audit_cron`, defined in `docker-compose.yml`) runs **every Wednesday at 13:00 UTC** and executes:

```bash
node scripts/audit/win-rate-diff.js \
  --diff refactors/btc-baseline-2026-05-15-pre-tf-fix.json \
  --since 2026-05-15
```

Output writes to both `notes/audits/latest.txt` (overwrite) and `notes/audits/mid-week-diff-<utc-timestamp>.txt` (append-only history).

### Manual run

```bash
docker compose exec audit-cron /app/scripts/audit/run-mid-week-diff.sh
```

Or run on the host:

```bash
cd ~/trading
node scripts/audit/win-rate-diff.js --diff refactors/btc-baseline-2026-05-15-pre-tf-fix.json --since 2026-05-15
```

### Future analysis

For any future Claude session asked to "review the BTC week" or "look at how the strategy performed":
1. Read `notes/audits/latest.txt` first — it has the current diff state.
2. Look at `notes/audits/mid-week-diff-*.txt` ordered by timestamp for the historical sequence.
3. The active week plan is the most recent `notes/YYYY-MM-DD-btc-week-plan.md`.

## What's gitignored

- `notes/audits/*.txt` — generated data, local-only. The `README.md` and weekly-plan markdowns ARE committed.
