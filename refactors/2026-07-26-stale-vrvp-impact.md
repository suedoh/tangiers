# 2026-07-26 — Stale-VRVP-rows impact quantification (spec 06 item 1)

**Question:** how many historical BTC signals fired on stale/blind VRVP rows?
**Data:** parity sidecar `logs/zone-parity.jsonl` (1,984 cycles, 2026-07-12T11:22 →
2026-07-26T18:40, 14.3d) + a scratch copy of `trades.json` (801 signals, 2026-04-13 →
2026-07-26). Analysis read-only; live files untouched.

## Headline

**Staleness is chronic, not episodic.** In every one of the 1,689 measurable cycles the
histogram rows disagreed with the study's own fresh data store by more than one row (34.7 pts):
median Δ **2.05% of price**, p95 6.3%, and >2% in 57.7% of cycles. The rows-POC the production
brain uses has not matched the chart's own developing POC once in 14.3 days.

- **Blind cycles: 295/1,984 = 14.9%** (VRVP read null → `checkVRVPProximity` returns null).
  Structural consequence: blind cycles produce *missed* polls, never bad signals.
- **Covered window (14.3d): 79 signals fired, 78 joined to their cycle (±6 min).**
  - **8 were HVN signals — every one fired on measurably stale rows** (Δ 1.28–2.94% of price):
    `1784080210802-HVN-64351, 1784685020353-HVN-66299, 1784690420328-HVN-66196,
    1784691622129-HVN-66196, 1784692219887-HVN-66299, 1784693413080-HVN-66299,
    1784736613616-HVN-65966, 1784742039803-HVN-65979` — ΣpnlR +4.3R (claimed accounting).
  - The other 70 were VAL/VAH signals: trigger level comes from the fresh store, **but their
    TP1/TP2 targets are HVN clusters built from the same stale rows** — every signal's payoff
    geometry rode stale volume structure even when its trigger didn't.

## All-history bound (pre-sidecar staleness is unmeasurable)

`computeVRVPLevels` takes POC + all HVN/LVN zones from the rows; VAH/VAL from the store. The
row-derived (exposed) population over all 801 signals: **HVN 274 = 34.2% of the book,
+244.2R claimed** (POC signals: 0; VAL 311 / VAH 212 / unknown 4). Render-layer state was not
logged before 2026-07-12, so *directly* attributing staleness to those 274 is **insufficient
evidence** — but with staleness at 100% of measured cycles across the entire window, there is
no support for assuming the rows were ever fresh. Treat the full HVN cohort (and all TP
ladders) as measured-on-unstable-input in spec-07 research.

## Parity gate status (pre-cutover, 14.3d accumulated)

`evaluateGate` verdict **FAIL** as written: POC median Δ 1.99% (vs stale rows), VAH 0.42%,
VAL 0.42%, trigger agreement 34.0%, CVD-sign 64.4%, OI-trend 86.7%. The tell:
**mkt-vs-`pocFresh` median is 0.202%** — 10× tighter — so most POC disagreement is TV's own
stale rows, not a methodology gap; VAH/VAL residue is viewport drift (visible range ≠ frozen
14d window). Conclusion unchanged from the plan: the TV feed cannot pass its own gate; cutover
to the frozen native window (14d/5m/34.7, `config/btc-zones.json`) removes the class.

## Spot check — 10 cycles spread across the window (tv vs native)

| ts (UTC) | price | tv POC(rows) | tv POC(store) | tv VAH | tv VAL | mkt POC | mkt VAH | mkt VAL | tv trig | mkt trig |
|---|---|---|---|---|---|---|---|---|---|---|
| 07-13 11:00 | 62850 | 61593 | 62773 | 64421 | 61610 | 62790 | 64473 | 60760 | ∅ | HVN/short |
| 07-14 20:00 | 64546 | 60441 | 62781 | 64491 | 61215 | 62790 | 64264 | 61731 | VAH/short | VAH/long |
| 07-16 05:10 | 64647 | 60130 | 62717 | 65089 | 60189 | 62790 | 64264 | 61905 | ∅ | ∅ |
| 07-17 14:20 | 63289 | 60130 | 62835 | 65128 | 61130 | 62790 | 64438 | 62425 | ∅ | HVN/long |
| 07-18 23:20 | 64798 | — | — | — | — | 63969 | 64473 | 62529 | ∅ (blind) | VAH/long |
| 07-20 08:20 | 64263 | 62795 | 64101 | 65090 | 62866 | 63969 | 64854 | 62772 | ∅ | HVN/long |
| 07-21 18:50 | 66303 | 62817 | 64763 | 65595 | 63137 | 64108 | 65028 | 62668 | ∅ | ∅ |
| 07-23 03:50 | 65617 | 62817 | 64763 | 66184 | 63342 | 64108 | 65167 | 62703 | ∅ | ∅ |
| 07-24 12:50 | 64819 | 66007 | 64763 | 65868 | 63734 | 64108 | 66034 | 63640 | ∅ | HVN/long |
| 07-25 22:20 | 64367 | 66008 | 64748 | 65643 | 63875 | 64108 | 65999 | 63640 | VAL/long | HVN/long |

## Shipped alongside (this branch)

- `lib/market-data.js`: `fetchOpenInterest`, `fetchLastPrice`, `computeATR`, `completedBars`
  (D4 primitive), `sessionBars`, `12h` interval — native path now serves everything
  trigger-check reads from CDP. 14 new tests (`scripts/tests/market-data.test.js`); live smoke
  reproduced the sidecar's zone set exactly (POC 64768 / VAH 66034 / VAL 63675).
- `zone-parity-report.js`: spec-06 gate items — **0 native blind cycles** (gated) + tv-blind
  informational; trigger agreement scored on live cycles only.
- `rebuild/06-integration-patch.md`: the full cutover change set for trigger-check.js
  (Agent A's file), with spec-03 re-anchor tags and the no-CDP smoke test.
