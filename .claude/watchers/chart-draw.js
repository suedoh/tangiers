'use strict';
// Keeps the coach's floors, ceilings and boxes on the learner's TradingView chart in step with the market map, so the
// lines in the messages are the lines on the chart. It only ever removes shapes it drew itself (their ids live in the
// coach state), never the learner's own drawings, and it holds the shared .tradingview-lock so it cannot collide with
// the pipeline's CDP sweeps of the same chart. It stays on one chart tab (remembered in the state) and skips a redraw,
// rather than hopping tabs, when that tab no longer shows BTCUSDT.P.
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const CDP = require(path.join(ROOT, 'tradingview-mcp', 'node_modules', 'chrome-remote-interface'));
const { acquireLock, releaseLock } = require(path.join(ROOT, 'scripts', 'lib', 'lock'));

const SYMBOL = 'BINANCE:BTCUSDT.P', PORT = 9222, H = 3_600_000, H6 = 6 * H;
const STYLE = 2; // bump when the look changes, so the next check redraws
const RANGE = 0.022; // lines within 2.2% of price: about what the 1h chart shows
const MERGE = 0.002; // levels closer than 0.2% read as one zone ($117 apart on Nov 11, their labels overlapped)
const RED = '#f23645', GREEN = '#22ab94', BLUE = '#2962ff', AMBER = '#f7a600';
const FILL = { [RED]: 'rgba(242, 54, 69, 0.12)', [GREEN]: 'rgba(34, 171, 148, 0.15)', [BLUE]: 'rgba(41, 98, 255, 0.12)', [AMBER]: 'rgba(247, 166, 0, 0.15)' };
const API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const fmt = n => Math.round(n).toLocaleString('en-US');

// What belongs on the chart for this price: each level as a line, close levels merged into a zone, and the box price
// sits in (the nearest floor to the nearest ceiling), drawn from when price entered it
function layout(levels, price, T, s) {
  const groups = [];
  for (const lv of levels.filter(([L]) => Math.abs(L / price - 1) <= RANGE)) {
    const g = groups.at(-1);
    if (g && lv[0] / g.at(-1)[0] - 1 < MERGE) g.push(lv); else groups.push([lv]);
  }
  // Box edges move in 6h steps, so the drawing changes when the map does rather than every hour
  const sec = t => Math.floor(t / 1000), to = sec(Math.ceil((T + H6) / H6) * H6), from = sec(Math.floor(T / H6) * H6 - 24 * H), shapes = [];
  let inside = false;
  for (const g of groups) {
    const lo = g[0][0], hi = g.at(-1)[0], at = lo <= price && price <= hi, ceil = lo > price;
    const color = at ? AMBER : ceil ? RED : GREEN, kind = at ? 'PRICE IS IN' : ceil ? 'CEILING' : 'FLOOR';
    inside ||= at;
    if (g.length === 1) shapes.push({ type: 'line', price: lo, time: sec(T), color, text: `${kind} ${fmt(lo)}  ${g[0][1].replace(/^the /, '')}` });
    else shapes.push({ type: 'box', top: hi, bottom: lo, from, to, color, fill: FILL[color], text: `${kind} ZONE ${fmt(lo)}-${fmt(hi)}` });
  }
  // Inside a zone the zone itself is where price is; a box drawn around it would cover the zone
  const below = groups.filter(g => g.at(-1)[0] < price), above = groups.filter(g => g[0][0] > price);
  if (!inside && below.length && above.length) {
    const floor = below.at(-1).at(-1)[0], ceil = above[0][0][0], key = `${Math.round(floor)}|${Math.round(ceil)}`;
    if (s.boxKey !== key) { s.boxKey = key; s.boxSince = Math.floor(T / H) * H; }
    shapes.push({ type: 'box', top: ceil, bottom: floor, from: sec(s.boxSince), to, color: BLUE, fill: FILL[BLUE], text: 'BOX: WAIT' });
  }
  return shapes;
}

const evaluate = async (c, expression) => {
  const r = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value ?? null;
};
// Remove the coach's old shapes (only those that still exist) and draw the new ones; returns the new ids
const pageScript = (oldIds, shapes) => `(async function () {
  var api = ${API}, old = ${JSON.stringify(oldIds)}, specs = ${JSON.stringify(shapes)}, ids = [];
  var have = api.getAllShapes().map(function (s) { return s.id; });
  old.forEach(function (id) { if (have.indexOf(id) > -1) api.removeEntity(id); });
  for (var i = 0; i < specs.length; i++) {
    var s = specs[i];
    if (s.type === 'line') ids.push(await api.createShape({ time: s.time, price: s.price }, { shape: 'horizontal_line', text: s.text,
      overrides: { linecolor: s.color, linewidth: 2, linestyle: 0, showLabel: true, textcolor: s.color, fontsize: 12, bold: true, horzLabelsAlign: 'left', vertLabelsAlign: 'bottom' } })); // 'bottom' = text above the line
    else ids.push(await api.createMultipointShape([{ time: s.from, price: s.top }, { time: s.to, price: s.bottom }], { shape: 'rectangle', text: s.text,
      overrides: { color: s.color, backgroundColor: s.fill, fillBackground: true, linewidth: 1, extendLeft: false, extendRight: false,
        textColor: s.color, fontSize: 12, bold: true, horzLabelsAlign: 'right', vertLabelsAlign: 'middle' } }));
  }
  return ids;
})()`;

async function openChart(s) {
  const tabs = (await CDP.List({ host: 'localhost', port: PORT })).filter(t => /tradingview\.com\/chart\//.test(t.url));
  const candidates = s.chart ? tabs.filter(t => t.url.includes(`/chart/${s.chart}/`)) : tabs;
  for (const t of candidates) {
    const c = await CDP({ host: 'localhost', port: PORT, target: t.id });
    try {
      await c.Runtime.enable();
      if (await evaluate(c, `${API}.symbol()`) === SYMBOL) return { c, id: t.url.match(/\/chart\/([^/]+)\//)[1] };
    } catch { /* not a chart page */ }
    await c.close();
  }
  return null;
}

// Redraw only when the picture changed. Returns what happened, for the coach state
async function syncChart(s, levels, price, T) {
  const shapes = layout(levels, price, T, s);
  const key = JSON.stringify([STYLE, ...shapes.map(x => [x.type, x.color, Math.round(x.price ?? x.top), Math.round(x.bottom ?? 0), x.from ?? 0, x.to ?? 0, x.text])]);
  if (s.drawn?.key === key) return 'unchanged';
  const lock = await acquireLock(10_000, 'btc-coach-draw'); // the coach retries next minute, so no long wait here
  if (!lock) return 'tradingview busy';
  let chart = null;
  try {
    chart = await openChart(s);
    if (!chart) return 'no BTCUSDT.P chart';
    s.chart = chart.id;
    s.drawn = { key, ids: await evaluate(chart.c, pageScript(s.drawn?.ids || [], shapes)) };
    return `drew ${shapes.length}`;
  } finally {
    try { await chart?.c.close(); } catch { /* already closed */ }
    releaseLock(lock);
  }
}

module.exports = { syncChart, layout };
