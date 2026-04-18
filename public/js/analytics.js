// ── PORTFOLIO HEALTH ENGINE ──────────────────────────────────────────────────

let mcParamsCollapsed = true;
function toggleMcParams() {
  mcParamsCollapsed = !mcParamsCollapsed;
  const body = document.getElementById('mcParamsBody');
  const chevron = document.getElementById('mcParamsChevron');
  if (body) body.style.display = mcParamsCollapsed ? 'none' : '';
  if (chevron) chevron.style.transform = mcParamsCollapsed ? 'rotate(-90deg)' : '';
}

let mcAutoRan = false;
function switchAnalyticsTab(tab, btn) {
  document.querySelectorAll('.analytics-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.analytics-subtab').forEach(s => s.classList.remove('active'));
  document.getElementById(
    tab === 'health' ? 'analyticsHealth' :
    tab === 'corr'   ? 'analyticsCorr'   :
    tab === 'perf'   ? 'analyticsPerf'   : 'analyticsSims'
  ).classList.add('active');
  if (tab === 'health' && typeof renderHealthScore === 'function') renderHealthScore();
  if (tab === 'corr') loadCorrelation();
  if (tab === 'perf') { loadPerformance(); loadRelPerf(); }
  if (tab === 'sims' && !mcAutoRan && typeof mcRun === 'function') {
    mcAutoRan = true;
    setTimeout(() => { const btn = document.getElementById('mcRunBtn'); if (btn) btn.click(); }, 100);
  }
}

// Sector comes from Yahoo assetProfile via /api/market-data — no hardcoding
function toYahooTicker(ticker) {
  if (ticker === 'RSU_META') return 'META';
  if (ticker === 'BTC')      return 'BTC-USD';
  if (ticker === 'ADA')      return 'ADA-USD';
  return ticker;
}

function getTickerSector(ticker, marketMeta) {
  const yahooTicker = toYahooTicker(ticker);
  const d = marketMeta[yahooTicker];
  if (d?.sector) return d.sector;
  // Crypto has no sector in Yahoo
  if (yahooTicker.endsWith('-USD')) return 'Crypto';
  return 'Other';
}

const TICKER_IS_BROAD_ETF = {
  'SPY': true, 'VWRP.L': true,  // truly diversified broad market
  // ARKK.L and NDIA.L are thematic/country-specific — NOT broad
};

const TICKER_BETA_FALLBACK = {
  'SPY': 1.0, 'BRK.B': 0.9, 'MELI': 1.6, 'NU': 1.5, 'ARKK.L': 1.4,
  'VWRP.L': 0.95, 'MSFT': 1.1, 'NDIA.L': 1.1, 'BTC': 1.8, 'ADA': 2.0, 'RSU_META': 1.3,
};

const DRAWDOWN_TOLERANCE = 20; // %

function computeHealthData() {
  if (!liveData) return null;
  const { totalUSD, assets } = liveData;
  const mm = window._marketMeta || {};

  // Exclude RENT_DEPOSIT and EMERGENCY_FUND from health calculations — locked/non-investable
  const EXCLUDED_FROM_HEALTH = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND']);
  const healthAssets = assets.filter(a => !EXCLUDED_FROM_HEALTH.has(a.pos.ticker) && a.valueUSD > 0.5);
  const healthTotalUSD = healthAssets.reduce((s, a) => s + a.valueUSD, 0);
  if (healthTotalUSD < 1) return null;

  // Investable = non-fiat within health assets
  const positions = healthAssets.filter(a => a.pos.category !== 'fiat');
  const investableUSD = positions.reduce((s, a) => s + a.valueUSD, 0);

  // ── Weights (relative to health total, excluding RENT_DEPOSIT) ──
  const weights = positions.map(a => ({
    ticker: a.pos.ticker,
    w: a.valueUSD / healthTotalUSD,
    wInv: investableUSD > 0 ? a.valueUSD / investableUSD : 0,
    valueUSD: a.valueUSD,
    currency: a.pos.currency,
  }));

  // ── HHI (investable positions only — cash has no concentration risk) ──
  const hhiWeights = positions.map(a => a.valueUSD / investableUSD);
  const N = hhiWeights.length;
  const hhi = hhiWeights.reduce((s, w) => s + w * w, 0);
  const effectiveN = hhi > 0 ? 1 / hhi : 0;
  // Normalized HHI: 0 = perfectly equal, 1 = all in one position
  // Auto-calibrates to number of positions: HHI* = (HHI - 1/N) / (1 - 1/N)
  const hhiNorm = N > 1 ? (hhi - 1/N) / (1 - 1/N) : 1;

  // ── Single Stock Risk (only broad ETFs are exempt) ──
  const sorted = [...weights].sort((a, b) => b.w - a.w);
  const topPosition = sorted[0] || { ticker: '—', w: 0 };
  const topNonBroadETF = sorted.find(p => !TICKER_IS_BROAD_ETF[p.ticker]) || topPosition;

  // ── Sector Exposure (from Yahoo assetProfile) ──
  const sectorMap = {};
  weights.forEach(({ ticker, wInv }) => {
    const sector = getTickerSector(ticker, mm);
    sectorMap[sector] = (sectorMap[sector] || 0) + wInv;
  });
  const topSector = Object.entries(sectorMap).sort((a, b) => b[1] - a[1])[0] || ['—', 0];

  // ── Currency Exposure ──
  // GBP = fiat with currency='GBP' (cash/emergency/rent) + assets with pricing_currency='GBP' (VWRP.L etc)
  // USD = everything else (stocks, RSUs, crypto — even if bought with GBP)
  // Uses pricing_currency from DB, NOT the transaction currency
  const currencyAssets = assets.filter(a => a.valueUSD > 0.5);
  const currencyTotalUSD = currencyAssets.reduce((s, a) => s + a.valueUSD, 0);
  let gbpVal = 0;
  currencyAssets.forEach(a => {
    const pos = a.pos;
    const isGBPExposure = (pos.category === 'fiat' && pos.currency === 'GBP')
                       || pos.pricing_currency === 'GBP';
    if (isGBPExposure) gbpVal += a.valueUSD;
  });
  const gbpPct = currencyTotalUSD > 0 ? gbpVal / currencyTotalUSD : 0;
  const usdPct = 1 - gbpPct;

  // ── Portfolio Beta (weighted over FULL health portfolio — cash has beta 0) ──
  // This correctly reflects that cash dampens portfolio volatility
  let betaSum = 0;
  weights.forEach(({ ticker, valueUSD }) => {
    const yahooTicker = toYahooTicker(ticker);
    const beta = mm[yahooTicker]?.beta ?? TICKER_BETA_FALLBACK[ticker] ?? 1.0;
    betaSum += beta * (valueUSD / healthTotalUSD); // weight over full health total (incl cash)
  });
  // Cash portion (fiat in healthAssets) contributes beta 0 — already implicit since we only sum investments
  const portfolioBeta = betaSum; // sum of (beta_i × weight_i) where cash weight has beta=0

  // ── Volatility Estimate ── (beta × SPY historical vol ~15.5%)
  const spyVol = 15.5;
  const portfolioVol = portfolioBeta * spyVol;

  // ── Valuation (weighted forward P/E) — live Yahoo data only ──
  let peSum = 0, peWeightSum = 0;
  weights.forEach(({ ticker, wInv }) => {
    const yahooTicker = toYahooTicker(ticker);
    const d = mm[yahooTicker];
    const fpe = d?.forwardPE ?? d?.trailingPE;
    if (fpe && fpe > 0 && fpe < 200) {
      peSum += fpe * wInv;
      peWeightSum += wInv;
    }
  });
  const portfolioPE = peWeightSum > 0 ? peSum / peWeightSum : null;

  // ── Income Momentum ──
  // Denominator includes emergency fund — it's part of total patrimony
  const emergencyUSD = assets.filter(a => a.pos.ticker === 'EMERGENCY_FUND').reduce((s, a) => s + a.valueUSD, 0);
  const incomeBaseUSD = healthTotalUSD + emergencyUSD;
  const annualFlow = (950 * 12) + 9500 + (calcRsuDefault() * 4); // savings + bonus + RSUs in GBP
  const portfolioGBP = incomeBaseUSD * FX_RATE;
  const incomeRatio = portfolioGBP > 0 ? annualFlow / portfolioGBP : 0;

  // ── Drawdown estimates (informational, used in subscores) ──
  const ddCorrection = portfolioBeta * 14; // typical SPY correction
  const ddBearMarket = portfolioBeta * 34; // typical bear market

  // ── Sub-scores (0-100) ──
  function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }

  const diversificationScore = clamp(100 * (1 - hhiNorm));
  // Risk alignment: beta-based — how much does portfolio amplify market moves
  const riskAlignScore = clamp(100 - (portfolioBeta - 0.8) / (1.6 - 0.8) * 100);
  // Valuation: adjusted thresholds
  const valuationScore = portfolioPE ? clamp(100 - (portfolioPE - 16) / (35 - 16) * 100) : 50;
  // Currency score: you live & spend in GBP, so GBP-heavy is healthy.
  // Ideal range: 40–80% GBP (enough GBP to cover expenses, enough USD for growth).
  // Score 100 at center (60% GBP), linear penalty outside the band.
  // 100% GBP = score ~75 (fine, just opportunity cost), 100% USD = score 0.
  const gbpIdeal = 0.60;
  const gbpMin = 0.30; // below this: FX risk is real
  const gbpMax = 1.00; // 100% GBP allowed but not optimal
  let currencyScore;
  if (gbpPct >= gbpMin && gbpPct <= 0.80) {
    // In comfort zone: small penalty for distance from 60%
    currencyScore = clamp(100 - Math.abs(gbpPct - gbpIdeal) / 0.20 * 25);
  } else if (gbpPct < gbpMin) {
    // Too USD-heavy: linearly worse from 30% down to 0%
    currencyScore = clamp((gbpPct / gbpMin) * 75);
  } else {
    // >80% GBP: mild penalty (you're leaving USD growth on the table)
    currencyScore = clamp(100 - (gbpPct - 0.80) / 0.20 * 25);
  }
  // Single stock: only broad ETFs (SPY, VWRP) exempt; thematic ETFs (NDIA, ARKK) penalize
  const singleStockW = topNonBroadETF.w * 100;
  const singleStockScore = clamp(100 - (singleStockW - 10) / (30 - 10) * 100);
  const incomeScore = clamp(incomeRatio / 0.5 * 100);

  const healthScore = Math.round(
    diversificationScore * 0.20 +
    riskAlignScore * 0.20 +
    valuationScore * 0.15 +
    currencyScore * 0.15 +
    singleStockScore * 0.15 +
    incomeScore * 0.15
  );

  const topNonBroadETFTicker = topNonBroadETF.ticker === 'RSU_META' ? 'META' : topNonBroadETF.ticker;

  // Per-position detail data for modals (investments + cash)
  const positionDetails = weights.map(({ ticker, w, wInv, valueUSD, currency }) => {
    const yahooTicker = toYahooTicker(ticker);
    const d = mm[yahooTicker] || {};
    const displayTicker = ticker === 'RSU_META' ? 'META' : ticker;
    return {
      ticker: displayTicker,
      beta: d.beta ?? TICKER_BETA_FALLBACK[ticker] ?? null,
      pe: d.forwardPE ?? d.trailingPE ?? null,
      sector: getTickerSector(ticker, mm),
      currency,
      weight: valueUSD / healthTotalUSD, // weight over full health total
      weightInv: wInv,
      valueUSD,
      valueGBP: valueUSD * FX_RATE,
    };
  });
  // Add cash positions for beta/currency modals
  const cashInHealth = healthAssets.filter(a => a.pos.category === 'fiat' && a.valueUSD > 0.5);
  cashInHealth.forEach(a => {
    positionDetails.push({
      ticker: a.pos.ticker === 'GBP_LIQUID' ? 'Cash GBP' : a.pos.ticker,
      beta: 0,
      pe: null,
      sector: 'Cash',
      currency: a.pos.currency,
      weight: a.valueUSD / healthTotalUSD,
      weightInv: 0,
      valueUSD: a.valueUSD,
      valueGBP: a.valueUSD * FX_RATE,
    });
  });

  return {
    healthScore, hhi, effectiveN, healthTotalUSD, hhiNorm,
    topPosition, topNonBroadETF, topSector, sectorMap,
    usdPct, gbpPct,
    portfolioBeta, portfolioVol, portfolioPE,
    incomeRatio, annualFlow, portfolioGBP,
    ddCorrection, ddBearMarket,
    positionDetails, currencyTotalUSD,
    subscores: [
      { name: 'Diversificación', score: diversificationScore, icon: '◆',
        detail: `${effectiveN.toFixed(1)} pos. efectivas de ${N} · concentración ${(hhiNorm*100).toFixed(0)}%`,
        color: diversificationScore > 66 ? 'var(--accent3)' : diversificationScore > 33 ? 'var(--accent4)' : 'var(--accent2)' },
      { name: 'Alineación al riesgo', score: riskAlignScore, icon: '◎',
        detail: `Beta ${portfolioBeta.toFixed(2)} · corrección -${ddCorrection.toFixed(0)}% · bear -${ddBearMarket.toFixed(0)}%`,
        color: riskAlignScore > 66 ? 'var(--accent3)' : riskAlignScore > 33 ? 'var(--accent4)' : 'var(--accent2)' },
      { name: 'Valuación', score: valuationScore, icon: '◈',
        detail: portfolioPE ? `Forward P/E ${portfolioPE.toFixed(1)}x vs S&P ~21x` : 'Sin datos de P/E',
        color: valuationScore > 66 ? 'var(--accent3)' : valuationScore > 33 ? 'var(--accent4)' : 'var(--accent2)' },
      { name: 'Balance cambiario', score: currencyScore, icon: '◇',
        detail: `GBP ${(gbpPct*100).toFixed(0)}% · USD ${(usdPct*100).toFixed(0)}%`,
        color: currencyScore > 66 ? 'var(--accent3)' : currencyScore > 33 ? 'var(--accent4)' : 'var(--accent2)' },
      { name: 'Concentración individual', score: singleStockScore, icon: '◉',
        detail: `Top stock: ${topNonBroadETFTicker} (${(topNonBroadETF.w*100).toFixed(1)}%)` + (topPosition.ticker !== topNonBroadETF.ticker ? ` · Top total: ${topPosition.ticker === 'RSU_META' ? 'META' : topPosition.ticker} (${(topPosition.w*100).toFixed(1)}%)` : ''),
        color: singleStockScore > 66 ? 'var(--accent3)' : singleStockScore > 33 ? 'var(--accent4)' : 'var(--accent2)' },
      { name: 'Income momentum', score: incomeScore, icon: '◈',
        detail: `Flujo anual = ${(incomeRatio*100).toFixed(0)}% del portfolio`,
        color: incomeScore > 66 ? 'var(--accent3)' : incomeScore > 33 ? 'var(--accent4)' : 'var(--accent2)' },
    ],
  };
}

function renderHealthScore() {
  const data = computeHealthData();
  if (!data) return;

  // ── Gauge ──
  const canvas = document.getElementById('healthGaugeCanvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 280 * dpr; canvas.height = 160 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cx = 140, cy = 140, r = 110;
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const scoreAngle = startAngle + (data.healthScore / 100) * Math.PI;

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.lineWidth = 14;
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Score arc with gradient
  const grad = ctx.createLinearGradient(30, 0, 250, 0);
  grad.addColorStop(0, '#ff4d6d');
  grad.addColorStop(0.4, '#f7b731');
  grad.addColorStop(0.7, '#43e97b');
  grad.addColorStop(1, '#43e97b');
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, scoreAngle);
  ctx.lineWidth = 14;
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Score value
  const scoreEl = document.getElementById('healthScoreVal');
  const scoreColor = data.healthScore > 70 ? 'var(--accent3)' : data.healthScore > 45 ? 'var(--accent4)' : 'var(--accent2)';
  scoreEl.textContent = data.healthScore;
  scoreEl.style.color = scoreColor;

  // Label
  const labelEl = document.getElementById('healthLabel');
  const labels = [
    [80, 'Excelente'], [65, 'Bueno'], [50, 'Moderado'], [35, 'Necesita atención'], [0, 'Riesgo alto']
  ];
  const label = labels.find(l => data.healthScore >= l[0])?.[1] || 'Riesgo alto';
  labelEl.textContent = label;
  labelEl.style.color = scoreColor;

  // ── Sub-scores ──
  const ssEl = document.getElementById('healthSubscores');
  ssEl.innerHTML = data.subscores.map((s, idx) => `
    <div class="health-subscore" onclick="openHealthDetail('subscore_${idx}')" style="cursor:pointer">
      <div class="health-ss-icon" style="background:${s.color}22;color:${s.color}">${s.icon}</div>
      <div class="health-ss-info">
        <div class="health-ss-name">${s.name}<span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;border:1px solid var(--border);font-size:7px;color:var(--muted);margin-left:4px;vertical-align:middle;line-height:1">i</span></div>
        <div class="health-ss-detail">${s.detail}</div>
        <div class="health-ss-bar"><div class="health-ss-fill" style="width:${s.score}%;background:${s.color}"></div></div>
      </div>
      <div class="health-ss-score" style="color:${s.color}">${s.score}</div>
    </div>
  `).join('');

  // ── Key Metrics (with ⓘ for drillable ones) ──
  const metricsEl = document.getElementById('healthMetrics');
  const topTicker = data.topNonBroadETF.ticker === 'RSU_META' ? 'META' : data.topNonBroadETF.ticker;
  const impactIf20 = (data.topNonBroadETF.w * 20).toFixed(1);
  const infoIcon = '<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--border);font-size:8px;color:var(--muted);margin-left:5px;flex-shrink:0;line-height:1">i</span>';

  const metrics = [
    { label: 'Beta del portfolio', val: data.portfolioBeta.toFixed(2), color: data.portfolioBeta > 1.3 ? 'var(--accent2)' : data.portfolioBeta > 1.0 ? 'var(--accent4)' : 'var(--accent3)', drilldown: 'beta' },
    { label: 'Volatilidad estimada (anual)', val: data.portfolioVol.toFixed(1) + '%', color: data.portfolioVol > 22 ? 'var(--accent2)' : data.portfolioVol > 16 ? 'var(--accent4)' : 'var(--accent3)' },
    { label: 'Valuación (fwd P/E)', val: data.portfolioPE ? data.portfolioPE.toFixed(1) + 'x' : '—', color: data.portfolioPE > 30 ? 'var(--accent2)' : data.portfolioPE > 22 ? 'var(--accent4)' : 'var(--accent3)', drilldown: 'pe' },
    { label: 'Mayor exposición sectorial', val: data.topSector[0] + ' (' + (data.topSector[1]*100).toFixed(0) + '%)', color: data.topSector[1] > 0.4 ? 'var(--accent4)' : 'var(--text)', drilldown: 'sector' },
    { label: 'Exposición USD / GBP', val: (data.usdPct*100).toFixed(0) + '% / ' + (data.gbpPct*100).toFixed(0) + '%', color: data.usdPct > 0.85 ? 'var(--accent4)' : 'var(--text)', drilldown: 'currency' },
    { label: `Si ${topTicker} cae 20%`, val: '-' + impactIf20 + '% portfolio', color: 'var(--accent2)' },
    { label: 'Posiciones efectivas (1/HHI)', val: data.effectiveN.toFixed(1), color: data.effectiveN < 5 ? 'var(--accent2)' : data.effectiveN < 10 ? 'var(--accent4)' : 'var(--accent3)' },
  ];

  metricsEl.innerHTML = metrics.map(m => {
    const clickAttr = m.drilldown ? ` onclick="openHealthDetail('${m.drilldown}')" style="cursor:pointer"` : '';
    const icon = m.drilldown ? infoIcon : '';
    return `<div class="health-metric-row"${clickAttr}>
      <div class="health-metric-label">${m.label}${icon}</div>
      <div class="health-metric-val" style="color:${m.color}">${m.val}</div>
    </div>`;
  }).join('');

  // ── Drawdown slider ──
  updateDrawdown();
}

// ── Health detail modal ──
function openHealthDetail(type) {
  const data = computeHealthData();
  if (!data) return;
  const isGBP = currentCurrency === 'GBP';
  const sym = isGBP ? '£' : '$';
  const pd = data.positionDetails;

  let title = '', html = '';

  if (type === 'beta') {
    title = 'Beta por posición';
    const sorted = [...pd].filter(p => p.beta != null).sort((a, b) => b.beta - a.beta);
    html = '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += '<tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:6px 4px;color:var(--muted);font-size:10px">Ticker</th><th style="text-align:right;padding:6px 4px;color:var(--muted);font-size:10px">Beta</th><th style="text-align:right;padding:6px 4px;color:var(--muted);font-size:10px">Peso</th></tr>';
    sorted.forEach(p => {
      const bColor = p.beta > 1.3 ? 'var(--accent2)' : p.beta > 1.0 ? 'var(--accent4)' : 'var(--accent3)';
      html += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px;font-weight:600">${p.ticker}</td><td style="text-align:right;padding:6px 4px;font-family:var(--font-num);font-weight:700;color:${bColor}">${p.beta.toFixed(2)}</td><td style="text-align:right;padding:6px 4px;color:var(--muted)">${(p.weight*100).toFixed(1)}%</td></tr>`;
    });
    html += '</table>';
  }

  if (type === 'pe') {
    title = 'P/E por posición';
    const sorted = [...pd].filter(p => p.pe != null && p.pe > 0).sort((a, b) => b.pe - a.pe);
    html = '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += '<tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:6px 4px;color:var(--muted);font-size:10px">Ticker</th><th style="text-align:right;padding:6px 4px;color:var(--muted);font-size:10px">P/E</th><th style="text-align:right;padding:6px 4px;color:var(--muted);font-size:10px">Peso</th></tr>';
    sorted.forEach(p => {
      const peColor = p.pe > 30 ? 'var(--accent2)' : p.pe > 22 ? 'var(--accent4)' : 'var(--accent3)';
      html += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px;font-weight:600">${p.ticker}</td><td style="text-align:right;padding:6px 4px;font-family:var(--font-num);font-weight:700;color:${peColor}">${p.pe.toFixed(1)}x</td><td style="text-align:right;padding:6px 4px;color:var(--muted)">${(p.weight*100).toFixed(1)}%</td></tr>`;
    });
    html += '</table>';
  }

  if (type === 'sector') {
    title = 'Exposición sectorial';
    // Group positions by sector
    const sectorGroups = {};
    pd.forEach(p => {
      if (!sectorGroups[p.sector]) sectorGroups[p.sector] = [];
      sectorGroups[p.sector].push(p);
    });
    const sortedSectors = Object.entries(sectorGroups).sort((a, b) => {
      const wA = a[1].reduce((s, p) => s + p.weight, 0);
      const wB = b[1].reduce((s, p) => s + p.weight, 0);
      return wB - wA;
    });
    html = '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    sortedSectors.forEach(([sector, positions]) => {
      const sectorWeight = positions.reduce((s, p) => s + p.weight, 0);
      const rowspan = positions.length;
      positions.forEach((p, i) => {
        html += '<tr style="border-bottom:1px solid var(--border)">';
        if (i === 0) html += `<td style="padding:6px 4px;font-weight:700;color:var(--accent);vertical-align:top;font-size:11px;width:100px;min-width:100px" rowspan="${rowspan}">${sector}<br><span style="font-size:10px;color:var(--muted);font-weight:400">${(sectorWeight*100).toFixed(0)}%</span></td>`;
        html += `<td style="padding:4px 4px;font-weight:500">${p.ticker}</td><td style="text-align:right;padding:4px;color:var(--muted)">${(p.weight*100).toFixed(1)}%</td></tr>`;
      });
    });
    html += '</table>';
  }

  if (type === 'currency') {
    title = 'Exposición por moneda';
    const allAssets = liveData.assets.filter(a => a.valueUSD > 0.5);
    const usdAssets = [], gbpAssets = [];
    allAssets.forEach(a => {
      const pos = a.pos;
      const displayTicker = pos.ticker === 'RSU_META' ? 'META' : pos.ticker;
      const meta = TICKER_META[pos.ticker] || { name: pos.ticker };
      const entry = { ticker: displayTicker, name: meta.name, valueUSD: a.valueUSD, valueGBP: a.valueUSD * FX_RATE, pct: a.valueUSD / data.currencyTotalUSD };
      const isGBP = (pos.category === 'fiat' && pos.currency === 'GBP') || pos.pricing_currency === 'GBP';
      if (isGBP) gbpAssets.push(entry);
      else usdAssets.push(entry);
    });
    usdAssets.sort((a, b) => b.valueUSD - a.valueUSD);
    gbpAssets.sort((a, b) => b.valueUSD - a.valueUSD);

    const fmtV = v => isGBP ? sym + Math.round(v * FX_RATE).toLocaleString('es-AR') : sym + Math.round(v).toLocaleString('es-AR');

    html = '<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px">USD (' + (data.usdPct*100).toFixed(0) + '%)</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">';
    usdAssets.forEach(a => {
      html += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:4px">${a.ticker}</td><td style="text-align:right;padding:4px;font-family:var(--font-num);font-weight:600">${fmtV(a.valueUSD)}</td><td style="text-align:right;padding:4px;color:var(--muted)">${(a.pct*100).toFixed(1)}%</td></tr>`;
    });
    html += '</table>';
    html += '<div style="font-size:11px;font-weight:700;color:var(--accent3);margin-bottom:6px">GBP (' + (data.gbpPct*100).toFixed(0) + '%)</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    gbpAssets.forEach(a => {
      html += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:4px">${a.ticker}</td><td style="text-align:right;padding:4px;font-family:var(--font-num);font-weight:600">${fmtV(a.valueUSD)}</td><td style="text-align:right;padding:4px;color:var(--muted)">${(a.pct*100).toFixed(1)}%</td></tr>`;
    });
    html += '</table>';
  }

  // Subscore explanations
  const subscoreExplanations = [
    { name: 'Diversificación', text: 'Usa el HHI Normalizado (Herfindahl-Hirschman). Mide qué tan concentrado está tu portfolio relativo a la distribución óptima (todas las posiciones iguales). HHI* = 0% = perfectamente diversificado, 100% = todo en una posición. Score = 100 × (1 - HHI*). Se auto-calibra al número de posiciones.' },
    { name: 'Alineación al riesgo', text: 'Basado en el beta ponderado del portfolio. Beta < 1 = amortigua caídas del mercado, Beta > 1 = amplifica. Escala: beta 0.8 = score 100 (defensivo), beta 1.6 = score 0 (muy agresivo). Se complementa con las estimaciones de corrección (SPY -14%) y bear market (SPY -34%).' },
    { name: 'Valuación', text: 'Forward P/E ponderado del portfolio vs benchmark S&P ~21x. Un P/E bajo significa que pagás menos por cada peso de ganancia futura — más "margin of safety". Escala: 16x = score 100, 35x = score 0. Datos de Yahoo Finance.' },
    { name: 'Balance cambiario', text: 'Mide la distribución entre activos denominados en GBP y USD. La clasificación se basa en la moneda de cotización de cada activo: GBP incluye efectivo en libras y activos que cotizan en GBP; USD incluye el resto. Zona ideal: 40–80% GBP. Score máximo cerca del 60% GBP; por debajo del 30% el riesgo cambiario es elevado; por encima del 80% hay una penalización leve por menor exposición a crecimiento en USD.' },
    { name: 'Concentración individual', text: 'La posición individual (no-ETF broad) más grande como % del portfolio. ETFs diversificados (SPY, VWRP) no penalizan; ETFs temáticos (NDIA, ARKK) sí. Escala: <10% = score 100, >30% = score 0.' },
    { name: 'Income momentum', text: 'Flujo anual de cash nuevo (ahorro + bono + RSUs) como % del portfolio. Mientras más alto, menos dependés del rendimiento del mercado para crecer. Score = ratio / 50% × 100, capped a 100.' },
  ];

  if (type.startsWith('subscore_')) {
    const idx = parseInt(type.split('_')[1]);
    const ss = data.subscores[idx];
    const exp = subscoreExplanations[idx];
    if (!ss || !exp) return;
    title = exp.name;
    html = `<div style="font-size:13px;line-height:1.6;color:var(--text);margin-bottom:16px">${exp.text}</div>`;
    html += `<div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--surface2);border-radius:12px">
      <div style="font-family:var(--font-num);font-size:28px;font-weight:800;color:${ss.color}">${ss.score}</div>
      <div>
        <div style="font-size:12px;font-weight:600">${ss.name}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${ss.detail}</div>
      </div>
    </div>`;
  }

  if (type === 'total') {
    title = 'Composición del Health Score';
    const weights = [20, 20, 15, 15, 15, 15];
    html = '<div style="font-size:12px;color:var(--muted);margin-bottom:14px">Promedio ponderado de 6 sub-scores</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += '<tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:6px 4px;color:var(--muted);font-size:10px">Componente</th><th style="text-align:right;padding:6px 4px;color:var(--muted);font-size:10px">Peso</th><th style="text-align:right;padding:6px 4px;color:var(--muted);font-size:10px">Score</th><th style="text-align:right;padding:6px 4px;color:var(--muted);font-size:10px">Aporte</th></tr>';
    data.subscores.forEach((ss, i) => {
      const contrib = (ss.score * weights[i] / 100).toFixed(1);
      html += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 4px">${ss.name}</td><td style="text-align:right;padding:6px 4px;color:var(--muted)">${weights[i]}%</td><td style="text-align:right;padding:6px 4px;font-family:var(--font-num);font-weight:700;color:${ss.color}">${ss.score}</td><td style="text-align:right;padding:6px 4px;font-family:var(--font-num);font-weight:600">${contrib}</td></tr>`;
    });
    html += `<tr><td style="padding:8px 4px;font-weight:700">Total</td><td></td><td></td><td style="text-align:right;padding:8px 4px;font-family:var(--font-num);font-weight:800;font-size:16px">${data.healthScore}</td></tr>`;
    html += '</table>';
  }

  // Show in modal
  const modal = document.getElementById('healthDetailModal');
  document.getElementById('healthDetailTitle').textContent = title;
  document.getElementById('healthDetailBody').innerHTML = html;
  modal.classList.add('open');
}

function closeHealthDetail() {
  document.getElementById('healthDetailModal').classList.remove('open');
}

function updateDrawdown() {
  const data = computeHealthData();
  if (!data) return;
  const spyDrop = parseInt(document.getElementById('ddSlider').value);
  document.getElementById('ddSpyVal').textContent = '-' + spyDrop + '%';

  const portfolioDrop = data.portfolioBeta * spyDrop;
  const portfolioGBP = data.portfolioGBP;
  const lossGBP = portfolioGBP * portfolioDrop / 100;
  const sym = currentCurrency === 'GBP' ? '£' : '$';
  const lossDisplay = currentCurrency === 'GBP' ? lossGBP : lossGBP / FX_RATE;

  // Color based on severity vs tolerance
  const dropColor = portfolioDrop <= DRAWDOWN_TOLERANCE ? 'var(--accent3)'
    : portfolioDrop <= DRAWDOWN_TOLERANCE * 1.3 ? 'var(--accent4)'
    : 'var(--accent2)';

  const ddPortEl = document.getElementById('ddPortfolio');
  ddPortEl.textContent = '-' + portfolioDrop.toFixed(1) + '%';
  ddPortEl.style.color = dropColor;

  const ddLossEl = document.getElementById('ddLoss');
  ddLossEl.textContent = '-' + sym + Math.round(Math.abs(lossDisplay)).toLocaleString('es-AR');
  ddLossEl.style.color = dropColor;

  const tolEl = document.getElementById('ddTolerance');
  if (portfolioDrop <= DRAWDOWN_TOLERANCE) {
    tolEl.textContent = '✓ OK';
    tolEl.style.color = 'var(--accent3)';
  } else if (portfolioDrop <= DRAWDOWN_TOLERANCE * 1.3) {
    // Within 30% above tolerance — warning but not critical
    tolEl.textContent = '~ Cerca';
    tolEl.style.color = 'var(--accent4)';
  } else {
    tolEl.textContent = '⚠ Excede';
    tolEl.style.color = 'var(--accent2)';
  }
}

// ── MONTE CARLO ENGINE (Chart.js version) ──────────────────────────────────

const MC_NOW       = new Date();
const MC_NOW_YEAR  = MC_NOW.getFullYear();
const MC_NOW_MONTH = MC_NOW.getMonth();
const MC_BONUS_MONTHS = new Set([3, 9]);
const MC_RSU_MONTHS   = new Set([1, 4, 7, 10]);

let mcChartFan = null, mcChartHist = null;
let mcSimsCache = null, mcSimMonths = 0;
const mcTogState = { monthly:true, bonus:true, rsu:true, eom:true };
const MC_SCEN = { bear:{ret:3,vol:25}, neutral:{ret:9,vol:18}, bull:{ret:16,vol:22} };
let mcHistYr = 3;

// Seed portfolio values from already-loaded liveData
function mcGetPortfolioInvested() {
  if (typeof liveData !== 'undefined' && liveData && liveData.totalUSD) {
    const invested = liveData.assets
      .filter(a => a.pos.category !== 'fiat' && a.valueUSD > 0)
      .reduce((s, a) => s + a.valueUSD, 0);
    return Math.round(invested * FX_RATE);
  }
  return 8000;
}
function mcGetPortfolioCash() {
  if (typeof liveData !== 'undefined' && liveData && liveData.totalUSD) {
    const cash = liveData.assets
      .filter(a => a.pos.category === 'fiat' && a.valueUSD > 0)
      .reduce((s, a) => s + a.valueUSD, 0);
    return Math.round(cash * FX_RATE);
  }
  return 4000;
}

// Box-Muller
function mcRandn() {
  let u, v;
  do { u = Math.random(); v = Math.random(); } while (!u);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mcCalMonth(m) { return (MC_NOW_MONTH + m) % 12; }

function mcSimulate({ startInvested, startCash, annRet, annVol, cashRet, cashVol, years, n, monthly, bonus, rsu,
                      useMo, useBo, useRSU, isEOM }) {
  const mr = annRet / 100 / 12;
  const mv = annVol / 100 / Math.sqrt(12);
  const cr = cashRet / 100 / 12;
  const cv = cashVol / 100 / Math.sqrt(12);
  const M  = years * 12;
  const snaps = Array.from({ length: n }, () => new Float32Array(M + 1));
  for (let s = 0; s < n; s++) {
    let inv = startInvested;
    let cash = startCash;
    snaps[s][0] = inv + cash;
    for (let m = 1; m <= M; m++) {
      const applyMarket = !(isEOM && m === 1);
      if (applyMarket) {
        inv  *= 1 + mr + mv * mcRandn();
        cash *= 1 + cr + cv * mcRandn();
      }
      const cm = mcCalMonth(m);
      // New cash flows go to invested (assumption: you invest new money)
      if (useMo)             inv += monthly;
      if (useBo && MC_BONUS_MONTHS.has(cm)) inv += bonus / 2;
      if (useRSU && MC_RSU_MONTHS.has(cm))   inv += rsu;
      const total = inv + cash;
      snaps[s][m] = total < 0 ? 0 : total;
    }
  }
  return snaps;
}

function mcPct(arr, p) {
  const sorted = Float32Array.from(arr).sort();
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function mcProbAbove(sims, mi, target) {
  const above = sims.reduce((a, s) => a + (s[mi] >= target ? 1 : 0), 0);
  return (above / sims.length * 100).toFixed(0) + '%';
}

function mcFmtK(v) {
  if (v == null) return '—';
  return v >= 1000 ? '£' + Math.round(v / 1000) + 'k' : '£' + Math.round(v);
}
function mcFmtFull(v) {
  if (v == null) return '—';
  return '£' + Math.round(v).toLocaleString('es-AR');
}

function mcDateShort(m) {
  const d = new Date(MC_NOW_YEAR, MC_NOW_MONTH + m, 1);
  return d.toLocaleDateString('es-AR', { month:'short', year:'2-digit' });
}

function mcTheme() {
  const dark = typeof isDark !== 'undefined' ? isDark : true;
  return {
    gc:   dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    tc:   dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)',
    ttBg: dark ? '#1c1c26' : '#fff',
  };
}

// Render histogram for a given year
function mcRenderHist(sims, M, yr) {
  const mi = Math.min(yr * 12, M);
  const finals = sims.map(s => s[mi]);
  const total  = finals.length;
  const hMin = Math.min(...finals), hMax = Math.max(...finals);
  const B    = 30;
  const bSz  = (hMax - hMin) / B || 1;
  const counts = new Array(B).fill(0);
  finals.forEach(v => { counts[Math.min(Math.floor((v - hMin) / bSz), B-1)]++; });
  const freqs = counts.map(c => c / total * 100);
  const cumul = [];
  let acc = 0;
  freqs.forEach(f => { acc += f; cumul.push(acc); });
  const hLbls = Array.from({length:B}, (_,i) => mcFmtK(hMin + i * bSz));
  const { gc, tc, ttBg } = mcTheme();

  document.getElementById('mcHistEmpty').style.display = 'none';
  const histCvs = document.getElementById('mcHistChart');
  histCvs.style.display = 'block';
  if (mcChartHist) mcChartHist.destroy();

  mcChartHist = new Chart(histCvs, {
    type:'bar',
    data:{
      labels: hLbls,
      datasets:[{
        data: freqs,
        backgroundColor: freqs.map((_,i) => {
          const v = hMin + i * bSz;
          if (v >= 200000) return 'rgba(79,195,247,.8)';
          if (v >= 100000) return 'rgba(67,233,123,.8)';
          if (v >= 30000)  return 'rgba(108,99,255,.8)';
          return 'rgba(255,77,109,.5)';
        }),
        borderWidth:0, borderRadius:2
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:ttBg, titleColor:tc, bodyColor:tc, borderColor:gc, borderWidth:1,
          callbacks:{
            title: ctx => '~' + ctx[0].label,
            label: ctx => {
              const i = ctx.dataIndex;
              return ['Frecuencia: ' + freqs[i].toFixed(1) + '%', 'Acumulado: ' + cumul[i].toFixed(1) + '%'];
            }
          }
        }
      },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:tc, font:{size:8}, maxTicksLimit:5 } },
        y:{ grid:{color:gc}, ticks:{ color:tc, font:{size:9}, callback: v => v.toFixed(0) + '%' } }
      }
    }
  });
}

// Main run
// Calcula el valor neto por vest RSU basado en los próximos 8 trimestres.
// Promedia las unidades, multiplica por precio META actual, convierte a GBP y aplica 53% neto.
function calcRsuDefault() {
  if (typeof vestSchedule === 'undefined' || !Array.isArray(vestSchedule)) return 2100;
  const upcoming = vestSchedule.filter(v => !v.vested).slice(0, 8);
  if (!upcoming.length) return 2100;
  const avgUnits = upcoming.reduce((s, v) => s + v.units, 0) / upcoming.length;
  const priceUSD = (typeof getRSUPriceUSD === 'function') ? getRSUPriceUSD() : 600;
  const rate = (typeof FX_RATE !== 'undefined') ? FX_RATE : 0.79;
  return Math.round(avgUnits * priceUSD * rate * 0.53);
}

function mcRun() {
  const btn = document.getElementById('mcRunBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="mc-spin"></span>Simulando…';

  setTimeout(() => {
    const _n = (id, fb) => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? fb : v; };
    const annRet   = _n('mc-p-return', 9);
    const annVol   = _n('mc-p-vol',    18);
    const cashRet  = _n('mc-p-cash-return', 3);
    const cashVol  = _n('mc-p-cash-vol',    1);
    const monthly  = _n('mc-p-monthly',950);
    const bonus    = _n('mc-p-bonus',  8000);
    const rsu      = _n('mc-p-rsu',    calcRsuDefault());
    const years    = parseInt(document.getElementById('mc-p-years').value) || 5;
    const n        = Math.min(parseInt(document.getElementById('mc-p-sims').value) || 10000, 50000);
    const startInvested = _n('mc-p-invested', mcGetPortfolioInvested());
    const startCash     = _n('mc-p-cash', mcGetPortfolioCash());

    const M = years * 12;
    mcSimMonths = M;

    const sims = mcSimulate({
      startInvested, startCash, annRet, annVol, cashRet, cashVol, years, n,
      monthly, bonus, rsu,
      useMo: mcTogState.monthly, useBo: mcTogState.bonus, useRSU: mcTogState.rsu,
      isEOM: mcTogState.eom
    });
    mcSimsCache = sims;

    // Probability targets
    const targets = [
      { id:'mcProb30k',  mi:12,  target:30000,  label:'£30k'  },
      { id:'mcProb100k', mi:36,  target:100000, label:'£100k' },
      { id:'mcProb200k', mi:60,  target:200000, label:'£200k' },
    ];
    targets.forEach(({ id, mi, target, label }) => {
      const capped = Math.min(mi, M);
      const dateStr = mcDateShort(capped);
      document.getElementById(id).textContent = capped <= M ? mcProbAbove(sims, capped, target) : '—';
      document.getElementById(id + '-tgt').textContent = label + ' · ' + dateStr;
      document.querySelector('#' + id).closest('.mc-prob-card').querySelector('.mc-prob-yr').textContent = dateStr;
    });

    // Percentile bands
    const { gc, tc, ttBg } = mcTheme();
    const labels = [], fullLabels = [], p10=[], p25=[], p50=[], p75=[], p90=[];
    for (let m = 0; m <= M; m++) {
      const d = new Date(MC_NOW_YEAR, MC_NOW_MONTH + m, 1);
      labels.push(m % 3 === 0 ? d.toLocaleDateString('es-AR', { month:'short', year:'2-digit' }) : '');
      fullLabels.push(d.toLocaleDateString('es-AR', { month:'long', year:'numeric' }));
      const col = sims.map(s => s[m]);
      p10.push(mcPct(col,10)); p25.push(mcPct(col,25)); p50.push(mcPct(col,50));
      p75.push(mcPct(col,75)); p90.push(mcPct(col,90));
    }

    // Fan chart
    document.getElementById('mcFanEmpty').style.display = 'none';
    const fanCvs = document.getElementById('mcFanChart');
    fanCvs.style.display = 'block';
    if (mcChartFan) mcChartFan.destroy();

    mcChartFan = new Chart(fanCvs, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label:'p90', data:p90, borderColor:'rgba(79,195,247,.85)',  borderWidth:1.5, pointRadius:0, fill:false,  stepped:true },
          { label:'p75', data:p75, borderColor:'rgba(67,233,123,.85)',  borderWidth:1.5, pointRadius:0, fill:'-1',   backgroundColor:'rgba(67,233,123,.06)', stepped:true },
          { label:'p50', data:p50, borderColor:'rgba(108,99,255,1)',    borderWidth:2.5, pointRadius:0, fill:false,  stepped:true },
          { label:'p25', data:p25, borderColor:'rgba(247,183,49,.85)',  borderWidth:1.5, pointRadius:0, fill:'+1',   backgroundColor:'rgba(247,183,49,.06)', stepped:true },
          { label:'p10', data:p10, borderColor:'rgba(255,77,109,.85)',  borderWidth:1.5, pointRadius:0, fill:false,  stepped:true },
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ display:false },
          tooltip:{
            backgroundColor:ttBg, titleColor:tc, bodyColor:tc, borderColor:gc, borderWidth:1,
            callbacks:{
              title: ctx => fullLabels[ctx[0].dataIndex],
              label: c => c.dataset.label + ': ' + mcFmtFull(c.raw)
            }
          },
          zoom:{
            limits:{ x:{ min:'original', max:'original' } },
            zoom:{
              pinch:{ enabled:true, speed:0.03 },
              wheel:{ enabled:true, speed:0.03 },
              mode:'x',
            },
            pan:{ enabled:true, mode:'xy', speed:5, threshold:10,
              modifierKey: null,
              onPanStart: ({event}) => event.touches?.length >= 2,
            }
          }
        },
        scales:{
          x:{ grid:{color:gc}, ticks:{ color:tc, font:{size:9}, maxRotation:0, maxTicksLimit:14 } },
          y:{ grid:{color:gc}, ticks:{ color:tc, font:{size:9}, callback:mcFmtK } }
        }
      }
    });

    fanCvs.addEventListener('touchmove', e => { if (e.touches.length >= 2) e.preventDefault(); }, { passive:false });
    fanCvs.addEventListener('touchstart', e => { if (e.touches.length >= 2) e.stopPropagation(); }, { passive:true });

    // Histogram
    mcRenderHist(sims, M, mcHistYr);

    // Percentile table
    const milestones = [3,6,12,18,24,36,48,60].filter(m => m <= M);
    let html = '<table class="mc-pct-table"><thead><tr><th></th><th>p10</th><th>p25</th><th>p50</th><th>p75</th><th>p90</th></tr></thead><tbody>';
    milestones.forEach(m => {
      const lbl = mcDateShort(m);
      const col = sims.map(s => s[m]);
      html += '<tr><td>' + lbl + '</td>' + [10,25,50,75,90].map(p => '<td>' + mcFmtK(mcPct(col,p)) + '</td>').join('') + '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('mcTblWrap').innerHTML = html;

    btn.disabled = false;
    btn.textContent = 'Simular';
  }, 20);
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
  // Pre-fill Monte Carlo inputs: Railway env vars when available, dynamic calc otherwise
  if (typeof getAppConfig === 'function') {
    getAppConfig().then(cfg => {
      const setField = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      if (cfg.mcMonthlySaving) setField('mc-p-monthly', cfg.mcMonthlySaving);
      // Bonus: Railway var o fallback 8000
      setField('mc-p-bonus', cfg.mcAnnualBonus || 8000);
      // RSU: Railway var o cálculo dinámico (requiere vestSchedule + precio cargados)
      if (cfg.mcRsuPerVest) {
        setField('mc-p-rsu', cfg.mcRsuPerVest);
      } else {
        // vestSchedule puede no estar listo aún — esperar a que loadRSUVests termine
        const setRsuWhenReady = () => {
          const v = calcRsuDefault();
          if (v !== 2100 || (typeof vestSchedule !== 'undefined' && vestSchedule.length > 0)) {
            setField('mc-p-rsu', v);
          } else {
            setTimeout(setRsuWhenReady, 500);
          }
        };
        setTimeout(setRsuWhenReady, 300);
      }
    }).catch(() => {});
  }
  // Scenario buttons
  document.querySelectorAll('.mc-scen-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mc-scen-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (MC_SCEN[btn.dataset.scen]) {
        document.getElementById('mc-p-return').value = MC_SCEN[btn.dataset.scen].ret;
        document.getElementById('mc-p-vol').value    = MC_SCEN[btn.dataset.scen].vol;
      }
    });
  });

  // Deselect scenario on manual edit
  ['mc-p-return','mc-p-vol'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      document.querySelectorAll('.mc-scen-btn').forEach(b => b.classList.remove('active'));
    });
  });

  // Advanced panel toggle
  document.getElementById('mcAdvBtn').addEventListener('click', () => {
    const panel = document.getElementById('mcAdvPanel');
    const btn   = document.getElementById('mcAdvBtn');
    const open  = panel.classList.toggle('open');
    btn.classList.toggle('open', open);
    btn.textContent = open ? '⚙ cerrar' : '⚙ ajustar';
  });

  // Toggles
  document.querySelectorAll('.mc-tog').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.dataset.toggle;
      mcTogState[k] = !mcTogState[k];
      el.classList.toggle('on', mcTogState[k]);
    });
  });

  // Histogram year tabs
  document.querySelectorAll('.mc-hist-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mc-hist-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      mcHistYr = parseInt(tab.dataset.yr);
      if (mcSimsCache) mcRenderHist(mcSimsCache, mcSimMonths, mcHistYr);
    });
  });

  // Run button
  document.getElementById('mcRunBtn').addEventListener('click', mcRun);

  // Zoom reset
  document.getElementById('mcZoomReset').addEventListener('click', () => {
    if (mcChartFan) mcChartFan.resetZoom();
  });

  // Seed portfolio value when navigating to analytics

  // ── MC Results Ribbon (3-card swipe) ──
  (function() {
    let mcRibOffset = 0, mcRibDragging = false, mcRibPointerDown = false;
    let mcRibIsHoriz = false, mcRibIsVert = false;
    let mcRibStartX = 0, mcRibStartY = 0, mcRibDragCurX = 0;
    let mcRibLastX = 0, mcRibLastT = 0, mcRibVelX = 0;
    let mcRibPage = 0; // 0, 1, or 2

    function mcRibCardWidth() {
      const outer = document.getElementById('mcRibbonOuter');
      return outer ? outer.offsetWidth + 10 : 330; // +10 for the gap between cards
    }

    function mcRibSetPos(x, animate) {
      const track = document.getElementById('mcRibbonTrack');
      if (!track) return;
      track.style.transition = animate ? 'transform 0.38s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none';
      track.style.transform = 'translateX(' + x + 'px)';
    }

    function mcRibClamp(raw) {
      const W = mcRibCardWidth();
      const minOff = -(W * 2);
      if (raw > 0) return raw * 0.2;
      if (raw < minOff) return minOff + (raw - minOff) * 0.2;
      return raw;
    }

    function mcRibSnap(velocity) {
      const W = mcRibCardWidth();
      const cur = mcRibOffset;
      // Determine target page from position + velocity
      let page = Math.round(-cur / W);
      if (Math.abs(velocity) > 0.5) {
        page = velocity < -0.5 ? Math.min(page + 1, 2) : Math.max(page - 1, 0);
      }
      page = Math.max(0, Math.min(2, page));
      mcRibPage = page;
      mcRibOffset = -page * W;
      mcRibSetPos(mcRibOffset, true);
    }

    const outer = document.getElementById('mcRibbonOuter');
    if (outer) {
      outer.addEventListener('pointerdown', function(e) {
        if (e.target.closest('canvas')) return;
        mcRibPointerDown = true;
        mcRibDragging = false;
        mcRibIsHoriz = false;
        mcRibIsVert = false;
        mcRibStartX = e.clientX;
        mcRibStartY = e.clientY;
        mcRibDragCurX = mcRibOffset;
        mcRibLastX = e.clientX;
        mcRibLastT = performance.now();
        mcRibVelX = 0;
      }, { passive: true });

      document.addEventListener('pointermove', function(e) {
        if (!mcRibPointerDown) return;
        const dx = e.clientX - mcRibStartX;
        const dy = e.clientY - mcRibStartY;
        if (!mcRibIsHoriz && !mcRibIsVert) {
          if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
            if (Math.abs(dx) > Math.abs(dy) * 1.4) mcRibIsHoriz = true;
            else mcRibIsVert = true;
          }
        }
        if (!mcRibIsHoriz) return;
        mcRibDragging = true;
        e.preventDefault();
        const now = performance.now();
        const dt = now - mcRibLastT || 16;
        mcRibVelX = (e.clientX - mcRibLastX) / dt;
        mcRibLastX = e.clientX; mcRibLastT = now;
        mcRibOffset = mcRibClamp(mcRibDragCurX + dx);
        mcRibSetPos(mcRibOffset, false);
      }, { passive: false });

      document.addEventListener('pointerup', function() {
        if (!mcRibPointerDown) return;
        mcRibPointerDown = false;
        if (!mcRibIsHoriz) return;
        mcRibSnap(mcRibVelX);
      });

      document.addEventListener('pointercancel', function() {
        if (!mcRibPointerDown) return;
        mcRibPointerDown = false;
        mcRibSnap(0);
      });
    }
  })();

  // Prefetch correlation matrix in background so AI agent always has the data
  // Delayed 4s to avoid competing with portfolio load on startup
  setTimeout(prefetchCorrelationData, 4000);
});


// ── CORRELATION HEATMAP ──────────────────────────────────────────────────────

// All rows cached after first fetch — switching periods is instant
let corrAllRows = null;
let corrActivePeriod = 90;

// Background prefetch — populates corrAllRows silently on startup so the AI
// agent always has correlation data available even if the user never opens
// the Correlación tab. Called from DOMContentLoaded with a delay to avoid
// competing with the portfolio load on startup.
async function prefetchCorrelationData() {
  if (corrAllRows) return; // already loaded
  try {
    const rows = await sbFetch('/rest/v1/correlation_matrix?select=ticker_a,ticker_b,correlation,period_days,calculated_at&order=ticker_a.asc');
    if (Array.isArray(rows) && rows.length > 0) {
      corrAllRows = rows;
      console.log(`[Correlation] Prefetch: ${rows.length} filas cargadas en background.`);
    }
  } catch (e) {
    // Silently ignore — non-critical, tab will retry on open
    console.warn('[Correlation] Prefetch falló (no crítico):', e.message);
  }
}

async function loadCorrelation(period) {
  if (period !== undefined) corrActivePeriod = period;
  const wrap = document.getElementById('corrHeatmap');
  if (!wrap) return;

  // First load: fetch all periods at once
  if (!corrAllRows) {
    wrap.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:32px 0">Cargando...</div>';
    try {
      corrAllRows = await sbFetch('/rest/v1/correlation_matrix?select=ticker_a,ticker_b,correlation,period_days,calculated_at&order=ticker_a.asc');
      if (!Array.isArray(corrAllRows) || corrAllRows.length === 0) {
        wrap.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:32px 0">Sin datos aún — el worker los generará hoy</div>';
        corrAllRows = null;
        return;
      }
    } catch (e) {
      console.error('loadCorrelation error:', e);
      wrap.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:32px 0">Error cargando datos</div>';
      return;
    }
  }

  // Filter to active period
  const rows = corrAllRows.filter(r => r.period_days === corrActivePeriod);
  if (rows.length === 0) {
    wrap.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:32px 0">Sin datos para ${corrActivePeriod}d aún</div>`;
    return;
  }

  // Update date label
  const lastCalc = rows[0]?.calculated_at;
  if (lastCalc) {
    const d = new Date(lastCalc);
    const label = d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
    const el = document.getElementById('corrPeriodLabel');
    if (el) el.textContent = `actualizado ${label}`;
  }

  // Update active pill — CSS handles styling via .active class
  document.querySelectorAll('.corr-period-pill').forEach(p => {
    p.classList.toggle('active', parseInt(p.dataset.period) === corrActivePeriod);
  });

  // Use rAF to ensure the subtab is visible and clientWidth is accurate
  requestAnimationFrame(() => renderCorrelationHeatmap(rows));

  // Load position vs portfolio correlation (independent — doesn't block heatmap)
  loadCorrVsPortfolio(corrActivePeriod);
}

function renderCorrelationHeatmap(rows) {
  // Build sorted ticker list (self-pairs give us all tickers)
  const tickerSet = new Set();
  rows.forEach(r => { tickerSet.add(r.ticker_a); tickerSet.add(r.ticker_b); });

  // Sort: acciones first, then crypto, then rsu — match portfolio order
  const CATEGORY_ORDER = ['acciones', 'rsu', 'cripto'];
  const tickerMeta = window.liveData?.assets || [];
  const categoryOf = {};
  tickerMeta.forEach(a => {
    const t = a.pos.ticker === 'RSU_META' ? 'RSU_META' : a.pos.ticker;
    categoryOf[t] = a.pos.category;
  });

  const tickers = [...tickerSet].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(categoryOf[a] || 'acciones');
    const cb = CATEGORY_ORDER.indexOf(categoryOf[b] || 'acciones');
    if (ca !== cb) return ca - cb;
    return a.localeCompare(b);
  });

  // Build lookup map
  const corrMap = {};
  rows.forEach(r => {
    corrMap[`${r.ticker_a}|${r.ticker_b}`] = r.correlation;
  });

  const N = tickers.length;
  // Measure available width — read from wrap, fall back to card - padding
  const LABEL_W = 44;
  const panelEl = document.getElementById('panel-analytics');
  const AVAILABLE = panelEl ? panelEl.clientWidth - 80 : 300;
  // Fill the full available width — no artificial min/max on cell size
  const CELL = Math.floor((AVAILABLE - LABEL_W) / N);

  // Color coding based on absolute correlation value — sign doesn't matter for diversification
  // Thresholds: 0.0–0.3 green, 0.3–0.6 yellow, 0.6–1.0 red
  function corrColor(c) {
    if (c === null) return 'var(--surface2)';
    const abs = Math.abs(c);
    const isDark = !document.documentElement.classList.contains('light');
    if (abs < 0.3) {
      // green — low correlation, good diversification
      const intensity = abs / 0.3;
      return isDark
        ? `rgba(67,233,123,${0.15 + intensity * 0.45})`
        : `rgba(22,163,74,${0.12 + intensity * 0.4})`;
    } else if (abs < 0.6) {
      // yellow — medium correlation
      const intensity = (abs - 0.3) / 0.3;
      return isDark
        ? `rgba(247,183,49,${0.2 + intensity * 0.5})`
        : `rgba(202,138,4,${0.15 + intensity * 0.45})`;
    } else {
      // red — high correlation, low diversification benefit
      const intensity = (abs - 0.6) / 0.4;
      return isDark
        ? `rgba(255,77,109,${0.3 + intensity * 0.6})`
        : `rgba(220,38,38,${0.2 + intensity * 0.6})`;
    }
  }

  function corrTextColor(c) {
    if (c === null) return 'var(--muted)';
    const abs = Math.abs(c);
    if (abs < 0.3) return abs < 0.15 ? 'var(--muted)' : '#43e97b';
    if (abs < 0.6) return '#f7b731';
    return '#ff4d6d';
  }

  // Display name (strip RSU_META → META, drop .L suffix)
  function dispTicker(t) {
    return t.replace('RSU_META', 'META').replace('.L', '');
  }

  // Build table HTML — width:auto so it only takes as much space as needed, centered
  let html = `<table style="border-collapse:separate;border-spacing:2px;font-size:${Math.max(7, Math.min(11, CELL - 18))}px;width:100%;table-layout:fixed">`;

  // Header row
  html += '<thead><tr>';
  html += `<th style="width:${LABEL_W}px"></th>`;
  tickers.forEach(t => {
    html += `<th style="width:${CELL}px;height:${CELL}px;text-align:center;font-weight:600;color:var(--muted);padding:2px 1px;vertical-align:bottom;overflow:hidden">
      <div style="writing-mode:vertical-rl;transform:rotate(180deg);font-size:${Math.max(6, Math.min(10, CELL - 20))}px;line-height:1;max-height:40px;overflow:hidden;white-space:nowrap">${dispTicker(t)}</div>
    </th>`;
  });
  html += '</tr></thead><tbody>';

  // Data rows
  tickers.forEach((ta, i) => {
    html += '<tr>';
    html += `<td style="width:${LABEL_W}px;padding-right:4px;text-align:right;font-weight:600;color:var(--muted);font-size:${Math.max(6, Math.min(10, CELL - 20))}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${dispTicker(ta)}</td>`;
    tickers.forEach((tb, j) => {
      const key = `${ta}|${tb}`;
      const c = corrMap[key] ?? corrMap[`${tb}|${ta}`] ?? (ta === tb ? 1.0 : null);
      const isSelf = ta === tb;
      const bg = isSelf ? 'var(--surface2)' : corrColor(c);
      const textCol = isSelf ? 'var(--muted)' : corrTextColor(c);
      const val = c !== null ? (isSelf ? '—' : c.toFixed(2)) : '?';
      const title = isSelf ? ta : `${dispTicker(ta)} vs ${dispTicker(tb)}: ${c !== null ? c.toFixed(3) : 'N/A'}`;
      const clickAttr = isSelf ? '' : ` onclick="openScatterModal('${ta}','${tb}',${corrActivePeriod})" style="width:${CELL}px;height:${CELL}px;text-align:center;background:${bg};border-radius:4px;font-family:var(--font-num);font-weight:700;color:${textCol};cursor:pointer;vertical-align:middle;overflow:hidden"`;
      if (isSelf) {
        html += `<td title="${title}" style="width:${CELL}px;height:${CELL}px;text-align:center;background:${bg};border-radius:4px;font-family:var(--font-num);font-weight:700;color:${textCol};cursor:default;vertical-align:middle;overflow:hidden">${val}</td>`;
      } else {
        html += `<td title="${title}"${clickAttr}>${val}</td>`;
      }
    });
    html += '</tr>';
  });

  html += '</tbody></table>';

  const wrap = document.getElementById('corrHeatmap');
  wrap.innerHTML = html;

  // Insight: find highest off-diagonal correlation pair
  let maxCorr = -Infinity, maxPair = null;
  let minCorr = Infinity, minPair = null;
  rows.forEach(r => {
    if (r.ticker_a === r.ticker_b) return;
    // Only process each pair once (a < b alphabetically)
    if (r.ticker_a > r.ticker_b) return;
    if (r.correlation > maxCorr) { maxCorr = r.correlation; maxPair = [r.ticker_a, r.ticker_b]; }
    if (r.correlation < minCorr) { minCorr = r.correlation; minPair = [r.ticker_a, r.ticker_b]; }
  });

  const insightEl = document.getElementById('corrInsight');
  if (insightEl && maxPair && minPair) {
    const high = `<span style="color:#ff6584;font-weight:700">${dispTicker(maxPair[0])} / ${dispTicker(maxPair[1])}</span> (${maxCorr.toFixed(2)})`;
    const low  = `<span style="color:#43e97b;font-weight:700">${dispTicker(minPair[0])} / ${dispTicker(minPair[1])}</span> (${minCorr.toFixed(2)})`;
    insightEl.innerHTML = `Mayor correlación: ${high} &nbsp;·&nbsp; Menor: ${low}`;
  }
}

// ── CLIENT-SIDE STATS UTILS ──────────────────────────────────────────────────
function pearsonCorrelation(a, b) {
  const n = a.length;
  if (n < 10 || n !== b.length) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    da2 += da * da;
    db2 += db * db;
  }
  const denom = Math.sqrt(da2 * db2);
  if (denom === 0) return null;
  return Math.round((num / denom) * 1000) / 1000;
}

// ── CORRELATION VS PORTFOLIO ──────────────────────────────────────────────────

async function loadCorrVsPortfolio(period) {
  const el = document.getElementById('corrVsPortList');
  const labelEl = document.getElementById('corrVsPortPeriodLabel');
  if (!el) return;

  // Use already-loaded daily_returns data if available, else fetch
  // daily_returns for portfolio tickers from Supabase
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (period + 10)); // small buffer
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    // Get portfolio tickers (non-fiat, non-benchmark)
    if (!liveData) { el.innerHTML = '<div style="color:var(--muted)">Sin datos de portfolio</div>'; return; }
    const EXCLUDED = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND', 'GBP_LIQUID']);
    const portfolioTickers = liveData.assets
      .filter(a => a.pos.category !== 'fiat' && !EXCLUDED.has(a.pos.ticker) && a.valueUSD > 0.5)
      .map(a => a.pos.ticker);

    if (portfolioTickers.length < 2) { el.innerHTML = '<div style="color:var(--muted)">Insuficientes posiciones</div>'; return; }

    // Fetch daily_returns for all portfolio tickers
    // Use PostgREST "in" operator instead of "or" — more reliable through the Express proxy
    const tickerList = portfolioTickers.join(',');
    const rows = await sbFetch(`/rest/v1/daily_returns?select=ticker,date,return_pct&ticker=in.(${tickerList})&date=gte.${cutoffStr}&order=date.asc&limit=5000`);
    if (!Array.isArray(rows) || rows.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px 0">Sin datos aún — el worker los generará hoy</div>';
      return;
    }

    // Group returns by ticker and date
    const byTicker = {};
    rows.forEach(r => {
      if (!byTicker[r.ticker]) byTicker[r.ticker] = {};
      byTicker[r.ticker][r.date] = r.return_pct;
    });

    // Get common dates across all tickers (last `period` days)
    const allDates = [...new Set(rows.map(r => r.date))].sort();
    const periodDates = allDates.slice(-period);
    if (periodDates.length < 20) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px 0">Datos insuficientes para este período</div>';
      return;
    }

    // Build portfolio daily return (equal-weighted across available tickers each day)
    // Uses actual weights from liveData for weighted average
    const totalInvested = portfolioTickers.reduce((s, t) => {
      const a = liveData.assets.find(a => a.pos.ticker === t);
      return s + (a ? a.valueUSD : 0);
    }, 0);
    const weights = {};
    portfolioTickers.forEach(t => {
      const a = liveData.assets.find(a => a.pos.ticker === t);
      weights[t] = a && totalInvested > 0 ? a.valueUSD / totalInvested : 0;
    });

    const portfolioReturns = {};
    periodDates.forEach(date => {
      let wSum = 0, wRet = 0;
      portfolioTickers.forEach(t => {
        if (byTicker[t]?.[date] != null) {
          wRet += byTicker[t][date] * weights[t];
          wSum += weights[t];
        }
      });
      if (wSum > 0.3) portfolioReturns[date] = wRet / wSum;
    });

    const portDates = Object.keys(portfolioReturns).sort();
    if (portDates.length < 20) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px">Datos insuficientes</div>';
      return;
    }
    const portReturnArr = portDates.map(d => portfolioReturns[d]);

    // Calculate Pearson correlation of each ticker vs portfolio
    function corrVsPort(ticker) {
      const pairs = portDates
        .filter(d => byTicker[ticker]?.[d] != null)
        .map(d => [byTicker[ticker][d], portfolioReturns[d]]);
      if (pairs.length < 20) return null;
      const a = pairs.map(p => p[0]);
      const b = pairs.map(p => p[1]);
      return pearsonCorrelation(a, b);
    }

    // Build rows sorted by correlation desc
    const results = portfolioTickers
      .map(t => ({ ticker: t, corr: corrVsPort(t) }))
      .filter(r => r.corr !== null)
      .sort((a, b) => b.corr - a.corr);

    if (labelEl) labelEl.textContent = `${period}d · ${portDates.length} días`;

    function corrColor(c) {
      const abs = Math.abs(c);
      if (abs >= 0.8) return '#ff4d6d';
      if (abs >= 0.6) return '#f7b731';
      return '#43e97b';
    }

    function dispT(t) { return t.replace('RSU_META', 'META').replace('.L', ''); }

    let html = '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += '<tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:5px 4px;color:var(--muted);font-size:10px">Posición</th><th style="text-align:right;padding:5px 4px;color:var(--muted);font-size:10px">Corr vs Portfolio</th><th style="text-align:right;padding:5px 4px;color:var(--muted);font-size:10px">Peso</th></tr>';
    results.forEach(({ ticker, corr }) => {
      const w = weights[ticker] || 0;
      const col = corrColor(corr);
      const interpretation = corr >= 0.8 ? 'Alta — poca diversificación' : corr >= 0.6 ? 'Media' : 'Baja — diversifica bien';
      html += `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:7px 4px;font-weight:600">${dispT(ticker)}</td>
        <td style="text-align:right;padding:7px 4px;font-family:var(--font-num);font-weight:700;color:${col}">${corr.toFixed(3)}<span style="font-size:9px;color:var(--muted);font-weight:400;margin-left:5px">${interpretation}</span></td>
        <td style="text-align:right;padding:7px 4px;color:var(--muted)">${(w * 100).toFixed(1)}%</td>
      </tr>`;
    });
    html += '</table>';
    el.innerHTML = html;

  } catch (e) {
    console.error('loadCorrVsPortfolio error:', e);
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">Error cargando datos</div>';
  }
}


// ── SCATTER PLOT MODAL ────────────────────────────────────────────────────────

let scatterChartInstance = null;

async function openScatterModal(tickerA, tickerB, period) {
  const modal = document.getElementById('scatterModal');
  const titleEl = document.getElementById('scatterModalTitle');
  const subEl = document.getElementById('scatterModalSub');
  const statsEl = document.getElementById('scatterStats');

  function dispT(t) { return t.replace('RSU_META', 'META').replace('.L', ''); }
  titleEl.textContent = `${dispT(tickerA)} vs ${dispT(tickerB)}`;
  subEl.textContent = `Retornos diarios — últimos ${period}d`;
  statsEl.innerHTML = '<span style="color:var(--muted);font-size:12px">Cargando...</span>';
  modal.classList.add('open');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (period + 10));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    const rows = await sbFetch(`/rest/v1/daily_returns?select=ticker,date,return_pct&ticker=in.(${tickerA},${tickerB})&date=gte.${cutoffStr}&order=date.asc&limit=2000`);

    const mapA = {}, mapB = {};
    rows.forEach(r => {
      if (r.ticker === tickerA) mapA[r.date] = r.return_pct;
      if (r.ticker === tickerB) mapB[r.date] = r.return_pct;
    });

    // Inner join on common dates, last `period` days
    const commonDates = Object.keys(mapA).filter(d => mapB[d] != null).sort().slice(-period);
    if (commonDates.length < 10) {
      statsEl.innerHTML = '<span style="color:var(--muted);font-size:12px">Datos insuficientes</span>';
      return;
    }

    const points = commonDates.map(d => ({ x: mapA[d] * 100, y: mapB[d] * 100, date: d }));
    const aArr = points.map(p => p.x);
    const bArr = points.map(p => p.y);

    // Stats
    const corr = pearsonCorrelation(aArr.map(v => v / 100), bArr.map(v => v / 100));

    // Linear regression for trendline
    const n = aArr.length;
    const meanA = aArr.reduce((s, v) => s + v, 0) / n;
    const meanB = bArr.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (aArr[i] - meanA) * (bArr[i] - meanB); den += (aArr[i] - meanA) ** 2; }
    const slope = den !== 0 ? num / den : 0;
    const intercept = meanB - slope * meanA;
    const xMin = Math.min(...aArr), xMax = Math.max(...aArr);
    const trendline = [{ x: xMin, y: slope * xMin + intercept }, { x: xMax, y: slope * xMax + intercept }];

    const isDarkMode = !document.documentElement.classList.contains('light');
    const tc = isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
    const gc = isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

    if (scatterChartInstance) scatterChartInstance.destroy();
    const cvs = document.getElementById('scatterChart');
    scatterChartInstance = new Chart(cvs, {
      data: {
        datasets: [
          {
            type: 'scatter',
            label: 'Retornos',
            data: points,
            backgroundColor: 'rgba(108,99,255,0.55)',
            pointRadius: 3.5,
            pointHoverRadius: 5,
          },
          {
            type: 'line',
            label: 'Tendencia',
            data: trendline,
            borderColor: 'rgba(247,183,49,0.8)',
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointRadius: 0,
            fill: false,
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDarkMode ? '#1c1c26' : '#fff',
            titleColor: tc, bodyColor: tc,
            callbacks: {
              title: ctx => ctx[0].raw.date || '',
              label: ctx => ctx.datasetIndex === 0
                ? [`${dispT(tickerA)}: ${ctx.raw.x.toFixed(2)}%`, `${dispT(tickerB)}: ${ctx.raw.y.toFixed(2)}%`]
                : null,
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: `${dispT(tickerA)} retorno diario (%)`, color: tc, font: { size: 9 } },
            grid: { color: gc }, ticks: { color: tc, font: { size: 9 }, callback: v => v.toFixed(1) + '%' }
          },
          y: {
            title: { display: true, text: `${dispT(tickerB)} retorno diario (%)`, color: tc, font: { size: 9 } },
            grid: { color: gc }, ticks: { color: tc, font: { size: 9 }, callback: v => v.toFixed(1) + '%' }
          }
        }
      }
    });

    const corrColor = corr >= 0.7 ? '#ff4d6d' : corr >= 0.4 ? '#f7b731' : '#43e97b';
    statsEl.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div style="background:var(--surface2);border-radius:10px;padding:10px 14px;flex:1;min-width:80px">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Correlación</div>
          <div style="font-family:var(--font-num);font-size:18px;font-weight:800;color:${corrColor}">${corr !== null ? corr.toFixed(3) : '—'}</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:10px 14px;flex:1;min-width:80px">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Pendiente</div>
          <div style="font-family:var(--font-num);font-size:18px;font-weight:800">${slope.toFixed(2)}x</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:10px 14px;flex:1;min-width:80px">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Días</div>
          <div style="font-family:var(--font-num);font-size:18px;font-weight:800">${n}</div>
        </div>
      </div>`;

  } catch (e) {
    console.error('openScatterModal error:', e);
    statsEl.innerHTML = '<span style="color:var(--muted);font-size:12px">Error cargando datos</span>';
  }
}

function closeScatterModal() {
  document.getElementById('scatterModal').classList.remove('open');
  if (scatterChartInstance) { scatterChartInstance.destroy(); scatterChartInstance = null; }
}

// ── PERFORMANCE TAB ───────────────────────────────────────────────────────────

const PERF_BENCHMARKS = [
  { ticker: 'SPY',    label: 'SPY',  color: '#43e97b' },
  { ticker: 'QQQ',    label: 'QQQ',  color: '#4fc3f7' },
  { ticker: 'TLT',    label: 'TLT',  color: '#f7b731' },
  { ticker: 'VWRP.L', label: 'VWRP', color: '#ff6584' },
];
const PERF_PORTFOLIO_COLOR = '#6c63ff';
const PERF_RF_ANNUAL = 0.043; // ~4.3% risk-free (approx US T-bill)

let perfActivePeriod = 90;
let pmePeriod = 90;
let perfAllReturns = null;  // cache: { ticker: { date: return_pct } }
let perfTransactions = null;
let perfChart = null;
let perfRollingChart = null;

async function loadPerformance(period) {
  if (period !== undefined) perfActivePeriod = period;

  // Update pill active state
  document.querySelectorAll('[data-perfperiod]').forEach(p => {
    p.classList.toggle('active', parseInt(p.dataset.perfperiod) === perfActivePeriod);
  });

  // Show loading state
  document.getElementById('perfSharpeVal').textContent = '…';
  document.getElementById('perfSortinoVal').textContent = '…';

  try {
    // Fetch all data once and cache
    if (!perfAllReturns) {
      await fetchPerfData();
    }
    if (!perfAllReturns) {
      showPerfError('Sin datos de retornos — el worker los generará hoy');
      return;
    }

    renderSharpeAndSortino();
    renderRollingSharpe();
    // PME renders separately via setPmePeriod
    renderPME();

  } catch (e) {
    console.error('loadPerformance error:', e);
    showPerfError('Error cargando datos de performance');
  }
}

function showPerfError(msg) {
  document.getElementById('perfSharpeVal').textContent = '—';
  document.getElementById('perfSortinoVal').textContent = '—';
  const st = document.getElementById('perfRatiosStatus');
  st.textContent = msg;
  st.style.display = 'block';
}

async function fetchPerfData() {
  // Fetch daily_returns for portfolio tickers + benchmarks
  // 400d to cover all periods + rolling sharpe window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 400);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const EXCLUDED_FIAT = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND', 'GBP_LIQUID']);
  const portfolioTickers = liveData
    ? liveData.assets
        .filter(a => a.pos.category !== 'fiat' && !EXCLUDED_FIAT.has(a.pos.ticker) && a.valueUSD > 0.5)
        .map(a => a.pos.ticker)
    : [];

  const allTickers = [...new Set([...portfolioTickers, ...PERF_BENCHMARKS.map(b => b.ticker)])];
  const tickerList = allTickers.join(',');

  const rows = await sbFetch(`/rest/v1/daily_returns?select=ticker,date,return_pct&ticker=in.(${tickerList})&date=gte.${cutoffStr}&order=date.asc&limit=20000`);
  if (!Array.isArray(rows) || rows.length === 0) return;

  // Group by ticker
  perfAllReturns = {};
  rows.forEach(r => {
    if (!perfAllReturns[r.ticker]) perfAllReturns[r.ticker] = {};
    perfAllReturns[r.ticker][r.date] = r.return_pct;
  });

  // Fetch transactions (for PME cash flows) — buy/vest only, exclude cash/fiat
  const txRows = await sbFetch('/rest/v1/transactions?select=ticker,date,amount_usd,type&order=date.asc&limit=2000');
  perfTransactions = Array.isArray(txRows)
    ? txRows.filter(t => t.type === 'buy' || t.type === 'vest')
    : [];
}

// Build portfolio daily returns (weighted) for a given date range
function buildPortfolioReturns(dates) {
  const EXCLUDED = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND', 'GBP_LIQUID']);
  if (!liveData) return {};
  const portfolioTickers = liveData.assets
    .filter(a => a.pos.category !== 'fiat' && !EXCLUDED.has(a.pos.ticker) && a.valueUSD > 0.5)
    .map(a => a.pos.ticker);

  const totalInvested = portfolioTickers.reduce((s, t) => {
    const a = liveData.assets.find(a => a.pos.ticker === t);
    return s + (a ? a.valueUSD : 0);
  }, 0);

  const portReturns = {};
  dates.forEach(date => {
    let wRet = 0, wSum = 0;
    portfolioTickers.forEach(t => {
      const r = perfAllReturns[t]?.[date];
      if (r != null) {
        const a = liveData.assets.find(a => a.pos.ticker === t);
        const w = a && totalInvested > 0 ? a.valueUSD / totalInvested : 0;
        wRet += r * w;
        wSum += w;
      }
    });
    if (wSum > 0.3) portReturns[date] = wRet / wSum;
  });
  return portReturns;
}

// Get sorted dates for a period ending today
function getPeriodDates(periodDays) {
  const allDates = [...new Set(
    Object.values(perfAllReturns).flatMap(m => Object.keys(m))
  )].sort();

  if (periodDays === 0) {
    // YTD
    const ytdStart = new Date().getFullYear() + '-01-01';
    return allDates.filter(d => d >= ytdStart);
  }
  return allDates.slice(-periodDays);
}

function computeRatios(returnArr, rfAnnual) {
  const n = returnArr.length;
  if (n < 10) return { sharpe: null, sortino: null };
  const rfDaily = rfAnnual / 252;
  const mean = returnArr.reduce((s, v) => s + v, 0) / n;
  const excessMean = mean - rfDaily;
  const variance = returnArr.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const downsideReturns = returnArr.filter(r => r < rfDaily);
  const downsideVar = downsideReturns.length > 0
    ? downsideReturns.reduce((s, v) => s + (v - rfDaily) ** 2, 0) / n
    : 0;
  const downsideStd = Math.sqrt(downsideVar);
  const annualFactor = Math.sqrt(252);
  const sharpe  = stdDev > 0 ? (excessMean / stdDev) * annualFactor : null;
  const sortino = downsideStd > 0 ? (excessMean / downsideStd) * annualFactor : null;
  return { sharpe, sortino };
}

function ratioColor(v) {
  if (v === null) return 'var(--text)';
  if (v >= 1.5) return '#43e97b';
  if (v >= 0.5) return '#f7b731';
  return '#ff4d6d';
}

function ratioLabel(v, type) {
  if (v === null) return '—';
  if (type === 'sharpe') {
    if (v >= 2)   return 'Excelente (>2)';
    if (v >= 1)   return 'Bueno (>1)';
    if (v >= 0)   return 'Moderado';
    return 'Negativo — mercado bajista';
  }
  if (v >= 2)   return 'Excelente — poca vol. negativa';
  if (v >= 1)   return 'Bueno';
  if (v >= 0)   return 'Moderado';
  return 'Negativo';
}

function renderSharpeAndSortino() {
  const dates = getPeriodDates(perfActivePeriod);
  const portReturns = buildPortfolioReturns(dates);
  const returnArr = Object.values(portReturns);

  const { sharpe, sortino } = computeRatios(returnArr, PERF_RF_ANNUAL);

  const sharpeEl = document.getElementById('perfSharpeVal');
  const sortinoEl = document.getElementById('perfSortinoVal');
  const shLblEl = document.getElementById('perfSharpeLabel');
  const soLblEl = document.getElementById('perfSortinoLabel');
  const statusEl = document.getElementById('perfRatiosStatus');

  sharpeEl.textContent = sharpe !== null ? sharpe.toFixed(2) : '—';
  sharpeEl.style.color = ratioColor(sharpe);
  sortinoEl.textContent = sortino !== null ? sortino.toFixed(2) : '—';
  sortinoEl.style.color = ratioColor(sortino);
  shLblEl.textContent = ratioLabel(sharpe, 'sharpe');
  soLblEl.textContent = ratioLabel(sortino, 'sortino');
  shLblEl.style.color = ratioColor(sharpe);
  soLblEl.style.color = ratioColor(sortino);
  statusEl.style.display = 'none';
}

function renderRollingSharpe() {
  const WINDOW = 90;
  // Use all available dates for rolling chart (not filtered by perfActivePeriod)
  const allDates = [...new Set(
    Object.values(perfAllReturns).flatMap(m => Object.keys(m))
  )].sort();
  if (allDates.length < WINDOW + 5) {
    document.getElementById('perfRollingEmpty').textContent = 'Datos insuficientes para rolling Sharpe';
    return;
  }

  const portReturns = buildPortfolioReturns(allDates);
  const portDates = Object.keys(portReturns).sort();
  if (portDates.length < WINDOW + 5) {
    document.getElementById('perfRollingEmpty').textContent = 'Datos insuficientes';
    return;
  }

  const portArr = portDates.map(d => portReturns[d]);
  const rollingDates = [], rollingSharpe = [];

  for (let i = WINDOW - 1; i < portArr.length; i++) {
    const window = portArr.slice(i - WINDOW + 1, i + 1);
    const { sharpe } = computeRatios(window, PERF_RF_ANNUAL);
    if (sharpe !== null) {
      rollingDates.push(portDates[i]);
      rollingSharpe.push(Math.round(sharpe * 100) / 100);
    }
  }

  const isDarkMode = !document.documentElement.classList.contains('light');
  const tc = isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
  const gc = isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  document.getElementById('perfRollingEmpty').style.display = 'none';
  const cvs = document.getElementById('perfRollingChart');
  cvs.style.display = 'block';

  if (perfRollingChart) perfRollingChart.destroy();

  // Thin labels: only every ~30 days
  const labels = rollingDates.map((d, i) => {
    if (i % 30 === 0) {
      const dt = new Date(d);
      return dt.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });
    }
    return '';
  });

  perfRollingChart = new Chart(cvs, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: rollingSharpe,
          borderColor: PERF_PORTFOLIO_COLOR,
          borderWidth: 2,
          pointRadius: 0,
          fill: {
            target: { value: 0 },
            above: 'rgba(108,99,255,0.12)',
            below: 'rgba(255,77,109,0.10)',
          },
          tension: 0.3,
        },
        // Reference line at Sharpe = 1
        {
          data: new Array(rollingSharpe.length).fill(1),
          borderColor: 'rgba(67,233,123,0.4)',
          borderWidth: 1,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: false,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDarkMode ? '#1c1c26' : '#fff',
          titleColor: tc, bodyColor: tc,
          callbacks: {
            title: ctx => rollingDates[ctx[0].dataIndex] || '',
            label: ctx => ctx.datasetIndex === 0 ? `Sharpe: ${ctx.raw.toFixed(2)}` : null,
          }
        }
      },
      scales: {
        x: { grid: { color: gc }, ticks: { color: tc, font: { size: 9 }, maxRotation: 0 } },
        y: {
          grid: { color: gc },
          ticks: { color: tc, font: { size: 9 }, callback: v => v.toFixed(1) },
          suggestedMin: -1, suggestedMax: 2,
        }
      }
    }
  });
}

// PME: portfolio index-100 vs benchmarks with same cash flows applied
function setPmePeriod(period) {
  pmePeriod = period;
  document.querySelectorAll('[data-pmeperiod]').forEach(p => {
    p.classList.toggle('active', parseInt(p.dataset.pmeperiod) === pmePeriod);
  });
  if (perfAllReturns) renderPME();
}

function renderPME() {
  if (!perfAllReturns) return;

  const dates = getPeriodDates(pmePeriod);
  if (dates.length < 5) {
    document.getElementById('pmeChartEmpty').textContent = 'Datos insuficientes';
    return;
  }
  const startDate = dates[0];

  // Portfolio index-100: weighted daily returns
  const portReturns = buildPortfolioReturns(dates);
  const portDates = dates.filter(d => portReturns[d] != null);
  if (portDates.length < 5) {
    document.getElementById('pmeChartEmpty').textContent = 'Datos insuficientes para el portfolio';
    return;
  }

  // Cash flows from transactions within the period (for PME benchmark lines)
  // Each cash flow is a buy/vest — we apply it to each benchmark as if you'd
  // bought that benchmark instead on the same date
  const cashFlows = (perfTransactions || [])
    .filter(t => t.date >= startDate)
    .map(t => ({ date: t.date, amountUSD: Math.abs(t.amount_usd || 0) }))
    .filter(t => t.amountUSD > 0);

  // Build index-100 for portfolio (pure return chain, no PME adjustment needed)
  // The portfolio line already reflects true weights
  function buildIndex100(ticker, dates) {
    const m = perfAllReturns[ticker];
    if (!m) return null;
    const validDates = dates.filter(d => m[d] != null);
    if (validDates.length < 5) return null;
    let idx = 100;
    return validDates.map(d => {
      idx *= Math.exp(m[d]); // log return → price factor
      return { x: d, y: Math.round(idx * 100) / 100 };
    });
  }

  // Portfolio: build from weighted returns
  let portIdx = 100;
  const portLine = portDates.map(d => {
    portIdx *= Math.exp(portReturns[d]);
    return { x: d, y: Math.round(portIdx * 100) / 100 };
  });

  // Benchmarks: index-100 + cash flow bumps (PME)
  // For each cash flow date, add the proportional amount to each benchmark's index
  // This simulates investing the same cash flows into the benchmark
  function buildPMELine(ticker, dates) {
    const m = perfAllReturns[ticker];
    if (!m) return null;
    const validDates = dates.filter(d => m[d] != null);
    if (validDates.length < 5) return null;

    // Initial "investment" equivalent = 100 index units
    let units = 100; // think of this as £100 worth at start
    const initialValue = 100;
    let currentValue = 100;

    // Total initial invested (to scale new cash flows)
    const totalInitialCashFlows = cashFlows
      .filter(cf => cf.date >= startDate)
      .reduce((s, cf) => s + cf.amountUSD, 0);

    const result = [];
    validDates.forEach(d => {
      // Apply return
      currentValue *= Math.exp(m[d]);
      // Apply any cash flows on this date (add to benchmark)
      cashFlows.filter(cf => cf.date === d).forEach(cf => {
        // Scale cash flow relative to initial portfolio value
        // If initial portfolio is ~X and cf is Y, add Y/X * 100 index units
        if (totalInitialCashFlows > 0) {
          currentValue += (cf.amountUSD / totalInitialCashFlows) * initialValue * Math.exp(m[d]);
        }
      });
      result.push({ x: d, y: Math.round(currentValue * 100) / 100 });
    });
    return result;
  }

  const isDarkMode = !document.documentElement.classList.contains('light');
  const tc = isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
  const gc = isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  // Build datasets
  const datasets = [];

  // Portfolio line
  datasets.push({
    label: 'Portfolio',
    data: portLine,
    borderColor: PERF_PORTFOLIO_COLOR,
    borderWidth: 2.5,
    pointRadius: 0,
    fill: false,
    tension: 0.2,
  });

  // Benchmark lines
  PERF_BENCHMARKS.forEach(bm => {
    const line = buildPMELine(bm.ticker, dates);
    if (!line) return;
    datasets.push({
      label: bm.label,
      data: line,
      borderColor: bm.color,
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.2,
      borderDash: [3, 2],
    });
  });

  // Build legend
  const legendEl = document.getElementById('pmeLegend');
  const allLabels = [{ label: 'Portfolio', color: PERF_PORTFOLIO_COLOR }, ...PERF_BENCHMARKS];
  legendEl.innerHTML = allLabels.map(l => `
    <div style="display:flex;align-items:center;gap:4px">
      <div style="width:16px;height:2px;background:${l.color};border-radius:1px;flex-shrink:0"></div>
      <span style="font-size:10px;color:var(--muted)">${l.label}</span>
    </div>`).join('');

  document.getElementById('pmeChartEmpty').style.display = 'none';
  const cvs = document.getElementById('pmeChart');
  cvs.style.display = 'block';
  if (perfChart) perfChart.destroy();

  perfChart = new Chart(cvs, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDarkMode ? '#1c1c26' : '#fff',
          titleColor: tc, bodyColor: tc,
          callbacks: {
            title: ctx => ctx[0]?.raw?.x || '',
            label: ctx => `${ctx.dataset.label}: ${ctx.raw.y.toFixed(1)}`,
          }
        }
      },
      scales: {
        x: {
          type: 'category',
          grid: { color: gc },
          ticks: {
            color: tc, font: { size: 9 }, maxRotation: 0, maxTicksLimit: 7,
            callback(val, i) {
              // Show date label for first dataset's data points
              const d = datasets[0]?.data[i]?.x;
              if (!d) return '';
              const dt = new Date(d);
              return dt.toLocaleDateString('es-AR', { month: 'short', day: 'numeric' });
            }
          }
        },
        y: {
          grid: { color: gc },
          ticks: { color: tc, font: { size: 9 }, callback: v => v.toFixed(0) },
        }
      }
    }
  });
}

// Performance detail modals
function openPerfDetail(type) {
  const modal = document.getElementById('perfDetailModal');
  const titleEl = document.getElementById('perfDetailTitle');
  const bodyEl = document.getElementById('perfDetailBody');

  const dates = getPeriodDates(perfActivePeriod);
  const portReturns = buildPortfolioReturns(dates);
  const returnArr = Object.values(portReturns);
  const { sharpe, sortino } = computeRatios(returnArr, PERF_RF_ANNUAL);

  if (type === 'sharpe') {
    titleEl.textContent = 'Sharpe Ratio';
    bodyEl.innerHTML = `
      <div style="font-size:13px;line-height:1.7;color:var(--text);margin-bottom:16px">
        Mide el retorno obtenido por unidad de riesgo total. Compara el retorno en exceso sobre la tasa libre de riesgo con la volatilidad total del portfolio (subidas y bajadas).
        <br><br>
        <strong>Fórmula:</strong> (Retorno anualizado − Tasa libre de riesgo) / Volatilidad anualizada
        <br><br>
        <strong>Tasa libre de riesgo usada:</strong> ${(PERF_RF_ANNUAL * 100).toFixed(1)}% (T-Bill US)
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--surface2);border-radius:12px;margin-bottom:12px">
        <div style="font-family:var(--font-num);font-size:32px;font-weight:800;color:${ratioColor(sharpe)}">${sharpe !== null ? sharpe.toFixed(2) : '—'}</div>
        <div>
          <div style="font-size:12px;font-weight:600">${perfActivePeriod}d annualizado</div>
          <div style="font-size:11px;color:${ratioColor(sharpe)};margin-top:2px">${ratioLabel(sharpe, 'sharpe')}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        <strong>&gt; 2</strong> — Excelente · <strong>1–2</strong> — Bueno · <strong>0–1</strong> — Moderado · <strong>&lt; 0</strong> — Negativo
      </div>`;
  }

  if (type === 'sortino') {
    titleEl.textContent = 'Sortino Ratio';
    bodyEl.innerHTML = `
      <div style="font-size:13px;line-height:1.7;color:var(--text);margin-bottom:16px">
        Como el Sharpe, pero solo penaliza la volatilidad negativa (downside deviation). Es más relevante para un inversor real: no importa si el portfolio sube fuerte, solo si baja.
        <br><br>
        <strong>Fórmula:</strong> (Retorno anualizado − Tasa libre de riesgo) / Downside Deviation anualizada
        <br><br>
        Si Sortino &gt;&gt; Sharpe, tu volatilidad es mayormente al alza — buena señal.
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--surface2);border-radius:12px;margin-bottom:12px">
        <div style="font-family:var(--font-num);font-size:32px;font-weight:800;color:${ratioColor(sortino)}">${sortino !== null ? sortino.toFixed(2) : '—'}</div>
        <div>
          <div style="font-size:12px;font-weight:600">${perfActivePeriod}d annualizado</div>
          <div style="font-size:11px;color:${ratioColor(sortino)};margin-top:2px">${ratioLabel(sortino, 'sortino')}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        Sortino siempre es mayor o igual a Sharpe. La diferencia entre ambos mide cuánta de tu volatilidad es al alza.
      </div>`;
  }

  modal.classList.add('open');
}

function closePerfDetail() {
  document.getElementById('perfDetailModal').classList.remove('open');
}

// ── RELATIVE PERFORMANCE (base-100 per asset) ─────────────────────────────────

// Fixed colors per ticker — stable regardless of portfolio order
const REL_TICKER_COLORS = {
  'MELI':     '#f7b731', // amarillo
  'NDIA.L':   '#ffffff', // blanco
  'RSU_META': '#4361ee', // azul oscuro violáceo
  'ADA':      '#0ea5e9', // azul eléctrico puro (más azulado que META)
  'GOOGL':    '#ea4335', // rojo Google
  'BTC':      '#f97316', // naranja
  'SPY':      '#43e97b', // verde
  'ARKK.L':   '#888888', // gris
  'VWRP.L':   '#ff6584', // rosa/rojo
  'NU':       '#6c63ff', // violeta fuerte
  'BRK.B':    '#74b9ff',
  'QQQ':      '#4fc3f7',
  'TLT':      '#fdcb6e',
  'MSFT':     '#a29bfe', // lila clarito
  'AAPL':     '#55efc4',
  'TSLA':     '#fd79a8',
  'AMZN':     '#e17055',
};
const REL_COLOR_FALLBACKS = [
  '#6c63ff','#43e97b','#f7b731','#4fc3f7','#ff6584',
  '#a29bfe','#fd79a8','#00cec9','#e17055','#74b9ff',
];

function getRelColor(ticker, fallbackIdx) {
  return REL_TICKER_COLORS[ticker] ?? REL_COLOR_FALLBACKS[fallbackIdx % REL_COLOR_FALLBACKS.length];
}

const REL_WINDOWS = ['1W','1M','3M','6M','1A','YTD'];

// Only SPY and VWRP.L visible by default — everything else hidden
const REL_DEFAULT_VISIBLE = new Set(['SPY', 'VWRP.L']);

let relPerfChart    = null;
let relPerfPeriod   = '1M';  // default 1M
let relPerfCache    = {};
let relPerfHidden   = new Set(); // populated on first load based on REL_DEFAULT_VISIBLE

// Background prefetch: fetch all windows sequentially after initial render
// so switching windows is instant. Runs after loadRelPerf() finishes.
async function prefetchRelPerf(tickers) {
  for (const win of REL_WINDOWS) {
    if (relPerfCache[win]) continue; // already cached (current window fetched first)
    try {
      const qs  = `window=${win}&tickers=${tickers.join(',')}`;
      const res = await fetch(`/api/price-history?${qs}`);
      if (!res.ok) continue;
      const json = await res.json();
      relPerfCache[win] = json.data || {};
    } catch (e) {
      console.warn(`[relPerf prefetch] ${win}:`, e.message);
    }
    // Small delay between fetches to avoid hammering Yahoo in parallel
    await new Promise(r => setTimeout(r, 400));
  }
}

function onRelPerfSlider(val) {
  const win = REL_WINDOWS[parseInt(val)];
  relPerfPeriod = win;
  const label = document.getElementById('relPerfWindowLabel');
  if (label) label.textContent = win;
  loadRelPerf();
}

// Interpolate a series (sorted [{t,v}]) to a set of target timestamps.
// For timestamps outside the series range, clamp to edge value.
// This ensures all datasets share exactly the same x-axis points → tooltip aligns correctly.
function interpolateSeries(series, targetTs) {
  if (!series.length) return targetTs.map(t => ({ x: t, y: null }));
  return targetTs.map(t => {
    // Binary search for surrounding points
    let lo = 0, hi = series.length - 1;
    if (t <= series[lo].t) return { x: t, y: series[lo].v };
    if (t >= series[hi].t) return { x: t, y: series[hi].v };
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (series[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = series[lo], b = series[hi];
    const frac = (t - a.t) / (b.t - a.t);
    return { x: t, y: Math.round((a.v + frac * (b.v - a.v)) * 100) / 100 };
  });
}

// Build a common timeline from all loaded series.
// Use the series with most data points as the master; others interpolate onto it.
function buildCommonTimeline(seriesMap, loaded) {
  let masterTicker = loaded[0];
  let maxLen = 0;
  loaded.forEach(t => {
    if ((seriesMap[t]?.length ?? 0) > maxLen) {
      maxLen = seriesMap[t].length;
      masterTicker = t;
    }
  });
  return seriesMap[masterTicker].map(p => p.t);
}

async function loadRelPerf() {
  const emptyEl  = document.getElementById('relPerfEmpty');
  const canvasEl = document.getElementById('relPerfChart');
  const legendEl = document.getElementById('relPerfLegend');

  emptyEl.textContent = 'Cargando…';
  emptyEl.style.display = 'flex';
  canvasEl.style.display = 'none';

  const EXCLUDED = new Set(['RENT_DEPOSIT','EMERGENCY_FUND','GBP_LIQUID','USD_CASH']);
  if (!liveData) { emptyEl.textContent = 'Sin datos de portfolio'; return; }

  const tickers = liveData.assets
    .filter(a => a.pos.category !== 'fiat' && !EXCLUDED.has(a.pos.ticker) && a.valueUSD > 0.5)
    .map(a => a.pos.ticker);

  if (!tickers.length) { emptyEl.textContent = 'Sin activos en cartera'; return; }

  // Initialize hidden set on very first call: hide everything except REL_DEFAULT_VISIBLE
  const isFirstLoad = relPerfHidden.size === 0 && !relPerfChart;
  if (isFirstLoad) {
    tickers.forEach(t => {
      if (!REL_DEFAULT_VISIBLE.has(t)) relPerfHidden.add(t);
    });
  }

  let seriesMap = relPerfCache[relPerfPeriod];
  const needsFetch = !seriesMap;
  if (needsFetch) {
    try {
      const qs  = `window=${relPerfPeriod}&tickers=${tickers.join(',')}`;
      const res = await fetch(`/api/price-history?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      seriesMap = json.data || {};
      relPerfCache[relPerfPeriod] = seriesMap;
    } catch (e) {
      console.error('[relPerf] fetch error:', e);
      emptyEl.textContent = 'Error cargando datos';
      return;
    }
  }

  const loaded = tickers.filter(t => seriesMap[t]?.length > 1);
  if (!loaded.length) { emptyEl.textContent = 'Sin datos para esta ventana'; return; }

  // Kick off background prefetch for remaining windows (after this render)
  if (needsFetch) setTimeout(() => prefetchRelPerf(tickers), 200);

  // Build common timeline so all datasets share the same x points → tooltip crosshair aligns
  const commonTs = buildCommonTimeline(seriesMap, loaded);

  const isDark = !document.documentElement.classList.contains('light');
  const tc = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
  const gc = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  const datasets = loaded.map((ticker, i) => {
    const color = getRelColor(ticker, i);
    const label = ticker === 'RSU_META' ? 'META' : ticker.replace('.L','');
    const pts   = interpolateSeries(seriesMap[ticker], commonTs);
    return {
      label,
      _ticker: ticker,
      data: pts,
      borderColor: color,
      borderWidth: 1.8,
      pointRadius: 0,
      fill: false,
      tension: 0.15,
      hidden: relPerfHidden.has(ticker),
    };
  });

  // Legend chips
  legendEl.innerHTML = datasets.map(ds => {
    const hidden  = relPerfHidden.has(ds._ticker);
    const opacity = hidden ? '0.35' : '1';
    return `<div
      onclick="toggleRelLine('${ds._ticker}')"
      style="display:flex;align-items:center;gap:4px;cursor:pointer;opacity:${opacity};transition:opacity .15s"
      id="relleg-${ds._ticker}">
      <div style="width:14px;height:2px;background:${ds.borderColor};border-radius:1px;flex-shrink:0"></div>
      <span style="font-size:10px;color:var(--muted)">${ds.label}</span>
    </div>`;
  }).join('');

  emptyEl.style.display = 'none';
  canvasEl.style.display = 'block';
  if (relPerfChart) relPerfChart.destroy();

  // Baseline dataset (dashed line at 100)
  const baselineDs = {
    label: '—',
    _isBaseline: true,
    data: [{ x: commonTs[0], y: 100 }, { x: commonTs[commonTs.length - 1], y: 100 }],
    borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
    borderWidth: 1,
    borderDash: [3, 3],
    pointRadius: 0,
    fill: false,
    tension: 0,
  };

  relPerfChart = new Chart(canvasEl, {
    type: 'line',
    data: { datasets: [...datasets, baselineDs] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      // nearest finds the single closest point per dataset at same x index
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? '#1c1c26' : '#fff',
          titleColor: tc,
          bodyColor: tc,
          filter: item => !item.dataset._isBaseline,
          callbacks: {
            title: ctx => {
              const ts = ctx[0]?.raw?.x;
              if (!ts) return '';
              const d = new Date(ts);
              if (relPerfPeriod === '1W') {
                return d.toLocaleDateString('es-AR', { weekday:'short', month:'short', day:'numeric' })
                  + ' ' + d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
              }
              return d.toLocaleDateString('es-AR', {
                month: 'short', day: 'numeric',
                year: (relPerfPeriod === '1A' || relPerfPeriod === 'YTD') ? '2-digit' : undefined
              });
            },
            label: ctx => {
              if (ctx.dataset._isBaseline || ctx.dataset.hidden) return null;
              const v = ctx.raw?.y;
              if (v == null) return null;
              const chg = v - 100;
              const sign = chg >= 0 ? '+' : '';
              return `${ctx.dataset.label}: ${v.toFixed(1)}  (${sign}${chg.toFixed(1)}%)`;
            },
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: relPerfPeriod === '1W' ? 'day'
                : relPerfPeriod === '1M' ? 'week'
                : 'month',
            displayFormats: { day: 'd MMM', week: 'd MMM', month: 'MMM yy' }
          },
          grid:  { color: gc },
          ticks: { color: tc, font: { size: 9 }, maxRotation: 0, maxTicksLimit: 6 },
        },
        y: {
          grid:  { color: gc },
          ticks: { color: tc, font: { size: 9 }, callback: v => v.toFixed(0) },
          afterDataLimits: scale => { scale.min = Math.min(scale.min, 95); },
        }
      }
    }
  });
}

function toggleRelLine(ticker) {
  if (!relPerfChart) return;
  const ds = relPerfChart.data.datasets.find(d => d._ticker === ticker);
  if (!ds) return;
  ds.hidden = !ds.hidden;
  if (ds.hidden) relPerfHidden.add(ticker); else relPerfHidden.delete(ticker);
  const chip = document.getElementById(`relleg-${ticker}`);
  if (chip) chip.style.opacity = ds.hidden ? '0.35' : '1';
  relPerfChart.update('none');
}
