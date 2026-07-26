# Spec 08 — Execution layer changes (rebuild)

**Files:** `scripts/lib/blofin-autotrade.js`, `scripts/blofin/postonly-probe.js` (new),
`scripts/tests/governance.test.js` (extended), `.env.example`, `Makefile`
**Audit refs:** §8b, D3, D9, R14. Spec: `rebuild/08-execution-layer.md`.
KEEP list (SL verify-or-flatten, fill-fetch, risk trim, idempotency, spool) untouched.

## What changed

1. **Flat risk sizing — tierMult removed entirely.** `TIER_MULT`/`tierKey` deleted;
   `sizingFor({entry, stop, equity})` = `equity × RISK_PER_TRADE_PCT / |entry − stop|`.
   Tier ranking flips between accountings (audit §5); tiers return only if spec 07
   re-derives them. Source-scan assert in the test pins `tierMult` absent from the module.
   (`setupType` still accepted in the payload for compat; it no longer affects anything.)
2. **Equity marked to live balance** (`resolveEquity`): one balance read at entry time;
   `equity = min(cash + frozen, ACCOUNT_EQUITY_USD)`. The env var is now a *cap* so a demo
   top-up can't silently double risk (R14). Failed read → cap (fail-open; money path never
   blocks on a balance read). The same single read feeds spec 02's margin cap and the
   preflight trim — one fetch, three consumers.
3. **`confirmedPrice` basis (Agent-A interface contract).** New optional signal-payload
   field: the confirming 30M close. When present it is the sizing basis, the fill-fetch
   fallback, and the planned stop distance (`|confirmedPrice − stop|`) — so the event the
   exchange trades is the event the corrected ledger scores (D9). Absent → plan entry
   (probes/manual calls unchanged). trigger-check.js is Agent A's file; not touched here.
4. **Fee-in-R** (`computeFeeR`): measured schedule — 6bp taker entry & stop, 2bp maker TP
   rungs, exit legs weighted by rung size × price. Two paths reported (a trade pays exactly
   one): `tpPathR` (entry taker + Σ rung maker) and `stopPathR` (entry taker + stop taker).
   Returned on the result object (`feeR`, for Agent A's signal post) and printed on the new
   execution-layer Discord trade post to `#blofin-recon` (fill, size, SL/TPs, equity basis,
   fee-in-R). Cost visibility is permanent.
5. **TP structure unchanged** — 3-rung ladder + burned-rung repricing stays exactly as
   built. Single-TP/2-rung geometry belongs to spec 07's validated candidate; no
   improvisation between validation and execution.
6. **Falsification kill-file (Agent-C interface contract):** `.autotrade-disabled.json` at
   repo root (path exported as `KILL_FILE`) ⇒ every entry skips with detail exactly
   `falsification gate tripped` (`executionStatus='skipped'` via the existing caller
   tagging) + red rate-limited alert naming the file. Delete the file to re-arm.

## post_only — probed status

`scripts/blofin/postonly-probe.js` is written and gated (`--confirm`; exit 2 otherwise):
far-from-touch post-only must rest; crossing post-only documents actual behavior
(reject / accepted-then-cancelled / SILENT TAKER — the dangerous case, auto-flattened);
cancel path verified. It bypasses `lib/blofin.placeOrder` with a raw signed request so the
server sees exactly `orderType:'post_only'`, and reports if the enum itself is rejected.
**PENDING MARGIN UNLOCK — not run.** Maker-entry mode is explicitly deferred until the
probe report exists (spec 08 acceptance 4); no maker-entry code was written.

## Verification

- `node scripts/tests/governance.test.js` — passes: flat-sizing math, equity min() (live
  800→16 contracts, live 5000→capped 30), confirmedPrice basis proven via captured order
  size (7.5 vs 15 contracts), computeFeeR against hand-computed numbers
  (entry $1.8 / TP exit $0.607 / stop exit $1.791 on a 30-contract, $15-risk trade →
  0.160R TP path, 0.239R stop path), kill-file trip + re-arm, plus all spec 02 asserts.
- `node scripts/blofin/governance-probe.js` — 14 assertions incl. kill-file scenario.
- **PENDING MARGIN UNLOCK:** postonly probe run; `make blofin-probe` /
  `blofin-autotrade-probe` / `blofin-sl-probe` / `blofin-degraded-probe` regression runs;
  end-to-end demo trade (acceptance 3). No orders were placed, cancelled, or modified in
  this session — the operator is deciding the live book's fate.

## Notes

- At the audit's cost model this fee print will show ≈0.2R+ per trade at current stop
  geometry — that is the point (D3: costs exceed measured gross edge ~30×). Expect the
  numbers to look bad; they are true.
- Live-firing on a real signal remains gated on specs 07 + 09; everything here sits behind
  `BLOFIN_AUTOTRADE` exactly as before.
