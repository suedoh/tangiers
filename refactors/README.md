# Refactor Log — Index + Process Guide

This folder is the durable decision record for Tangiers. Every significant bug fix, audit finding, optimization plan, or architectural decision gets a file here. Future sessions read this index FIRST before assuming anything about prior work.

---

## Active index (READ FIRST)

> **Convention since 2026-05-15:** new files use `YYYY-MM-DD-<scope>-<slug>.md`. Files predating this convention keep their original names. Status field is the first line of each doc.

### ACTIVE

| File | What | Owner | Last touched |
|---|---|---|---|
| [2026-05-15-btc-optimization-roadmap.md](2026-05-15-btc-optimization-roadmap.md) | 4-phase plan: Phase 1 shipped, Phase 2 = observation, Phase 3 = data-validated tuning, Phase 4 = architecture | suedoh | 2026-05-15 |
| [mongodb-migration-plan.md](mongodb-migration-plan.md) | Phases 0–2 merged to main; Phase 3 entry conditions documented | suedoh | 2026-05-09 |

### DONE (kept for audit trail)

| File | What | Date |
|---|---|---|
| [2026-05-15-btc-took-exit-activation.md](2026-05-15-btc-took-exit-activation.md) | Activated BTC `!took` / `!exit` Phase 2 execution tracking | 2026-05-15 |
| [btc-tier1-defects-2026-05-15.md](btc-tier1-defects-2026-05-15.md) | 6 BTC Tier-1 defect fixes shipped (D1, D2, D3, D6, D7, D9) | 2026-05-15 |
| [btc-audit-2026-05-14-v2.md](btc-audit-2026-05-14-v2.md) | Evidence-based BTC audit v2 — defects/open-questions/hypotheses tier system | 2026-05-14 |
| [btc-audit-2026-05-14.md](btc-audit-2026-05-14.md) | BTC audit v1 (superseded by v2 — v1 mixed defects with un-substantiated tuning claims) | 2026-05-14 |
| [recent-analysis.md](recent-analysis.md) | Full system audit by Sonnet 4.6 — covers all instruments | 2026-05-05 |
| [remove-bos-choch-dead-code.md](remove-bos-choch-dead-code.md) | Dead-code removal in BTC trigger-check (commit 868ce1a) | 2026-05-05 |
| [poly-btc-5-remove-oi-factor.md](poly-btc-5-remove-oi-factor.md) | Poly BTC-5: OI factor removed (−17.2pp lift evidence) | (see commit) |
| [poly-btc-5-outcome-measurement.md](poly-btc-5-outcome-measurement.md) | Poly BTC-5 outcome resolution rule | (see commit) |

### SNAPSHOTS

| File | What |
|---|---|
| [btc-baseline-2026-05-15.json](btc-baseline-2026-05-15.json) | Wilson-CI baseline metrics + anomaly counters for Tier 1 + Phase 1 diffs |

---

## Status field — mandatory on every new refactor doc

Every refactor `.md` in this folder MUST have a `**Status:**` line in the first 5 lines. Allowed values:

| Status | Meaning |
|---|---|
| `PROPOSED` | Drafted, awaiting user decision — DO NOT IMPLEMENT |
| `ACTIVE` | Multi-phase work in progress; check the doc for the current phase |
| `DONE` | Complete, kept for audit trail. Do not edit; cross-reference instead |
| `BLOCKED` | Waiting on external dependency or user decision; reason stated in doc |
| `SUPERSEDED BY <file>` | Replaced by another doc; link to it |

**Future sessions:** when you find a refactor doc with no Status field, treat it as DONE unless its dates suggest active work, and add a Status field while you're there.

---

## File naming convention (since 2026-05-15)

`YYYY-MM-DD-<scope>-<slug>.md`

- **Date** = creation date (not last-edit). Lets `ls` sort chronologically.
- **Scope** = `btc` / `bz` / `poly` / `ew` / `mongo` / `cron` / `bot` / `process` etc.
- **Slug** = short kebab-case description.

Examples:
- `2026-05-15-btc-optimization-roadmap.md`
- `2026-06-01-ew-pine-rewrite.md`
- `2026-07-12-bz-session-gate-dst-fix.md`

Files before this convention keep their original names (`btc-tier1-defects-2026-05-15.md` etc.) — do not rename them, just update the index.

---

## What every refactor doc must contain

1. **Status field** (first 5 lines).
2. **Owner** and **Date** (or **Last touched**).
3. **What changed** — specific file:line ranges.
4. **Why** — the actual reason, not "it was unused."
5. **Risk** — what could behave differently, and confidence level.
6. **Verification** — how we know it worked (test output, manual check, link to diff).
7. **Decision history** (for multi-phase plans) — dated entries explaining why each call was made.

---

## Cross-reference rules

- A doc that supersedes another MUST set the older doc's status to `SUPERSEDED BY <new-file>` and add a one-line "Replaced by" note at the top.
- A doc that affects a deployed change MUST link to the commit SHA(s).
- An audit doc that produces a plan MUST link to the plan doc (audit → plan → execution refactor).

---

## How We Evaluate Before Touching Anything

The process below was established during the BOS/CHoCH dead code removal. It applies to any change where the right call isn't immediately obvious.

### 1. Confirm the claim before forming an opinion

Before deciding what to do with a suspect piece of code, verify the premise independently.

**Rule:** A claim that code is dead, unused, or broken is not evidence — a search result is.

### 2. Understand the original intent

Read the code, its comments, AND the git blame + commit messages on the relevant lines. Documented intent (in commit messages, BACKTESTING.md, docs/, or refactors/) ranks higher than current code when they disagree.

### 3. Check whether the code *could* work even if wired in

If the data source doesn't exist in the environment the code runs in, wiring it in is building on nothing.

### 4. Check whether the gap it was meant to fill actually exists

The underlying need might already be addressed elsewhere.

### 5. Confirm the correct home exists elsewhere if relevant

If the pattern has value but is in the wrong place, note that — don't just delete it.

### 6. State the risk explicitly before committing

For correctness-only changes against documented intent, risk is usually low. For tuning changes that alter signal selection, risk is moderate and the metrics protocol applies (see [memory: feedback_change_metrics_protocol](https://github.com/anthropics/claude-code/issues) — captured in `~/.claude/projects/-Users-vpm-trading/memory/`).
