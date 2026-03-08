const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Exposes config from environment variables — never stored in code
app.get('/api/config', (req, res) => {
  const n = (key) => process.env[key] !== undefined ? Number(process.env[key]) : null;
  const s = (key) => process.env[key] || null;
  res.json({
    // AI + keys
    anthropicKey:     process.env.ANTHROPIC_API_KEY || '',
    // Monte Carlo simulation inputs
    mcMonthly:        n('MC_MONTHLY_SAVING'),
    mcBonus:          n('MC_ANNUAL_BONUS'),
    mcRsu:            n('MC_RSU_PER_VEST'),
    // AI system prompt profile overrides
    aiName:           s('AI_PROFILE_NAME'),           // e.g. "Julián"
    aiMonthlyExp:     s('AI_MONTHLY_EXPENSES'),       // e.g. "£4000"
    aiSavingsRange:   s('AI_SAVINGS_RANGE'),          // e.g. "£900-1000/mo"
    aiBonusRange:     s('AI_BONUS_RANGE'),            // e.g. "£9000-10000/yr (Mar+Sep, 50/50)"
    aiRsuRange:       s('AI_RSU_RANGE'),              // e.g. "META quarterly ~£2500-2800 net/vest"
    aiEmergencyFund:  s('AI_EMERGENCY_FUND'),         // e.g. "£2500"
    aiCashAvailable:  s('AI_CASH_AVAILABLE'),         // e.g. "£500 aprox"
    aiGoals:          s('AI_GOALS'),                  // e.g. "£30k (end 2026) | £100k (end 2028) | £200k (end 2030)"
    aiSalaryRange:    s('AI_SALARY_RANGE'),           // e.g. "£20k-22k"
    aiAnnualInvest:   s('AI_ANNUAL_INVESTABLE'),      // e.g. "£31k-34k/yr"
  });
});

// ── Supabase Proxy ────────────────────────────────────────────────────────────
// All Supabase calls from the frontend go through here.
// Credentials stay server-side only — never exposed to the browser.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';

app.get('/api/db/*', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const subPath = req.params[0];
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const supaUrl = `${SUPABASE_URL}/rest/v1/${subPath}${qs}`;

  try {
    const sbRes = await fetch(supaUrl, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json',
      }
    });

    if (!sbRes.ok) {
      const errText = await sbRes.text();
      console.error(`[db-proxy] ${sbRes.status} for ${subPath}:`, errText.slice(0, 300));
      return res.status(sbRes.status).json({ error: errText.slice(0, 300) });
    }

    const data = await sbRes.json();
    res.json(data);
  } catch (e) {
    console.error('[db-proxy] fetch error:', e.message);
    res.status(502).json({ error: 'Supabase unreachable' });
  }
});

// ── Market data via yahoo-finance2 ──────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Tickers the frontend passes dynamically (live portfolio positions)
// Separate watchlist fetched proactively on startup for AI recommendations
const WATCHLIST_TICKERS = [
  // Portfolio core (always included even if not held)
  'SPY', 'MELI', 'NU', 'BRK-B', 'VWRP.L',
  // Mega-cap tech + semis
  'GOOGL', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'TSM',
  // Defensivos / valor
  'KO', 'MCD', 'WMT', 'JNJ', 'XOM',
  // Índices / ETFs EEUU
  'QQQ', 'DIA', 'IWM', 'VNQ',
  // Sectorial
  'XLK', 'XLF', 'XLE', 'SOXX', 'ICLN',
  // Dividendos
  'VIG', 'SCHD',
  // Emergentes
  'EEM', 'INDA', 'EWZ', 'ARGT', 'ILF',
  // China
  'FXI', 'KWEB', 'BABA',
  // Latam individual
  'YPF', 'PBR', 'GGAL',
  // Bonos
  'TLT', 'IEF', 'HYG',
  // UK
  'IGLT.L', 'VUKE.L',
  // Commodities
  'GLD', 'SLV', 'USO', 'PDBC',
  // Cripto
  'BTC-USD', 'ETH-USD', 'ADA-USD', 'SOL-USD',
];

// yahoo-finance2 v3: .default is the class, instantiate with new
let yf;
try {
  const YahooFinance = require('yahoo-finance2').default;
  yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  console.log('[market-data] yahoo-finance2 loaded');
} catch(e) {
  console.error('[market-data] yahoo-finance2 load error:', e.message);
}

// Ticker aliases for fundamentals fetching only (P/E, beta, etc.)
const TICKER_MAP = {
  'BTC':   'BTC-USD',
  'BRK.B': 'BRK-B',
};

async function fetchFundamentals(ticker) {
  if (!yf) throw new Error('yahoo-finance2 not loaded');
  const yticker = TICKER_MAP[ticker] || ticker;

  const q = await yf.quoteSummary(yticker, {
    modules: ['summaryDetail', 'defaultKeyStatistics', 'price', 'financialData', 'calendarEvents', 'assetProfile']
  });

  const sd = q.summaryDetail        || {};
  const ks = q.defaultKeyStatistics || {};
  const pr = q.price                || {};
  const fd = q.financialData        || {};
  const ce = q.calendarEvents       || {};
  const ap = q.assetProfile         || {};
  const n  = v => (v !== undefined && v !== null ? v : null);

  // Earnings date — calendarEvents.earnings.earningsDate is an array
  const earningsDates = ce.earnings?.earningsDate;
  const nextEarnings  = Array.isArray(earningsDates) && earningsDates.length > 0
    ? earningsDates[0] : null;

  return {
    ticker,
    yahooTicker:        yticker,
    name:               pr.longName || pr.shortName || null,
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
    currency:           pr.currency || null,
    // Analyst consensus
    analystRating:      n(fd.recommendationMean),   // 1=Strong Buy … 5=Sell
    analystTarget:      n(fd.targetMeanPrice),       // mean price target
    numberOfAnalysts:   n(fd.numberOfAnalystOpinions),
    // Upcoming earnings
    nextEarningsDate:   nextEarnings instanceof Date
      ? nextEarnings.toISOString().slice(0, 10)
      : typeof nextEarnings === 'string' ? nextEarnings.slice(0, 10) : null,
    // Sector & industry (from assetProfile)
    sector:             ap.sector || null,
    industry:           ap.industry || null,
  };
}

// ── Two separate caches ──────────────────────────────────────────────────────

let portfolioCache      = null, portfolioCachedAt = 0, portfolioTickers = null;
let watchlistCache      = null, watchlistCachedAt = 0;

// Portfolio tickers: passed dynamically by the frontend (?tickers=...)
app.get('/api/market-data', async (req, res) => {
  const requested = req.query.tickers
    ? req.query.tickers.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  if (!requested.length) return res.json({ data: {}, errors: {}, cached: false });

  const sameSet = portfolioTickers &&
    requested.length === portfolioTickers.length &&
    requested.every(t => portfolioTickers.includes(t));

  if (portfolioCache && sameSet && (Date.now() - portfolioCachedAt) < CACHE_TTL_MS) {
    return res.json({ data: portfolioCache, cached: true, cachedAt: portfolioCachedAt });
  }

  const results = {}, errors = {};
  await Promise.allSettled(requested.map(async t => {
    try   { results[t] = await fetchFundamentals(t); }
    catch (e) { errors[t] = e.message; console.warn(`[portfolio] ${t}:`, e.message); }
  }));

  if (Object.keys(results).length > 0) {
    portfolioCache    = results;
    portfolioCachedAt = Date.now();
    portfolioTickers  = requested;
  }

  res.json({ data: results, errors, cached: false, cachedAt: portfolioCachedAt });
});

// ── Macro indicators with historical evolution ───────────────────────────────

const MACRO_TICKERS = {
  // Volatility
  '^VIX':    { label: 'VIX (Fear Index)',          unit: 'pts' },
  // US rates
  '^TNX':    { label: 'US 10Y Treasury Yield',     unit: '%' },
  '^IRX':    { label: 'US 3M Treasury Yield',      unit: '%' },
  // FX
  'GBP=X':   { label: 'GBP/USD',                   unit: 'USD per GBP' },
  'EURUSD=X':{ label: 'EUR/USD',                   unit: 'USD per EUR' },
  // Indices
  '^IXIC':   { label: 'Nasdaq Composite',          unit: 'pts' },
  '^FTSE':   { label: 'FTSE 100',                  unit: 'pts' },
};

let macroCache = null, macroCachedAt = 0;

async function fetchMacro(yahooTicker) {
  if (!yf) throw new Error('yahoo-finance2 not loaded');

  // v3: chart() takes period1 (Date) + interval, not range
  const period1 = new Date();
  period1.setDate(period1.getDate() - 35); // 35 days back to ensure ~30 trading days

  const result = await yf.chart(yahooTicker, {
    period1,
    interval: '1d',
  });

  const quotes = result?.quotes || [];
  if (!quotes.length) throw new Error('No quotes returned');

  quotes.sort((a, b) => new Date(a.date) - new Date(b.date));

  const current = quotes[quotes.length - 1]?.close ?? null;
  const ago7d   = quotes[Math.max(0, quotes.length - 6)]?.close ?? null;
  const ago30d  = quotes[0]?.close ?? null;

  const chg7d  = (current != null && ago7d  != null) ? ((current - ago7d)  / Math.abs(ago7d)  * 100) : null;
  const chg30d = (current != null && ago30d != null) ? ((current - ago30d) / Math.abs(ago30d) * 100) : null;

  const trend = chg30d == null ? 'sin datos'
    : chg30d >  2 ? '↑ subiendo'
    : chg30d < -2 ? '↓ bajando'
    : '→ estable';

  return { yahooTicker, current, ago7d, ago30d, chg7d, chg30d, trend };
}

app.get('/api/macro-data', async (req, res) => {
  if (macroCache && (Date.now() - macroCachedAt) < CACHE_TTL_MS) {
    return res.json({ data: macroCache, cached: true, cachedAt: macroCachedAt });
  }

  const results = {}, errors = {};
  await Promise.allSettled(
    Object.keys(MACRO_TICKERS).map(async ticker => {
      try   { results[ticker] = { ...MACRO_TICKERS[ticker], ...await fetchMacro(ticker) }; }
      catch (e) { errors[ticker] = e.message; console.warn(`[macro] ${ticker}:`, e.message); }
    })
  );

  if (Object.keys(results).length > 0) {
    macroCache    = results;
    macroCachedAt = Date.now();
  }

  res.json({ data: results, errors, cached: false, cachedAt: macroCachedAt });
});
// ───────────────────────────────────────────────────────────────────────────

// Watchlist: fixed list, fetched once and cached
app.get('/api/watchlist-data', async (req, res) => {
  if (watchlistCache && (Date.now() - watchlistCachedAt) < CACHE_TTL_MS) {
    return res.json({ data: watchlistCache, cached: true, cachedAt: watchlistCachedAt });
  }

  const results = {}, errors = {};
  await Promise.allSettled(WATCHLIST_TICKERS.map(async t => {
    try   { results[t] = await fetchFundamentals(t); }
    catch (e) { errors[t] = e.message; console.warn(`[watchlist] ${t}:`, e.message); }
  }));

  if (Object.keys(results).length > 0) {
    watchlistCache    = results;
    watchlistCachedAt = Date.now();
  }

  res.json({ data: results, errors, cached: false, cachedAt: watchlistCachedAt });
});

// Pre-warm watchlist and macro in background 30s after startup
setTimeout(() => {
  if (!yf) return;
  console.log('[cache] pre-warming watchlist + macro...');
  Promise.all([
    fetch(`http://localhost:${PORT}/api/watchlist-data`),
    fetch(`http://localhost:${PORT}/api/macro-data`),
  ])
    .then(() => console.log('[cache] watchlist + macro ready'))
    .catch(e => console.warn('[cache] pre-warm failed:', e.message));
}, 30000);

// ───────────────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Personal Hub corriendo en puerto ${PORT}`);
});
