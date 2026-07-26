# Discord bot — the "DNS is broken" outage was a missing retry (2026-07-26)

`logs/discord-bot.log` was **59% errors** — 23,772 × `getaddrinfo ENOTFOUND discord.com` out of
40,274 lines — and every recent run failed. Commands (`!analyze`, `!took`, `!trades`, `!status`)
and 📊 reaction tracking were dead, while signal alerts kept arriving normally.

## Diagnosis: reproduce in the failing context, don't theorise

The obvious story — "cron can't resolve DNS on this host" — was wrong, and testing from an
interactive shell could not have shown that, because the shell is not the failing context. So the
diagnostic ran **from cron**, invoked exactly the way the bot is:

```
res_order: verbatim          dns.getServers(): ["8.8.8.8","1.1.1.1"]
1. dns.lookup        : OK 162.159.135.232 (ipv4)
3. dns.resolve4      : OK 162.159.135.232,162.159.128.233,…
5. curl discord      : OK 200
6. node https        : OK status 200          ← the bot's exact code path
```

Everything worked. The failure is **transient**, not environmental: DNS on this host drops
requests sporadically (consistent with the known VPN egress behaviour) and recovers within
milliseconds.

## Why a sporadic blip looked like a total outage

`discordRequest()` had **no retry and no timeout**. One failed lookup lost the whole call. The bot
issues ~16 concurrent requests per run (8 channels × poll + reactions), so the chance that *at
least one* hit a blip was high on every single cycle — and each one wrote an error line. A fault
affecting a small fraction of requests rendered as a log that was 59% errors and a command
interface that never worked.

## Fix

- **Retry on transient codes** (`ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`,
  `ECONNREFUSED`, `EPIPE`, `ENETUNREACH`, timeout) — 2 retries at 400 ms / 1500 ms. Non-transient
  errors (auth, bad JSON, 4xx) still fail immediately; retrying those would just hide bugs.
- **12 s request timeout.** There was none, so a stalled connect could outlive the one-minute cron
  cadence entirely.
- **Timestamped logging.** The log had no timestamps, which is why a multi-week outage could not
  be dated from 23,772 error lines.
- **Health heartbeat** `.discord-bot-health.json`: `lastSuccessAt`, request/failure counts,
  `consecutiveFailedRuns`. Tracks *reaching Discord*, not merely *running*.

## Proof it works

The very first run after the change caught a live failure and recovered from it:

```
transient ENOTFOUND on GET /channels/…/messages — retry 1/2 in 400ms
health: requests 37, failures 0, consecutiveFailedRuns 0
```

Three further runs: 1 transient event, 0 failures. The bot is reaching Discord again.

## Monitoring — the real lesson

New `discordBot` watchdog class: alerts when the bot hasn't had a **successful** Discord request in
20 minutes. This outage lasted weeks with every other check green, because **outbound alerts use
`curl` and inbound polling uses Node** — the half that failed was the half nobody could see.

That is now the third instance of the same shape today (158 hung crons, the margin lock, this):
*a component that fails silently needs a watcher that proves it is working, not one that proves it
is running.* The watchdog now carries eight classes, and three of them were added today.

## Caveat

The underlying DNS instability is **not fixed** — it is absorbed. If `consecutiveFailedRuns` starts
climbing in the health file, the retries have stopped being enough and the host's resolver (or the
VPN configuration) is the next place to look.
