'use strict';
// Educational "would a textbook desk trader call this an entry zone?" check for BTCUSDT.P. Scores the long and the
// short side on the four things institutional traders look for before committing: trend (4h + daily agree), location
// (at a level where orders cluster - prior highs/lows, the VRVP value-area edges and POC, the 200-day line - not in the
// middle), order flow (who is hitting, and whether new bets back it) and reward vs risk (room to the next level vs the
// distance to the point that proves the idea wrong). A teaching checklist only: backtested 2021-2026 it has no edge
// (3/4 setups lost more than random after fees; notes/entry-checklist/RESULTS-2026-11-09.md), so the verdicts say so.
// CLI (from the repo root): node .claude/watchers/entry-check.js [--window 1h]   (default 15m)   Module: entryCheck({window})
const path = require('path');
const mkt = require(path.resolve(process.cwd(), 'scripts', 'lib', 'market-data.js'));
const cfg = require(path.resolve(process.cwd(), 'config', 'btc-zones.json'));

const B = 'https://fapi.binance.com';
const DAY = 86_400_000;
const FIXED = [[72808, "Tuesday's data low"], [73333, "Sunday's crash low"], [73715, "Monday's overnight low"], [74909, "Friday's low"], [75724, "Sunday night's high"]];
const NEAR = 0.003;    // within 0.3% of a level counts as "at" it
const BUFFER = 0.0015; // the textbook "wrong" point sits 0.15% beyond the level
const j = u => fetch(B + u).then(r => { if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); });
const fmt = n => Math.round(n).toLocaleString('en-US');
const ema = (c, n) => { const k = 2 / (n + 1); let e = c[0]; for (const v of c) e = v * k + e * (1 - k); return e; };
const trend = k => { const c = k.map(x => +x[4]), p = c.at(-1), a = ema(c, 20), b = ema(c, 50); return p > a && a > b ? 'up' : p < a && a < b ? 'down' : 'mixed'; };

// The levels where orders cluster, low to high, near-duplicates dropped (shared with the tape watcher)
async function keyLevels(k1d) {
  const now = Date.now();
  k1d ??= (await j('/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=500')).filter(x => +x[6] + 10_000 < now);
  const bars = mkt.completedBars(await mkt.fetchKlines({ symbol: 'BTCUSDT', interval: cfg.interval, startTime: now - cfg.windowDays * DAY, endTime: now }), cfg.interval, now);
  const vp = mkt.buildVolumeProfile(bars, { rowSize: cfg.rowSize }), pd = k1d.at(-1);
  const all = [...FIXED, [vp.val, 'the bottom of the busy zone (VAL)'], [vp.poc, 'the busiest price (POC)'], [vp.vah, 'the top of the busy zone (VAH)'],
    [ema(k1d.map(x => +x[4]), 200), 'the 200-day line'], [+pd[2], "yesterday's high"], [+pd[3], "yesterday's low"]];
  return all.filter(([L], i) => !all.slice(0, i).some(([M]) => Math.abs(M / L - 1) < 0.0015)).sort((a, b) => a[0] - b[0]);
}

async function entryCheck({ window = '15m' } = {}) {
  const now = Date.now(), closed = k => k.filter(x => +x[6] + 10_000 < now);
  const [k4h, k1d, kf, oi5, tick] = await Promise.all([
    j('/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=300').then(closed),
    j('/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=500').then(closed),
    j(`/fapi/v1/klines?symbol=BTCUSDT&interval=${window === '1h' ? '1h' : '5m'}&limit=5`).then(closed),
    j('/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=24'),
    j('/fapi/v1/ticker/price?symbol=BTCUSDT'),
  ]);
  const price = +tick.price, span = window === '1h' ? kf.slice(-1) : kf.slice(-3);
  const delta = span.reduce((a, x) => a + 2 * +x[9] - +x[5], 0);
  const oiAt = t => +(oi5.filter(o => +o.timestamp <= t).at(-1) || oi5[0]).sumOpenInterest;
  const oiChg = (oiAt(now) / oiAt(+span[0][0]) - 1) * 100;
  const t4 = trend(k4h), td = trend(k1d);

  const levels = await keyLevels(k1d);
  const below = levels.filter(([L]) => L < price), above = levels.filter(([L]) => L > price);
  const sup = below.at(-1), res = above[0];

  const side = (dir) => {
    const isLong = dir === 'long', lvl = isLong ? sup : res, target = isLong ? res : sup;
    if (!lvl || !target) return { score: 0, line: `${dir}: no level on that side` };
    const at = Math.abs(price / lvl[0] - 1) <= NEAR;
    const wrong = isLong ? lvl[0] * (1 - BUFFER) : lvl[0] * (1 + BUFFER);
    const rr = Math.abs(target[0] - price) / Math.abs(price - wrong);
    const checks = [
      [isLong ? t4 === 'up' && td === 'up' : t4 === 'down' && td === 'down', `trend (4h ${t4}, daily ${td})`],
      [at, at ? `location: at ${lvl[1]} ${fmt(lvl[0])}` : `location: in the middle, ${fmt(Math.abs(price - lvl[0]))} from ${lvl[1]} ${fmt(lvl[0])}`],
      [isLong ? delta > 0 && oiChg > 0.15 : delta < 0 && oiChg > 0.15,
        `flow (CVD ${delta >= 0 ? '+' : ''}${fmt(delta)}, OI ${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(2)}%${isLong ? ', needs buyers + new bets' : ', needs sellers + new bets'})`],
      [rr >= 2, `reward:risk ${rr.toFixed(1)} (room to ${fmt(target[0])} vs the "wrong" point ${isLong ? 'under' : 'over'} ${fmt(wrong)})`],
    ];
    const score = checks.filter(c => c[0]).length;
    const verdict = (score === 4 ? 'textbook zone' : score === 3 ? 'textbook, one piece missing' : 'not a textbook zone, a desk trader would wait')
      + (score >= 3 ? ' (backtest: no edge after fees)' : '');
    return { score, line: `${dir} ${score}/4 -> ${verdict}: ${checks.map(([ok, txt]) => `${ok ? '✓' : '✗'} ${txt}`).join(' | ')}` };
  };
  return { price, sup, res, long: side('long'), short: side('short') };
}

if (require.main === module) {
  const w = process.argv.includes('--window') ? process.argv[process.argv.indexOf('--window') + 1] : '15m';
  entryCheck({ window: w }).then(r => {
    console.log(`PRICE ${fmt(r.price)} | support ${r.sup ? `${fmt(r.sup[0])} ${r.sup[1]}` : 'none'} | resistance ${r.res ? `${fmt(r.res[0])} ${r.res[1]}` : 'none'}`);
    console.log(`ENTRY ${r.long.line}`);
    console.log(`ENTRY ${r.short.line}`);
  }).catch(e => { console.log('FAILED:', e.message); process.exit(1); });
}
module.exports = { entryCheck, keyLevels, trend };
