const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Tickers that need to be renamed before querying Yahoo Finance
// key = ticker stored in DB, value = Yahoo Finance ticker
const YAHOO_TICKER_MAP = {
  'BRK.B':   'BRK-B',
  'BTC':     'BTC-USD',
  'RSU_META': 'META',
};

// Convert DB ticker → Yahoo ticker
function toYahoo(ticker) {
  return YAHOO_TICKER_MAP[ticker] || ticker;
}

// Convert Yahoo ticker → DB ticker (reverse map)
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
  // rate is GBP per USD, we want USD per GBP
  return rate ? (1 / rate) : 1.27;
}

async function run() {
  console.log(`[${new Date().toISOString()}] Worker arrancando...`);

  // 1. Load positions — derive which tickers need prices dynamically
  const { data: positions, error: posError } = await supabase
    .from('positions')
    .select('*');

  if (posError) { console.error('Error leyendo positions:', posError); return; }

  // Build list of unique Yahoo tickers from non-fiat positions
  const pricedPositions = positions.filter(p => p.category !== 'fiat' && Number(p.qty) > 0);
  const yahooTickers = [...new Set(pricedPositions.map(p => toYahoo(p.ticker)))];

  console.log(`Tickers a fetchear: ${yahooTickers.join(', ')}`);

  // 2. Fetch all prices
  const pricesByYahoo = {};
  for (const yahooTicker of yahooTickers) {
    const price = await fetchPrice(yahooTicker);
    if (price) {
      pricesByYahoo[yahooTicker] = price;
      console.log(`${yahooTicker}: $${price}`);
    } else {
      console.log(`${yahooTicker}: no se pudo obtener precio`);
    }
  }

  // Build prices map keyed by DB ticker for easy lookup
  const prices = {};
  for (const [yahooTicker, price] of Object.entries(pricesByYahoo)) {
    prices[toDb(yahooTicker)] = price;
  }

  // 3. Fetch FX rate USD/GBP
  const fxRate = await fetchFxRate();
  console.log(`FX Rate USD/GBP: ${fxRate}`);

  // 4. Save price snapshots (use DB ticker as stored key)
  const snapshots = Object.entries(prices).map(([ticker, price_usd]) => ({ ticker, price_usd }));

  const { error: snapError } = await supabase
    .from('price_snapshots')
    .insert(snapshots);

  if (snapError) console.error('Error guardando price_snapshots:', snapError);
  else console.log(`Guardados ${snapshots.length} price snapshots`);

  // 5. Calculate portfolio value
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
      // acciones, cripto, rsu — all use their price from the map
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

  // Round breakdown values
  Object.keys(breakdown).forEach(k => {
    breakdown[k] = Math.round(breakdown[k] * 100) / 100;
  });

  // 6. Save portfolio snapshot
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

// Run immediately then every 30 minutes
run();
setInterval(run, 30 * 60 * 1000);
