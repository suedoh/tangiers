#!/usr/bin/env node
'use strict';

/**
 * scripts/research/walkforward-model.js — the strong falsification (spec 07.3).
 *
 * The hypothesis battery tests ten hand-picked rules. This asks the harder
 * question: does ANY linear combination of the feature set predict the
 * symmetric ±k×ATR outcome out of sample? If a walk-forward logistic model
 * cannot beat the drift benchmark on unseen data, "no edge in these features"
 * stops being an opinion about ten rules and becomes a statement about the
 * information itself.
 *
 * Protocol (fixed before running):
 *   - Rolling origin. Train on TRAIN_DAYS, predict the next TEST_DAYS, advance.
 *     A row is scored exactly once, always by a model that never saw it.
 *   - Standardisation uses TRAIN-window mean/sd only. Leaking the test window's
 *     scale is the classic way to manufacture an edge that does not exist.
 *   - L2-regularised logistic regression, batch gradient descent. Deliberately
 *     boring: if a real edge needs a fancier learner to appear at these sample
 *     sizes, it is noise.
 *   - PRIMARY CELL: out-of-sample hit rate over rows where |p − 0.5| ≥ MARGIN.
 *     The margin grid is reported as a descriptive curve, not as separate
 *     hypothesis cells — one primary number, declared in advance.
 *   - Benchmark is NOT 50%. It is the always-long rate on the same OOS rows,
 *     because BTC drifts and drift is free.
 *
 * Usage:
 *   node scripts/research/walkforward-model.js --data .market-data-cache/ds-k1.json
 */

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { wilson, makeRng } = require('../audit/falsification');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

const TRAIN_DAYS = Number(arg('train', 180));
const TEST_DAYS  = Number(arg('test', 30));
const MARGIN     = Number(arg('margin', 0.02));
const L2         = Number(arg('l2', 1.0));
const ITERS      = Number(arg('iters', 400));
const LR         = Number(arg('lr', 0.5));

const FEATURES = ['ret6h', 'ret24h', 'ret7d', 'emaSpread', 'rsi', 'rangePos',
                  'vwapDist', 'imb', 'imbZ', 'volZ', 'bodyRatio', 'atrPct', 'atrPctl'];

const sigmoid = z => 1 / (1 + Math.exp(-z));

function standardise(train, test, feats) {
  const stats = feats.map(f => {
    let s = 0, n = 0;
    for (const r of train) { const v = r[f]; if (Number.isFinite(v)) { s += v; n++; } }
    const mean = n ? s / n : 0;
    let ss = 0;
    for (const r of train) { const v = r[f]; if (Number.isFinite(v)) ss += (v - mean) ** 2; }
    const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 1;
    return { mean, sd: sd > 0 ? sd : 1 };
  });
  const enc = rows => rows.map(r => feats.map((f, j) => {
    const v = r[f];
    return Number.isFinite(v) ? (v - stats[j].mean) / stats[j].sd : 0;
  }));
  return { X: enc(train), Xt: enc(test) };
}

function fitLogistic(X, y, { l2 = L2, iters = ITERS, lr = LR } = {}) {
  const d = X[0].length, n = X.length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const e = sigmoid(z) - y[i];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
    }
    b -= lr * gb / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j] / n);
  }
  return { w, b };
}

const predict = (m, x) => sigmoid(m.b + x.reduce((s, v, j) => s + v * m.w[j], 0));

function clusteredCI(items, B = 10000, rng = makeRng(11)) {
  const byDay = new Map();
  for (const it of items) {
    const d = Math.floor(it.t / 86_400_000);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(it.hit);
  }
  const days = [...byDay.values()];
  if (days.length < 5) return [null, null];
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, m = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[Math.floor(rng() * days.length)];
      for (const x of d) { s += x; m++; }
    }
    means.push(m ? s / m : 0);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * B)], means[Math.floor(0.975 * B)]];
}

(function main() {
  const dataFile = arg('data', path.join(ROOT, '.market-data-cache', 'ds-k1.json'));
  const { meta, rows } = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  rows.sort((a, b) => a.t - b.t);

  const DAY = 86_400_000;
  const t0 = rows[0].t, tEnd = rows[rows.length - 1].t;

  const atrPcts = rows.map(r => r.atrPct).sort((a, b) => a - b);
  const medAtr = atrPcts[Math.floor(atrPcts.length / 2)];
  const feeR = 0.0008 / (meta.k * medAtr);
  const breakEven = (1 + feeR) / 2;

  console.log('═══ Walk-forward logistic model ═══');
  console.log(`data     ${path.relative(ROOT, dataFile)}  (±${meta.k}×ATR, ${meta.horizonH}h)`);
  console.log(`protocol train ${TRAIN_DAYS}d → test ${TEST_DAYS}d, rolling; ${FEATURES.length} features, L2=${L2}`);
  console.log(`primary  OOS hit rate where |p−0.5| ≥ ${MARGIN}`);
  console.log(`hurdle   break-even ${(100 * breakEven).toFixed(1)}% (fee ${feeR.toFixed(3)}R)\n`);

  const oos = [];
  let folds = 0;
  for (let start = t0; start + (TRAIN_DAYS + TEST_DAYS) * DAY <= tEnd; start += TEST_DAYS * DAY) {
    const trEnd = start + TRAIN_DAYS * DAY;
    const teEnd = trEnd + TEST_DAYS * DAY;
    const train = rows.filter(r => r.t >= start && r.t < trEnd);
    const test  = rows.filter(r => r.t >= trEnd && r.t < teEnd);
    if (train.length < 500 || test.length < 50) continue;
    folds++;

    const { X, Xt } = standardise(train, test, FEATURES);
    const model = fitLogistic(X, train.map(r => r.upFirst));
    for (let i = 0; i < test.length; i++) {
      const p = predict(model, Xt[i]);
      oos.push({ t: test[i].t, p, y: test[i].upFirst });
    }
    process.stderr.write(`\r  fold ${folds}: train ${train.length} → test ${test.length}   `);
  }
  process.stderr.write('\n');

  console.log(`folds ${folds} | OOS rows ${oos.length} | `
    + `${new Date(oos[0].t).toISOString().slice(0, 10)} → ${new Date(oos[oos.length - 1].t).toISOString().slice(0, 10)}\n`);

  const alwaysLongAll = oos.filter(o => o.y === 1).length / oos.length;
  console.log(`always-long on OOS rows: ${(100 * alwaysLongAll).toFixed(2)}%  ← the benchmark to beat\n`);

  console.log('margin   traded    hit%   Wilson95        clustered95     alwaysLong   lift-vs-drift');
  console.log('─'.repeat(88));
  for (const m of [0, 0.01, 0.02, 0.03, 0.05, 0.10]) {
    const sel = oos.filter(o => Math.abs(o.p - 0.5) >= m);
    if (sel.length < 50) { console.log(`${m.toFixed(2).padStart(6)}   ${String(sel.length).padStart(6)}    (too few)`); continue; }
    const items = sel.map(o => ({ t: o.t, hit: ((o.p > 0.5) === (o.y === 1)) ? 1 : 0 }));
    const k = items.reduce((s, x) => s + x.hit, 0);
    const [, lo, hi] = wilson(k, items.length);
    const [clo, chi] = clusteredCI(items);
    const al = sel.filter(o => o.y === 1).length / sel.length;
    const drift = Math.max(al, 1 - al);
    const star = m === MARGIN ? ' ←primary' : '';
    console.log(
      m.toFixed(2).padStart(6) +
      String(sel.length).padStart(9) +
      (100 * k / items.length).toFixed(2).padStart(8) + '   ' +
      `[${(100 * lo).toFixed(1)},${(100 * hi).toFixed(1)}]`.padEnd(16) +
      (clo == null ? '—'.padEnd(16) : `[${(100 * clo).toFixed(1)},${(100 * chi).toFixed(1)}]`.padEnd(16)) +
      (100 * al).toFixed(1).padStart(10) +
      (100 * (k / items.length - drift)).toFixed(2).padStart(14) + 'pp' + star);
  }

  // Per-fold stability at the primary margin: an edge that only lives in a
  // couple of folds is a regime artefact, not an edge.
  const sel = oos.filter(o => Math.abs(o.p - 0.5) >= MARGIN);
  const byMonth = new Map();
  for (const o of sel) {
    const d = new Date(o.t), key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, [0, 0]);
    const e = byMonth.get(key);
    e[0] += ((o.p > 0.5) === (o.y === 1)) ? 1 : 0; e[1]++;
  }
  const months = [...byMonth.entries()].sort();
  const winning = months.filter(([, [k, n]]) => k / n > 0.5).length;
  console.log(`\nmonthly OOS (primary margin): ${winning}/${months.length} months above 50%`);
  console.log('  ' + months.map(([m, [k, n]]) => `${m.slice(2)} ${(100 * k / n).toFixed(0)}%`).join('  '));

  if (arg('json')) {
    fs.writeFileSync(arg('json'), JSON.stringify({ meta, folds, oosRows: oos.length, alwaysLongAll, breakEven }, null, 2));
  }
})();
