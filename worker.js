const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Tickers that need to be renamed before querying Yahoo Finance
const YAHOO_TICKER_MAP = {
  'BRK.B':    'BRK-B',
  'BTC':      'BTC-USD',
  'ADA':      'ADA-USD',
  'RSU_META': 'META',
};

function toYahoo(ticker) {
  return YAHOO_TICKER_MAP[ticker] || ticker;
}

const YAHOO_TO_DB = Object.fromEntries(
  Object.entries(YAHOO_TICKER_MAP).map(([db, yahoo]) => [yahoo, db])
);

function toDb(yahooTicker) {
  return YAHOO_TO_DB[yahooTicker] || yahooTicker;
}

async function fetchPrice(yahooTicker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const data = await res.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  return price || null;
}

async function fetchFxRate() {
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GBPUSD=X?interval=1d&range=1d', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const data = await res.json();
  const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  // rate is USD per GBP (how many USD for 1 GBP)
  // We want fxRate = GBP per USD (how many GBP for 1 USD)
  return rate ? (1 / rate) : 0.79;
}

async function fetchUsdArs() {
  try {
    const res = await fetch('https://dolarapi.com/v1/dolares/bolsa', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    // Use venta (ask) as the reference rate
    const rate = data?.venta;
    if (rate && rate > 0) return rate;
    console.warn('[FX] USD/ARS bolsa no disponible, usando null');
    return null;
  } catch (e) {
    console.error('[FX] Error fetching USD/ARS bolsa:', e.message);
    return null;
  }
}

// ── CORRELATION MATRIX + DAILY RETURNS ───────────────────────────────────────

async function fetchDailyPriceMap(yahooTicker, range = '400d') {
  // Returns { 'YYYY-MM-DD': closePrice } — keyed by UTC date string for alignment
  // range=400d covers up to 365 trading days needed for the longest correlation period
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=${range}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const closes    = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    const timestamps = data?.chart?.result?.[0]?.timestamp;
    if (!closes || !timestamps) return null;

    const map = {};
    timestamps.forEach((ts, i) => {
      if (closes[i] != null && closes[i] > 0) {
        // Normalize to UTC date string regardless of timezone offset in timestamp
        const d = new Date(ts * 1000);
        const key = d.toISOString().slice(0, 10);
        map[key] = closes[i];
      }
    });
    return map;
  } catch (e) {
    console.error(`fetchDailyPriceMap error for ${yahooTicker}:`, e.message);
    return null;
  }
}

function buildAlignedReturns(mapA, mapB, fxMap, isGBP_A, isGBP_B, maxDays = 90) {
  // Inner join on dates present in BOTH series (and FX map if needed)
  const datesA = new Set(Object.keys(mapA));
  const datesB = new Set(Object.keys(mapB));
  const fxDates = fxMap ? new Set(Object.keys(fxMap)) : null;

  let commonDates = [...datesA].filter(d => datesB.has(d));
  if (fxMap) commonDates = commonDates.filter(d => fxDates.has(d));
  commonDates.sort(); // ascending

  // Take last maxDays+1 dates (need N+1 prices for N returns)
  const slice = commonDates.slice(-(maxDays + 1));
  if (slice.length < 31) return null; // need at least 30 returns

  const returnsA = [], returnsB = [];
  for (let i = 1; i < slice.length; i++) {
    const d0 = slice[i - 1], d1 = slice[i];

    let pA0 = mapA[d0], pA1 = mapA[d1];
    let pB0 = mapB[d0], pB1 = mapB[d1];

    // FX-adjust GBP-priced tickers: convert GBP close → USD close
    // so all returns are in the same currency (USD) before correlating
    if (isGBP_A && fxMap) {
      // fxMap is GBPUSD (USD per 1 GBP) — multiply to get USD price
      pA0 = pA0 * fxMap[d0];
      pA1 = pA1 * fxMap[d1];
    }
    if (isGBP_B && fxMap) {
      pB0 = pB0 * fxMap[d0];
      pB1 = pB1 * fxMap[d1];
    }

    const rA = Math.log(pA1 / pA0);
    const rB = Math.log(pB1 / pB0);
    // Discard the pair if either return looks like a data error (split, gap, corrupt)
    // ±20% daily move is the threshold — both discarded together to keep arrays in sync
    if (Math.abs(rA) < 0.20 && Math.abs(rB) < 0.20) {
      returnsA.push(rA);
      returnsB.push(rB);
    }
  }

  return { returnsA, returnsB, n: returnsA.length };
}

function pearsonCorrelation(a, b) {
  const n = a.length;
  if (n < 10) return null;
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

// ── DAILY RETURNS ─────────────────────────────────────────────────────────────
// Benchmarks always fetched regardless of whether they're in positions.
// SPY may already be in positions — fetchDailyPriceMap is idempotent so no issue
// fetching it twice; the priceMapByTicker entry just gets overwritten with same data.
const BENCHMARK_TICKERS = ['SPY', 'QQQ', 'TLT', 'VWRP.L'];

// Build daily returns upserts from a price map (FX-adjusted to USD already)
// Returns array of { ticker, date, return_pct, close_usd }
function buildDailyReturnRows(dbTicker, priceMapUSD) {
  const dates = Object.keys(priceMapUSD).sort();
  const rows = [];
  for (let i = 1; i < dates.length; i++) {
    const d0 = dates[i - 1];
    const d1 = dates[i];
    const p0 = priceMapUSD[d0];
    const p1 = priceMapUSD[d1];
    if (!p0 || !p1 || p0 <= 0) continue;
    const logReturn = Math.log(p1 / p0);
    // Discard obvious data errors (splits, gaps) — same threshold as correlation
    if (Math.abs(logReturn) >= 0.20) continue;
    rows.push({
      ticker:     dbTicker,
      date:       d1,
      return_pct: Math.round(logReturn * 1e6) / 1e6, // 6 decimal places
      close_usd:  Math.round(p1 * 1e6) / 1e6,
    });
  }
  return rows;
}

async function runCorrelationAndReturns(positions) {
  // Shared guard: check if we already ran today (UTC date)
  // Uses correlation_matrix as the canonical "ran today" flag —
  // both correlation and daily_returns are written in the same run.
  const todayUTC = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from('correlation_matrix')
    .select('calculated_at')
    .limit(1);

  if (existing && existing.length > 0) {
    const lastRun = existing[0].calculated_at?.slice(0, 10);
    if (lastRun === todayUTC) {
      console.log('[Correlation+Returns] Ya se calculó hoy, saltando.');
      return;
    }
  }

  console.log('[Correlation+Returns] Calculando correlación (90d/180d/365d) + retornos diarios...');

  // Only investable, non-fiat tickers with qty > 0
  const investable = positions.filter(p => p.category !== 'fiat' && Number(p.qty) > 0);
  const portfolioDbTickers = [...new Set(investable.map(p => p.ticker))];

  // All tickers to fetch: portfolio positions + benchmarks (deduped)
  const allDbTickers = [...new Set([...portfolioDbTickers, ...BENCHMARK_TICKERS])];

  // Build GBP set dynamically from DB — consistent with GBP_PRICED_TICKERS in price logic
  // VWRP.L is GBP-priced; benchmarks SPY/QQQ/TLT are USD-priced
  const GBP_CORR_TICKERS = new Set(
    positions.filter(p => p.pricing_currency === 'GBP').map(p => p.ticker)
  );
  // VWRP.L is in BENCHMARK_TICKERS — mark it as GBP if not already in positions
  // (handles the case where VWRP.L is a benchmark but not currently held)
  GBP_CORR_TICKERS.add('VWRP.L');
  console.log(`[Correlation+Returns] GBP tickers (FX-adjust): ${[...GBP_CORR_TICKERS].join(', ') || 'ninguno'}`);

  // Fetch GBPUSD daily prices once — needed for FX adjustment
  const needsFx = allDbTickers.some(t => GBP_CORR_TICKERS.has(t));
  let fxMap = null;
  // fxMap here is GBPUSD rate (USD per 1 GBP) — multiply GBP price to get USD price
  let gbpusdMap = null;
  if (needsFx) {
    gbpusdMap = await fetchDailyPriceMap('GBPUSD=X');
    fxMap = gbpusdMap;
    if (!fxMap) console.warn('[Correlation+Returns] No se pudo obtener GBPUSD, GBP tickers sin ajuste FX');
  }

  // Fetch price maps once per ticker — 400d range covers 90/180/365 all at once
  const priceMapByTicker = {}; // raw prices (GBP for GBP-priced, USD for others)
  for (const dbTicker of allDbTickers) {
    const yahooTicker = toYahoo(dbTicker);
    const map = await fetchDailyPriceMap(yahooTicker);
    if (map && Object.keys(map).length >= 31) {
      priceMapByTicker[dbTicker] = map;
      console.log(`[Correlation+Returns] ${dbTicker}: ${Object.keys(map).length} días`);
    } else {
      console.log(`[Correlation+Returns] ${dbTicker}: datos insuficientes`);
    }
  }

  // Build USD-adjusted price maps for daily_returns
  // For GBP-priced tickers: multiply by GBPUSD rate to get USD price
  const priceMapUSDByTicker = {};
  for (const [dbTicker, rawMap] of Object.entries(priceMapByTicker)) {
    if (GBP_CORR_TICKERS.has(dbTicker) && gbpusdMap) {
      const usdMap = {};
      for (const [date, price] of Object.entries(rawMap)) {
        if (gbpusdMap[date]) usdMap[date] = price * gbpusdMap[date];
      }
      priceMapUSDByTicker[dbTicker] = usdMap;
    } else {
      priceMapUSDByTicker[dbTicker] = rawMap;
    }
  }

  // ── DAILY RETURNS ──────────────────────────────────────────────────────────
  console.log('[Daily Returns] Calculando retornos diarios...');
  const returnUpserts = [];
  for (const dbTicker of Object.keys(priceMapUSDByTicker)) {
    const rows = buildDailyReturnRows(dbTicker, priceMapUSDByTicker[dbTicker]);
    returnUpserts.push(...rows);
    console.log(`[Daily Returns] ${dbTicker}: ${rows.length} retornos`);
  }

  if (returnUpserts.length > 0) {
    // Upsert in batches of 500 to avoid payload limits
    const BATCH = 500;
    for (let i = 0; i < returnUpserts.length; i += BATCH) {
      const batch = returnUpserts.slice(i, i + BATCH);
      const { error } = await supabase
        .from('daily_returns')
        .upsert(batch, { onConflict: 'ticker,date' });
      if (error) console.error(`[Daily Returns] Error batch ${i / BATCH + 1}:`, error);
    }
    console.log(`[Daily Returns] Guardados ${returnUpserts.length} retornos. ✓`);
  } else {
    console.log('[Daily Returns] No hay retornos para guardar.');
  }

  // ── CORRELATION MATRIX ────────────────────────────────────────────────────
  // Only correlate portfolio positions (not benchmarks) — same behavior as before
  const validPortfolioTickers = portfolioDbTickers.filter(t => priceMapByTicker[t]);
  if (validPortfolioTickers.length < 2) {
    console.log('[Correlation] Menos de 2 tickers con datos, abortando correlación.');
    return;
  }

  const PERIODS = [90, 180, 365];
  const corrUpserts = [];

  for (const period of PERIODS) {
    console.log(`[Correlation] Calculando período ${period}d...`);
    let pairCount = 0;

    for (let i = 0; i < validPortfolioTickers.length; i++) {
      for (let j = i; j < validPortfolioTickers.length; j++) {
        const ta = validPortfolioTickers[i];
        const tb = validPortfolioTickers[j];

        if (i === j) {
          corrUpserts.push({ ticker_a: ta, ticker_b: tb, correlation: 1.0, period_days: period });
          continue;
        }

        const isGBP_A = GBP_CORR_TICKERS.has(ta);
        const isGBP_B = GBP_CORR_TICKERS.has(tb);
        const needFxForPair = isGBP_A || isGBP_B;

        const aligned = buildAlignedReturns(
          priceMapByTicker[ta],
          priceMapByTicker[tb],
          needFxForPair ? fxMap : null,
          isGBP_A,
          isGBP_B,
          period
        );

        if (!aligned) continue;

        const corr = pearsonCorrelation(aligned.returnsA, aligned.returnsB);
        if (corr === null) continue;

        corrUpserts.push({ ticker_a: ta, ticker_b: tb, correlation: corr, period_days: period });
        corrUpserts.push({ ticker_a: tb, ticker_b: ta, correlation: corr, period_days: period });
        pairCount++;
      }
    }
    console.log(`[Correlation] ${period}d: ${pairCount} pares calculados`);
  }

  if (corrUpserts.length > 0) {
    const { error } = await supabase
      .from('correlation_matrix')
      .upsert(corrUpserts, { onConflict: 'ticker_a,ticker_b,period_days' });
    if (error) {
      console.error('[Correlation] Error guardando matriz:', error);
    } else {
      console.log(`[Correlation] Guardados ${corrUpserts.length} entradas (3 períodos). ✓`);
    }
  } else {
    console.log('[Correlation] No hay pares válidos.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[${new Date().toISOString()}] Worker arrancando...`);

  // 1. Load positions
  const { data: positions, error: posError } = await supabase
    .from('positions')
    .select('*');
  if (posError) { console.error('Error leyendo positions:', posError); return; }

  // 2. Build GBP_PRICED set dynamically from pricing_currency column
  const GBP_PRICED_TICKERS = new Set(
    positions
      .filter(p => p.pricing_currency === 'GBP')
      .map(p => p.ticker)
  );
  console.log(`GBP-priced tickers: ${[...GBP_PRICED_TICKERS].join(', ') || 'ninguno'}`);

  // 3. Fetch FX rates
  const fxRate = await fetchFxRate();
  console.log(`FX Rate (GBP per USD): ${fxRate}`);
  const usdArs = await fetchUsdArs();
  console.log(`FX Rate (USD/ARS bolsa): ${usdArs ?? 'no disponible'}`);

  // 4. Build list of unique Yahoo tickers from non-fiat positions
  const pricedPositions = positions.filter(p => p.category !== 'fiat' && Number(p.qty) > 0);
  const yahooTickers = [...new Set(pricedPositions.map(p => toYahoo(p.ticker)))];
  console.log(`Tickers a fetchear: ${yahooTickers.join(', ')}`);

  // 5. Fetch all prices
  const pricesByYahoo = {};
  for (const yahooTicker of yahooTickers) {
    const price = await fetchPrice(yahooTicker);
    if (price) {
      pricesByYahoo[yahooTicker] = price;
      console.log(`${yahooTicker}: ${price}`);
    } else {
      console.log(`${yahooTicker}: no se pudo obtener precio`);
    }
  }

  // 6. Build prices map keyed by DB ticker
  const prices = {};
  for (const [yahooTicker, price] of Object.entries(pricesByYahoo)) {
    const dbTicker = toDb(yahooTicker);
    if (GBP_PRICED_TICKERS.has(dbTicker)) {
      prices[dbTicker] = price / fxRate;
      console.log(`${dbTicker}: £${price} → $${(price / fxRate).toFixed(2)} (converted GBP→USD)`);
    } else {
      prices[dbTicker] = price;
    }
  }

  // 7. Save price snapshots (all in USD)
  const snapshots = Object.entries(prices).map(([ticker, price_usd]) => ({
    ticker,
    price_usd,
    fx_rate:    Math.round(fxRate * 1e10) / 1e10,
    price_gbp:  Math.round(price_usd * fxRate * 1e8) / 1e8,
    fx_usd_ars: usdArs,
  }));
  const { error: snapError } = await supabase
    .from('price_snapshots')
    .insert(snapshots);
  if (snapError) console.error('Error guardando price_snapshots:', snapError);
  else console.log(`Guardados ${snapshots.length} price snapshots`);

  // 8. Calculate portfolio value
  let total_usd = 0;
  const breakdown = { acciones: 0, cripto: 0, rsu: 0, fiat_gbp: 0, fiat_usd: 0 };

  for (const pos of positions) {
    let value_usd = 0;

    if (pos.category === 'fiat') {
      if (pos.currency === 'GBP') {
        value_usd = Number(pos.qty) / fxRate;
        breakdown.fiat_gbp += Number(pos.qty);
      } else if (pos.currency === 'ARS') {
        value_usd = usdArs ? Number(pos.qty) / usdArs : 0;
        breakdown.fiat_ars = (breakdown.fiat_ars || 0) + Number(pos.qty);
      } else {
        value_usd = Number(pos.qty);
        breakdown.fiat_usd += Number(pos.qty);
      }
    } else {
      const price = prices[pos.ticker];
      if (price) {
        value_usd = Number(pos.qty) * price;
        breakdown[pos.category] = (breakdown[pos.category] || 0) + value_usd;
      } else if (Number(pos.qty) > 0) {
        console.warn(`Sin precio para ${pos.ticker} (${pos.category})`);
      }
    }

    total_usd += value_usd;
  }

  const total_gbp = total_usd * fxRate;
  Object.keys(breakdown).forEach(k => {
    breakdown[k] = Math.round(breakdown[k] * 100) / 100;
  });

  // 9. Save portfolio snapshot
  const total_ars = usdArs ? Math.round(total_usd * usdArs * 100) / 100 : null;
  const { error: portError } = await supabase
    .from('portfolio_snapshots')
    .insert({
      total_usd:  Math.round(total_usd * 100) / 100,
      total_gbp:  Math.round(total_gbp * 100) / 100,
      total_ars,
      fx_rate:    fxRate,
      fx_usd_ars: usdArs,
      breakdown
    });
  if (portError) console.error('Error guardando portfolio_snapshot:', portError);
  else console.log(`Portfolio snapshot: $${Math.round(total_usd)} / £${Math.round(total_gbp)}${total_ars ? ` / ARS${Math.round(total_ars / 1e6)}M` : ''}`);

  // 10. Correlation matrix + daily returns — runs once per day
  await runCorrelationAndReturns(positions);

  console.log(`[${new Date().toISOString()}] Worker terminado.`);
}

// Run immediately then every 15 minutes
run();
setInterval(run, 15 * 60 * 1000);
