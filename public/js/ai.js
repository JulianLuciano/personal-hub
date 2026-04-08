// ── AI CHAT ────────────────────────────────────────────────────────────────
const aiHistory = [];

// ── Chat history logging ──────────────────────────────────────────────────
// How many messages to send as context on each turn.
// Change this one constant to adjust the sliding window everywhere.
const AI_CONTEXT_WINDOW = 8;

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
async function aiLogMessage({ role, content, model, input_tokens, output_tokens, context_start_seq }) {
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

  let tsv = 'MACRO\nticker|label|value|unit|7d|30d|trend\n';
  Object.entries(md).forEach(([ticker, d]) => {
    if (!d || d.current == null) return;
    tsv += `${ticker}|${d.label}|${f2(d.current)}|${d.unit}|${sgn(d.chg7d)}|${sgn(d.chg30d)}|${d.trend}\n`;
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
    'qué está barato','que esta barato','análisis','analisis',
    'fundamentals','fwd pe','forward pe','compro','screener',
    'qué comprarías','que comprarias','dónde metería','donde meteria',
    'alternativa','diversificar','rotar','rotación','rotacion',
    // themes
    'latam','argentina','brasil','china','emergentes','bonos','bond',
    'commodities','defensivo','defensivas','dividendo','dividendos',
    'uk','cripto','crypto','india',
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
  ctx += `total: ${d.healthScore}/100 (weights: diversification 20%, risk_alignment 20%, valuation 15%, currency 15%, concentration 15%, income 15%)\n`;
  ctx += `note: excludes RENT_DEPOSIT + EMERGENCY_FUND from all scores except currency_exposure + income_momentum\n\n`;

  ctx += 'HEALTH_METRICS\n';
  ctx += `diversification: score ${d.subscores[0].score} | HHI_norm ${(d.hhiNorm*100).toFixed(1)}% | effective_positions ${d.effectiveN.toFixed(1)} | computed_over: investments_only (no cash/fiat)\n`;
  ctx += `risk_alignment: score ${d.subscores[1].score} | portfolio_beta ${d.portfolioBeta.toFixed(2)} | vol_est ${d.portfolioVol.toFixed(1)}% | correction_est -${d.ddCorrection.toFixed(0)}% | bear_est -${d.ddBearMarket.toFixed(0)}% | beta_includes_cash_at_0\n`;
  ctx += `valuation: score ${d.subscores[2].score}` + (d.portfolioPE ? ` | fwd_PE ${d.portfolioPE.toFixed(1)}x vs SPY ~21x` : ' | no PE data') + ` | investments_only\n`;
  ctx += `currency: score ${d.subscores[3].score} | GBP ${(d.gbpPct*100).toFixed(0)}% USD ${(d.usdPct*100).toFixed(0)}% | GBP=fiat_gbp+pricing_currency_GBP | USD=stocks+RSU+crypto\n`;
  ctx += `concentration: score ${d.subscores[4].score} | top_stock ${topStock} ${(d.topNonBroadETF.w*100).toFixed(1)}% | broad_ETFs (SPY,VWRP) exempt from penalty\n`;
  ctx += `income: score ${d.subscores[5].score} | annual_flow/portfolio ${(d.incomeRatio*100).toFixed(0)}% | denominator_includes_emergency_fund\n`;
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

  tsv += '\nCORRELATIONS_VS_SPY: META~0.70|VWRP.L~0.92|BRK-B~0.65|BTC~0.25|MELI~0.65|NU~0.55|ARKK~0.80';
  return tsv.trim();
}

function buildPortfolioContext() {
  if (!liveData) return 'Portfolio data not loaded yet.';
  const { totalUSD, totalGBP: _totalGBP, changeUSD, changeGBP, breakdown, assets, costBasisUSD, costBasisGBP } = liveData;
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
  ctx += `day_change_usd: ${changeUSD >= 0 ? '+' : ''}${fU(changeUSD)} (${chgPctUSD >= 0 ? '+' : ''}${chgPctUSD.toFixed(2)}%)\n`;
  if (changeGBP != null) ctx += `day_change_gbp: ${changeGBP >= 0 ? '+' : ''}${fGn(changeGBP)} (${chgPctGBP >= 0 ? '+' : ''}${chgPctGBP.toFixed(2)}%)\n`;
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

    if (upcoming.length > 0) {
      ctx += '\nVEST_SCHEDULE_PENDING\ndate|days|units|gross|net\n';
      upcoming.forEach(v => {
        const vU = v.units * rsuP;
        ctx += `${v.date}|${v.days}d|${v.units}|${fU(vU)}|${fU(vU * NET_RATE)}\n`;
      });
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
  document.getElementById('aiSheetTitle').textContent    = 'Análisis de Portfolio';
  document.getElementById('aiHistoryBtn').classList.remove('active');
  document.getElementById('aiModelToggle').style.display = 'flex';
}

function aiShowHistoryView() {
  document.getElementById('aiChatView').style.display    = 'none';
  document.getElementById('aiHistoryView').style.display = 'flex';
  document.getElementById('aiSheetTitle').textContent    = 'Historial';
  document.getElementById('aiHistoryBtn').classList.add('active');
  document.getElementById('aiModelToggle').style.display = 'none';
  if (!aiHistoryLoaded) aiLoadHistory();
}

function aiToggleHistory() {
  const historyVisible = document.getElementById('aiHistoryView').style.display !== 'none';
  historyVisible ? aiShowChatView() : aiShowHistoryView();
}

async function aiLoadHistory() {
  const list = document.getElementById('aiHistoryList');
  list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Cargando...</div>';
  try {
    const r = await fetch('/api/ai-conversations?limit=15');
    const convos = await r.json();
    aiHistoryLoaded = true;

    if (!Array.isArray(convos) || convos.length === 0) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Sin conversaciones guardadas.</div>';
      return;
    }

    list.innerHTML = convos.map(c => {
      const date = new Date(c.started_at);
      const dateStr = date.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
      const timeStr = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      const model = c.model?.includes('opus') ? 'opus' : 'sonnet';
      const modelLabel = model === 'opus' ? 'OPUS' : 'SONNET';
      const title = c.title || '(sin título)';
      const msgs = c.message_count ? `${c.message_count} msgs` : '';
      return `<div class="ai-hist-item" onclick="aiOpenConversation('${c.id}')">
        <div class="ai-hist-item-title">${title}</div>
        <div class="ai-hist-item-meta">
          <span>${dateStr} ${timeStr}</span>
          ${msgs ? `<span>·</span><span>${msgs}</span>` : ''}
          <span class="ai-hist-item-model ${model}">${modelLabel}</span>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Error al cargar historial.</div>';
  }
}

async function aiOpenConversation(id) {
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

    // Rebuild aiHistory from the loaded conversation so context is preserved
    aiHistory.length = 0;
    aiConversationId = id;
    aiMessageSeq = rows[rows.length - 1].seq + 1;

    msgs.innerHTML = '';
    rows.forEach(row => {
      aiAddMsg(row.role, row.content);
      aiHistory.push({ role: row.role, content: row.content });
    });
    msgs.scrollTop = msgs.scrollHeight;
  } catch(e) {
    msgs.innerHTML = '<div class="ai-msg assistant">⚠️ Error al cargar la conversación.</div>';
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// Copies a preset message into the input box (doesn't send — lets user edit first)
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

async function aiSendMsg() {
  const input = document.getElementById('aiInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';

  // Add user message to UI and history
  aiAddMsg('user', msg);
  aiHistory.push({ role: 'user', content: msg });

  // Thinking indicator with animated states
  const thinkingEl = aiAddMsg('thinking', '');
  thinkingEl.innerHTML = '<span class="ai-thinking-text">Analizando tu portfolio</span><span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';
  const thinkingMsgs = ['Analizando tu portfolio', 'Procesando datos', 'Calculando métricas', 'Preparando respuesta'];
  let tmIdx = 0;
  const tmInterval = setInterval(() => {
    tmIdx = (tmIdx + 1) % thinkingMsgs.length;
    const textEl = thinkingEl.querySelector('.ai-thinking-text');
    if (textEl) textEl.textContent = thinkingMsgs[tmIdx];
  }, 1800);
  thinkingEl._tmInterval = tmInterval;

  // ── Logging: ensure conversation exists, log user message ──
  // Do this before the API call so we have the ID ready when the reply comes back.
  // aiHistory at this point already includes the current user message as the last item.
  // The context slice is the last AI_CONTEXT_WINDOW items of aiHistory *before* this push,
  const historySnapshot = aiHistory.slice();
  const contextSlice    = historySnapshot.slice(-AI_CONTEXT_WINDOW);
  const contextStartSeq = historySnapshot.length - contextSlice.length;

  await aiEnsureConversation(AI_MODELS[aiModel], msg);
  aiLogMessage({ role: 'user', content: msg, context_start_seq: contextStartSeq });

  try {
    const wlBase     = buildWatchlistBase();
    const wlExtended = needsExtendedWatchlist(msg) ? buildWatchlistExtended() : null;
    const macroSection = buildMacroContext();

    // Calculate USD vs GBP exposure dynamically from live portfolio
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
      ? `FX risk: gana y gasta en GBP, pero ~${usdExposurePct}% del portfolio cotiza en USD — movimientos GBP/USD impactan directamente su patrimonio en libras`
      : `FX risk: gana y gasta en GBP, portfolio mixto USD/GBP — movimientos GBP/USD impactan su patrimonio en libras`;

    // ── Profile from Railway env vars with hardcoded fallbacks ──
    const _cfg          = await getAppConfig();
    const _name         = _cfg.aiProfileName       || 'Julián';
    const _monthlyExp   = _cfg.aiMonthlyExpenses   || '£4000';
    const _savingsRange = _cfg.aiSavingsRange      || '£900-1000/mo';
    const _bonusRange   = _cfg.aiBonusRange        || '£9000-10000/yr';
    const _rsuRange     = _cfg.aiRsuRange          || 'META quarterly ~£2100 net/vest';
    const _emergencyMin = _cfg.aiEmergencyFund     || '2500';
    const _goals        = _cfg.aiGoals             || '£30k (end 2026) | £100k (end 2028) | £200k (end 2030)';
    const _annualInvest = _cfg.aiAnnualInvestable  || '~£20k-22k salary+bonus + ~£8k-9k RSUs = £28k-31k/yr';

    // ── Live values from Supabase positions ──
    let _gbpLiquidQty = '?', _emergencyQty = '?';
    if (liveData && liveData.assets) {
      const gbpLiq = liveData.assets.find(a => a.pos.ticker === 'GBP_LIQUID');
      const ef     = liveData.assets.find(a => a.pos.ticker === 'EMERGENCY_FUND');
      if (gbpLiq) _gbpLiquidQty = Math.round(gbpLiq.pos.qty || gbpLiq.valueUSD * FX_RATE).toLocaleString('es-AR');
      if (ef)     _emergencyQty = Math.round(ef.pos.qty     || ef.valueUSD     * FX_RATE).toLocaleString('es-AR');
    }

    // ── Today + next bonus date ──
    const _now      = new Date();
    const _todayStr = _now.toLocaleDateString('es-AR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const _todayISO = _now.toISOString().slice(0,10);

    // Last business day of March (month0=2) and September (month0=8)
    function lastBizDay(year, month0) {
      let d = new Date(Date.UTC(year, month0 + 1, 0)); // last day of month
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0,10);
    }
    const yr = _now.getUTCFullYear();
    const bonusDates = [
      lastBizDay(yr, 2),
      lastBizDay(yr, 8),
      lastBizDay(yr + 1, 2),
    ].filter(d => d >= _todayISO);
    const _nextBonus   = bonusDates[0] || lastBizDay(yr + 1, 2);
    const _daysToBonus = Math.round((new Date(_nextBonus) - _now) / 86400000);

    const systemPrompt = `Sos el asesor financiero personal de ${_name}. Respondé en español, directo y conciso. No uses markdown excesivo.

TODAY: ${_todayStr} (${_todayISO})
NEXT_BONUS: ${_nextBonus} (en ${_daysToBonus} días) — 50% del bono anual neto

PROFILE
location: London, UK | currency: GBP | monthly_expenses: ${_monthlyExp}
savings: ${_savingsRange} | bonus_net: ${_bonusRange} en DOS TRAMOS: 50% último día hábil de marzo + 50% último día hábil de septiembre
rsu: ${_rsuRange} | vest trimestral (ene/abr/jul/oct)
emergency_fund: actual £${_emergencyQty} (EMERGENCY_FUND position) | min_threshold: £${_emergencyMin} — INTOCABLE, prioridad máxima
cash_available: GBP_LIQUID = £${_gbpLiquidQty} (excedente para invertir)
horizon: 5+ years | max_drawdown: 20% | no immediate liquidity needs beyond emergency fund
goals: ${_goals}

CASHFLOW_ANALYSIS
annual_investable: ${_annualInvest}
promotion_possible_2-3yr: bonus +10%, savings +20%, RSUs +15% (no guarantee)
key_dates: último día hábil de mar (50% bonus) | último día hábil de sep (50% bonus) | trim ene/abr/jul/oct (RSU vest)

RULES
- ${fxLine}
- day_change en GBP incluye efecto de movimiento del tipo de cambio USD/GBP intradía (no solo precios)
- META concentration risk: RSUs + held shares = largest single exposure — warn if high relative to total portfolio
- VIX >30=panic, >20=elevated, <15=calm
- US10Y rising = pressure on growth + long bonds
- GBP/USD up = USD portfolio worth less in GBP
- Si emergency_fund < £${_emergencyMin}, prioridad absoluta reponerlo antes de invertir
- Promotion delta should go to investing, not expenses
- Use all provided data (fundamentals, macro, watchlist) for analysis

${buildPortfolioContext()}

${buildHealthContext()}
${buildMarketContext()}
${macroSection ? '\n' + macroSection : ''}
${wlBase       ? '\n' + wlBase       : ''}
${wlExtended   ? '\n' + wlExtended   : ''}`;

    const res = await fetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODELS[aiModel],
        max_tokens: 3000,
        system: systemPrompt,
        messages: contextSlice // already computed above
      })
    });

    const data = await res.json();
    clearInterval(thinkingEl._tmInterval);
    thinkingEl.remove();

    if (data.error) {
      aiAddMsg('assistant', '⚠️ Error: ' + (data.error.message || 'No se pudo conectar con la IA.'));
      aiHistory.pop();
      return;
    }

    // Filter out thinking blocks (Opus extended thinking) — only keep text blocks
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const reply = textBlock?.text || '(sin respuesta)';
    aiAddMsg('assistant', reply);
    aiHistory.push({ role: 'assistant', content: reply });

    // ── Logging: record assistant reply (fire-and-forget) ──
    aiLogMessage({
      role: 'assistant',
      content: reply,
      model: AI_MODELS[aiModel],
      input_tokens:      data.usage?.input_tokens  ?? null,
      output_tokens:     data.usage?.output_tokens ?? null,
      context_start_seq: contextStartSeq,
    });

  } catch(e) {
    clearInterval(thinkingEl._tmInterval);
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

function aiAddMsg(role, text) {
  const msgs = document.getElementById('aiMessages');
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  if (role === 'assistant' && text) {
    el.innerHTML = aiRenderMarkdown(text);
  } else {
    el.textContent = text;
  }
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}
// ── END AI CHAT ─────────────────────────────────────────────────────────────
