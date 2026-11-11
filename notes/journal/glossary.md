# BTC glossary - plain words

Every term the alerts use, in one or two sentences, with what it looks like on the chart.
Examples are from Nov 9-10, 2026, so you can scroll back and see them.

## The chart

- **Candle** - one bar on the chart. It shows where price started (open), ended (close), and
  the highest and lowest it went in that time.
- **Timeframe** - how much time one candle covers: 15m (15 minutes), 1h (1 hour), 4h, daily.
  Bigger timeframes move slower but matter more.
- **Close** - where a candle ends. Traders trust closes, not quick pokes: a level only "breaks"
  when a candle **closes** past it.
- **Wick** - the thin line above or below a candle's body. A long wick means price went there
  and got pushed back. Long upper wick = sellers pushed it down; long lower wick = buyers pushed
  it up. *Example: 1:00 AM Nov 10, the 1h poked to 74,977 and closed at 74,788.*
- **Green / red candle** - closed higher / lower than it opened.

## Direction

- **Trend** - which way price has been going. **Down** = lower highs and lower lows, price under
  its average lines. **Up** = the opposite. **Mixed** = no clear direction. The alerts check the
  trend on the daily and 4h first: that's the "big picture".
- **Level** - a price where the market reacted before (a past low, a past high, a busy price).
  - **Floor** (support) - a level under price where buyers stepped in before.
  - **Ceiling** (resistance) - a level above price where sellers stepped in before.
  - **A broken floor becomes a ceiling**, and a broken ceiling becomes a floor. *Example: after
    74,909 broke on Nov 9 at 10 PM, price came back up to it three times and got pushed away.*
- **Box** (range) - price stuck between a floor and a ceiling. Inside a box, nobody is in
  control; a close outside it picks the next move. *Example: 73,333-73,715 on Nov 10 evening.*

## What price does at a level

- **Test** - price comes to a level.
- **Hold** - price touches a floor and closes back above it (buyers defended it).
- **Rejection** - price touches a ceiling and closes back below it (sellers defended it).
- **Break** - a candle closes past the level.
- **Retest** - after a break, price comes back to the broken level. If it holds from the other
  side, the break was real.
- **Fake breakout / fake breakdown** (a trap) - price closes past a level, then closes back on
  the other side within a few candles. The people who bet on the break are trapped. *Example:
  10 AM Nov 10, the 1h closed back above 73,715 one hour after breaking under it.*
- **Sweep** - price dips just past a level, then closes back (it "swept" the stop orders there).

## Who is buying and selling (order flow)

- **Taker** - a trader who buys or sells right now at the market price, instead of waiting.
  Takers push price.
- **CVD** (buyers vs sellers) - takers who bought minus takers who sold. Positive = buyers hit
  harder; negative = sellers hit harder.
- **OI** (open interest) - how many bets (futures contracts) are open. Read it **with** price:
  - price up + OI up = new buyers piling in (strong rise)
  - price up + OI down = sellers closing their bets (a squeeze; can fade)
  - price down + OI up = new sellers piling in (strong drop)
  - price down + OI down = buyers giving up (can run out)
- **Short squeeze** - sellers forced to buy back fast, which pushes price up. *Example: 10:02 AM
  Nov 10, 43 BTC of shorts force-closed, price jumped $400, then faded.*
- **Liquidation** (forced close) - the exchange closes a losing bet automatically.
- **Whale** - one very large order (75+ BTC here, about $5.5M+).
- **Absorption** - lots of selling (or buying) but price doesn't move, because hidden orders are
  soaking it up. A clue for the side doing the soaking.
- **Volume** - how much traded. 2x normal = busy (people care); 0.4x = quiet (easy to reverse).

## Where price sits

- **Volume profile (VRVP)** - shows how much traded at each price over the last 14 days.
  - **Busy zone** (value area) - where most trading happened. Price tends to slow down there.
  - **VAL / VAH** - the bottom / top of the busy zone. **POC** - the single busiest price.
  - **Thin area** - little traded there before; price tends to move fast through it.

## Planning a trade (what a trader would do)

- **Entry** - where a trader would get in.
- **Stop loss (SL)** - where the idea is proven wrong and a trader gets out.
- **Target** - where a trader takes profit, usually the next level.
- **R** - one unit of risk: the distance from entry to stop. "+2R" = made twice the risk.
- **R:R** (reward vs risk) - the target distance divided by the stop distance, after fees.
  Desk traders want 2 or more.
- **Fees** - about 0.16% of price per trade (in and out). With a tight stop, fees eat a big
  part of the reward.
- **Setup grade** (in our alerts)
  - **A** - goes with the big-picture trend, flow agrees, pays 2x or more after fees.
  - **B** - one of those three is missing (often: against the trend). Lower quality.
  - Both are tracked in the journal scorecard so we learn which ones actually work.

## Time

- **US morning** - 8:30 AM EST (US economic data) and 9:30 AM (stock market open). Big moves
  are about 2.5x more likely in the 2 hours after 8:30. *Example: Nov 10 8:30 AM, a $1,100 swing
  in one minute.*
- All times in the alerts are US Eastern (EST).
