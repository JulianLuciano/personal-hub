const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Tickers that need to be renamed before querying Yahoo Finance
const YAHOO_TICKER_MAP = {
  'BRK.B':    'BRK-B',
  'BTC':      'BTC-USD',
  'RSU_META': 'META',
  'ARKK.L':   'ARKK',   // LSE UCITS version — use US ticker for price
  'NDIA.L':   'NDIA',   // Global X India ETF LSE — use US ticker for price
};

// Tickers whose Yahoo price is in GBP (LSE stocks) — must convert to USD before storing
// Note: ARKK.L and NDIA.L are mapped to their US tickers (ARKK, NDIA) so Yahoo
// returns USD prices directly — no conversion needed for them.
const GBP_PRICED_TICKERS = new Set(['VWRP.L']);

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

async function run() {
  console.log(`[${new Date().toISOString()}] Worker arrancando...`);

  // 1. Load positions
  const { data: positions, error: posError } = await supabase
    .from('positions')
    .select('*');
  if (posError) { console.error('Error leyendo positions:', posError); return; }

  // 2. Fetch FX rate first (needed to convert GBP prices)
  const fxRate = await fetchFxRate();
  console.log(`FX Rate (GBP per USD): ${fxRate}`);

  // 3. Build list of unique Yahoo tickers from non-fiat positions
  const pricedPositions = positions.filter(p => p.category !== 'fiat' && Number(p.qty) > 0);
  const yahooTickers = [...new Set(pricedPositions.map(p => toYahoo(p.ticker)))];
  console.log(`Tickers a fetchear: ${yahooTickers.join(', ')}`);

  // 4. Fetch all prices
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

  // 5. Build prices map keyed by DB ticker
  // For LSE stocks (GBP_PRICED_TICKERS), convert GBP price → USD before storing
  // so all price_usd values are consistently in USD
  const prices = {};
  for (const [yahooTicker, price] of Object.entries(pricesByYahoo)) {
    const dbTicker = toDb(yahooTicker);
    if (GBP_PRICED_TICKERS.has(dbTicker)) {
      // Yahoo gives price in GBP — convert to USD
      prices[dbTicker] = price / fxRate;
      console.log(`${dbTicker}: £${price} → $${(price / fxRate).toFixed(2)} (converted GBP→USD)`);
    } else {
      prices[dbTicker] = price;
    }
  }

  // 6. Save price snapshots (all in USD now)
  const snapshots = Object.entries(prices).map(([ticker, price_usd]) => ({ ticker, price_usd }));
  const { error: snapError } = await supabase
    .from('price_snapshots')
    .insert(snapshots);
  if (snapError) console.error('Error guardando price_snapshots:', snapError);
  else console.log(`Guardados ${snapshots.length} price snapshots`);

  // 7. Calculate portfolio value
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

  // 8. Save portfolio snapshot
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

  console.log(`[${new Date().toISOString()}] Worker terminado.`);
}

// Run immediately then every 15 minutes
run();
setInterval(run, 15 * 60 * 1000);
