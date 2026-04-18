// ── AI CHAT ────────────────────────────────────────────────────────────────
const aiHistory = [];

// ── Chat history logging ──────────────────────────────────────────────────
// How many messages to send as context on each turn.
// Change this one constant to adjust the sliding window everywhere.
const AI_CONTEXT_WINDOW = 10;

let aiConversationId = null; // UUID — created on first message, reset on page load
let aiMessageSeq     = 0;    // global sequence counter within a conversation

// Creates the conversation row on first message. Returns the UUID or null on failure.
async function aiEnsureConversation(model, firstMsg) {
  if (aiConversationId) return aiConversationId;
  try {
    const r = await fetch('/api/ai-conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, title: firstMsg.slice(0, 80) }),
    });
    const d = await r.json();
    aiConversationId = d.id || null;
    aiMessageSeq = 0;
  } catch(e) {
    console.warn('[ai-log] failed to create conversation:', e.message);
  }
  return aiConversationId;
}

// Inserts one message row. Returns the server-assigned UUID (from response body), or null.
async function aiLogMessage({ role, content, model, input_tokens, output_tokens, context_start_seq, tool_calls }) {
  if (!aiConversationId) return null;
  try {
    const r = await fetch('/api/ai-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id:   aiConversationId,
        seq:               aiMessageSeq++,
        role,
        content,
        model:             model             ?? null,
        input_tokens:      input_tokens      ?? null,
        output_tokens:     output_tokens     ?? null,
        context_start_seq: context_start_seq ?? null,
        tool_calls:        tool_calls        ?? null,
      }),
    });
    const d = await r.json();
    aiHistoryLoaded = false; // force history list refresh next time it's opened
    return d.id ?? null;
  } catch(e) {
    console.warn('[ai-log] failed to log message:', e.message);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function buildMacroContext() {
  const md = window._macroData || {};
  if (!Object.keys(md).length) return null;

  const f2  = v => v != null ? Number(v).toFixed(2) : '—';
  const sgn = v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';

  let tsv = 'MACRO\nticker|value|unit|7d|30d|trend\n';
  Object.entries(md).forEach(([ticker, d]) => {
    if (!d || d.current == null) return;
    tsv += `${ticker}|${f2(d.current)}|${d.unit}|${sgn(d.chg7d)}|${sgn(d.chg30d)}|${d.trend}\n`;
  });
  return tsv.trim();
}

// Tickers already covered in MARKET_FUNDAMENTALS (portfolio positions).
// Excluded from watchlist to avoid duplication.
function getPortfolioTickers() {
  if (!liveData || !liveData.assets) return new Set();
  return new Set(
    liveData.assets
      .filter(a => a.valueUSD > 0.5 && a.pos.category !== 'fiat')
      .map(a => a.pos.ticker === 'RSU_META' ? 'META' : a.pos.ticker)
  );
}

// Shared helpers and row builder used by both watchlist functions
function _wlHelpers() {
  const RL    = { 1:'StrongBuy', 2:'Buy', 3:'Hold', 4:'Underperf', 5:'Sell' };
  const f2    = v => (v != null && v !== '') ? Number(v).toFixed(2) : '';
  const fCap  = v => v ? '$' + (v / 1e9).toFixed(1) + 'B' : '';
  const rPos  = (p, lo, hi) => (!p || !lo || !hi || hi === lo)
    ? '' : ((p - lo) / (hi - lo) * 100).toFixed(0) + '%';
  const fDist = (a, b) => (a && b) ? ((a / b - 1) * 100).toFixed(1) + '%' : '';
  const fUp   = (target, price) => (target && price)
    ? (((target / price) - 1) * 100).toFixed(1) + '%' : '';
  const maSig = (price, ma50, ma200) => {
    if (!price || !ma50 || !ma200) return '';
    const above50  = price > ma50;
    const above200 = price > ma200;
    const diff = (ma50 - ma200) / ma200;
    if ( above50 &&  above200 && diff >  0.015) return 'golden_cross';
    if (!above50 && !above200 && diff < -0.015) return 'death_cross';
    if ( above50 &&  above200)                  return 'above_both';
    if (!above50 && !above200)                  return 'below_both';
    return 'between';
  };

  const HEADER = 'group|ticker|name|β|fwdPE|pos52w|dist_52hi|price|dist_ma200|ma_signal|target|upside|consensus|nAnalysts|earnings';

  const rowFor = (group, t, d, withCap = false) => {
    const p    = d.regularMarketPrice  ?? null;
    const lo52 = d.fiftyTwoWeekLow     ?? null;
    const hi52 = d.fiftyTwoWeekHigh    ?? null;
    const ma50  = d.fiftyDayAvg        ?? null;
    const ma200 = d.twoHundredDayAvg   ?? null;
    const rating = d.analystRating != null
      ? (RL[Math.round(d.analystRating)] || f2(d.analystRating)) : '';
    const cols = [
      group, t, (d.name || '').replace(/,.*/, ''),
      f2(d.beta), f2(d.forwardPE),
      rPos(p, lo52, hi52), fDist(p, hi52),
      f2(p), fDist(p, ma200), maSig(p, ma50, ma200),
      f2(d.analystTarget), fUp(d.analystTarget, p),
      rating, d.numberOfAnalysts || '', d.nextEarningsDate || '',
    ];
    if (withCap) cols.push(fCap(d.marketCap));
    return cols.join('|') + '\n';
  };

  return { HEADER, rowFor };
}

// BASE watchlist — always included, ~14 high-signal market reference tickers.
// Independent of portfolio. Portfolio tickers already in MARKET_FUNDAMENTALS are skipped.
function buildWatchlistBase() {
  const wl   = window._watchlistMeta || {};
  if (!Object.keys(wl).length) return null;
  const skip = getPortfolioTickers();
  const { HEADER, rowFor } = _wlHelpers();

  const BASE = [
    // Broad benchmarks
    ['Benchmark', 'SPY'],
    ['Benchmark', 'VWRP.L'],
    ['Benchmark', 'QQQ'],
    ['Benchmark', 'DIA'],
    ['Benchmark', 'IWM'],
    // Value / quality reference
    ['Core',      'BRK-B'],
    // Key megacap references
    ['MegaTech',  'NVDA'],
    ['MegaTech',  'GOOGL'],
    ['MegaTech',  'TSLA'],
    // Macro / risk references
    ['Bonds',     'TLT'],
    ['Commod',    'GLD'],
    ['Defensive', 'WMT'],
    ['EM',        'EEM'],
    ['Crypto',    'BTC-USD'],
  ];

  let tsv = 'WATCHLIST_BASE\n' + HEADER + '\n';
  let count = 0;
  BASE.forEach(([group, t]) => {
    if (skip.has(t)) return; // already in MARKET_FUNDAMENTALS, skip to avoid duplication
    const d = wl[t];
    if (!d) return;
    tsv += rowFor(group, t, d, false);
    count++;
  });
  return count > 0 ? tsv.trim() : null;
}

// EXTENDED watchlist — only added when user message triggers keywords.
// Grouped by theme. Includes cap column for less-known tickers.
function buildWatchlistExtended() {
  const wl   = window._watchlistMeta || {};
  if (!Object.keys(wl).length) return null;
  const skip = getPortfolioTickers();
  const { HEADER, rowFor } = _wlHelpers();

  // Skip tickers already shown in base or portfolio
  const BASE_SET = new Set([
    'SPY','VWRP.L','QQQ','DIA','IWM','BRK-B',
    'NVDA','GOOGL','TSLA','TLT','GLD','WMT','EEM','BTC-USD'
  ]);

  const EXTENDED_GROUPS = {
    'MegaTech':  ['AAPL','AMZN','TSM'],        // MSFT removed — in portfolio; NVDA/GOOGL/TSLA in base
    'Defensive': ['KO','MCD','JNJ','XOM'],      // WMT in base
    'ETF_US':    ['VNQ','XLK','XLF','XLE','SOXX','ICLN'],
    'Dividend':  ['VIG','SCHD'],
    'EM':        ['INDA','EWZ','ARGT','ILF'],   // EEM in base
    'China':     ['FXI','KWEB','BABA'],
    'Latam':     ['YPF','PBR','GGAL'],
    'Bonds':     ['IEF','HYG'],                 // TLT in base
    'UK':        ['IGLT.L','VUKE.L'],
    'Commod':    ['SLV','USO','PDBC'],          // GLD in base
    'Crypto':    ['ETH-USD','ADA-USD','SOL-USD'], // BTC-USD in base
  };

  let tsv = 'WATCHLIST_EXTENDED\n' + HEADER + '|cap\n';
  let count = 0;
  Object.entries(EXTENDED_GROUPS).forEach(([group, tickers]) => {
    tickers.forEach(t => {
      if (skip.has(t) || BASE_SET.has(t)) return;
      const d = wl[t];
      if (!d) return;
      tsv += rowFor(group, t, d, true);
      count++;
    });
  });
  return count > 0 ? tsv.trim() : null;
}

// Returns true only when the USER's message references watchlist-relevant intent
// or specific extended tickers/themes — to avoid including extended on every turn.
function needsExtendedWatchlist(userMsg) {
  const m = userMsg.toLowerCase();
  const keywords = [
    // intent
    'watchlist','comprar','agregar','comparar','busco','oportunidad',
    'qué está barato','que esta barato',
    'fundamentals','fwd pe','forward pe','compro','screener',
    'qué comprarías','que comprarias','dónde metería','donde meteria',
    'alternativa','diversificar','rotar','rotación','rotacion',
    // rioplatense / coloquial
    'pongo plata',
    'vale la pena','conviene','qué conviene','que conviene',
    'fuera del portfolio','afuera del portfolio','por fuera',
    'algo interesante','algo lindo','algo bueno',
    // extended tickers (any mention pulls the full extended block)
    'aapl','amzn','tsm','ko','mcd','jnj','xom','vnq','xlk','xlf','xle',
    'soxx','icln','vig','schd','inda','ewz','argt','ilf','fxi','kweb',
    'baba','ief','hyg','iglt','vuke','slv','uso','pdbc','eth','sol',
    'ypf','pbr','ggal',
  ];
  return keywords.some(k => m.includes(k));
}

function buildHealthContext() {
  if (typeof computeHealthData !== 'function') return '';
  const d = computeHealthData();
  if (!d) return '';

  const topStock = d.topNonBroadETF.ticker === 'RSU_META' ? 'META' : d.topNonBroadETF.ticker;
  const sectors = Object.entries(d.sectorMap).sort((a, b) => b[1] - a[1]).map(([s, w]) => `${s} ${(w*100).toFixed(0)}%`).join(', ');

  let ctx = 'HEALTH_SCORE\n';
  ctx += `total: ${d.healthScore}/100 (div 20% risk 20% val 15% fx 15% conc 15% income 15%)\n`;
  ctx += `excl: RENT_DEPOSIT+EMERGENCY_FUND (except fx+income scores)\n\n`;

  ctx += 'HEALTH_METRICS\n';
  ctx += `diversification: score ${d.subscores[0].score} | HHI_norm ${(d.hhiNorm*100).toFixed(1)}% | effective_n ${d.effectiveN.toFixed(1)}\n`;
  ctx += `risk_alignment: score ${d.subscores[1].score} | beta ${d.portfolioBeta.toFixed(2)} | vol ${d.portfolioVol.toFixed(1)}% | dd_correction -${d.ddCorrection.toFixed(0)}% | dd_bear -${d.ddBearMarket.toFixed(0)}%\n`;
  ctx += `valuation: score ${d.subscores[2].score}` + (d.portfolioPE ? ` | fwd_PE ${d.portfolioPE.toFixed(1)}x vs SPY ~21x` : ' | no PE') + `\n`;
  ctx += `currency: score ${d.subscores[3].score} | GBP ${(d.gbpPct*100).toFixed(0)}% USD ${(d.usdPct*100).toFixed(0)}%\n`;
  ctx += `concentration: score ${d.subscores[4].score} | top_stock ${topStock} ${(d.topNonBroadETF.w*100).toFixed(1)}%\n`;
  ctx += `income: score ${d.subscores[5].score} | rsu_flow/portfolio ${(d.incomeRatio*100).toFixed(0)}%\n`;
  ctx += `sectors: ${sectors}\n`;

  return ctx;
}

function buildMarketContext() {
  const mm = window._marketMeta || {};

  const FALLBACK = {
    'META':    { beta: 1.3,  trailingPE: 25 },
    'SPY':     { beta: 1.0,  trailingPE: 22, dividendYield: 0.013 },
    'VWRP.L':  { beta: 0.95, trailingPE: 18 },
    'BRK-B':   { beta: 0.9,  trailingPE: 22 },
    'BTC-USD': { beta: 1.8 },
    'MELI':    { beta: 1.6,  trailingPE: 55 },
    'NU':      { beta: 1.5,  trailingPE: 40 },
    'ARKK':    { beta: 1.4 },
    'ARKK.L':  { beta: 1.4 },
  };

  const f2   = v => (v != null) ? Number(v).toFixed(2) : '';
  const fPct = v => (v != null) ? (Number(v) * 100).toFixed(2) + '%' : '';
  const fCap = v => v ? '$' + (v / 1e9).toFixed(1) + 'B' : '';
  const rPos = (p, lo, hi) => (!p || !lo || !hi || hi === lo) ? '' : ((p - lo) / (hi - lo) * 100).toFixed(0) + '%';
  const RL = { 1:'StrongBuy', 2:'Buy', 3:'Hold', 4:'Underperf', 5:'Sell' };

  const liveTickers  = Object.keys(mm);
  const allTickers   = [...new Set([...liveTickers, ...Object.keys(FALLBACK)])];
  const tickers      = allTickers.filter(t => mm[t] || FALLBACK[t]);

  let tsv = 'MARKET_FUNDAMENTALS\nsource: ' + (liveTickers.length > 0 ? 'Yahoo Finance live' : 'static fallbacks') + '\n';
  tsv += 'ticker|β|PE|fwdPE|P/B|yield|52wLo|52wHi|pos52w|MA50|MA200|price|target|consensus|nAnalysts|earnings|cap|shortRatio\n';

  tickers.forEach(t => {
    const live = mm[t] || {};
    const fb   = FALLBACK[t] || {};
    // Skip if no live data at all (pure fallback with no price = useless row)
    if (!live.regularMarketPrice && !fb.trailingPE && !fb.beta) return;
    const price = live.regularMarketPrice ?? null;
    const lo52  = live.fiftyTwoWeekLow ?? null;
    const hi52  = live.fiftyTwoWeekHigh ?? null;
    // BRK.B P/B from Yahoo is a known data error
    const ptb   = (t === 'BRK.B' || t === 'BRK-B') ? null : (live.priceToBook ?? null);

    tsv += [t,
      f2(live.beta ?? fb.beta), f2(live.trailingPE ?? fb.trailingPE), f2(live.forwardPE),
      f2(ptb), fPct(live.dividendYield ?? fb.dividendYield),
      f2(lo52), f2(hi52), rPos(price, lo52, hi52),
      f2(live.fiftyDayAvg), f2(live.twoHundredDayAvg), f2(price),
      f2(live.analystTarget),
      live.analystRating != null ? (RL[Math.round(live.analystRating)] || f2(live.analystRating)) : '',
      live.numberOfAnalysts || '', live.nextEarningsDate || '', fCap(live.marketCap),
      f2(live.shortRatio)
    ].join('|') + '\n';
  });

  return tsv.trim();
}

// ── CORRELATION CONTEXT ───────────────────────────────────────────────────────
function buildCorrelationContext() {
  // corrAllRows is cached in analytics.js after the Correlation tab is first opened.
  // If not loaded yet (user never opened that tab), skip gracefully — no blocking fetch.
  if (typeof corrAllRows === 'undefined' || !corrAllRows || !Array.isArray(corrAllRows)) return null;
  if (!liveData || !liveData.assets) return null;

  const EXCLUDED = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND', 'GBP_LIQUID']);
  const portfolioAssets = liveData.assets.filter(
    a => a.pos.category !== 'fiat' && !EXCLUDED.has(a.pos.ticker) && a.valueUSD > 0.5
  );
  if (portfolioAssets.length < 2) return null;

  const totalInvested = portfolioAssets.reduce((s, a) => s + a.valueUSD, 0);
  function dispT(t) { return t.replace('RSU_META', 'META').replace('.L', ''); }

  // Use 90d as primary period for the agent (most recent signal)
  const PRIMARY = 90;
  const rows90 = corrAllRows.filter(r => r.period_days === PRIMARY);
  if (rows90.length === 0) return null;

  // Build lookup map for 90d
  const corrMap = {};
  rows90.forEach(r => { corrMap[`${r.ticker_a}|${r.ticker_b}`] = r.correlation; });
  function getCorr(a, b) {
    return corrMap[`${a}|${b}`] ?? corrMap[`${b}|${a}`] ?? null;
  }

  const tickers = portfolioAssets.map(a => a.pos.ticker);
  const weights = {};
  portfolioAssets.forEach(a => { weights[a.pos.ticker] = a.valueUSD / totalInvested; });

  // ── 1. Correlations vs SPY (real, from correlation_matrix) ──
  const SPY_TICKER = 'SPY';
  const corrVsSpy = [];
  tickers.forEach(t => {
    const c = getCorr(t, SPY_TICKER);
    if (c !== null) corrVsSpy.push(`${dispT(t)}: ${c.toFixed(2)}`);
  });

  // ── 2. Correlation vs portfolio (weighted daily returns proxy using pairwise matrix) ──
  // Approximate corr(ticker, portfolio) using weighted sum of pairwise correlations.
  // corr(i, P) ≈ Σ_j w_j × corr(i, j) — standard linear approximation.
  // This avoids a separate fetch and is accurate enough for advisory context.
  const corrVsPort = [];
  tickers.forEach(ti => {
    let weightedSum = 0, weightSum = 0;
    tickers.forEach(tj => {
      const c = ti === tj ? 1.0 : getCorr(ti, tj);
      if (c !== null) {
        weightedSum += weights[tj] * c;
        weightSum   += weights[tj];
      }
    });
    if (weightSum > 0.5) {
      const approxCorr = weightedSum / weightSum;
      corrVsPort.push({ ticker: ti, corr: approxCorr, weight: weights[ti] });
    }
  });
  corrVsPort.sort((a, b) => b.corr - a.corr);

  // ── 3. Concentration Risk Score ──
  // Based on: weighted avg corr of top 3 positions between each other + avg corr vs portfolio
  const top3 = [...portfolioAssets]
    .sort((a, b) => b.valueUSD - a.valueUSD)
    .slice(0, 3)
    .map(a => a.pos.ticker);

  let top3CorrSum = 0, top3CorrCount = 0, top3WeightSum = 0;
  for (let i = 0; i < top3.length; i++) {
    for (let j = i + 1; j < top3.length; j++) {
      const c = getCorr(top3[i], top3[j]);
      if (c !== null) {
        // Weight by product of the two positions' weights
        const pairWeight = weights[top3[i]] * weights[top3[j]];
        top3CorrSum   += Math.abs(c) * pairWeight;
        top3CorrCount += pairWeight;
        top3WeightSum += pairWeight;
      }
    }
  }
  const top3AvgCorr = top3CorrCount > 0 ? top3CorrSum / top3CorrCount : null;

  const avgCorrVsPort = corrVsPort.length > 0
    ? corrVsPort.reduce((s, r) => s + r.corr * r.weight, 0) /
      corrVsPort.reduce((s, r) => s + r.weight, 0)
    : null;

  // HHI from healthData if available
  let hhiNorm = null;
  if (typeof computeHealthData === 'function') {
    const hd = computeHealthData();
    if (hd) hhiNorm = hd.hhiNorm;
  }

  // Risk signal: HIGH if top3 avg corr >0.80 AND hhi >35%, MEDIUM if either, LOW otherwise
  let riskSignal = 'LOW';
  if (top3AvgCorr !== null && avgCorrVsPort !== null) {
    const highCorr = top3AvgCorr > 0.80;
    const highHHI  = hhiNorm !== null ? hhiNorm > 0.35 : false;
    const medCorr  = top3AvgCorr > 0.65;
    if (highCorr && highHHI)        riskSignal = 'HIGH';
    else if (highCorr || medCorr)   riskSignal = 'MEDIUM';
  }

  // ── Build TSV output ──
  let ctx = `CORRELATION_DATA (period: ${PRIMARY}d, Pearson log-returns)\n`;

  if (corrVsSpy.length > 0) {
    ctx += `corr_vs_SPY: ${corrVsSpy.join(' | ')}\n`;
  }

  if (corrVsPort.length > 0) {
    const portLine = corrVsPort
      .map(r => `${dispT(r.ticker)}: ${r.corr.toFixed(2)}`)
      .join(' | ');
    ctx += `corr_vs_portfolio (approx): ${portLine}\n`;
    ctx += `note: corr_vs_portfolio >0.90 = position moves almost identically to whole portfolio — adding more provides near-zero diversification\n`;
  }

  ctx += `\nCONCENTRATION_RISK\n`;
  ctx += `top3_positions: ${top3.map(dispT).join(', ')}\n`;
  if (top3AvgCorr !== null) ctx += `corr_top3_weighted: ${top3AvgCorr.toFixed(2)}${top3AvgCorr > 0.80 ? ' ⚠ >0.80 threshold' : ''}\n`;
  if (avgCorrVsPort !== null) ctx += `avg_corr_vs_portfolio: ${avgCorrVsPort.toFixed(2)}\n`;
  if (hhiNorm !== null) ctx += `hhi_norm: ${(hhiNorm * 100).toFixed(0)}%\n`;
  ctx += `risk_signal: ${riskSignal}\n`;

  // Also include multi-period summary for key pairs if 180d/365d available
  const rows180 = corrAllRows.filter(r => r.period_days === 180);
  const rows365 = corrAllRows.filter(r => r.period_days === 365);
  if (rows180.length > 0 || rows365.length > 0) {
    ctx += `\nCORR_MULTI_PERIOD (top pairs by weight)\n`;
    // Show top 4 pairs by combined weight
    const pairs = [];
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const ta = tickers[i], tb = tickers[j];
        const c90 = getCorr(ta, tb);
        if (c90 === null) continue;
        pairs.push({ ta, tb, c90, combinedWeight: weights[ta] + weights[tb] });
      }
    }
    pairs.sort((a, b) => b.combinedWeight - a.combinedWeight).slice(0, 4).forEach(p => {
      const get = (rows, ta, tb) => {
        const r = rows.find(r => (r.ticker_a === ta && r.ticker_b === tb) || (r.ticker_a === tb && r.ticker_b === ta));
        return r ? r.correlation.toFixed(2) : '—';
      };
      const c180 = get(rows180, p.ta, p.tb);
      const c365 = get(rows365, p.ta, p.tb);
      ctx += `${dispT(p.ta)}/${dispT(p.tb)}: 90d ${p.c90.toFixed(2)} | 180d ${c180} | 365d ${c365}\n`;
    });
  }

  return ctx.trim();
}

function buildPortfolioContext() {
  if (!liveData) return 'Portfolio data not loaded yet.';
  const { totalUSD, totalGBP: _totalGBP, changeUSD, changeGBP, netCFusd, breakdown, assets, costBasisUSD, costBasisGBP } = liveData;
  const rate = FX_RATE;
  const fG  = v => '£' + Math.round(v * rate).toLocaleString('es-AR');
  const fGn = v => '£' + Math.round(v).toLocaleString('es-AR'); // already in GBP
  const fU  = v => '$' + Math.round(v).toLocaleString('en-US');

  // totalGBP: use snapshot native value if available, fallback to conversion
  const totalGBP = _totalGBP != null ? _totalGBP : totalUSD * rate;

  // Day change % — use yesterday total as denominator (total - change = yesterday)
  const yesterdayUSD = totalUSD - changeUSD;
  const chgPctUSD = yesterdayUSD > 0 ? (changeUSD / yesterdayUSD * 100) : 0;
  const yesterdayGBP = totalGBP - (changeGBP || 0);
  const chgPctGBP = yesterdayGBP > 0 && changeGBP ? (changeGBP / yesterdayGBP * 100) : 0;

  let ctx = `PORTFOLIO\n`;
  ctx += `total: ${fU(totalUSD)} / £${Math.round(totalGBP).toLocaleString('es-AR')}\n`;
  ctx += `day_return_usd: ${changeUSD >= 0 ? '+' : ''}${fU(changeUSD)} (${chgPctUSD >= 0 ? '+' : ''}${chgPctUSD.toFixed(2)}%) [rendimiento, excluye cashflows]\n`;
  if (changeGBP != null) ctx += `day_return_gbp: ${changeGBP >= 0 ? '+' : ''}${fGn(changeGBP)} (${chgPctGBP >= 0 ? '+' : ''}${chgPctGBP.toFixed(2)}%) [rendimiento, excluye cashflows]\n`;
  if (netCFusd != null && netCFusd !== 0) {
    ctx += `day_cashflow_usd: ${netCFusd >= 0 ? '+' : ''}${fU(netCFusd)} [capital ingresado/retirado, no es rendimiento]\n`;
    if (FX_RATE) ctx += `day_cashflow_gbp: ${netCFusd * FX_RATE >= 0 ? '+' : ''}${fGn(netCFusd * FX_RATE)} [capital ingresado/retirado, no es rendimiento]\n`;
  }
  ctx += `fx: 1 USD = ${rate.toFixed(4)} GBP\n`;

  // Cost basis total
  if (costBasisUSD > 0) {
    const pnlTotalUSD = totalUSD - costBasisUSD;
    const pnlTotalGBP = totalGBP - (costBasisGBP || costBasisUSD * rate);
    const pnlTotalPct = costBasisUSD > 0 ? (pnlTotalUSD / costBasisUSD * 100) : 0;
    ctx += `cost_basis: ${fU(costBasisUSD)}${costBasisGBP ? ` / £${Math.round(costBasisGBP).toLocaleString('es-AR')}` : ''}\n`;
    ctx += `total_pnl: ${pnlTotalUSD >= 0 ? '+' : ''}${fU(pnlTotalUSD)} / ${pnlTotalGBP >= 0 ? '+' : ''}${fGn(pnlTotalGBP)} (${pnlTotalPct >= 0 ? '+' : ''}${pnlTotalPct.toFixed(2)}%)\n`;
  }

  // Allocation — full portfolio
  ctx += '\nALLOCATION_TOTAL\n';
  const cats = [
    ['acciones', breakdown.acciones],
    ['cripto',   breakdown.cripto],
    ['rsu',      breakdown.rsu],
    ['cash_liquid', breakdown.fiat_liquid],
    ['cash_locked', breakdown.fiat_locked],
  ];
  cats.forEach(([k, v]) => {
    if (v) ctx += `${k}: ${fU(v)} / ${fG(v)} (${(v/totalUSD*100).toFixed(1)}%)\n`;
  });

  // Allocation — equity only (excl fiat), for pie chart context
  const equityUSD = (breakdown.acciones || 0) + (breakdown.cripto || 0) + (breakdown.rsu || 0);
  if (equityUSD > 0) {
    ctx += '\nALLOCATION_EQUITY_ONLY (excl cash)\n';
    [['acciones', breakdown.acciones], ['cripto', breakdown.cripto], ['rsu', breakdown.rsu]].forEach(([k, v]) => {
      if (v) ctx += `${k}: ${(v/equityUSD*100).toFixed(1)}%\n`;
    });
  }

  ctx += '\nPOSITIONS\nticker|name|weight%|value_usd|value_gbp|qty|price|avg_cost_usd|invested_usd|invested_gbp|pnl_usd%|pnl_gbp%|pnl_abs_usd|pnl_abs_gbp|day%\n';
  assets.filter(a => a.valueUSD > 0.5).forEach(({ pos, valueUSD, priceUSD, pctUSD, pctGBP, dayPct }) => {
    const meta = TICKER_META[pos.ticker] || { name: pos.ticker };
    const w = totalUSD > 0 ? (valueUSD / totalUSD * 100).toFixed(1) : '—';
    const valueGBP = valueUSD * rate;
    const invUSD = pos.initial_investment_usd ? Number(pos.initial_investment_usd) : null;
    const invGBP = pos.initial_investment_gbp ? Number(pos.initial_investment_gbp) : null;
    const pnlAbsUSD = pctUSD !== null && invUSD ? fU(valueUSD - invUSD) : '';
    const pnlAbsGBP = invGBP ? fGn(valueGBP - invGBP) : (invUSD ? fG(valueUSD - invUSD) : '');
    ctx += [pos.ticker, meta.name, w,
      fU(valueUSD), fGn(Math.round(valueGBP)),
      pos.qty,
      priceUSD ? '$' + priceUSD.toFixed(2) : '',
      pos.avg_cost_usd ? '$' + Number(pos.avg_cost_usd).toFixed(2) : '',
      invUSD ? fU(invUSD) : '',
      invGBP ? fGn(invGBP) : '',
      pctUSD !== null ? (pctUSD >= 0 ? '+' : '') + pctUSD.toFixed(2) + '%' : '',
      pctGBP !== null ? (pctGBP >= 0 ? '+' : '') + pctGBP.toFixed(2) + '%' : '',
      pnlAbsUSD, pnlAbsGBP,
      dayPct !== null ? (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%' : ''
    ].join('|') + '\n';
  });

  // RSU vesting
  ctx += '\nRSU_META\n';
  const rsuP = getRSUPriceUSD();
  ctx += `meta_price: $${rsuP.toFixed(2)} | tax_rate: 47% | net_rate: 53%\n`;

  if (vestSchedule && vestSchedule.length > 0) {
    const upcoming = vestSchedule.filter(v => !v.vested);
    const vested   = vestSchedule.filter(v => v.vested);
    const totalU = vestSchedule.reduce((s,v) => s + v.units, 0);
    const vestedU = vested.reduce((s,v) => s + v.units, 0);
    const pendingU = upcoming.reduce((s,v) => s + v.units, 0);
    const accumBruto = upcoming.reduce((s,v) => s + v.units * rsuP, 0);
    const accumNeto  = accumBruto * NET_RATE;

    ctx += `total_units: ${totalU} | vested: ${vestedU} (${Math.round(vestedU/totalU*100)}%) | pending: ${pendingU}\n`;
    ctx += `pending_gross: ${fU(accumBruto)} | pending_net: ${fU(accumNeto)} (${fG(accumNeto)})\n`;

    // Flujo anual RSU neto: promedio de próximos 8 quarters × 4 (anualizado)
    const next8 = upcoming.slice(0, 8);
    if (next8.length > 0) {
      const avgUnits8 = next8.reduce((s, v) => s + v.units, 0) / next8.length;
      const annualRsuNet = Math.round(avgUnits8 * rsuP * NET_RATE * 4);
      ctx += `annual_rsu_net_flow (next 8 quarters avg x4): ${fG(annualRsuNet)}\n`;
    }

    if (upcoming.length > 0) {
      const show = upcoming.slice(0, 4);
      const rest = upcoming.slice(4);
      ctx += '\nVEST_SCHEDULE_PENDING\ndate|days|units|gross|net\n';
      show.forEach(v => {
        const vU = v.units * rsuP;
        ctx += `${v.date}|${v.days}d|${v.units}|${fU(vU)}|${fU(vU * NET_RATE)}\n`;
      });
      if (rest.length > 0) {
        const restUnits = rest.reduce((s, v) => s + v.units, 0);
        const restGross = restUnits * rsuP;
        const lastVest  = rest[rest.length - 1];
        ctx += `...+${rest.length} vests (${restUnits}u gross ${fU(restGross)} net ${fU(restGross * NET_RATE)} through ${lastVest.date})\n`;
      }
    }
    if (vested.length > 0) {
      ctx += '\nVEST_HISTORY\n';
      vested.forEach(v => ctx += `${v.date}: ${v.units} units (vested)\n`);
    }
  }

  // Historical performance (7d and 30d)
  const _snaps = liveData.snapshots || [];
  if (_snaps.length > 1) {
    const latest = _snaps[0];
    const latestGBP = latest.total_gbp || (latest.total_usd * (latest.fx_rate || FX_RATE));
    const msDay = 86400000;
    const now = new Date(latest.captured_at).getTime();
    const snap7  = _snaps.find(s => (now - new Date(s.captured_at).getTime()) >= 6 * msDay);
    const snap30 = _snaps.find(s => (now - new Date(s.captured_at).getTime()) >= 29 * msDay);
    ctx += '\nHISTORICAL_PERFORMANCE\n';
    if (snap7) {
      const gbp7 = snap7.total_gbp || (snap7.total_usd * (snap7.fx_rate || FX_RATE));
      const chg7 = latest.total_usd - snap7.total_usd;
      const chgG7 = latestGBP - gbp7;
      const pct7 = snap7.total_usd > 0 ? (chg7 / snap7.total_usd * 100) : 0;
      ctx += `7d: ${chg7 >= 0 ? '+' : ''}${fU(chg7)} (${chgG7 >= 0 ? '+' : ''}${fGn(chgG7)}) ${pct7 >= 0 ? '+' : ''}${pct7.toFixed(2)}%\n`;
    }
    if (snap30) {
      const gbp30 = snap30.total_gbp || (snap30.total_usd * (snap30.fx_rate || FX_RATE));
      const chg30 = latest.total_usd - snap30.total_usd;
      const chgG30 = latestGBP - gbp30;
      const pct30 = snap30.total_usd > 0 ? (chg30 / snap30.total_usd * 100) : 0;
      ctx += `30d: ${chg30 >= 0 ? '+' : ''}${fU(chg30)} (${chgG30 >= 0 ? '+' : ''}${fGn(chgG30)}) ${pct30 >= 0 ? '+' : ''}${pct30.toFixed(2)}%\n`;
    }
  }

  // P&L attribution — per category, non-fiat only
  const investedAssets = assets.filter(a => a.pos.category !== 'fiat' && a.pos.initial_investment_usd && a.valueUSD > 0);
  if (investedAssets.length > 0) {
    const byCategory = {};
    investedAssets.forEach(a => {
      const cat = a.pos.category;
      if (!byCategory[cat]) byCategory[cat] = { valueUSD: 0, investedUSD: 0, investedGBP: 0 };
      byCategory[cat].valueUSD   += a.valueUSD;
      byCategory[cat].investedUSD += Number(a.pos.initial_investment_usd);
      byCategory[cat].investedGBP += Number(a.pos.initial_investment_gbp || 0);
    });
    ctx += '\nPNL_ATTRIBUTION\ncategory|invested_usd|invested_gbp|current_usd|pnl_usd|pnl_gbp|pnl%\n';
    Object.entries(byCategory).forEach(([cat, d]) => {
      const pnlUSD = d.valueUSD - d.investedUSD;
      const pnlGBP = d.valueUSD * rate - d.investedGBP;
      const pnlPct = d.investedUSD > 0 ? (pnlUSD / d.investedUSD * 100) : 0;
      ctx += `${cat}|${fU(d.investedUSD)}|${fGn(Math.round(d.investedGBP))}|${fU(d.valueUSD)}|${pnlUSD >= 0 ? '+' : ''}${fU(pnlUSD)}|${pnlGBP >= 0 ? '+' : ''}${fGn(Math.round(pnlGBP))}|${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\n`;
    });
    const totInvUSD = investedAssets.reduce((s, a) => s + Number(a.pos.initial_investment_usd), 0);
    const totInvGBP = investedAssets.reduce((s, a) => s + Number(a.pos.initial_investment_gbp || 0), 0);
    const totCurUSD = investedAssets.reduce((s, a) => s + a.valueUSD, 0);
    const totPnlUSD = totCurUSD - totInvUSD;
    const totPnlGBP = totCurUSD * rate - totInvGBP;
    const totPnlPct = totInvUSD > 0 ? (totPnlUSD / totInvUSD * 100) : 0;
    ctx += `TOTAL|${fU(totInvUSD)}|${fGn(Math.round(totInvGBP))}|${fU(totCurUSD)}|${totPnlUSD >= 0 ? '+' : ''}${fU(totPnlUSD)}|${totPnlGBP >= 0 ? '+' : ''}${fGn(Math.round(totPnlGBP))}|${totPnlPct >= 0 ? '+' : ''}${totPnlPct.toFixed(2)}%\n`;
    ctx += `note_pnl: pnl_gbp uses initial_investment_gbp (locked-in FX at purchase) for GBP positions; USD positions converted at today's FX — this matches what the app displays\n`;
  }

  return ctx.trim();
}

let aiModel = 'sonnet'; // 'sonnet' or 'opus'
const AI_MODELS = {
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-6'
};

// ── System prompt cache ───────────────────────────────────────────────────────
// El system prompt incluye datos de mercado y portfolio que solo cambian cuando
// liveData se refresca (al cargar la página). Se cachea usando el timestamp del
// último snapshot como clave; si no cambió, se reutiliza el string ya construido.
let _cachedSystemPrompt   = null;
let _cachedSystemPromptKey = null; // snapshot timestamp del último liveData usado

function setAiModel(m) {
  aiModel = m;
  const sEl = document.getElementById('aiModelSonnet');
  const oEl = document.getElementById('aiModelOpus');
  if (m === 'sonnet') {
    sEl.style.background = 'var(--accent)'; sEl.style.color = '#fff';
    oEl.style.background = 'transparent'; oEl.style.color = 'var(--muted)';
  } else {
    oEl.style.background = 'linear-gradient(135deg, #e8824a, #d4602a)'; oEl.style.color = '#fff';
    sEl.style.background = 'transparent'; sEl.style.color = 'var(--muted)';
  }
}

function openAIChat() {
  document.getElementById('aiModal').classList.add('open');
  const app = document.getElementById('app');
  app.style.overflow = 'hidden';
  app.style.touchAction = 'none';
  setTimeout(() => document.getElementById('aiInput').focus(), 300);
  aiRenderAlerts();
}

// ── Alert signals ─────────────────────────────────────────────────────────────
// Reads liveData, _macroData, vestSchedule — returns structured signals object.
function aiComputeSignals() {
  const s = {
    vix:          null,
    vixHigh:      false,
    equityDayPct: null,
    equityDrop:   false,
    equityRise:   false,
    bigMovers:    [],  // [{ ticker, dayPct }] abs >= 5%
    deepRed:      [],  // [{ ticker, pnlPct }] pnlPct <= -10%
  };

  // VIX
  const md = window._macroData || {};
  if (md['^VIX']?.current != null) {
    s.vix     = md['^VIX'].current;
    s.vixHigh = s.vix > 28;
  }

  // Portfolio positions
  if (liveData && liveData.assets) {
    const EXCL = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND', 'GBP_LIQUID']);
    const equityAssets = liveData.assets.filter(
      a => a.pos.category !== 'fiat' && !EXCL.has(a.pos.ticker) && a.valueUSD > 0.5
    );

    // Equity-only weighted day change
    const totalEquityUSD = equityAssets.reduce((sum, a) => sum + a.valueUSD, 0);
    if (totalEquityUSD > 0) {
      let wSum = 0;
      equityAssets.forEach(a => {
        const d = a.dayPct ?? a.dayPctGBP ?? null;
        if (d != null) wSum += d * (a.valueUSD / totalEquityUSD);
      });
      s.equityDayPct = wSum;
      s.equityDrop   = wSum <= -3;
      s.equityRise   = wSum >= 3;
    }

    // Individual big movers (abs >= 5%)
    equityAssets.forEach(a => {
      const d = a.dayPct ?? a.dayPctGBP ?? null;
      if (d != null && Math.abs(d) >= 3) {
        const ticker = a.pos.ticker === 'RSU_META' ? 'META' : a.pos.ticker;
        s.bigMovers.push({ ticker, dayPct: d });
      }
    });
    s.bigMovers.sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct));

    // Deep red (pnlUSD% <= -10%)
    equityAssets.forEach(a => {
      if (a.pctUSD != null && a.pctUSD <= -6) {
        const ticker = a.pos.ticker === 'RSU_META' ? 'META' : a.pos.ticker;
        s.deepRed.push({ ticker, pnlPct: a.pctUSD });
      }
    });
    s.deepRed.sort((a, b) => a.pnlPct - b.pnlPct);
  }

  return s;
}

// ── Alert banner ──────────────────────────────────────────────────────────────
// Header colapsable estilo tool-log. Expandido por defecto, cerrable por sesión.
let _alertsDismissed = false;
let _alertsExpanded  = true;

function aiRenderAlerts() {
  const container = document.getElementById('aiAlertBanner');
  if (!container) return;
  if (_alertsDismissed) { container.style.display = 'none'; return; }

  const s = aiComputeSignals();
  const alerts = [];

  if (s.vixHigh)
    alerts.push({ icon: '⚠️', text: 'VIX en ' + s.vix.toFixed(1) + ' — mercado en pánico' });

  if (s.equityDrop)
    alerts.push({ icon: '📉', text: 'Cartera variable ' + s.equityDayPct.toFixed(1) + '% hoy' });
  else if (s.equityRise)
    alerts.push({ icon: '📈', text: 'Cartera variable +' + s.equityDayPct.toFixed(1) + '% hoy' });

  s.bigMovers.forEach(m => {
    const sign = m.dayPct > 0 ? '+' : '';
    alerts.push({ icon: m.dayPct > 0 ? '📈' : '📉', text: m.ticker + ' ' + sign + m.dayPct.toFixed(1) + '% hoy' });
  });

  s.deepRed.forEach(m => {
    alerts.push({ icon: '🔴', text: m.ticker + ' en rojo: ' + m.pnlPct.toFixed(1) + '% vs costo' });
  });

  if (alerts.length === 0) { container.style.display = 'none'; return; }

  container.style.cssText = 'display:block;flex-shrink:0;border-top:1px solid var(--border);margin:0 0 2px';
  container.innerHTML = '';

  // ── Header row (siempre visible) ─────────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = [
    'display:flex;align-items:center;justify-content:space-between',
    'padding:5px 12px 5px 12px;cursor:pointer;user-select:none',
  ].join(';');

  const left = document.createElement('div');
  left.style.cssText = 'display:flex;align-items:center;gap:5px;flex:1;min-width:0';

  const chevron = document.createElement('span');
  chevron.style.cssText = 'font-size:10px;color:var(--muted);transition:transform 0.18s;display:inline-block';
  chevron.textContent = '›';
  chevron.style.transform = _alertsExpanded ? 'rotate(90deg)' : 'rotate(0deg)';

  const label = document.createElement('span');
  label.style.cssText = 'font-size:11px;font-weight:600;color:var(--muted);letter-spacing:0.3px;text-transform:uppercase';
  label.textContent = 'Alertas';

  const badge = document.createElement('span');
  badge.style.cssText = [
    'font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px',
    'background:var(--surface2);color:var(--muted);border:1px solid var(--border)',
  ].join(';');
  badge.textContent = alerts.length;

  left.appendChild(chevron);
  left.appendChild(label);
  left.appendChild(badge);

  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;color:var(--muted);font-size:16px;line-height:1;padding:0 0 0 8px;cursor:pointer;flex-shrink:0';
  closeBtn.textContent = '×';
  closeBtn.title = 'Cerrar alertas';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _alertsDismissed = true;
    container.style.display = 'none';
  });

  header.appendChild(left);
  header.appendChild(closeBtn);

  // ── Pills container (colapsable) ─────────────────────────────────────────
  const pillsWrap = document.createElement('div');
  pillsWrap.style.cssText = [
    'display:' + (_alertsExpanded ? 'flex' : 'none'),
    'flex-wrap:wrap;gap:6px;padding:2px 12px 8px',
  ].join(';');

  alerts.forEach(a => {
    const pill = document.createElement('div');
    pill.style.cssText = [
      'display:inline-flex;align-items:center;gap:4px',
      'padding:4px 10px;border-radius:20px',
      'background:var(--surface2);border:1px solid var(--border)',
      'font-size:12px;color:var(--text);white-space:nowrap;cursor:pointer;flex-shrink:0',
    ].join(';');
    pill.innerHTML = '<span>' + a.icon + '</span><span>' + a.text + '</span>';
    pill.addEventListener('click', () => aiCopyToInput(_alertToPrompt(a)));
    pillsWrap.appendChild(pill);
  });

  // Toggle collapse on header click
  header.addEventListener('click', () => {
    _alertsExpanded = !_alertsExpanded;
    pillsWrap.style.display = _alertsExpanded ? 'flex' : 'none';
    chevron.style.transform  = _alertsExpanded ? 'rotate(90deg)' : 'rotate(0deg)';
  });

  container.appendChild(header);
  container.appendChild(pillsWrap);
}

// Maps a rendered alert to a pre-filled prompt for the input
function _alertToPrompt(alert) {
  const t = alert.text;
  if (t.includes('VIX'))
    return 'El VIX está en ' + (window._macroData?.['^VIX']?.current?.toFixed(1) ?? '') + '. ¿Cómo afecta a mi cartera y qué debería hacer?';
  if (t.includes('Cartera') && alert.icon === '📉')
    return '¿Por qué cayó mi cartera hoy y qué hago?';
  if (t.includes('Cartera') && alert.icon === '📈')
    return 'Mi cartera subió bastante hoy. ¿Conviene tomar algo de ganancia o sigo quieto?';
  if (t.includes('rojo')) {
    const ticker = t.split(' ')[0];
    return ticker + ' está en rojo histórico. ¿Promedio, mantengo o corto pérdidas?';
  }
  // Big mover — extract ticker from start of text
  const tickerMatch = t.match(/^([A-Z0-9.\-]+)\s/);
  if (tickerMatch) return '¿Qué pasó con ' + tickerMatch[1] + ' hoy y cómo me afecta?';
  return t;
}

// Wire textarea keyboard behavior once DOM is ready
(function() {
  function setupAiInput() {
    const input = document.getElementById('aiInput');
    if (!input) return;

    function resize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    input.addEventListener('input', resize);

    input.addEventListener('keydown', function(e) {
      // Shift+Enter → send
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        aiSendMsg();
        return;
      }

      if (e.key === 'Enter') {
        const val = input.value;
        const cursor = input.selectionStart;
        // Find current line
        const lineStart = val.lastIndexOf('\n', cursor - 1) + 1;
        const currentLine = val.slice(lineStart, cursor);

        // If current line is ONLY a bullet/number prefix (no content) → break out of list
        if (/^(\d+\. |[-•] )$/.test(currentLine)) {
          e.preventDefault();
          input.value = val.slice(0, lineStart) + val.slice(cursor);
          input.selectionStart = input.selectionEnd = lineStart;
          resize();
          return;
        }

        // If current line starts with a numbered bullet → auto-continue
        const numberedMatch = currentLine.match(/^(\d+)\. /);
        if (numberedMatch) {
          e.preventDefault();
          const nextNum = parseInt(numberedMatch[1]) + 1;
          const prefix = nextNum + '. ';
          const insert = '\n' + prefix;
          input.value = val.slice(0, cursor) + insert + val.slice(cursor);
          input.selectionStart = input.selectionEnd = cursor + insert.length;
          resize();
          return;
        }

        // Default: let Enter insert newline naturally (no preventDefault)
        setTimeout(resize, 0);
      }
    });
  }

  // Run after DOM — script is at bottom so this fires immediately
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAiInput);
  } else {
    setupAiInput();
  }
})();
function closeAIChat() {
  document.getElementById('aiModal').classList.remove('open');
  const app = document.getElementById('app');
  app.style.overflow = '';
  app.style.touchAction = '';
  // Always return to chat view on close
  aiShowChatView();
}

// ── History view ──────────────────────────────────────────────────────────────
let aiHistoryLoaded = false;

function aiShowChatView() {
  document.getElementById('aiChatView').style.display    = 'flex';
  document.getElementById('aiHistoryView').style.display = 'none';
  document.getElementById('aiStarredView').style.display = 'none';
  document.getElementById('aiSheetTitle').textContent    = 'Asesor Financiero';
  document.getElementById('aiHistoryBtn').classList.remove('active');
  document.getElementById('aiStarredBtn').classList.remove('active');
  document.getElementById('aiModelToggle').style.display = 'flex';
}

function aiShowHistoryView() {
  document.getElementById('aiChatView').style.display    = 'none';
  document.getElementById('aiHistoryView').style.display = 'flex';
  document.getElementById('aiStarredView').style.display = 'none';
  document.getElementById('aiSheetTitle').textContent    = 'Historial';
  document.getElementById('aiHistoryBtn').classList.add('active');
  document.getElementById('aiStarredBtn').classList.remove('active');
  document.getElementById('aiModelToggle').style.display = 'none';

  // Inject search bar if not already present
  const historyView = document.getElementById('aiHistoryView');
  if (!document.getElementById('aiHistorySearch')) {
    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'padding:8px 16px 4px;flex-shrink:0';
    const searchInput = document.createElement('input');
    searchInput.id = 'aiHistorySearch';
    searchInput.type = 'text';
    searchInput.placeholder = 'Buscar en conversaciones…';
    searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:13px;outline:none';
    searchWrap.appendChild(searchInput);
    // Insert before the list
    const list = document.getElementById('aiHistoryList');
    historyView.insertBefore(searchWrap, list);

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        aiHistoryLoaded = false;
        aiLoadHistory(searchInput.value.trim());
      }, 320);
    });
  }

  if (!aiHistoryLoaded) aiLoadHistory();
}

function aiShowStarredView() {
  document.getElementById('aiChatView').style.display    = 'none';
  document.getElementById('aiHistoryView').style.display = 'none';
  document.getElementById('aiStarredView').style.display = 'flex';
  document.getElementById('aiSheetTitle').textContent    = 'Guardados';
  document.getElementById('aiHistoryBtn').classList.remove('active');
  document.getElementById('aiStarredBtn').classList.add('active');
  document.getElementById('aiModelToggle').style.display = 'none';
  if (!aiStarredLoaded) aiLoadStarred();
}

function aiToggleHistory() {
  const historyVisible = document.getElementById('aiHistoryView').style.display !== 'none';
  historyVisible ? aiShowChatView() : aiShowHistoryView();
}

function aiToggleStarred() {
  const starredVisible = document.getElementById('aiStarredView').style.display !== 'none';
  starredVisible ? aiShowChatView() : aiShowStarredView();
}

function aiNewConversation() {
  // Reset state — next message will create a new conversation row in Supabase
  aiHistory.length    = 0;
  aiConversationId    = null;
  aiMessageSeq        = 0;
  // Reset chat UI to the welcome message
  const msgs = document.getElementById('aiMessages');
  msgs.innerHTML = '<div class="ai-msg assistant">Hola Julián 👋 Tengo acceso a todos los datos de tu portfolio. ¿En qué puedo ayudarte?</div>';
  aiShowChatView();
}

async function aiLoadHistory(searchQuery = '') {
  const list = document.getElementById('aiHistoryList');
  list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Cargando...</div>';
  try {
    const url = searchQuery
      ? `/api/ai-conversations/search?q=${encodeURIComponent(searchQuery)}`
      : '/api/ai-conversations?limit=15';
    const r = await fetch(url);
    const convos = await r.json();
    if (!searchQuery) aiHistoryLoaded = true;

    if (!Array.isArray(convos) || convos.length === 0) {
      list.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">${searchQuery ? 'Sin resultados para "' + searchQuery + '".' : 'Sin conversaciones guardadas.'}</div>`;
      return;
    }

    list.innerHTML = '';
    convos.forEach(c => {
      const date = new Date(c.started_at);
      const dateStr = date.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
      const timeStr = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      const model = c.model?.includes('opus') ? 'opus' : 'sonnet';
      const modelLabel = model === 'opus' ? 'OPUS' : 'SONNET';
      const title = c.title || '(sin título)';
      const msgs = c.message_count ? `${c.message_count} msgs` : '';

      // Wrapper with swipe gesture
      const wrap = document.createElement('div');
      wrap.className = 'ai-hist-swipe-wrap';
      wrap.style.marginBottom = '8px';
      wrap.dataset.id = c.id;

      // Red delete background
      const bg = document.createElement('div');
      bg.className = 'ai-hist-delete-bg';
      bg.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;

      // Card
      const card = document.createElement('div');
      card.className = 'ai-hist-item';
      card.innerHTML = `
        <div class="ai-hist-item-title">${title}</div>
        <div class="ai-hist-item-meta">
          <span>${dateStr} ${timeStr}</span>
          ${msgs ? `<span>·</span><span>${msgs}</span>` : ''}
          <span class="ai-hist-item-model ${model}">${modelLabel}</span>
        </div>`;

      wrap.appendChild(bg);
      wrap.appendChild(card);
      list.appendChild(wrap);

      // Open conversation on tap (only if not swiping)
      card.addEventListener('click', () => aiOpenConversation(c.id));

      // Swipe gesture
      _aiHistInitSwipe(wrap, card, bg, c.id, title);
    });

  } catch(e) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Error al cargar historial.</div>';
  }
}

// Initialises the swipe-left-to-delete gesture on one history card.
function _aiHistInitSwipe(wrap, card, bg, id, title) {
  const THRESHOLD = 72; // px — how far to swipe before revealing delete
  let startX = 0, startY = 0, dx = 0, isSwiping = false, didSwipe = false;

  function onStart(e) {
    // If card is revealed and user taps the bg, let bg's touchstart handle it
    if (didSwipe && bg.contains(e.target)) return;
    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX;
    startY = touch.clientY;
    dx = 0;
    isSwiping = false;
    didSwipe = false;
  }

  function onMove(e) {
    const touch = e.touches ? e.touches[0] : e;
    const rawDx = touch.clientX - startX;
    const rawDy = touch.clientY - startY;

    // Decide axis on first meaningful move
    if (!isSwiping && Math.abs(rawDx) < 5 && Math.abs(rawDy) < 5) return;
    if (!isSwiping) {
      // If mostly vertical → don't capture, let scroll happen
      if (Math.abs(rawDy) > Math.abs(rawDx)) return;
      isSwiping = true;
    }

    // Only allow left swipe (negative dx)
    dx = Math.min(0, rawDx);
    card.classList.add('swiping');
    card.style.transform = `translateX(${dx}px)`;

    // Show/activate bg when past threshold
    if (dx < -THRESHOLD) {
      bg.classList.add('active');
    } else {
      bg.classList.remove('active');
    }

    if (e.cancelable) e.preventDefault();
  }

  function onEnd() {
    card.classList.remove('swiping');

    if (dx < -THRESHOLD) {
      // Snap to reveal state: lock card at -80px
      card.style.transform = 'translateX(-80px)';
      didSwipe = true;
    } else {
      // Snap back
      card.style.transform = '';
      bg.classList.remove('active');
      didSwipe = false;
    }
  }

  function onSnapBack() {
    if (didSwipe) {
      card.style.transform = '';
      bg.classList.remove('active');
      didSwipe = false;
    }
  }

  // Touch events
  wrap.addEventListener('touchstart', onStart, { passive: true });
  wrap.addEventListener('touchmove',  onMove,  { passive: false });
  wrap.addEventListener('touchend',   onEnd,   { passive: true });

  // Use touchstart on bg (fires before card snaps back) instead of click
  bg.addEventListener('touchstart', (e) => {
    if (!didSwipe) return;
    e.stopPropagation();
    e.preventDefault();
    onSnapBack();
    _aiHistShowConfirm(wrap, id, title);
  }, { passive: false });

  // Tap elsewhere when revealed → snap back
  document.addEventListener('touchstart', (e) => {
    if (didSwipe && !wrap.contains(e.target)) onSnapBack();
  }, { passive: true });
}

// Shows the confirmation popup for delete, mounted inside the aiSheet so it
// stays within the modal boundaries.
function _aiHistShowConfirm(wrap, id, title) {
  // Snap card back before showing modal
  const card = wrap.querySelector('.ai-hist-item');
  const bg   = wrap.querySelector('.ai-hist-delete-bg');
  if (card) card.style.transform = '';
  if (bg)   bg.classList.remove('active');

  const sheet = document.getElementById('aiSheet');
  void sheet; // keep reference in case needed later

  const overlay = document.createElement('div');
  overlay.className = 'ai-confirm-overlay';
  overlay.innerHTML = `
    <div class="ai-confirm-box">
      <div class="ai-confirm-title">Eliminar conversación</div>
      <div class="ai-confirm-body">¿Eliminás "<strong>${title.slice(0, 50)}</strong>"? Esta acción no se puede deshacer.</div>
      <div class="ai-confirm-actions">
        <button class="ai-confirm-cancel">Cancelar</button>
        <button class="ai-confirm-delete">Eliminar</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('.ai-confirm-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('.ai-confirm-delete').addEventListener('click', async () => {
    overlay.remove();
    await aiDeleteConversation(id, wrap);
  });
}

async function aiDeleteConversation(id, wrapEl) {
  try {
    const r = await fetch(`/api/ai-conversations/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      console.warn('[ai-delete] server error:', await r.text());
      return;
    }
  } catch(e) {
    console.warn('[ai-delete] fetch error:', e.message);
    return;
  }

  // Animate removal from DOM
  wrapEl.classList.add('deleting');
  wrapEl.addEventListener('animationend', () => wrapEl.remove(), { once: true });

  // If the deleted conversation was the active one, reset state silently
  if (aiConversationId === id) { aiHistory.length = 0; aiConversationId = null; aiMessageSeq = 0; }


}

async function aiOpenConversation(id, targetMsgId = null) {
  aiShowChatView();
  const msgs = document.getElementById('aiMessages');
  msgs.innerHTML = '<div class="ai-msg assistant" style="opacity:0.5;font-style:italic">Cargando conversación...</div>';

  try {
    const r = await fetch(`/api/ai-conversations/${id}/messages`);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      msgs.innerHTML = '<div class="ai-msg assistant">Conversación vacía.</div>';
      return;
    }

    aiHistory.length = 0;
    aiConversationId = id;
    aiMessageSeq = rows[rows.length - 1].seq + 1;

    msgs.innerHTML = '';
    const domMap = {}; // dbId → DOM element, para el scroll posterior
    rows.forEach(row => {
      // Si el mensaje del asistente tiene tool_calls guardados, mostrarlos antes
      if (row.role === 'assistant' && row.tool_calls && row.tool_calls.length > 0) {
        aiRenderToolLog(row.tool_calls, msgs);
      }
      const el = aiAddMsg(row.role, row.content, row.id || null, row.starred === true);
      aiHistory.push({ role: row.role, content: row.content });
      if (row.id) domMap[row.id] = el;
    });

    // Scroll: si hay targetMsgId scrollamos a ese mensaje y lo animamos,
    // si no, scrollamos al final como siempre.
    if (targetMsgId && domMap[targetMsgId]) {
      const target = domMap[targetMsgId];
      // Pequeño delay para asegurar que el layout ya está pintado
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('ai-msg-highlight');
        setTimeout(() => target.classList.remove('ai-msg-highlight'), 1800);
      }, 80);
    } else {
      msgs.scrollTop = msgs.scrollHeight;
    }
  } catch(e) {
    msgs.innerHTML = '<div class="ai-msg assistant">⚠️ Error al cargar la conversación.</div>';
  }
}
// ── Star / Favoritos ──────────────────────────────────────────────────────────
// Guarda el ID de DB de cada mensaje assistant para poder starearlos.
// Map: DOM element → { dbId, conversationId, seq }
const _aiMsgMeta = new WeakMap();

async function aiToggleStar(el) {
  const meta = _aiMsgMeta.get(el);
  if (!meta?.dbId) return;

  const nowStarred = el.dataset.starred === 'true';
  const next = !nowStarred;

  try {
    const r = await fetch(`/api/ai-messages/${meta.dbId}/star`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: next }),
    });
    if (!r.ok) { console.warn('[ai-star] error:', await r.text()); return; }
  } catch (e) { console.warn('[ai-star] fetch error:', e.message); return; }

  el.dataset.starred = String(next);
  const btn = el.querySelector('.ai-star-btn');
  if (btn) {
    btn.textContent = next ? '★' : '☆';
    btn.classList.toggle('active', next);
  }
  aiStarredLoaded = false;
}



// ── Starred History view ──────────────────────────────────────────────────────
let aiStarredLoaded = false;

async function aiLoadStarred() {
  const list = document.getElementById('aiStarredList');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Cargando...</div>';
  try {
    const r = await fetch('/api/ai-messages/starred');
    const rows = await r.json();
    aiStarredLoaded = true;

    if (!Array.isArray(rows) || rows.length === 0) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Sin mensajes guardados.<br><span style="font-size:11px">Mantené presionado un mensaje del asistente para guardarlo.</span></div>';
      return;
    }

    list.innerHTML = '';
    rows.forEach(row => {
      const conv = row.ai_conversations;
      const date = new Date(row.created_at);
      const dateStr = date.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
      const timeStr = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      const title = conv?.title || '(sin título)';

      const card = document.createElement('div');
      card.className = 'ai-starred-item';
      card.innerHTML = `
        <div class="ai-starred-preview">${row.content.slice(0, 120)}${row.content.length > 120 ? '…' : ''}</div>
        <div class="ai-starred-meta">
          <span>★</span>
          <span>${dateStr} ${timeStr}</span>
          <span>·</span>
          <span class="ai-starred-conv">${title.slice(0, 40)}</span>
        </div>`;

      card.addEventListener('click', () => aiOpenConversation(row.conversation_id, row.id));
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Error al cargar.</div>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function aiCopyToInput(msg) {
  const input = document.getElementById('aiInput');
  input.value = msg;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

function aiQuick(msg) {
  document.getElementById('aiInput').value = msg;
  aiSendMsg();
}

// ── Tool log widget — reutilizado en live chat y al reabrir conversaciones ────
// Construye el elemento .ai-tools-used y lo agrega al container dado.
// toolLog: array de { tool, input, elapsed_ms, row_count, error }
function aiRenderToolLog(toolLog, container) {
  if (!toolLog || toolLog.length === 0) return;

  const TOOL_META = {
    query_db:                { icon: '🗄', label: 'Base de datos' },
    run_montecarlo:          { icon: '📊', label: 'Monte Carlo' },
    run_montecarlo_target:   { icon: '🎯', label: 'Monte Carlo (objetivo)' },
  };
  const QUERY_LABELS = {
    transactions_by_ticker: 'transacciones',
    transactions_by_period: 'transacciones por período',
    transactions_all:       'últimas transacciones',
    portfolio_history:      'historial portfolio',
    price_history:          'historial precios',
    rsu_vests:              'RSU vests',
    positions_snapshot:     'posiciones',
    daily_returns:          'retornos diarios',
  };

  const wrapper = document.createElement('div');
  wrapper.className = 'ai-tools-used';

  // Header: conteo total
  const n = toolLog.length;
  const header = document.createElement('div');
  header.className = 'ai-tools-header';
  header.innerHTML =
    `<span class="ai-tools-summary">🔧\u00a0${n} herramienta${n !== 1 ? 's' : ''} usada${n !== 1 ? 's' : ''}</span>` +
    `<span class="ai-tools-chevron">›</span>`;

  // Detalle — una fila por tool call
  const detail = document.createElement('div');
  detail.className = 'ai-tools-detail';
  detail.style.display = 'none'; // colapsado por default

  toolLog.forEach(entry => {
    const meta = TOOL_META[entry.tool] || { icon: '⚙', label: entry.tool };
    const inp  = entry.input || {};
    let desc   = '';

    if (entry.tool === 'query_db') {
      const qt     = inp.query_type || '';
      const ticker = inp.filters?.ticker;
      const from   = inp.filters?.from_date;
      const to     = inp.filters?.to_date;
      desc = QUERY_LABELS[qt] || qt;
      if (ticker) desc += ` · ${ticker}`;
      if (from)   desc += ` · desde ${from}`;
      if (to)     desc += ` → ${to}`;
    } else if (entry.tool === 'run_montecarlo') {
      const sc  = inp.scenario || 'neutral';
      const rsu = inp.include_rsu === false ? ' · sin RSU' : '';
      const horizonLabel = inp.months != null
        ? `${inp.months} meses`
        : inp.years != null ? `${inp.years} año${inp.years !== 1 ? 's' : ''}` : '?';
      desc = `${sc} · ${horizonLabel}${rsu}`;
    }

    const errStr  = entry.error ? ` ⚠ ${entry.error}` : '';
    const timeStr = entry.elapsed_ms != null ? `${entry.elapsed_ms}ms` : '';

    const row = document.createElement('div');
    row.className = 'ai-tools-row';
    row.innerHTML =
      `<span class="ai-tools-row-icon">${meta.icon}</span>` +
      `<span class="ai-tools-row-name">${meta.label}</span>` +
      `<span class="ai-tools-row-desc">${desc}${errStr}</span>` +
      `<span class="ai-tools-row-time">${timeStr}</span>`;
    detail.appendChild(row);
  });

  let expanded = false;
  header.addEventListener('click', () => {
    expanded = !expanded;
    detail.style.display = expanded ? 'flex' : 'none';
    header.querySelector('.ai-tools-chevron').style.transform = expanded ? 'rotate(90deg)' : '';
  });

  wrapper.appendChild(header);
  wrapper.appendChild(detail);
  container.appendChild(wrapper);
}

async function aiSendMsg() {
  const input = document.getElementById('aiInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';

  // Add user message to UI and history
  aiAddMsg('user', msg);
  aiHistory.push({ role: 'user', content: msg });

  // Thinking indicator
  const thinkingEl = aiAddMsg('thinking', '');
  thinkingEl.innerHTML = '<span class="ai-thinking-text">Analizando tu portfolio</span><span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';
  const thinkingMsgs = ['Analizando tu portfolio', 'Procesando datos', 'Calculando métricas', 'Preparando respuesta'];
  let tmIdx = 0;
  const tmInterval = setInterval(() => {
    tmIdx = (tmIdx + 1) % thinkingMsgs.length;
    const textEl = thinkingEl.querySelector('.ai-thinking-text');
    if (textEl) textEl.textContent = thinkingMsgs[tmIdx];
  }, 1800);

  // Logging
  const historySnapshot  = aiHistory.slice();
  const contextSlice     = historySnapshot.slice(-AI_CONTEXT_WINDOW);
  const contextStartSeq  = historySnapshot.length - contextSlice.length;

  await aiEnsureConversation(AI_MODELS[aiModel], msg);
  aiLogMessage({ role: 'user', content: msg, context_start_seq: contextStartSeq });

  try {
    // Context sections (same as before)
    let corrSection = null;
    try {
      const corrRes = await fetch('/api/ai-correlation-context');
      if (corrRes.ok) { const d = await corrRes.json(); corrSection = d.tsv || null; }
    } catch (_) {}

    const wlBase       = buildWatchlistBase();
    const wlExtended   = needsExtendedWatchlist(msg) ? buildWatchlistExtended() : null;
    const macroSection = buildMacroContext();

    let txSection = null;
    try {
      const txRes = await fetch('/api/ai-transactions-context');
      if (txRes.ok) { const d = await txRes.json(); txSection = d.tsv || null; }
    } catch (_) {}

    // System prompt (cached)
    const _snapKey    = liveData?.snapshots?.[0]?.captured_at ?? null;
    const _needsRebuild = _snapKey !== _cachedSystemPromptKey || _cachedSystemPrompt === null;

    if (_needsRebuild) {
      let usdExposurePct = null;
      if (liveData && liveData.totalUSD > 0) {
        const usdAssets = liveData.assets.filter(a => {
          const pos = a.pos;
          const isGBP = (pos.category === 'fiat' && pos.currency === 'GBP') || pos.pricing_currency === 'GBP';
          return !isGBP;
        });
        const usdTotal = usdAssets.reduce((s, a) => s + a.valueUSD, 0);
        usdExposurePct = (usdTotal / liveData.totalUSD * 100).toFixed(0);
      }
      const fxLine = usdExposurePct !== null
        ? `earns+spends GBP, ~${usdExposurePct}% portfolio in USD — GBP/USD moves directly impact GBP wealth`
        : `earns+spends GBP, mixed USD/GBP portfolio — GBP/USD moves impact GBP wealth`;

      const _cfg          = await getAppConfig();
      const _name         = _cfg.aiProfileName       || 'Julián';
      const _monthlyExp   = _cfg.aiMonthlyExpenses   || '£4000';
      const _savingsRange = _cfg.aiSavingsRange      || '£900-1000/mo';
      const _bonusRange   = _cfg.aiBonusRange        || '£7500-8500/yr';
      const _rsuCalc      = (typeof calcRsuDefault === 'function') ? calcRsuDefault() : null;
      const _rsuRangeDyn  = _rsuCalc ? `META quarterly ~£${_rsuCalc.toLocaleString()} net/vest` : null;
      const _rsuRange     = _cfg.aiRsuRange          || _rsuRangeDyn || 'META quarterly RSU net/vest';
      const _emergencyMin = _cfg.aiEmergencyFund     || '2500';
      const _goals        = _cfg.aiGoals             || '£30k (end 2026) | £100k (end 2028) | £200k (end 2030)';
      const _rsuAnnual    = _rsuCalc ? _rsuCalc * 4 : null;
      const _aiLow        = _rsuAnnual ? Math.round((900 * 12) + 7500 + (_rsuAnnual * 0.95)) : null;
      const _aiHigh       = _rsuAnnual ? Math.round((1000 * 12) + 8500 + (_rsuAnnual * 1.05)) : null;
      const _annualInvest = _cfg.aiAnnualInvestable  ||
        (_aiLow && _aiHigh
          ? `~£${Math.round(_aiLow/1000)}k-${Math.round(_aiHigh/1000)}k/yr (salary+bonus+RSUs)`
          : '~£28k-31k/yr salary+bonus+RSUs');

      let _gbpLiquidQty = '?', _emergencyQty = '?';
      if (liveData && liveData.assets) {
        const gbpLiq = liveData.assets.find(a => a.pos.ticker === 'GBP_LIQUID');
        const ef     = liveData.assets.find(a => a.pos.ticker === 'EMERGENCY_FUND');
        if (gbpLiq) _gbpLiquidQty = Math.round(gbpLiq.pos.qty || gbpLiq.valueUSD * FX_RATE).toLocaleString('es-AR');
        if (ef)     _emergencyQty = Math.round(ef.pos.qty     || ef.valueUSD     * FX_RATE).toLocaleString('es-AR');
      }

      const _now      = new Date();
      const _todayISO = _now.toISOString().slice(0,10);

      function lastBizDay(year, month0) {
        let d = new Date(Date.UTC(year, month0 + 1, 0));
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0,10);
      }
      const yr = _now.getUTCFullYear();
      const bonusDates = [
        lastBizDay(yr, 2), lastBizDay(yr, 8), lastBizDay(yr + 1, 2),
      ].filter(d => d >= _todayISO);
      const _nextBonus   = bonusDates[0] || lastBizDay(yr + 1, 2);
      const _daysToBonus = Math.round((new Date(_nextBonus) - _now) / 86400000);

      _cachedSystemPrompt = `You are ${_name}'s personal financial advisor. Reply in Spanish, direct and concise. Minimal markdown. All tool call reasoning, intermediate steps, and error messages must also be in Spanish.

TODAY: ${_todayISO} | NEXT_BONUS: ${_nextBonus} (${_daysToBonus}d) — 50% annual net bonus

PROFILE
location: London UK | currency: GBP | expenses: ${_monthlyExp}/mo
savings: ${_savingsRange} | bonus: ${_bonusRange} in 2 tranches: last biz day Mar + last biz day Sep
rsu: ${_rsuRange} | quarterly vest Jan/Apr/Jul/Oct
emergency_fund: £${_emergencyQty} actual | min: £${_emergencyMin} — untouchable
cash: GBP_LIQUID=£${_gbpLiquidQty} | horizon: 5+yr | max_drawdown: 20%
goals: ${_goals}

CASHFLOW
annual_investable: ${_annualInvest} | promotion_possible_2-3yr: bonus+10% savings+20% RSU+15%

RULES
- ${fxLine}
- day_return_gbp includes intraday USD/GBP FX move; day_cashflow_* es capital nuevo, no rendimiento
- META: RSUs+shares = largest single exposure, warn if overweight
- VIX >30=panic >20=elevated <15=calm | US10Y rising = pressure on growth+bonds
- GBP/USD up = USD portfolio worth less in GBP
- If emergency_fund<£${_emergencyMin}: replenish before investing
- Use all provided data for analysis

${buildPortfolioContext()}

${buildHealthContext()}
${buildMarketContext()}`;
      _cachedSystemPromptKey = _snapKey;
      window._cachedSystemPrompt = _cachedSystemPrompt; // expose for console inspection
    }

    const systemPrompt = _cachedSystemPrompt
      + (txSection    ? '\n' + txSection    : '')
      + (corrSection  ? '\n' + corrSection  : '')
      + (macroSection ? '\n' + macroSection : '')
      + (wlBase       ? '\n' + wlBase       : '')
      + (wlExtended   ? '\n' + wlExtended   : '');

    // ── SSE fetch ────────────────────────────────────────────────────────────
    const sseRes = await fetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODELS[aiModel],
        max_tokens: 3000,
        system: systemPrompt,
        messages: contextSlice,
      }),
    });

    if (!sseRes.ok || !sseRes.body) {
      clearInterval(tmInterval);
      thinkingEl.remove();
      aiAddMsg('assistant', '⚠️ Error de conexión con el servidor.');
      aiHistory.pop();
      return;
    }

    const reader  = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let replyEl   = null;        // DOM element — created on first delta
    let replyText = '';          // accumulated full text
    let toolLog   = [];
    let usage     = null;
    let thinkingRemoved = false;

    const msgs = document.getElementById('aiMessages');

    const ensureReplyEl = () => {
      if (!replyEl) {
        replyEl = document.createElement('div');
        replyEl.className = 'ai-msg assistant';
        // Star button
        const starBtn = document.createElement('button');
        starBtn.className = 'ai-star-btn';
        starBtn.title = 'Guardar como favorito';
        starBtn.textContent = '☆';
        starBtn.addEventListener('click', (e) => { e.stopPropagation(); aiToggleStar(replyEl); });
        replyEl.appendChild(starBtn);
        replyEl.dataset.starred = 'false';
        _aiMsgMeta.set(replyEl, { dbId: null });
        msgs.appendChild(replyEl);
      }
    };

    // We'll build a <span> for the streaming text, separate from the star button
    let textSpan = null;
    const ensureTextSpan = () => {
      if (!textSpan) {
        textSpan = document.createElement('span');
        textSpan.className = 'ai-msg-text';
        replyEl.insertBefore(textSpan, replyEl.querySelector('.ai-star-btn'));
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let evt;
        try { evt = JSON.parse(raw); } catch (_) { continue; }

        if (evt.type === 'tool_log') {
          toolLog = evt.log || [];
          // Render tool log before the reply element
          if (toolLog.length > 0) aiRenderToolLog(toolLog, msgs);

        } else if (evt.type === 'delta') {
          // Remove thinking indicator on first text delta
          if (!thinkingRemoved) {
            clearInterval(tmInterval);
            thinkingEl.remove();
            thinkingRemoved = true;
          }
          ensureReplyEl();
          ensureTextSpan();
          replyText += evt.text;
          // Re-render markdown on every delta
          textSpan.innerHTML = aiRenderMarkdown(replyText);
          msgs.scrollTop = msgs.scrollHeight;

        } else if (evt.type === 'done') {
          usage = evt.usage;

        } else if (evt.type === 'error') {
          if (!thinkingRemoved) { clearInterval(tmInterval); thinkingEl.remove(); thinkingRemoved = true; }
          aiAddMsg('assistant', '⚠️ Error: ' + (evt.message || 'No se pudo conectar con la IA.'));
          aiHistory.pop();
          return;
        }
      }
    }

    // Ensure thinking is gone even if no deltas arrived
    if (!thinkingRemoved) { clearInterval(tmInterval); thinkingEl.remove(); }

    if (!replyText) {
      aiAddMsg('assistant', '(sin respuesta)');
      aiHistory.pop();
      return;
    }

    aiHistory.push({ role: 'assistant', content: replyText });

    // Log assistant message and wire up star dbId
    aiLogMessage({
      role: 'assistant',
      content: replyText,
      model: AI_MODELS[aiModel],
      input_tokens:      usage?.input_tokens  ?? null,
      output_tokens:     usage?.output_tokens ?? null,
      context_start_seq: contextStartSeq,
      tool_calls:        toolLog.length > 0 ? toolLog : null,
    }).then(dbId => {
      if (dbId && replyEl) _aiMsgMeta.set(replyEl, { dbId });
    });

  } catch (e) {
    clearInterval(tmInterval);
    if (!thinkingEl.parentNode) return; // already removed
    thinkingEl.remove();
    aiAddMsg('assistant', '⚠️ Error de conexión: ' + e.message);
    aiHistory.pop();
  }
}

// getAnthropicKey eliminada — la API key ya no se expone al frontend.
// El chat AI va a través de /api/ai-chat (server-side proxy).
async function getAnthropicKey_UNUSED() {
  // Fetch from server endpoint (keeps key out of frontend code)
  if (window._anthropicKey) return window._anthropicKey;
  const res = await fetch('/api/config');
  const cfg = await res.json();
  window._anthropicKey = cfg.anthropicKey;
  return window._anthropicKey;
}

async function getAppConfig() {
  if (window._appConfig) return window._appConfig;
  try {
    const res = await fetch('/api/config');
    window._appConfig = await res.json();
    return window._appConfig;
  } catch(e) {
    return {};
  }
}

function aiRenderMarkdown(text) {
  // Escape HTML first
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Tables: detect lines with | and render as table
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // Check if next line is separator (|---|---|)
      const sep = lines[i+1] || '';
      if (/^\|[-| :]+\|$/.test(sep.trim())) {
        const ths = line.split('|').slice(1,-1).map(c => '<th>' + c.trim() + '</th>').join('');
        const tableRows = [];
        i += 2; // skip header + separator
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          const cells = lines[i].split('|').slice(1,-1).map(c => '<td>' + c.trim() + '</td>').join('');
          tableRows.push('<tr>' + cells + '</tr>');
          i++;
        }
        out.push('<table class="ai-table"><thead><tr>' + ths + '</tr></thead><tbody>' + tableRows.join('') + '</tbody></table>');
        continue;
      }
    }
    out.push(line);
    i++;
  }
  text = out.join('\n');
  // Bold **text**
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic *text* (not inside words)
  text = text.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  // Headers
  text = text.replace(/^### (.+)$/gm, '<div class="ai-h3">$1</div>');
  text = text.replace(/^## (.+)$/gm, '<div class="ai-h2">$1</div>');
  text = text.replace(/^# (.+)$/gm, '<div class="ai-h1">$1</div>');
  // Bullet lists
  text = text.replace(/^[-•] (.+)$/gm, '<div class="ai-li">• $1</div>');
  // Newlines to <br>
  text = text.replace(/\n/g, '<br>');
  // Clean up extra <br> after block divs
  text = text.replace(/(<\/div>)<br>/g, '$1');
  text = text.replace(/<br>(<div)/g, '$1');
  return text;
}

function aiAddMsg(role, text, dbId = null, isStarred = false) {
  const msgs = document.getElementById('aiMessages');
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  if (role === 'assistant' && text) {
    el.innerHTML = aiRenderMarkdown(text);
    // Star button — always visible, tap to toggle
    const starBtn = document.createElement('button');
    starBtn.className = 'ai-star-btn';
    starBtn.title = 'Guardar como favorito';
    starBtn.textContent = isStarred ? '★' : '☆';
    if (isStarred) starBtn.classList.add('active');
    starBtn.addEventListener('click', (e) => { e.stopPropagation(); aiToggleStar(el); });
    el.appendChild(starBtn);
    // Siempre inicializar dataset + meta, aunque el dbId llegue después async
    el.dataset.starred = String(isStarred);
    _aiMsgMeta.set(el, { dbId }); // dbId puede ser null y actualizarse después
  } else {
    el.textContent = text;
  }
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}
// ── END AI CHAT ─────────────────────────────────────────────────────────────

// ── BRIEFING MODAL ────────────────────────────────────────────────────────────

let briefingHistoryLoaded = false;
let briefingHistoryVisible = false;

function openBriefingModal(content = null) {
  // Close AI chat if open so briefing appears on top without blocking
  const aiModal = document.getElementById('aiModal');
  if (aiModal && aiModal.classList.contains('open')) {
    aiModal.classList.remove('open');
  }

  document.getElementById('briefingModal').classList.add('open');
  briefingHistoryVisible = false;
  document.getElementById('briefingLatestView').style.display = 'block';
  document.getElementById('briefingHistoryView').style.display = 'none';
  document.getElementById('briefingHistoryBtn').classList.remove('active');

  if (content) {
    _briefingRender(content);
  } else {
    briefingLoadLatest();
  }
}

function closeBriefingModal() {
  document.getElementById('briefingModal').classList.remove('open');
}

async function briefingLoadLatest() {
  const el = document.getElementById('briefingContent');
  const title = document.getElementById('briefingModalTitle');
  el.textContent = 'Cargando…';
  try {
    const r = await fetch('/api/db/daily_briefings?select=date,content&order=date.desc&limit=1');
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      el.textContent = 'Aún no hay briefings generados. El primero llegará hoy después del cierre de NYSE.';
      return;
    }
    const row = rows[0];
    const dateStr = new Date(row.date + 'T12:00:00Z').toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    title.textContent = 'Briefing — ' + dateStr;
    _briefingRender(row.content);
  } catch (e) {
    el.textContent = '⚠️ Error al cargar el briefing.';
  }
}

function _briefingRender(content) {
  const el = document.getElementById('briefingContent');
  el.innerHTML = aiRenderMarkdown(content);
}

function briefingToggleHistory() {
  briefingHistoryVisible = !briefingHistoryVisible;
  document.getElementById('briefingLatestView').style.display  = briefingHistoryVisible ? 'none'  : 'block';
  document.getElementById('briefingHistoryView').style.display = briefingHistoryVisible ? 'flex'  : 'none';
  document.getElementById('briefingHistoryBtn').classList.toggle('active', briefingHistoryVisible);
  document.getElementById('briefingModalTitle').textContent = briefingHistoryVisible ? 'Historial de briefings' : 'Briefing del día';
  if (briefingHistoryVisible && !briefingHistoryLoaded) briefingLoadHistory();
}

async function briefingLoadHistory() {
  const list = document.getElementById('briefingHistoryList');
  list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0">Cargando...</div>';
  try {
    const r = await fetch('/api/db/daily_briefings?select=date,content&order=date.desc&limit=30');
    const rows = await r.json();
    briefingHistoryLoaded = true;
    if (!Array.isArray(rows) || rows.length === 0) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0">Sin briefings anteriores.</div>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(row => {
      const dateStr = new Date(row.date + 'T12:00:00Z').toLocaleDateString('es-AR', {
        weekday: 'long', day: 'numeric', month: 'long',
      });
      const card = document.createElement('div');
      card.className = 'briefing-hist-item';
      card.innerHTML = '<div class="briefing-hist-date">' + dateStr + '</div>' +
        '<div class="briefing-hist-preview">' + row.content.slice(0, 140) + (row.content.length > 140 ? '…' : '') + '</div>';
      card.addEventListener('click', () => {
        briefingHistoryVisible = false;
        document.getElementById('briefingLatestView').style.display  = 'block';
        document.getElementById('briefingHistoryView').style.display = 'none';
        document.getElementById('briefingHistoryBtn').classList.remove('active');
        const dateLabel = new Date(row.date + 'T12:00:00Z').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
        document.getElementById('briefingModalTitle').textContent = 'Briefing — ' + dateLabel;
        _briefingRender(row.content);
      });
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0">Error al cargar.</div>';
  }
}

// Detectar ?briefing=1 al cargar la app (viene del SW al tocar la notificación)
(function checkBriefingParam() {
  if (window.location.search.includes('briefing=1')) {
    // Limpiar el param de la URL sin recargar
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);
    // Esperar a que el DOM esté listo y los módulos cargados
    window.addEventListener('load', () => {
      setTimeout(() => openBriefingModal(), 400);
    });
  }
})();
// ── END BRIEFING MODAL ────────────────────────────────────────────────────────
