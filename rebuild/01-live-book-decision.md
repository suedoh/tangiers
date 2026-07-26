# 01 — Live book decision (OPERATOR GATE)

**Type:** operator decision · **Depends on:** nothing · **Blocks:** everything downstream

## Situation (as of audit, 2026-07-26)

48 consecutive long signals stacked into a single net position of **238.3 contracts**
(BTC-USDT demo), freezing **$1,528 of $1,570** account balance. Margin preflight
(blofin-autotrade.js:293–311) has been rejecting every new entry since **2026-07-26T01:50Z** —
signals skip silently. Root cause is spec 02's missing same-direction guard; this spec is only
about the *existing* position.

Nothing can be forward-tested while the account is margin-locked: no order can place, so no
new data accrues. This gate must clear first.

## Agent procedure

1. **Re-verify current state (read-only).** Do not assume the audit snapshot still holds:

   ```bash
   node -e "require('/Users/vpm/trading/scripts/lib/env.js').loadEnv(); const b=require('/Users/vpm/trading/scripts/lib/blofin.js'); (async()=>{ if(!b.isDemo()){console.error('NOT DEMO');process.exit(1);} console.log(JSON.stringify({positions: await b.getPositions('BTC-USDT'), balance: await b.getBalance()},null,1)); })()"
   ```

2. **Present the operator with the numbers and exactly these options:**
   - **(a) Flatten** — close the net position (reduce-only market), freeing margin. Realizes
     whatever P&L the stack carries at that moment.
   - **(b) Hold with explicit intent** — operator states a thesis, a stop, and a review date;
     record all three below. Forward testing remains blocked until margin frees.
   - Note for the operator: this is demo capital, but the *behavioral* point of Phase D is to
     rehearse prod discipline. An accidental 97%-margin position held without a thesis would be
     an emergency on prod.

3. **Wait for the operator's explicit choice.** The agent must not flatten, reduce, or hedge
   on its own initiative — position changes are the operator's call, and under this project's
   rules the agent never executes a trade decision the operator hasn't explicitly directed.

4. **Record the decision** in the log below, commit.

## Definition of Done

- [ ] Fresh position/balance snapshot taken and shown to operator
- [ ] Operator chose (a) or (b) explicitly, in writing
- [ ] If (a): position flat, available margin ≥ 90% of equity, confirmed by re-snapshot
- [ ] If (b): thesis + stop + review date recorded below
- [ ] Decision log updated + committed

## Decision log

| Date (UTC) | Snapshot (contracts / avail margin) | Decision | Notes |
|---|---|---|---|
| 2026-07-26 | 238.3 long / $42.70 avail ($1,528 frozen); mark $64,678, +$132 unrealized | **(a) Flatten** — operator explicit choice | Reduce-only market sell 238.3, order `1000132968095`, FLAT confirmed by re-snapshot. Realized ≈ +$126. Final balance $1,697.18, $0 frozen. No orphaned active orders or pending TPSL. Gate CLEAR — forward testing unblocked. |
