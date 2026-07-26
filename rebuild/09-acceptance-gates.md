# 09 — Acceptance gates → Phase E (real capital)

**Type:** capital gate · **Depends on:** everything · **Audit refs:** §8c, D12

This spec defines when "high conviction" is earned. No step here is skippable, and no gate is
passable by argument — only by measurement.

## 9.1 Standing falsification gate (weekly, automated, forever)

Wire `scripts/audit/falsification.js` (spec 07) into cron (ace-cron, weekly, alongside the
Monday report). Each run, on the trailing corrected ledger:

1. **Symmetric skill:** ≥55% at ±1×ATR with day-clustered CI excluding 50%.
2. **Random-entry MC:** actual trailing book > 95th percentile of ≥200 geometry-matched
   random books.

Post pass/fail + numbers to the weekly report channel. **Two consecutive failing weeks ⇒
`BLOFIN_AUTOTRADE` set false automatically** + red alert to `#blofin-recon`. Re-enable is a
manual operator action only. This gate runs in demo *and* forever after any capital goes live —
it is the system's tripwire against edge decay, and it also protects against the subtler
failure where the edge was never real and the demo window was lucky.

## 9.2 Reporting honesty (permanent)

- Weekly report prints: net-of-fee R (corrected ledger), exchange cumulative net (spec 04
  attribution), fee total in R and USD, falsification-gate status, paired-signal
  ledger↔exchange mean |Δ|.
- **Retire the 85/74/63 probability labels** (trigger-check.js:931–938) from all posts until
  re-derived out-of-sample on the corrected ledger with passing Brier/ECE (D12). Signals may
  state tier letter as a *category*, never as a probability.
- Every stated performance number is labeled in-sample or out-of-sample. No OOS estimate is
  quoted until one exists.

## 9.3 Phase E graduation checklist (demo → real capital)

ALL simultaneously true, verified on the corrected ledger, evidence linked in a graduation
document the operator signs off on:

- [ ] Specs 01–08 complete (each Definition of Done met)
- [ ] Spec 07's five-row bar passed by the live candidate signal (≥55% skill, ≥+0.25R gross,
      ≥1×ATR stops, ≥150 post-fix signals, ≥60 days, ≥2 regimes, ESS-corrected)
- [ ] Ledger↔exchange agreement: mean |Δ| ≤0.1R over ≥30 paired post-fix signals
- [ ] Falsification gate green ≥4 consecutive weeks
- [ ] Net-of-fee expectancy positive with day-clustered 95% CI excluding zero on the
      post-fix out-of-sample window
- [ ] Governance verified live: zero margin-skips and zero stacking events in the final
      30 demo days
- [ ] Operator has read the evidence package and explicitly authorized Phase E in writing

## 9.4 Phase E rollout requirements (when 9.3 passes)

- **Prod re-verification before first order:** re-run the docs-vs-truth probes against prod
  endpoints (`status`, `order-probe` read paths); **re-measure actual prod fee rates from the
  first fills** — the 6bp/2bp schedule is demo-measured and unverified at prod tiers. If prod
  fees differ, re-run the spec 07 cost model before continuing.
- **Egress check:** confirm split-tunnel/VPN posture (Cloudflare-403 class) from the exact
  host+network that will run prod recon.
- **Sizing at entry:** start at a risk fraction the operator chooses at sign-off time
  (insufficient evidence to prescribe one here — it is a bankroll decision, not a statistical
  one); the graduation document records it. Ramp rules, if any, are operator-defined in the
  same document.
- **Credentials hygiene:** prod keys enter `.env` only at this step, never before; demo and
  prod books stay separated by the existing `(orderId, env)` index.
- **Everything from 9.1–9.2 keeps running unchanged on prod.** The kill switch (spec 04) and
  falsification tripwire are not demo scaffolding — they are the product.

## The honest bottom line for the future agent

If specs 01–06 are done and spec 07 never produces a passing candidate, the correct final
state is: an honest, well-instrumented research system with autotrade off — and that outcome
is a success of this rebuild, because it will have cost $0. The failure mode this folder
exists to prevent is the opposite one: real capital deployed on a +965R illusion.
