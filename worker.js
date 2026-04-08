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

async function fetchDailyReturns(yahooTicker, days = 90) {
  // Fetch enough range to get ~90 trading days (90 calendar days ≈ 63 trading days,
  // use 150d to be safe and always have ≥90 data points)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=150d`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    const timestamps = data?.chart?.result?.[0]?.timestamp;
    if (!closes || !timestamps) return null;

    // Filter nulls (market closed days) and take last `days` valid closes
    const valid = closes
      .map((c, i) => ({ c, t: timestamps[i] }))
      .filter(x => x.c != null && x.c > 0);

    const slice = valid.slice(-days);
    if (slice.length < 30) return null; // not enough data

    // Log returns: ln(P_t / P_{t-1})
    const returns = [];
    for (let i = 1; i < slice.length; i++) {
      returns.push(Math.log(slice[i].c / slice[i - 1].c));
    }
    return returns;
  } catch (e) {
    console.error(`fetchDailyReturns error for ${yahooTicker}:`, e.message);
    return null;
  }
}

function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const xa = a.slice(-n), xb = b.slice(-n);
  const meanA = xa.reduce((s, v) => s + v, 0) / n;
  const meanB = xb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = xa[i] - meanA;
    const db = xb[i] - meanB;
    num += da * db;
    da2 += da * da;
    db2 += db * db;
  }
  const denom = Math.sqrt(da2 * db2);
  if (denom === 0) return null;
  return Math.round((num / denom) * 1000) / 1000; // 3 decimal places
}

async function runCorrelation(positions) {
  // Check if we already ran today (UTC date)
  const todayUTC = new Date().toISOString().slice(0, 10); // "2025-04-08"
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

  console.log('[Correlation] Calculando matriz de correlación (90d)...');

  // Only investable, non-fiat tickers with qty > 0
  const investable = positions.filter(p => p.category !== 'fiat' && Number(p.qty) > 0);
  const dbTickers = [...new Set(investable.map(p => p.ticker))];

  // Fetch returns for all tickers
  const returnsByTicker = {};
  for (const dbTicker of dbTickers) {
    const yahooTicker = toYahoo(dbTicker);
    const returns = await fetchDailyReturns(yahooTicker, 90);
    if (returns) {
      returnsByTicker[dbTicker] = returns;
      console.log(`[Correlation] ${dbTicker}: ${returns.length} returns`);
    } else {
      console.log(`[Correlation] ${dbTicker}: sin datos suficientes`);
    }
  }

  const validTickers = Object.keys(returnsByTicker);
  if (validTickers.length < 2) {
    console.log('[Correlation] Menos de 2 tickers con datos, abortando.');
    return;
  }

  // Compute all pairs (including self-correlation = 1.0)
  const upserts = [];
  for (let i = 0; i < validTickers.length; i++) {
    for (let j = i; j < validTickers.length; j++) {
      const ta = validTickers[i];
      const tb = validTickers[j];
      const corr = (i === j) ? 1.0 : pearsonCorrelation(returnsByTicker[ta], returnsByTicker[tb]);
      if (corr === null) continue;

      // Insert both directions for easy querying
      upserts.push({ ticker_a: ta, ticker_b: tb, correlation: corr, period_days: 90 });
      if (i !== j) {
        upserts.push({ ticker_a: tb, ticker_b: ta, correlation: corr, period_days: 90 });
      }
    }
  }

  if (upserts.length === 0) {
    console.log('[Correlation] No hay pares válidos.');
    return;
  }

  // Upsert all pairs
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
