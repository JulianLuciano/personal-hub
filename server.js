const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Exposes config from environment variables — never stored in code
app.get('/api/config', (req, res) => {
  res.json({
    pin: String(process.env.PIN || '1521'),
    anthropicKey: process.env.ANTHROPIC_API_KEY || ''
  });
});

// ── Market data from Yahoo Finance ─────────────────────────────────────────
// Fetches fundamentals (beta, P/E, 52-week range, etc.) for portfolio tickers.
// Results are cached in memory for 1 hour — Yahoo doesn't need to be hit on
// every page load, and these metrics don't change minute-to-minute.

const MARKET_DATA_TICKERS = ['META', 'SPY', 'VWRP.L', 'BRK-B', 'BTC-USD'];
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let marketDataCache = null;
let marketDataCachedAt = 0;

async function fetchYahooSummary(ticker) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}` +
    `?modules=summaryDetail,defaultKeyStatistics,price`;

  const res = await fetch(url, {
    headers: {
      // Yahoo occasionally blocks requests without a User-Agent
      'User-Agent': 'Mozilla/5.0 (compatible; personal-hub/1.0)'
    }
  });

  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${ticker}`);

  const json = await res.json();
  const result = json?.quoteSummary?.result?.[0];
  if (!result) throw new Error(`No data for ${ticker}`);

  const sd  = result.summaryDetail       || {};
  const ks  = result.defaultKeyStatistics || {};
  const pr  = result.price               || {};

  // Pull out the .raw numeric value (Yahoo wraps everything in {raw, fmt})
  const raw = v => (v && v.raw !== undefined ? v.raw : null);

  return {
    ticker,
    // Valuation
    trailingPE:       raw(sd.trailingPE),
    forwardPE:        raw(ks.forwardPE),
    priceToBook:      raw(ks.priceToBook),
    // Risk
    beta:             raw(sd.beta),
    shortRatio:       raw(ks.shortRatio),
    // Range
    fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:  raw(sd.fiftyTwoWeekLow),
    fiftyDayAvg:      raw(sd.fiftyDayAverage),
    twoHundredDayAvg: raw(sd.twoHundredDayAverage),
    // Size & liquidity
    marketCap:        raw(pr.marketCap),
    averageVolume:    raw(sd.averageVolume),
    // Income
    dividendYield:    raw(sd.dividendYield),
    // Current price (useful sanity-check)
    regularMarketPrice: raw(pr.regularMarketPrice),
    currency:         pr.currency || null
  };
}

app.get('/api/market-data', async (req, res) => {
  // Serve from cache if still fresh
  if (marketDataCache && (Date.now() - marketDataCachedAt) < CACHE_TTL_MS) {
    return res.json({ data: marketDataCache, cached: true, cachedAt: marketDataCachedAt });
  }

  const results = {};
  const errors  = {};

  // Fetch all tickers in parallel — if one fails the others still succeed
  await Promise.allSettled(
    MARKET_DATA_TICKERS.map(async ticker => {
      try {
        results[ticker] = await fetchYahooSummary(ticker);
      } catch (e) {
        errors[ticker] = e.message;
        console.warn(`[market-data] Failed to fetch ${ticker}:`, e.message);
      }
    })
  );

  // Only cache if we got at least something back
  if (Object.keys(results).length > 0) {
    marketDataCache   = results;
    marketDataCachedAt = Date.now();
  }

  res.json({ data: results, errors, cached: false, cachedAt: marketDataCachedAt });
});
// ───────────────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Personal Hub corriendo en puerto ${PORT}`);
});
