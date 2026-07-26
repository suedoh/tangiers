# Ledger & state backups (`*.bak-*`)

Every destructive migration of a gitignored data file leaves a timestamped `.bak-*` snapshot in
the project root. Those files are **gitignored** (they contain the same trade data as
`trades.json`, up to 1.7 MB each) — which is exactly why they need a tracked index. This is it.
Anything not listed here is undocumented and should be treated as unknown provenance, not deleted
on sight.

Naming: `<file>.bak-<label>-<epochMs>` (or bare `<file>.bak-<epochMs>` when a script wrote its own
auto-backup). Verify a snapshot's identity by hash, never by filename.

## Inventory (verified 2026-07-26)

| File | Written | Records | Schema | What it is |
|---|---|---|---|---|
| `trades.json.bak-preRecompute-1785095150` | 2026-07-26 15:45 | 801 | pre-rewrite | **The one that matters.** Last state of the ledger before the spec-03 design-intent recompute. This is the rollback point for the −131.4R correction. |
| `trades.json.bak-1785095151` | 2026-07-26 15:45 | 801 | pre-rewrite | `recompute-history.js`'s own auto-backup, written 1s later. **Byte-identical** to the row above (`sha256 3c4ced18…`) — redundant. |
| `trades.json.bak-1785095172` | 2026-07-26 15:46 | 801 | post-rewrite | Post-recompute snapshot; **byte-identical to the live `trades.json`** (`sha256 427bf62a…`). Redundant while the live file is intact. |
| `trades.json.bak-invalheal-1783256251` | 2026-07-05 | 704 | pre-rewrite | Before the phantom-invalidation heal (signal-brain audit, commit `4f175b3`). |
| `trades.json.bak-rewalk-1783181890` | 2026-07-04 | 703 | pre-rewrite | Before the outcome re-walk of the same audit. |
| `trades.json.bak-executedtrack-fix` | 2026-07-02 | 679 | pre-rewrite | Before the executed-track fixes (already individually gitignored since then). |
| `trades.json.bak-execstatus-1782387224511` | 2026-06-25 | 652 | pre-rewrite | Before the `executionStatus` backfill (`scripts/blofin/backfill-execution-status.js`). |
| `poly-btc-5-trades.json.bak-1779617918` | 2026-05-24 | 3,182 | — | Before the Polymarket entry-price tracking migration (commit `dca7f35`). |
| `.trigger-state.json.bak-1779616667` | 2026-05-24 | — | — | Zone-cooldown state from the same migration. Superseded: spec 05 replaced level-identity cooldown keys with `_firedCells`, so these keys no longer mean anything to the current code. |

**Schema column:** `pre-rewrite` = legacy accounting (fictional planned-entry fills, no fees).
`post-rewrite` = design-intent accounting (`accounting: 'design-intent-v1'`, `legacy*` fields
preserved). Do not compute performance from any `pre-rewrite` snapshot — those numbers are the
measurement artifact the audit disproved (see [rebuild/README.md](../rebuild/README.md) hard rule 4).

## Retention

- **Keep indefinitely:** `trades.json.bak-preRecompute-1785095150`. It is the only rollback point
  for the ledger rewrite, and the evidence base for the +965R → −131.4R correction.
- **Safe to prune** (verified duplicates, hash-checked above): `trades.json.bak-1785095151`,
  `trades.json.bak-1785095172`. Left in place deliberately — pruning is an operator call, not a
  cleanup script's.
- **Pre-2026-07 snapshots** are historical curiosities now: they predate the ledger rewrite, so
  they cannot be diffed against anything current. Keep while disk is cheap; document before deleting.

## Rule going forward

`*.bak-*` is gitignored as a pattern. Any new snapshot gets a row in this table **in the same
commit as the migration that created it**, or the migration isn't done.
