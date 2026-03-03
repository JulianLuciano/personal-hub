const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const TICKERS = ['SPY', 'BRK-B', 'MELI', 'NU', 'META', 'BTC-USD'];

async function fetchPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
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

  // 1. Fetch all prices
  const prices = {};
  for (const ticker of TICKERS) {
    const price = await fetchPrice(ticker);
    if (price) {
      prices[ticker] = price;
      console.log(`${ticker}: $${price}`);
    } else {
      console.log(`${ticker}: no se pudo obtener precio`);
    }
  }

  // BRK-B in Yahoo is BRK-B but we store as BRK.B
  if (prices['BRK-B']) prices['BRK.B'] = prices['BRK-B'];

  // 2. Fetch FX rate USD/GBP
  const fxRate = await fetchFxRate();
  console.log(`FX Rate USD/GBP: ${fxRate}`);

  // 3. Save price snapshots
  const snapshots = Object.entries(prices)
    .filter(([ticker]) => ticker !== 'BRK-B')
    .map(([ticker, price_usd]) => ({ ticker, price_usd }));

  const { error: snapError } = await supabase
    .from('price_snapshots')
    .insert(snapshots);

  if (snapError) console.error('Error guardando price_snapshots:', snapError);
  else console.log(`Guardados ${snapshots.length} price snapshots`);

  // 4. Load positions from Supabase
  const { data: positions, error: posError } = await supabase
    .from('positions')
    .select('*');

  if (posError) { console.error('Error leyendo positions:', posError); return; }

  // 5. Calculate portfolio value
  let total_usd = 0;
  const breakdown = { acciones: 0, cripto: 0, rsu: 0, fiat_gbp: 0, fiat_usd: 0 };

  for (const pos of positions) {
    let value_usd = 0;

    if (pos.category === 'fiat') {
      if (pos.currency === 'GBP') {
        value_usd = pos.qty / fxRate;
        breakdown.fiat_gbp += value_usd;
      } else {
        value_usd = pos.qty;
        breakdown.fiat_usd += value_usd;
      }
    } else if (pos.category === 'acciones') {
      const price = prices[pos.ticker];
      if (price) {
        value_usd = pos.qty * price;
        breakdown.acciones += value_usd;
      }
    } else if (pos.category === 'cripto') {
      const btcPrice = prices['BTC-USD'];
      if (btcPrice) {
        value_usd = pos.qty * btcPrice;
        breakdown.cripto += value_usd;
      }
    } else if (pos.category === 'rsu') {
      const metaPrice = prices['META'];
      if (metaPrice) {
        value_usd = pos.qty * metaPrice;
        breakdown.rsu += value_usd;
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