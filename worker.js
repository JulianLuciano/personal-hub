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

// ── CORRELATION MATRIX ────────────────────────────────────────────────────────

// GBP_CORR_TICKERS is built dynamically inside runCorrelation() from positions.pricing_currency
// — consistent with GBP_PRICED_TICKERS used in the price snapshot logic

async function fetchDailyPriceMap(yahooTicker) {
  // Returns { 'YYYY-MM-DD': closePrice } — keyed by UTC date string for alignment
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=150d`;
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

async function runCorrelation(positions) {
  // Check if we already ran today (UTC date)
  const todayUTC = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from('correlation_matrix')
    .select('calculated_at')
    .limit(1);

  if (existing && existing.length > 0) {
    const lastRun = existing[0].calculated_at?.slice(0, 10);
    if (lastRun === todayUTC) {
      console.log('[Correlation] Ya se calculó hoy, saltando.');
      return;
    }
  }

  console.log('[Correlation] Calculando matriz de correlación (90d, FX-adjusted, date-aligned)...');

  // Only investable, non-fiat tickers with qty > 0
  const investable = positions.filter(p => p.category !== 'fiat' && Number(p.qty) > 0);
  const dbTickers = [...new Set(investable.map(p => p.ticker))];

  // Build GBP set dynamically from DB — consistent with GBP_PRICED_TICKERS in price logic
  const GBP_CORR_TICKERS = new Set(
    positions.filter(p => p.pricing_currency === 'GBP').map(p => p.ticker)
  );
  console.log(`[Correlation] GBP tickers (FX-adjust): ${[...GBP_CORR_TICKERS].join(', ') || 'ninguno'}`);

  // Fetch GBPUSD daily prices (needed to FX-adjust GBP-priced tickers)
  const needsFx = dbTickers.some(t => GBP_CORR_TICKERS.has(t));
  let fxMap = null;
  if (needsFx) {
    fxMap = await fetchDailyPriceMap('GBPUSD=X');
    if (!fxMap) console.warn('[Correlation] No se pudo obtener GBPUSD, GBP tickers sin ajuste FX');
  }

  // Fetch price maps (date → close) for all tickers
  const priceMapByTicker = {};
  for (const dbTicker of dbTickers) {
    const yahooTicker = toYahoo(dbTicker);
    const map = await fetchDailyPriceMap(yahooTicker);
    if (map && Object.keys(map).length >= 31) {
      priceMapByTicker[dbTicker] = map;
      console.log(`[Correlation] ${dbTicker}: ${Object.keys(map).length} días`);
    } else {
      console.log(`[Correlation] ${dbTicker}: datos insuficientes`);
    }
  }

  const validTickers = Object.keys(priceMapByTicker);
  if (validTickers.length < 2) {
    console.log('[Correlation] Menos de 2 tickers con datos, abortando.');
    return;
  }

  // Compute all pairs with date-aligned, FX-adjusted returns
  const upserts = [];
  for (let i = 0; i < validTickers.length; i++) {
    for (let j = i; j < validTickers.length; j++) {
      const ta = validTickers[i];
      const tb = validTickers[j];

      if (i === j) {
        upserts.push({ ticker_a: ta, ticker_b: tb, correlation: 1.0, period_days: 90 });
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
        isGBP_B
      );

      if (!aligned) {
        console.log(`[Correlation] ${ta}/${tb}: no hay suficientes fechas comunes`);
        continue;
      }

      const corr = pearsonCorrelation(aligned.returnsA, aligned.returnsB);
      if (corr === null) continue;

      console.log(`[Correlation] ${ta}/${tb}: ${corr} (n=${aligned.n}${needFxForPair ? ', fx-adj' : ''})`);
      upserts.push({ ticker_a: ta, ticker_b: tb, correlation: corr, period_days: 90 });
      upserts.push({ ticker_a: tb, ticker_b: ta, correlation: corr, period_days: 90 });
    }
  }

  if (upserts.length === 0) {
    console.log('[Correlation] No hay pares válidos.');
    return;
  }

  const { error } = await supabase
    .from('correlation_matrix')
    .upsert(upserts, { onConflict: 'ticker_a,ticker_b' });

  if (error) {
    console.error('[Correlation] Error guardando matriz:', error);
  } else {
    console.log(`[Correlation] Guardados ${upserts.length} pares. ✓`);
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
  // (replaces the old hardcoded GBP_PRICED_TICKERS = new Set(['VWRP.L']))
  const GBP_PRICED_TICKERS = new Set(
    positions
      .filter(p => p.pricing_currency === 'GBP')
      .map(p => p.ticker)
  );
  console.log(`GBP-priced tickers: ${[...GBP_PRICED_TICKERS].join(', ') || 'ninguno'}`);

  // 3. Fetch FX rate first (needed to convert GBP prices)
  const fxRate = await fetchFxRate();
  console.log(`FX Rate (GBP per USD): ${fxRate}`);

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
  // For GBP-priced tickers (pricing_currency = 'GBP'), convert GBP price → USD before storing
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

  // 7. Save price snapshots (all in USD) — also store fx_rate and price_gbp at capture time
  // fx_rate: 10 decimal places (consistent with portfolio_snapshots)
  // price_gbp: 8 decimal places (sufficient precision for all asset types including crypto)
  const snapshots = Object.entries(prices).map(([ticker, price_usd]) => ({
    ticker,
    price_usd,
    fx_rate:   Math.round(fxRate * 1e10) / 1e10,
    price_gbp: Math.round(price_usd * fxRate * 1e8) / 1e8,
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
      } else {
        value_usd = Number(pos.qty);
        breakdown.fiat_usd += Number(pos.qty);
      }
    } else {
      const price = prices[pos.ticker]; // already in USD
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
  const { error: portError } = await supabase
    .from('portfolio_snapshots')
    .insert({
      total_usd: Math.round(total_usd * 100) / 100,
      total_gbp: Math.round(total_gbp * 100) / 100,
      fx_rate: fxRate,
      breakdown
    });
  if (portError) console.error('Error guardando portfolio_snapshot:', portError);
  else console.log(`Portfolio snapshot: $${Math.round(total_usd)} / £${Math.round(total_gbp)}`);

  // 10. Correlation matrix — runs once per day, after price snapshots
  await runCorrelation(positions);

  console.log(`[${new Date().toISOString()}] Worker terminado.`);
}

// Run immediately then every 15 minutes
run();
setInterval(run, 15 * 60 * 1000);
