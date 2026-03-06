const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Exposes config from environment variables — never stored in code
app.get('/api/config', (req, res) => {
  res.json({
    pin:          String(process.env.PIN || '1521'),
    anthropicKey: process.env.ANTHROPIC_API_KEY || ''
  });
});

// ── Market data via yahoo-finance2 ──────────────────────────────────────────
// yahoo-finance2 handles Yahoo's auth/crumb automatically — no 401s.
// Install once: npm install yahoo-finance2
//
// Accepts ?tickers=META,SPY,MELI so the frontend passes its live portfolio tickers.
// Falls back to DEFAULT_TICKERS if no param provided.
// Cached in memory for 1 hour.

const CACHE_TTL_MS    = 60 * 60 * 1000;
const DEFAULT_TICKERS = ['META', 'SPY', 'VWRP.L', 'BRK-B', 'BTC-USD', 'MELI', 'NU', 'ARKK'];

let marketDataCache    = null;
let marketDataCachedAt = 0;
let marketDataTickers  = null;

// Lazy-load so server still boots if package not installed yet
let yf = null;
function getYF() {
  if (!yf) {
    try {
      yf = require('yahoo-finance2').default;
      yf.setGlobalConfig({ validation: { logErrors: false } });
    } catch (e) {
      throw new Error('yahoo-finance2 not installed — run: npm install yahoo-finance2');
    }
  }
  return yf;
}

async function fetchFundamentals(ticker) {
  const lib = getYF();
  const q   = await lib.quoteSummary(ticker, {
    modules: ['summaryDetail', 'defaultKeyStatistics', 'price', 'financialData']
  });

  const sd = q.summaryDetail        || {};
  const ks = q.defaultKeyStatistics || {};
  const pr = q.price                || {};

  const n = v => (v !== undefined && v !== null ? v : null);

  return {
    ticker,
    trailingPE:         n(sd.trailingPE),
    forwardPE:          n(ks.forwardPE),
    priceToBook:        n(ks.priceToBook),
    beta:               n(sd.beta),
    shortRatio:         n(ks.shortRatio),
    fiftyTwoWeekHigh:   n(sd.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:    n(sd.fiftyTwoWeekLow),
    fiftyDayAvg:        n(sd.fiftyDayAverage),
    twoHundredDayAvg:   n(sd.twoHundredDayAverage),
    marketCap:          n(pr.marketCap),
    averageVolume:      n(sd.averageVolume),
    dividendYield:      n(sd.dividendYield),
    regularMarketPrice: n(pr.regularMarketPrice),
    currency:           pr.currency || null
  };
}

app.get('/api/market-data', async (req, res) => {
  const requested = req.query.tickers
    ? req.query.tickers.split(',').map(t => t.trim()).filter(Boolean)
    : DEFAULT_TICKERS;

  // Cache hit: same tickers, still fresh
  const sameSet = marketDataTickers &&
    requested.length === marketDataTickers.length &&
    requested.every(t => marketDataTickers.includes(t));

  if (marketDataCache && sameSet && (Date.now() - marketDataCachedAt) < CACHE_TTL_MS) {
    return res.json({ data: marketDataCache, cached: true, cachedAt: marketDataCachedAt });
  }

  const results = {};
  const errors  = {};

  await Promise.allSettled(
    requested.map(async ticker => {
      try {
        results[ticker] = await fetchFundamentals(ticker);
      } catch (e) {
        errors[ticker] = e.message;
        console.warn(`[market-data] ${ticker}:`, e.message);
      }
    })
  );

  if (Object.keys(results).length > 0) {
    marketDataCache    = results;
    marketDataCachedAt = Date.now();
    marketDataTickers  = requested;
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
