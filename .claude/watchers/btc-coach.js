'use strict';
// Educational BTC coach (BTCUSDT.P) for a novice learning to read the chart. It replaces the swarm of watchers with one
// voice that speaks in plain words and only when something changes, always in the same order: trend (the big picture),
// structure (the lines to draw), flow (who is pushing: CVD and open interest, explained), big orders (the tape).
// It wakes every minute and prints one of:
//   MARKET MAP  - at the 7 AM EST 4h close, and at any other 4h close where the trend or the box changed.
//   MAP CHANGE  - a 1h candle closes through key levels (all of them in one message), or back through one (a trap).
//   SETUP ZONE  - price comes within 0.08% of the box's floor or ceiling: a setup may form in the next 15m candles,
//                 here is what each outcome looks like on the 15m chart.
//   ALERT /     - a textbook setup (rejection, fake break, retest) on the 1h chart (Grade A or B) or the 15m chart
//   PRACTICE      (Grade A only: 15m Grade B is 97% of 15m setups and loses 0.5R+ a trade). ALERT is reserved for a
//                 setup whose measured record is positive after fees; anything else is PRACTICE. The record comes from
//                 notes/journal/setup-odds.json (scripts/research/setup-odds-test.js). Logged to
//                 notes/journal/btc-alerts.json and scored (RESULT).
//   PASSED      - 1h setups that formed but paid less than they risked, listed in one line on the next map.
//   HEADS-UP    - 5 minutes before a 1h close that is about to change the map or complete a setup.
// Each message is printed for the caller to relay; the watcher then exits so the caller can restart it (missed 1h and
// 15m closes from the last few minutes are caught up on restart).
// Run from the repo root: node .claude/watchers/btc-coach.js   (--map prints the market map now;
//   --replay <fromMs> <toMs> walks the 1h closes in between and prints what it would have said, without logging.
//   Replay uses today's key levels, so a level made later in the day can show up early.)
const fs = require('fs');
const path = require('path');
const { keyLevels, trend } = require(path.join(__dirname, 'entry-check.js'));
const { syncChart } = require(path.join(__dirname, 'chart-draw.js'));

const MIN = 60_000, M5 = 300_000, M15 = 900_000, H = 3_600_000, H4 = 4 * H;
const TOUCH = 0.0005, PAD = 0.0005, GAP = 0.001, BREAK = 0.001, COST = 2 * (0.0006 + 0.0002);
const TIME_STOP = { '1h': 48 * H, '15m': 12 * H }; // the limits the odds were measured with
const ZONE = 0.0008, REARM = 0.003, ZONE_GAP = 2 * H, ZONE_ANY_GAP = 30 * MIN; // at 0.15% a $335 box was all "zone"
const BIG_MIN = 100; // under 100 BTC of large orders in the window, nobody big was active and there is no lean to read
const PRIORITY = ['fake break', 'retest', 'rejection']; // one setup per side per candle: the most specific one leads
const ROOT = path.resolve(__dirname, '..', '..');
const STATE = path.join(__dirname, 'btc-coach-state.json');
const ALERTS = path.join(ROOT, 'notes', 'journal', 'btc-alerts.json');
const ODDS = path.join(ROOT, 'notes', 'journal', 'setup-odds.json');
const BOOK = path.join(ROOT, 'data', 'orderbook');
const REPLAY = process.argv.includes('--replay');

const j = u => fetch('https://fapi.binance.com' + u).then(r => { if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); });
const fmt = n => Math.round(n).toLocaleString('en-US');
const signed = (x, d = 0) => `${x >= 0 ? '+' : ''}${d ? x.toFixed(d) : fmt(x)}`;
const est = t => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' EST';
const estHour = t => +new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }) % 24;
const list = a => a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
const bar = x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], d: 2 * +x[9] - +x[5], ct: +x[6] + 1 });
const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const TREND = { up: 'UP', down: 'DOWN', mixed: 'MIXED (no clear direction)' };
const side = long => long ? 'BUY' : 'SELL';

// ── Plain-English readings ────────────────────────────────────────────────────────────────────────────────────────
function flowText(cvd, oiPct, move) {
  const who = Math.abs(cvd) < 30 ? 'buyers and sellers hit about equally (CVD near 0)'
    : `${cvd > 0 ? 'buyers' : 'sellers'} hit harder by ${fmt(Math.abs(cvd))} BTC (CVD ${signed(cvd)}: market buys minus market sells)`;
  const bets = Math.abs(oiPct) < 0.1 ? 'open bets barely changed (OI flat): no new money, so the move has little fuel'
    : move >= 0 ? (oiPct > 0 ? `open bets rose ${oiPct.toFixed(2)}% while price rose (OI up): new buyers are joining, the strong kind of rise`
      : `open bets fell ${Math.abs(oiPct).toFixed(2)}% while price rose (OI down): sellers are closing their bets, a squeeze that can fade`)
      : (oiPct > 0 ? `open bets rose ${oiPct.toFixed(2)}% while price fell (OI up): new sellers are joining, the strong kind of drop`
        : `open bets fell ${Math.abs(oiPct).toFixed(2)}% while price fell (OI down): buyers are giving up, a flush that can run out`);
  return `${who}; ${bets}`;
}
function tapeText(tp, move) {
  if (!tp) return 'big-order data unavailable';
  const liq = tp.liqL + tp.liqS >= 5 ? `; forced closes: ${fmt(tp.liqL)} BTC of buyers, ${fmt(tp.liqS)} of sellers` : '';
  if (tp.buy + tp.sell < BIG_MIN) return `few large orders (5+ BTC each, ${fmt(tp.buy + tp.sell)} BTC in all): the big players sat it out${liq}`;
  const lean = tp.buy > tp.sell * 1.5 ? 'buy' : tp.sell > tp.buy * 1.5 ? 'sell' : null;
  const effect = !lean ? 'neither side dominated'
    : (lean === 'buy') === (move >= 0) ? `and price went ${move >= 0 ? 'up' : 'down'} with them: the big ${lean}ers moved price`
      : `but price went ${move >= 0 ? 'up' : 'down'} anyway: the big ${lean}ers were absorbed by the other side`;
  return `large orders (5+ BTC each): ${fmt(tp.buy)} BTC bought vs ${fmt(tp.sell)} sold, ${effect}${liq}`;
}
function tape(t0, t1) {
  const rows = new Map();
  for (let d = Math.floor(t0 / 86_400_000) * 86_400_000; d < t1; d += 86_400_000) {
    let text = '';
    try { text = fs.readFileSync(path.join(BOOK, `btcusdt-${new Date(d).toISOString().slice(0, 10)}.ndjson`), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (!r.gap && r.t >= t0 && r.t < t1) rows.set(r.t, r); } catch { /* torn line */ }
    }
  }
  if (rows.size < (t1 - t0) / 120_000) return null;
  const sum = k => [...rows.values()].reduce((a, r) => a + (+r[k] || 0), 0);
  return { buy: sum('tbigBuy'), sell: sum('tbigSell'), liqL: sum('liqLong'), liqS: sum('liqShort') };
}

// ── Measured records (both periods pooled; the last two years shown on their own) ─────────────────────────────────────
function cell(tf, fam, filter) {
  const c = loadJSON(ODDS, null)?.cells?.find(x => x.tf === tf && x.fam === fam && x.filter === filter);
  if (!c?.is?.n || !c?.oos?.n) return null;
  const n = c.is.n + c.oos.n, w = k => (c.is[k] * c.is.n + c.oos[k] * c.oos.n) / n;
  return { n, oneR: w('oneR'), win: w('win'), meanR: w('meanR'), grossR: w('grossR'), oos: c.oos };
}
function record(tf, fam, grade) {
  const r = cell(tf, fam, grade);
  if (!r) return 'Record: not measured yet.';
  return `Record (Grade ${grade} ${fam}s on the ${tf} chart, BTC 2021-2026, ${r.n} past cases): 1R your way came before 1R against ${Math.round(r.oneR * 100)} times out of 100 ` +
    `(a coin flip is 50); the target was reached ${Math.round(r.win * 100)} out of 100; average ${signed(r.meanR, 2)}R after fees, ${signed(r.grossR, 2)}R before them` +
    `${r.meanR < 0 ? ', so on average it LOST money' : ''}. Last 2 years alone: ${r.oos.n} cases, ${Math.round(r.oos.oneR * 100)} of 100, ${signed(r.oos.meanR, 2)}R.`;
}

// ── Market data, live or as of a past time (replay) ───────────────────────────────────────────────────────────────
async function market(AT) {
  const end = AT ? `&endTime=${AT - 1}` : '', now = AT || Date.now();
  const raw = x => x.filter(y => +y[6] + 1 <= now), closed = k => raw(k).map(bar);
  const [k1, k4, kd, oi] = await Promise.all([
    j(`/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=200${end}`), j(`/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=300${end}`),
    j(`/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=500${end}`), j(`/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=60${end}`),
  ]);
  const oiAt = t => +(oi.filter(o => +o.timestamp <= t).at(-1) || oi[0]).sumOpenInterest;
  return { h1: closed(k1), t1: trend(raw(k1)), t4: trend(raw(k4)), td: trend(raw(kd)), oiAt };
}

// ── The three setups on a closed candle (the same rules setup-odds-test.js measured) ─────────────────────────────────
function setups(bars, i, levels, tf) {
  const c = bars[i], range = c.h - c.l || 1, up = (c.h - Math.max(c.o, c.c)) / range, dn = (Math.min(c.o, c.c) - c.l) / range, out = [];
  const step = tf === '1h' ? 60 : 15, ago = k => k * step < 60 ? `${k * step} minutes ago` : k * step === 60 ? 'an hour ago' : `${k * step / 60} hours ago`;
  for (const [L, name] of levels) {
    if (c.h >= L * (1 - TOUCH) && c.c < L && up >= 0.4) out.push({ fam: 'rejection', long: false, L, name, extreme: c.h, story: `the ${tf} candle poked up to ${fmt(c.h)}, touched ${name} (${fmt(L)}) and closed back under it at ${fmt(c.c)}: sellers defended the ceiling (a ${Math.round(up * 100)}% upper wick)` });
    if (c.l <= L * (1 + TOUCH) && c.c > L && dn >= 0.4) out.push({ fam: 'rejection', long: true, L, name, extreme: c.l, story: `the ${tf} candle dipped to ${fmt(c.l)}, touched ${name} (${fmt(L)}) and closed back above it at ${fmt(c.c)}: buyers defended the floor (a ${Math.round(dn * 100)}% lower wick)` });
    for (let k = 1; k <= 3 && i - k - 1 >= 0; k++) {
      const run = bars.slice(i - k, i);
      if (run.every(b => b.c < L) && bars[i - k - 1].c > L && c.c > L) { const lo = Math.min(...bars.slice(i - k, i + 1).map(b => b.l)); out.push({ fam: 'fake break', long: true, L, name, extreme: lo, story: `price closed under ${name} (${fmt(L)}) ${ago(k)}, then this ${tf} candle closed back above it at ${fmt(c.c)}: a FAKE BREAKDOWN. The sellers who sold the break are trapped and may have to buy back` }); break; }
      if (run.every(b => b.c > L) && bars[i - k - 1].c < L && c.c < L) { const hi = Math.max(...bars.slice(i - k, i + 1).map(b => b.h)); out.push({ fam: 'fake break', long: false, L, name, extreme: hi, story: `price closed above ${name} (${fmt(L)}) ${ago(k)}, then this ${tf} candle closed back under it at ${fmt(c.c)}: a FAKE BREAKOUT. The buyers who chased the break are trapped and may have to sell` }); break; }
    }
    for (let k = 1; k <= 6 && i - k - 1 >= 0; k++) {
      const run = bars.slice(i - k, i);
      if (bars[i - k - 1].c < L && run.every(b => b.c > L) && c.l <= L * (1 + TOUCH) && c.c > L && dn >= 0.3) { out.push({ fam: 'retest', long: true, L, name, extreme: c.l, story: `price broke above ${name} (${fmt(L)}) ${ago(k)}, came back to test it from above, and this ${tf} candle closed above it again at ${fmt(c.c)}: the old ceiling is now holding as a floor` }); break; }
      if (bars[i - k - 1].c > L && run.every(b => b.c < L) && c.h >= L * (1 - TOUCH) && c.c < L && up >= 0.3) { out.push({ fam: 'retest', long: false, L, name, extreme: c.h, story: `price broke under ${name} (${fmt(L)}) ${ago(k)}, came back up to test it, and this ${tf} candle closed under it again at ${fmt(c.c)}: the old floor is now acting as a ceiling` }); break; }
    }
  }
  // One per side: the most specific pattern leads, and a second pattern at the same level is mentioned with it
  return [false, true].flatMap(long => {
    const same = out.filter(x => x.long === long).sort((a, b) => PRIORITY.indexOf(a.fam) - PRIORITY.indexOf(b.fam));
    if (!same.length) return [];
    const st = same[0];
    st.also = same.filter(x => x.L === st.L && x.fam !== st.fam).map(x => x.fam);
    return [st];
  });
}
// Entry at the close, stop just past the extreme, target the next level. R (one unit of risk) is entry to stop; the
// R:R floor of 1 counts fees on both sides, exactly as the odds were measured
function plan(st, levels, close) {
  st.entry = close; st.stop = st.long ? st.extreme * (1 - PAD) : st.extreme * (1 + PAD);
  st.risk = Math.abs(st.entry - st.stop); st.fee = st.entry * COST;
  const tgt = st.long ? levels.find(([x]) => x > st.entry * (1 + GAP)) : levels.filter(([x]) => x < st.entry * (1 - GAP)).at(-1);
  if (!tgt) return st;
  [st.tgt, st.tgtName] = tgt;
  st.reward = Math.abs(st.tgt - st.entry);
  st.rr = (st.reward - st.fee) / (st.risk + st.fee);
  st.winR = (st.reward - st.fee) / st.risk; st.lossR = -(1 + st.fee / st.risk);
  return st;
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────────────────────────────
function boxOf(levels, price) {
  const below = levels.filter(([L]) => L < price), above = levels.filter(([L]) => L > price);
  return { floor: below.at(-1), floor2: below.at(-2), ceil: above[0], ceil2: above[1] };
}
// Setups that formed but paid less than they risked. Sent one hour at a time they flooded the chat (10 on Nov 10, while
// price chopped between lines $300 apart), so they wait for the next map as one line
function passedLine(passed) {
  const items = passed.slice(0, 6).map(p => `${est(p.t)} ${p.fam} ${side(p.long).toLowerCase()} at ${fmt(p.L)} (${p.rr == null ? 'nothing to aim for' : `stop ${fmt(p.risk)} away, target ${fmt(p.reward)} away`})`);
  return `PASSED since the last map: ${items.join('; ')}${passed.length > 6 ? `; and ${passed.length - 6} more` : ''}. ` +
    'These setups formed, but the stop had to sit further away than the next line, so they paid less than they risked. A trade like that loses over time even when it wins half the time, so a desk trader waits for room.';
}
function mapMessage(m, levels, T, s) {
  const price = m.h1.at(-1).c, b = boxOf(levels, price), w0 = T - H4, h4 = m.h1.filter(x => x.t >= w0);
  const key = [m.td, m.t4, b.floor?.[0], b.ceil?.[0]].join('|'), prev = s?.map;
  if (s && prev?.key === key && estHour(T) !== 7) return [];
  const cvd = h4.reduce((a, x) => a + x.d, 0), move = price - h4[0].o, oiPct = (m.oiAt(T) / m.oiAt(w0) - 1) * 100;
  const read = m.td === 'down' && m.t4 === 'down' ? 'sellers own the big picture'
    : m.td === 'up' && m.t4 === 'up' ? 'buyers own the big picture' : 'the big picture is split, so there is no clear side';
  const changed = [];
  if (prev && (prev.td !== m.td || prev.t4 !== m.t4)) changed.push(`the trend is now daily ${m.td}, 4h ${m.t4} (was daily ${prev.td}, 4h ${prev.t4})`);
  if (prev && (prev.floor !== b.floor?.[0] || prev.ceil !== b.ceil?.[0]) && b.floor && b.ceil && prev.floor && prev.ceil)
    changed.push(`the box moved ${b.floor[0] > prev.floor ? 'up' : 'down'} from ${fmt(prev.floor)}-${fmt(prev.ceil)} to ${fmt(b.floor[0])}-${fmt(b.ceil[0])}`);
  if (s) s.map = { key, T, td: m.td, t4: m.t4, floor: b.floor?.[0], ceil: b.ceil?.[0] };
  return [
    `MARKET MAP ${est(T)} (open your daily, 4h and 1h charts)`,
    ...(changed.length ? [`Changed since the ${est(prev.T)} map: ${changed.join('; ')}.`] : prev ? ['Nothing changed since the last map: same trend, same box.'] : []),
    `1) TREND, big picture first: daily ${TREND[m.td]}, 4h ${TREND[m.t4]}, 1h ${TREND[m.t1]}. Down means lower highs and lower lows with price under its average lines; when the daily and 4h agree, that's the side the bigger players are on: ${read}.`,
    `2) STRUCTURE, the lines to draw: price ${fmt(price)} sits between the floor ${b.floor ? `${fmt(b.floor[0])} (${b.floor[1]})` : 'none'} and the ceiling ${b.ceil ? `${fmt(b.ceil[0])} (${b.ceil[1]})` : 'none'}. ` +
      `Next ones out: ${b.floor2 ? `${fmt(b.floor2[0])} below` : 'nothing below'}, ${b.ceil2 ? `${fmt(b.ceil2[0])} above` : 'nothing above'}.`,
    `3) FLOW, last 4 hours (price ${signed(move)}): ${flowText(cvd, oiPct, move)}.`,
    `4) BIG ORDERS, last 4 hours: ${tapeText(tape(w0, T), move)}.`,
    `WHAT IT MEANS: ${read}; ${b.floor && b.ceil ? `inside ${fmt(b.floor[0])}-${fmt(b.ceil[0])} nobody is in control, so a desk trader waits. A 1h close above ${fmt(b.ceil[0])} or below ${fmt(b.floor[0])} is the next signal.` : 'price is outside the mapped levels.'}`,
    ...(s?.passed?.length ? [passedLine(s.passed.splice(0))] : []),
  ];
}
function changes(m, levels, s, T) {
  const out = [], c = m.h1.at(-1), p = m.h1.at(-2), name = ([L, n]) => `${n} (${fmt(L)})`;
  for (const dir of ['down', 'up']) {
    const down = dir === 'down';
    const crossed = levels.filter(([L]) => down ? p.c > L && c.c < L * (1 - BREAK) : p.c < L && c.c > L * (1 + BREAK));
    if (!crossed.length) continue;
    if (down) crossed.reverse(); // in the order price went through them
    const traps = crossed.filter(([L]) => { const r = s.breaks?.[Math.round(L)]; return r && r.dir !== dir && T - r.t <= 3 * H; });
    const hrs = ([L]) => Math.round((T - s.breaks[Math.round(L)].t) / H), b = boxOf(levels, c.c);
    const kind = down ? 'FAKE BREAKOUT (a trap): the buyers who chased it are stuck' : 'FAKE BREAKDOWN (a trap): the sellers who sold it are stuck';
    if (traps.length === crossed.length && crossed.length === 1)
      out.push(`MAP CHANGE ${est(T)}: the 1h closed back ${down ? 'UNDER' : 'ABOVE'} ${name(crossed[0])} at ${fmt(c.c)}, ${hrs(crossed[0])}h after breaking ${down ? 'above' : 'under'} it. That's a ${kind}. What it means: ${fmt(crossed[0][0])} is a ${down ? 'ceiling' : 'floor'} again.`);
    else
      out.push(`MAP CHANGE ${est(T)}: the 1h CLOSED ${down ? 'UNDER' : 'ABOVE'} ${list(crossed.map(name))} at ${fmt(c.c)}${crossed.length > 1 ? `: ${crossed.length} lines in one hour` : ''}. ` +
        `What it means: ${crossed.length > 1 ? `those ${down ? 'floors' : 'ceilings'}` : `that ${down ? 'floor' : 'ceiling'}`} broke on the hourly chart, and a broken ${down ? 'floor usually acts as a ceiling' : 'ceiling usually acts as a floor'}. ` +
        `Next ${down ? 'floor' : 'ceiling'}: ${(down ? b.floor : b.ceil) ? fmt((down ? b.floor : b.ceil)[0]) : 'none mapped'}.` +
        (traps.length ? ` And the move ${down ? 'above' : 'under'} ${list(traps.map(([L]) => fmt(L)))} ${hrs(traps[0])}h ago was a ${kind}.` : ''));
    for (const [L] of crossed) (s.breaks ??= {})[Math.round(L)] = { dir, t: T };
  }
  if (out.length) {
    const oiPct = (m.oiAt(T) / m.oiAt(c.t) - 1) * 100, move = c.c - c.o;
    out.push(`This hour: ${flowText(c.d, oiPct, move)}. ${tapeText(tape(c.t, T), move)}. Look at: the ${est(T)} candle on your 1h chart.`);
  }
  return out;
}
function alertMessage(st, m, c, T, id, tf) {
  const long = st.long, oiPct = (m.oiAt(T) / m.oiAt(c.t) - 1) * 100, move = c.c - c.o;
  const trendOk = long ? m.t4 === 'up' && m.td === 'up' : m.t4 === 'down' && m.td === 'down';
  const flowOk = oiPct >= 0 && (long ? c.d > 0 : c.d < 0), grade = trendOk && flowOk ? 'A' : 'B';
  const why = grade === 'A' ? 'with the big-picture trend and the flow' : !trendOk ? 'against the big-picture trend' : 'the flow does not agree';
  const proven = (cell(tf, st.fam, grade)?.meanR ?? -1) > 0;
  const fam = `${st.fam.toUpperCase()}${st.also.length ? ` (also a ${list(st.also)})` : ''}`;
  return { grade, lines: [
    proven ? `ALERT: ${side(long)}  (#${id}, ${tf} chart, Grade ${grade}: ${why})`
      : `PRACTICE: ${side(long)}  (#${id}, ${tf} chart, Grade ${grade}: ${why}. Setups like this have lost money on average after fees, so a desk trader would pass. Watch it to learn.)`,
    `Setup: ${fam} at ${st.name} (${fmt(st.L)}).`,
    `Why: (1) the setup: ${st.story}; (2) the big picture: daily ${TREND[m.td]}, 4h ${TREND[m.t4]}: this ${side(long).toLowerCase()} goes ${trendOk ? 'WITH' : 'AGAINST'} it; ` +
      `(3) flow in this candle: ${flowText(c.d, oiPct, move)}: ${flowOk ? 'it backs the setup' : 'it does not back the setup'}; (4) ${tapeText(tape(c.t, T), move)}.`,
    record(tf, st.fam, grade),
    `What: a trader would ${side(long).toLowerCase()} at the ${tf} close, put the stop just past ${st.fam === 'fake break' ? "the trap's extreme" : 'the wick'}, and aim for the next level, ${st.tgtName} (${fmt(st.tgt)}).`,
    `Entry: ${fmt(st.entry)} (the ${est(T)} ${tf} close)`,
    `SL: ${fmt(st.stop)} (just ${long ? 'under' : 'over'} ${fmt(st.extreme)}). That's ${fmt(st.risk)} dollars away: 1R, one unit of risk.`,
    `Target: ${fmt(st.tgt)}. If it gets there: about ${signed(st.winR, 1)}R after fees. If the stop hits: about ${st.lossR.toFixed(1)}R (fees make a loss bigger than 1R).`,
  ] };
}
const logAlert = (alerts, id, T, tf, st, grade) => alerts.push({ id, t: T, tf, fam: st.fam, also: st.also, grade, side: st.long ? 'long' : 'short', level: st.L, levelName: st.name,
  entry: st.entry, stop: st.stop, target: st.tgt, targetName: st.tgtName, rr: st.rr, status: 'open', source: 'coach' });

// ── Scoring: walk the 5m candles after each open setup (stop first, the same time limits as the backtest) ───────────
async function resolve(alerts, now) {
  const done = [];
  for (const a of alerts.filter(x => x.status === 'open')) {
    const long = a.side === 'long', risk = Math.abs(a.entry - a.stop), limit = a.tf === '15m' ? TIME_STOP['15m'] : TIME_STOP['1h'];
    for (const x of await j(`/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=${a.t}&limit=1000`)) {
      const t = +x[0], hi = +x[2], lo = +x[3], c = +x[4];
      if (t + M5 > now) break;
      const hitStop = long ? lo <= a.stop : hi >= a.stop, hitTgt = long ? hi >= a.target : lo <= a.target;
      if (!hitStop && !hitTgt && t + M5 < a.t + limit) continue;
      a.exit = hitStop ? a.stop : hitTgt ? a.target : c;
      a.status = hitStop ? 'stop' : hitTgt ? 'target' : 'time';
      a.exitT = t + M5;
      a.grossR = (long ? a.exit - a.entry : a.entry - a.exit) / risk;
      a.netR = a.grossR - a.entry * COST / risk;
      done.push(a); break;
    }
  }
  return done;
}
function score(alerts) {
  const closed = alerts.filter(a => a.status !== 'open');
  const by = g => { const x = closed.filter(a => (a.grade || 'A') === g); const w = x.filter(a => a.netR > 0).length; return `Grade ${g}: ${x.length} closed, ${w} won, ${signed(x.reduce((s, a) => s + a.netR, 0), 1)}R`; };
  return `${by('A')}; ${by('B')}; ${alerts.length - closed.length} open`;
}

// ── The 1h close at T, or the heads-up 5 minutes before it (T = 5 minutes before the close) ──────────────────────────
async function step(T, s, alerts, { headsUp = false } = {}) {
  const out = [];
  if (!s.levels || T - (s.levelsAt || 0) > H) { s.levels = await keyLevels(); s.levelsAt = T; }
  const levels = s.levels;
  if (headsUp) {
    // The forming candle as if it closed now: speak only if that would change the map or complete a setup
    const m = await market(T), forming = bar((await j('/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=1'))[0]), close = T + 5 * MIN;
    m.h1.push(forming);
    const ch = changes(m, levels, { breaks: structuredClone(s.breaks || {}) }, close).filter(x => x.startsWith('MAP CHANGE'));
    const st = setups(m.h1, m.h1.length - 1, levels, '1h').map(x => plan(x, levels, forming.c)).filter(x => x.rr >= 1);
    if (ch.length || st.length)
      out.push(`HEADS-UP: the ${est(close)} 1h close is in 5 minutes. If it closes like this (now ${fmt(forming.c)}):`,
        ...ch.map(x => `- ${x.replace(/^MAP CHANGE .*? EST: /, '')}`),
        ...st.map(x => `- a ${x.fam.toUpperCase()} ${side(x.long)} setup at ${x.name} (${fmt(x.L)}) forms: ${x.story}.`),
        'Not final: the candle can still change. Watch the close on your 1h chart.');
    return out;
  }
  const m = await market(T), c = m.h1.at(-1);
  if (!c || c.ct !== T) return out;
  if (!REPLAY) for (const a of await resolve(alerts, T))
    out.push(`RESULT #${a.id} (${a.tf === '15m' ? '15m' : '1h'} Grade ${a.grade || 'A'} ${a.side === 'short' ? 'SELL' : 'BUY'} from ${est(a.t)} at ${fmt(a.entry)}): ${a.status === 'target' ? 'TARGET hit' : a.status === 'stop' ? 'STOP hit' : 'time limit'} at ${est(a.exitT)} (${fmt(a.exit)}), ${signed(a.netR, 1)}R after fees. Scorecard: ${score(alerts)}.`);
  if (Math.round(T / H) % 4 === 0) out.push(...mapMessage(m, levels, T, s));
  out.push(...changes(m, levels, s, T));
  for (const st of setups(m.h1, m.h1.length - 1, levels, '1h')) {
    const ck = `1h:${st.long}:${Math.round(st.L)}`;
    if (T - (s.cool?.[ck] || 0) < 3 * H) continue;
    (s.cool ??= {})[ck] = T;
    plan(st, levels, c.c);
    if (!(st.rr >= 1)) { (s.passed ??= []).push({ t: T, fam: st.fam, long: st.long, L: st.L, rr: st.rr, risk: st.risk, reward: st.reward }); continue; }
    const id = (alerts.at(-1)?.id || 0) + 1, msg = alertMessage(st, m, c, T, id, '1h');
    out.push(...msg.lines);
    logAlert(alerts, id, T, '1h', st, msg.grade);
  }
  return out;
}

// ── The 15m close at T: Grade A setups only ──────────────────────────────────────────────────────────────────────
async function step15(T, s, alerts) {
  if (!s.levels) { s.levels = await keyLevels(); s.levelsAt = T; }
  const [m, k] = await Promise.all([market(T), j(`/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=20&endTime=${T - 1}`)]);
  const bars = k.map(bar).filter(b => b.ct <= T), c = bars.at(-1), out = [];
  if (!c || c.ct !== T) return out;
  for (const st of setups(bars, bars.length - 1, s.levels, '15m')) {
    const ck = `15m:${st.long}:${Math.round(st.L)}`;
    if (T - (s.cool?.[ck] || 0) < H) continue;
    plan(st, s.levels, c.c);
    if (!(st.rr >= 1)) continue;
    const id = (alerts.at(-1)?.id || 0) + 1, msg = alertMessage(st, m, c, T, id, '15m');
    if (msg.grade !== 'A') continue;
    (s.cool ??= {})[ck] = T;
    out.push(...msg.lines);
    logAlert(alerts, id, T, '15m', st, msg.grade);
  }
  return out;
}

// ── Setup zone: price is about to reach the box's floor or ceiling, so a setup may form in the next 15m candles ──────
async function zone(T, s) {
  if (!s.levels) { s.levels = await keyLevels(); s.levelsAt = T; }
  const [tick, k, oi] = await Promise.all([j('/fapi/v1/ticker/price?symbol=BTCUSDT'), j('/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=1'),
    j('/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=6')]);
  const price = +tick.price, b = boxOf(s.levels, price), f = bar(k[0]), out = [];
  const oiAt = t => +(oi.filter(o => +o.timestamp <= t).at(-1) || oi[0]).sumOpenInterest;
  for (const [edge, ceil] of [[b.ceil, true], [b.floor, false]]) {
    if (!edge) continue;
    const [L, name] = edge, dist = Math.abs(price - L) / L, z = (s.zone ??= {})[Math.round(L)] ??= { armed: dist > ZONE, t: 0 };
    if (dist > REARM) z.armed = true;
    if (!z.armed || dist > ZONE || T - z.t < ZONE_GAP || T - (s.zoneAny || 0) < ZONE_ANY_GAP) continue;
    z.armed = false; z.t = T; s.zoneAny = T;
    const odds = ['rejection', 'fake break', 'retest'].map(fam => cell('15m', fam, 'all')?.oneR).filter(x => x != null).map(x => Math.round(x * 100));
    out.push(
      `SETUP ZONE ${est(T)}: BTC ${fmt(price)} is ${fmt(Math.abs(price - L))} dollars ${ceil ? 'under the ceiling' : 'above the floor'} ${fmt(L)} (${name}). Setups only form at lines like this: open your 15m chart and watch the next candles.`,
      `What to watch: REJECTION = a 15m candle reaches ${fmt(L)} and closes back ${ceil ? 'under' : 'above'} it with a long ${ceil ? 'upper' : 'lower'} wick (${ceil ? 'sellers' : 'buyers'} defend the line). ` +
        `BREAK = a 15m candle closes ${ceil ? 'above' : 'under'} ${fmt(L)} (${ceil ? 'buyers' : 'sellers'} take the line; then watch for a retest).`,
      `Flow so far this 15m: ${flowText(f.d, (oiAt(T) / oiAt(f.t) - 1) * 100, price - f.o)}.` +
        (odds.length ? ` Measured on BTC 2021-2026, what follows either outcome is close to a coin flip on the 15m chart (${Math.min(...odds)}-${Math.max(...odds)} of 100), so watch it as practice in reading who wins the line.` : ''));
    break; // one zone at a time
  }
  return out;
}

// ── The learner's chart: floors, ceilings and the box drawn on TradingView (chart-draw.js) ──────────────────────────
// Drawn from the last 1h close, not the live price, which would recolour a line each time it is crossed and re-crossed.
// Checked every minute so a busy or closed TradingView is retried, but it only redraws when the picture changed.
async function drawChart(t, s) {
  if (!s.levels) return;
  const d = s.draw ??= {}, hour = Math.floor(t / H) * H;
  if (d.at !== hour) { d.price = bar((await j(`/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=1&endTime=${hour - 1}`))[0]).c; d.at = hour; }
  d.status = await syncChart(d, s.levels, d.price, hour);
}

async function main() {
  if (process.argv.includes('--map')) {
    const T = Math.floor(Date.now() / H) * H;
    console.log(mapMessage(await market(T), await keyLevels(), T).join('\n'));
    return;
  }
  if (REPLAY) {
    const i = process.argv.indexOf('--replay'), from = +process.argv[i + 1], to = +process.argv[i + 2], s = {}, alerts = [];
    for (let T = Math.ceil(from / M15) * M15; T <= Math.min(to, Date.now() - 20_000); T += M15) { // a future T would read the forming candle as closed
      const out = [...(T % H === 0 ? await step(T, s, alerts) : []), ...await step15(T, s, alerts)];
      if (out.length) console.log(`\n=== ${est(T)} ===\n${out.join('\n')}`);
    }
    for (const a of alerts) {
      const [r] = await resolve([a], Date.now());
      console.log(`OUTCOME #${a.id} Grade ${a.grade} ${a.side} ${a.fam} @ ${fmt(a.entry)} ${est(a.t)} -> ${r ? `${r.status} ${signed(r.netR, 1)}R at ${est(r.exitT)}` : 'still open'}`);
    }
    return;
  }
  // Live: wake 20s after every minute. Closes missed while the caller was relaying (up to 5 minutes) are caught up first
  const s = loadJSON(STATE, {}), alerts = loadJSON(ALERTS, []);
  const tick = async (t, live) => {
    const min = new Date(t).getUTCMinutes(), out = [];
    if (live && min === 55) out.push(...await step(t, s, alerts, { headsUp: true }));
    if (min === 0) out.push(...await step(t, s, alerts));
    if (min % 15 === 0) out.push(...await step15(t, s, alerts));
    if (live) out.push(...await zone(t, s));
    if (live) try { await drawChart(t, s); } catch (e) { s.draw.status = `failed: ${e.message}`; }
    s.lastTick = t;
    fs.writeFileSync(STATE, JSON.stringify(s));
    fs.mkdirSync(path.dirname(ALERTS), { recursive: true }); fs.writeFileSync(ALERTS, JSON.stringify(alerts, null, 2));
    return out;
  };
  const now = Math.floor(Date.now() / MIN) * MIN, missed = [];
  for (let t = Math.max((s.lastTick || now) + MIN, now - 5 * MIN); t < now; t += MIN) missed.push(t);
  const caught = [];
  for (const t of missed) { try { caught.push(...await tick(t, false)); } catch { /* network: skip it */ } }
  if (caught.length) { console.log(caught.join('\n')); process.exit(0); }
  const loop = () => {
    const wake = Math.floor(Date.now() / MIN) * MIN + MIN + 20_000;
    setTimeout(async () => {
      try {
        const out = await tick(Math.floor(Date.now() / MIN) * MIN, true);
        if (out.length) { console.log(out.join('\n')); process.exit(0); }
      } catch { /* network: try again next minute */ }
      loop();
    }, wake - Date.now());
  };
  loop();
}
main().catch(e => { console.log('FAILED:', e.message); process.exit(1); });
