const express = require('express');
const path    = require('path');
const { recalculatePositions } = require('./recalculator');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Exposes config from environment variables — never stored in code
app.get('/api/config', (req, res) => {
  res.json({
    anthropicKey:      process.env.ANTHROPIC_API_KEY || '',
    // AI profile (system prompt)
    aiProfileName:     process.env.AI_PROFILE_NAME       || '',
    aiMonthlyExpenses: process.env.AI_MONTHLY_EXPENSES   || '',
    aiSavingsRange:    process.env.AI_SAVINGS_RANGE       || '',
    aiBonusRange:      process.env.AI_BONUS_RANGE         || '',
    aiRsuRange:        process.env.AI_RSU_RANGE           || '',
    aiEmergencyFund:   process.env.AI_EMERGENCY_FUND      || '',
    aiGoals:           process.env.AI_GOALS               || '',
    aiSalaryRange:     process.env.AI_SALARY_RANGE        || '',
    aiAnnualInvestable:process.env.AI_ANNUAL_INVESTABLE   || '',
    // Monte Carlo defaults
    mcMonthlySaving:   process.env.MC_MONTHLY_SAVING      || '',
    mcAnnualBonus:     process.env.MC_ANNUAL_BONUS        || '',
    mcRsuPerVest:      process.env.MC_RSU_PER_VEST        || '',
  });
});

// ── Supabase Proxy ────────────────────────────────────────────────────────────
// All Supabase calls from the frontend go through here.
// Credentials stay server-side only — never exposed to the browser.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';

app.all('/api/db/*', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const subPath = req.params[0];
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const supaUrl = `${SUPABASE_URL}/rest/v1/${subPath}${qs}`;

  try {
    const sbRes = await fetch(supaUrl, {
      method: req.method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });

    const text = await sbRes.text();
    res.status(sbRes.status).send(text);

  } catch (e) {
    console.error('[db-proxy] fetch error:', e.message);
    res.status(502).json({ error: 'Supabase unreachable' });
  }
});

// ── Portfolio chart data with server-side downsampling ───────────────────────
// Returns ~180-365 points regardless of period, so the frontend never needs
// to fetch 140k raw rows. Each period uses a different sampling resolution.
//
// Sampling strategy (SQL: take the last snapshot in each bucket):
//   1S  → 1 point per hour        (~168 pts)
//   1M  → 1 point per 4 hours     (~180 pts)
//   3M  → 2 points per day        (~180 pts, anchored at 09:00 and 21:00 UTC)
//   6M  → 1 point per day         (~180 pts)
//   1A  → 1 point per day         (~365 pts)

app.get('/api/chart/:period', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const period = req.params.period; // '1S' | '1M' | '3M' | '6M' | '1A'
  const periodDays = { '1S': 7, '1M': 30, '3M': 90, '6M': 180, '1A': 365 };
  const days = periodDays[period];
  if (!days) return res.status(400).json({ error: 'Invalid period' });

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Build the SQL bucket expression depending on resolution
  // For 3M we want 2 anchors per day: 09:00 UTC and 21:00 UTC.
  // We achieve this by bucketing into 12-hour slots offset by 9h from midnight UTC.
  // For all other periods we use uniform hour-width buckets.
  let bucketExpr;
  if (period === '1S') {
    // Truncate to hour
    bucketExpr = `date_trunc('hour', captured_at)`;
  } else if (period === '1M') {
    // Truncate to 4-hour block (00, 04, 08, 12, 16, 20)
    bucketExpr = `date_trunc('hour', captured_at) - (EXTRACT(hour FROM captured_at)::int % 4) * interval '1 hour'`;
  } else if (period === '3M') {
    // 12-hour buckets anchored at 09:00 and 21:00 UTC
    // shift by -9h → truncate to 12h → shift back by +9h
    bucketExpr = `date_trunc('hour', captured_at - interval '9 hours' - (EXTRACT(hour FROM (captured_at - interval '9 hours'))::int % 12) * interval '1 hour') + interval '9 hours'`;
  } else {
    // 6M and 1A: daily
    bucketExpr = `date_trunc('day', captured_at)`;
  }

  // Use Supabase RPC or raw PostgREST? PostgREST doesn't support GROUP BY directly,
  // so we use the Supabase SQL endpoint (POST /rest/v1/rpc/... requires a function).
  // Instead: fetch with a large limit and downsample in Node — still way cheaper
  // than sending 140k rows to the browser. Max rows per period:
  //   1S: 7d × 96 snaps/day = 672 rows
  //   1M: 30d × 96 = 2,880 rows
  //   3M: 90d × 96 = 8,640 rows
  //   6M: 180d × 96 = 17,280 rows
  //   1A: 365d × 96 = 35,040 rows
  // All well within a single fetch at 50k limit.

  const FETCH_LIMIT = 50000;
  const supaUrl = `${SUPABASE_URL}/rest/v1/portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate,breakdown&order=captured_at.asc&captured_at=gte.${since}&limit=${FETCH_LIMIT}`;

  try {
    const sbRes = await fetch(supaUrl, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json',
      }
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      console.error('[chart] supabase error:', err.slice(0, 300));
      return res.status(sbRes.status).json({ error: err.slice(0, 200) });
    }

    const rows = await sbRes.json();

    // Downsample in Node: for each time bucket keep the last row in that bucket
    function getBucket(isoStr) {
      const d = new Date(isoStr);
      const h = d.getUTCHours();
      if (period === '1S') {
        // bucket key = YYYY-MM-DDTHH
        return isoStr.slice(0, 13);
      } else if (period === '1M') {
        // bucket key = YYYY-MM-DDTH (floored to 4h block)
        const block = Math.floor(h / 4) * 4;
        return `${isoStr.slice(0, 10)}T${String(block).padStart(2, '0')}`;
      } else if (period === '3M') {
        // 12h buckets anchored at 09 and 21 UTC
        // shift = hours since last anchor (09 or 21)
        const shiftedH = (h - 9 + 24) % 24; // hours since 09:00 UTC
        const anchor = shiftedH < 12 ? 9 : 21;
        return `${isoStr.slice(0, 10)}T${String(anchor).padStart(2, '0')}`;
      } else {
        // daily: YYYY-MM-DD
        return isoStr.slice(0, 10);
      }
    }

    // Keep last row per bucket (rows are asc, so later rows overwrite earlier)
    const bucketMap = new Map();
    for (const row of rows) {
      bucketMap.set(getBucket(row.captured_at), row);
    }

    // Sort buckets chronologically and return values
    const sampled = Array.from(bucketMap.values())
      .sort((a, b) => a.captured_at < b.captured_at ? -1 : 1);

    console.log(`[chart] period=${period} raw=${rows.length} sampled=${sampled.length}`);
    res.json(sampled);

  } catch (e) {
    console.error('[chart] fetch error:', e.message);
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

// ── Positions Recalculator ────────────────────────────────────────────────────
// Llamado desde el frontend después de INSERT/UPDATE en transactions.
// Recalcula positions_dev (solo managed_by = 'transactions') usando weighted average.
app.post('/api/recalculate-positions', async (req, res) => {
  try {
    const result = await recalculatePositions();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[recalculate-positions] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Manual cash updater ───────────────────────────────────────────────────────
// Actualiza posiciones de cash manualmente (managed_by = 'manual').
// Body: { ticker, qty, avg_cost_usd, notes }
// Solo permite tocar campos seguros — nunca cambia managed_by ni category.
app.post('/api/positions/manual', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { ticker, qty, avg_cost_usd, notes } = req.body || {};

  if (!ticker) return res.status(400).json({ error: 'ticker requerido' });

  const updates = { updated_at: new Date().toISOString() };
  if (qty           !== undefined) updates.qty           = qty;
  if (avg_cost_usd  !== undefined) {
    updates.avg_cost_usd    = avg_cost_usd;
    updates.fx_gbp_usd_avg  = avg_cost_usd; // para cash GBP, fx_avg = TC al tenerlo
  }
  if (notes !== undefined) updates.notes = notes;

  // Recalcula initial_investment_usd si tenemos qty y avg_cost_usd
  if (updates.qty !== undefined && updates.avg_cost_usd !== undefined) {
    updates.initial_investment_usd = Math.round(updates.qty * updates.avg_cost_usd * 100) / 100;
    updates.initial_investment_gbp = updates.qty; // para GBP cash, gbp = qty
  }

  const supaUrl = `${SUPABASE_URL}/rest/v1/positions?ticker=eq.${encodeURIComponent(ticker)}&managed_by=eq.manual`;

  try {
    const sbRes = await fetch(supaUrl, {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(updates),
    });

    if (!sbRes.ok) {
      const errText = await sbRes.text();
      return res.status(sbRes.status).json({ error: errText });
    }

    const data = await sbRes.json();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── OCR Transaction ───────────────────────────────────────────────────────────
app.post('/api/ocr-transaction', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, mediaType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image requerida (base64)' });

  console.log('[ocr] received, size:', image.length, 'type:', mediaType);

  const prompt = `Extract financial transaction data from this broker screenshot. Return ONLY a JSON object, no markdown.

CRITICAL - always extract these fields exactly as shown in the image:
- price_usd: the exact fill/execution price in USD (e.g. from "1 SPY5 = $672.33" -> 672.33)
- price_local: the exact fill price in GBP if shown (e.g. "1 VWRP = £128.92" -> 128.92, or from Kraken "Precio: 49861.52 GBP" -> 49861.52)
- fx_rate_to_usd: USD per 1 GBP (e.g. from "£1 = $1.33365998" -> 1.33365998). NEVER leave null if shown in image.
- qty: exact filled quantity with all decimals (e.g. "0.19806635" or Kraken "Cantidad: 0.0019857 BTC" -> 0.0019857)
- fee_local: FX FEE or Comisión in GBP (0 if not shown)
- amount_local: the net amount that went into the asset = TOTAL_GBP - fee_local

BROKER DETECTION - identify by visual appearance:
1. Trading212 (dark UI, English, "Market Buy", "FILLED QUANTITY", "FILL PRICE", "EXCHANGE RATE"):
   - USD stock: FILL PRICE "1 X = \${usd}", EXCHANGE RATE "£1 = \${fx}", FX FEE £{fee}
   - GBP stock (VWRP etc): FILL PRICE "1 X = £{gbp}", no exchange rate, no fee, pricing_currency=GBP, exchange=LSE
   - broker="Trading212"

2. Kraken (dark UI, Spanish, orange Bitcoin logo or crypto icons, fields: "Cantidad", "Precio", "Comisión", "Total", "Pagado con", "Tipo de orden", "Fecha"):
   - ALL Kraken transactions are crypto: asset_class="cripto", broker="Kraken", exchange=null
   - ticker: extract from header e.g. "BTC comprados" -> BTC, "ADA comprados" -> ADA, "ETH comprados" -> ETH
   - price_local: from "Precio: {X} GBP" field
   - fee_local: from "Comisión: {X} GBP"
   - amount_local = Total_GBP - fee_local (e.g. £100 total - £0.99 fee = £99.01)
   - amount_usd: from "≈\${X}" shown next to total if visible
   - pricing_currency="GBP"

3. Schwab: extract what you can, broker="Schwab"

TICKER MAP: SPY5->SPY, VWRP->VWRP.L, ARKK->ARKK.L, NDIA->NDIA.L. All others keep as-is (ADA, BTC, ETH, SOL, etc.)
DATE: YYYY-MM-DD format

Return this JSON structure:
{"ticker":"","name":null,"type":"BUY","asset_class":"stock","date":"","qty":0,"price_usd":null,"price_local":null,"amount_usd":null,"amount_local":0,"fee_local":0,"fx_rate_to_usd":null,"pricing_currency":"USD","broker":"","exchange":null,"confidence":"high","notes":null}`;

  const bodyStr = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  console.log('[ocr] body size:', bodyStr.length);

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const reqHttp = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      });
      reqHttp.on('error', reject);
      reqHttp.setTimeout(55000, () => { reqHttp.destroy(); reject(new Error('Timeout 55s')); });
      reqHttp.write(bodyStr);
      reqHttp.end();
    });

    console.log('[ocr] Anthropic status:', result.status, 'response length:', result.body.length);

    if (result.status !== 200) {
      console.error('[ocr] error body:', result.body.slice(0, 400));
      return res.status(502).json({ error: `Anthropic ${result.status}: ${result.body.slice(0, 300)}` });
    }

    const data = JSON.parse(result.body);
    const text = data.content?.[0]?.text || '';
    console.log('[ocr] Claude raw:', text.slice(0, 300));

    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      res.json({ ok: true, transaction: parsed });
    } catch(e) {
      console.error('[ocr] parse error:', text.slice(0, 300));
      res.status(422).json({ error: 'Parse error', raw: text.slice(0, 300) });
    }

  } catch(e) {
    console.error('[ocr] error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AI Transactions Context ───────────────────────────────────────────────────
// Devuelve las últimas 5 transacciones + total invertido en el mes corriente
// en formato TSV compact para incluir en el system prompt del agente.
app.get('/api/ai-transactions-context', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    // Últimas 5 transacciones
    const txRes = await fetch(
      `${SUPABASE_URL}/rest/v1/transactions?select=date,ticker,type,qty,price_usd,amount_usd,amount_local,broker&order=date.desc&limit=5`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' } }
    );
    const txRows = await txRes.json();

    // Totales mensuales — mes corriente y mes pasado
    const now = new Date();
    const y  = now.getUTCFullYear();
    const m  = now.getUTCMonth() + 1; // 1-based
    const currStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const prevM     = m === 1 ? 12 : m - 1;
    const prevY     = m === 1 ? y - 1 : y;
    const prevStart = `${prevY}-${String(prevM).padStart(2, '0')}-01`;

    const [currMonthRes, prevMonthRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/transactions?select=amount_usd,amount_local&date=gte.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/transactions?select=amount_usd,amount_local&date=gte.${prevStart}&date=lt.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' } }
      ),
    ]);

    const currRows = await currMonthRes.json();
    const prevRows = await prevMonthRes.json();

    const sumUSD = rows => Array.isArray(rows) ? rows.reduce((s, r) => s + (parseFloat(r.amount_usd)   || 0), 0) : 0;
    const sumGBP = rows => Array.isArray(rows) ? rows.reduce((s, r) => s + (parseFloat(r.amount_local) || 0), 0) : 0;

    const currUSD = sumUSD(currRows), currGBP = sumGBP(currRows);
    const prevUSD = sumUSD(prevRows), prevGBP = sumGBP(prevRows);

    const currLabel = `${y}-${String(m).padStart(2, '0')}`;
    const prevLabel = `${prevY}-${String(prevM).padStart(2, '0')}`;

    let tsv = 'RECENT_TRANSACTIONS (últimas 5)\ndate|ticker|type|qty|price_usd|amount_usd|amount_gbp|broker\n';
    if (Array.isArray(txRows)) {
      txRows.forEach(r => {
        tsv += `${r.date}|${r.ticker}|${r.type}|${r.qty}|${r.price_usd ?? ''}|${r.amount_usd ?? ''}|${r.amount_local ?? ''}|${r.broker ?? ''}\n`;
      });
    }
    tsv += `\nMONTH_INVESTED\n`;
    tsv += `${currLabel} (corriente): $${Math.round(currUSD).toLocaleString()} USD / £${Math.round(currGBP).toLocaleString()} GBP\n`;
    tsv += `${prevLabel} (anterior):  $${Math.round(prevUSD).toLocaleString()} USD / £${Math.round(prevGBP).toLocaleString()} GBP`;

    res.json({ tsv: tsv.trim() });
  } catch (e) {
    console.error('[ai-transactions-context]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AI Correlation Context ────────────────────────────────────────────────────
// Devuelve correlaciones del portfolio (90d) en TSV compacto para el system prompt.
// Idéntica lógica a buildCorrelationContext() del frontend pero server-side,
// así el agente siempre tiene el dato aunque el usuario nunca haya abierto Analytics.
app.get('/api/ai-correlation-context', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept': 'application/json',
  };

  try {
    const [corrRes, posRes, snapRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/correlation_matrix?period_days=eq.90&select=ticker_a,ticker_b,correlation&limit=500`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/positions?select=ticker,qty,category,pricing_currency&order=ticker.asc`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/price_snapshots?select=ticker,price_usd&order=captured_at.desc&limit=50`, { headers: sbHeaders }),
    ]);

    const corrRows  = await corrRes.json();
    const positions = await posRes.json();
    const priceRows = await snapRes.json();

    if (!Array.isArray(corrRows) || !Array.isArray(positions)) {
      return res.json({ tsv: null });
    }

    // Build price map (latest price per ticker)
    const priceMap = {};
    if (Array.isArray(priceRows)) {
      priceRows.forEach(r => { if (!priceMap[r.ticker]) priceMap[r.ticker] = parseFloat(r.price_usd) || 0; });
    }

    const EXCLUDED = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND', 'GBP_LIQUID']);
    const portfolioAssets = positions.filter(p =>
      p.category !== 'fiat' &&
      !EXCLUDED.has(p.ticker) &&
      (priceMap[p.ticker] || 0) * (parseFloat(p.qty) || 0) > 0.5
    );

    if (portfolioAssets.length < 2) return res.json({ tsv: null });

    const values  = portfolioAssets.map(p => (priceMap[p.ticker] || 0) * (parseFloat(p.qty) || 0));
    const totalUSD = values.reduce((s, v) => s + v, 0);
    if (totalUSD === 0) return res.json({ tsv: null });

    const weights = {};
    portfolioAssets.forEach((p, i) => { weights[p.ticker] = values[i] / totalUSD; });

    const dispT = t => t.replace('RSU_META', 'META').replace('.L', '');

    // Lookup helper (symmetric)
    const corrMap = {};
    corrRows.forEach(r => { corrMap[`${r.ticker_a}|${r.ticker_b}`] = r.correlation; });
    const getCorr = (a, b) => corrMap[`${a}|${b}`] ?? corrMap[`${b}|${a}`] ?? null;

    const tickers = portfolioAssets.map(p => p.ticker);

    // 1. Correlations vs SPY
    const corrVsSpy = [];
    tickers.forEach(t => {
      const c = getCorr(t, 'SPY');
      if (c !== null) corrVsSpy.push(`${dispT(t)}: ${c.toFixed(2)}`);
    });

    // 2. Corr vs portfolio (weighted pairwise approx: corr(i,P) ≈ Σ_j w_j × corr(i,j))
    const corrVsPort = [];
    tickers.forEach(ti => {
      let weightedSum = 0, weightSum = 0;
      tickers.forEach(tj => {
        const c = ti === tj ? 1.0 : getCorr(ti, tj);
        if (c !== null) { weightedSum += weights[tj] * c; weightSum += weights[tj]; }
      });
      if (weightSum > 0.5) corrVsPort.push(`${dispT(ti)}: ${(weightedSum / weightSum).toFixed(2)}`);
    });

    // 3. High-correlation pairs (|r| >= 0.7)
    const highPairs = [];
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const c = getCorr(tickers[i], tickers[j]);
        if (c !== null && Math.abs(c) >= 0.7) {
          highPairs.push(`${dispT(tickers[i])}-${dispT(tickers[j])}: ${c.toFixed(2)}`);
        }
      }
    }

    // 4. Full pairwise matrix
    const matrixLines = [];
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const c = getCorr(tickers[i], tickers[j]);
        if (c !== null) matrixLines.push(`${dispT(tickers[i])}|${dispT(tickers[j])}|${c.toFixed(2)}`);
      }
    }

    let tsv = 'CORRELATION_90D\n';
    if (corrVsSpy.length)    tsv += `vs_SPY: ${corrVsSpy.join(', ')}\n`;
    if (corrVsPort.length)   tsv += `vs_portfolio: ${corrVsPort.join(', ')}\n`;
    if (highPairs.length)    tsv += `high_corr_pairs (>=0.7): ${highPairs.join(', ')}\n`;
    if (matrixLines.length)  tsv += `pairs\nticker_a|ticker_b|corr\n${matrixLines.join('\n')}\n`;

    res.json({ tsv: tsv.trim() });
  } catch (e) {
    console.error('[ai-correlation-context]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Briefing context — prompt completo para el notification worker ────────────
// Arma el system prompt del briefing diario con todos los datos relevantes:
// portfolio actual, P&L, day change, histórico 7d/30d, macro, fundamentals
// de las posiciones actuales, y transacciones recientes.
// NO incluye: vesting, health score, watchlist extendida, correlaciones.
app.get('/api/briefing-context', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept': 'application/json',
  };
  const fU  = v => '$' + Math.round(v).toLocaleString('en-US');
  const fG  = v => '£' + Math.round(v).toLocaleString('en-US');
  const sgn = (v, decimals = 2) => (v >= 0 ? '+' : '') + Number(v).toFixed(decimals) + '%';

  try {
    // Fetch all data in parallel
    const [posRes, snapRes, txCtxRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/positions?select=ticker,qty,avg_cost_usd,initial_investment_usd,initial_investment_gbp,category,pricing_currency,currency&order=ticker.asc`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate,breakdown&order=captured_at.desc&limit=300`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/transactions?select=date,ticker,type,qty,price_usd,amount_usd,amount_local,broker&order=date.desc&limit=5`, { headers: sbHeaders }),
    ]);

    const positions = await posRes.json();
    const snapshots = await snapRes.json();
    const txRows    = await txCtxRes.json();

    if (!Array.isArray(positions) || !Array.isArray(snapshots)) {
      return res.status(502).json({ error: 'Failed to fetch portfolio data' });
    }

    // ── FX rate + latest snapshot ──
    const latestSnap  = snapshots[0] || {};
    const fxRate      = latestSnap.fx_rate || 0.79;
    const totalUSD    = latestSnap.total_usd || 0;
    const totalGBP    = latestSnap.total_gbp || (totalUSD * fxRate);

    // Day change: compare latest snap to ~24h ago
    const msDay = 86400000;
    const latestTs = latestSnap.captured_at ? new Date(latestSnap.captured_at).getTime() : Date.now();
    const snap24h  = snapshots.find(s => (latestTs - new Date(s.captured_at).getTime()) >= 20 * 3600000);
    const snap7d   = snapshots.find(s => (latestTs - new Date(s.captured_at).getTime()) >= 6  * msDay);
    const snap30d  = snapshots.find(s => (latestTs - new Date(s.captured_at).getTime()) >= 29 * msDay);

    const dayChangeUSD = snap24h ? totalUSD - snap24h.total_usd : null;
    const dayChangeGBP = snap24h ? totalGBP - (snap24h.total_gbp || snap24h.total_usd * fxRate) : null;
    const dayPct       = snap24h && snap24h.total_usd > 0 ? (dayChangeUSD / snap24h.total_usd * 100) : null;
    const chg7d        = snap7d  && snap7d.total_usd  > 0 ? ((totalUSD - snap7d.total_usd)  / snap7d.total_usd  * 100) : null;
    const chg30d       = snap30d && snap30d.total_usd > 0 ? ((totalUSD - snap30d.total_usd) / snap30d.total_usd * 100) : null;

    // ── Get live prices from market-data cache (portfolio tickers) ──
    const investedPositions = positions.filter(p => p.category !== 'fiat' && parseFloat(p.qty) > 0);
    const tickers = investedPositions.map(p => p.ticker === 'RSU_META' ? 'META' : p.ticker).filter(Boolean);
    let marketData = {};
    if (tickers.length > 0 && yf) {
      // Usar cache si está fresco y completo, sino fetchear directamente con fetchFundamentals.
      // Esto garantiza que el briefing tenga precios actuales aunque el frontend no haya sido abierto.
      const cacheValid = portfolioCache &&
        portfolioTickers &&
        tickers.every(t => portfolioTickers.includes(t)) &&
        (Date.now() - portfolioCachedAt) < CACHE_TTL_MS;

      if (cacheValid) {
        marketData = portfolioCache;
        console.log('[briefing-context] using portfolioCache for market data');
      } else {
        console.log('[briefing-context] fetching fresh fundamentals for', tickers.length, 'tickers');
        const results = {};
        await Promise.allSettled(tickers.map(async t => {
          try { results[t] = await fetchFundamentals(t); }
          catch (e) { console.warn('[briefing-context] fundamentals failed for', t, e.message); }
        }));
        marketData = results;
        // Actualizar el cache para que el frontend también lo aproveche
        if (Object.keys(results).length > 0) {
          portfolioCache    = results;
          portfolioCachedAt = Date.now();
          portfolioTickers  = tickers;
        }
      }
    }

    // ── Macro ──
    let macroSection = '';
    if (macroCache) {
      const f2  = v => v != null ? Number(v).toFixed(2) : '—';
      const sgnM = v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
      macroSection = 'MACRO\nticker|label|value|unit|7d|30d|trend\n';
      Object.entries(macroCache).forEach(([ticker, d]) => {
        if (!d || d.current == null) return;
        macroSection += `${ticker}|${d.label}|${f2(d.current)}|${d.unit}|${sgnM(d.chg7d)}|${sgnM(d.chg30d)}|${d.trend}\n`;
      });
    }

    // ── Positions with P&L and day% ──
    let posSection = 'POSITIONS\nticker|category|value_usd|value_gbp|weight%|invested_usd|invested_gbp|pnl_usd%|pnl_gbp%|day%\n';
    let totalInvUSD = 0, totalInvGBP = 0, totalValUSD = 0;

    investedPositions.forEach(p => {
      const yticker  = p.ticker === 'RSU_META' ? 'META' : p.ticker;
      const md       = marketData[yticker] || {};
      const price    = md.regularMarketPrice || parseFloat(p.avg_cost_usd) || 0;
      const qty      = parseFloat(p.qty) || 0;
      const isGBP    = p.pricing_currency === 'GBP';
      const valueUSD = isGBP ? price * qty / fxRate : price * qty;
      const valueGBP = valueUSD * fxRate;
      const invUSD   = parseFloat(p.initial_investment_usd) || 0;
      const invGBP   = parseFloat(p.initial_investment_gbp) || invUSD * fxRate;
      const pnlUSD   = invUSD > 0 ? ((valueUSD - invUSD) / invUSD * 100) : null;
      const pnlGBP   = invGBP > 0 ? ((valueGBP - invGBP) / invGBP * 100) : null;
      const dayPctPos = md.regularMarketChangePercent != null ? md.regularMarketChangePercent * 100 : null;

      totalValUSD += valueUSD;
      totalInvUSD += invUSD;
      totalInvGBP += invGBP;

      posSection += [
        p.ticker, p.category,
        fU(valueUSD), fG(valueGBP),
        '',  // weight filled after
        fU(invUSD), fG(invGBP),
        pnlUSD != null ? sgn(pnlUSD) : '',
        pnlGBP != null ? sgn(pnlGBP) : '',
        dayPctPos != null ? sgn(dayPctPos) : '',
      ].join('|') + '\n';
    });

    // Fill weight% now that we have totalValUSD
    posSection = posSection.split('\n').map((line, i) => {
      if (i < 2 || !line) return line;
      const parts = line.split('|');
      if (parts.length < 3) return line;
      const valUSD = parseFloat(parts[2].replace(/[$,]/g, '')) || 0;
      parts[4] = totalValUSD > 0 ? (valUSD / totalValUSD * 100).toFixed(1) + '%' : '';
      return parts.join('|');
    }).join('\n');

    // P&L total
    const totalPnlUSD = totalValUSD - totalInvUSD;
    const totalPnlGBP = totalValUSD * fxRate - totalInvGBP;
    const totalPnlPct = totalInvUSD > 0 ? (totalPnlUSD / totalInvUSD * 100) : 0;

    // ── Cash positions ──
    const cashPositions = positions.filter(p => p.category === 'fiat');
    let cashSection = 'CASH\nticker|value_gbp\n';
    cashPositions.forEach(p => {
      const qty = parseFloat(p.qty) || 0;
      cashSection += `${p.ticker}|${fG(qty)}\n`;
    });

    // ── Transactions context ──
    let txSection = 'RECENT_TRANSACTIONS (últimas 5)\ndate|ticker|type|qty|price_usd|amount_usd|amount_gbp|broker\n';
    if (Array.isArray(txRows)) {
      txRows.forEach(r => {
        txSection += `${r.date}|${r.ticker}|${r.type}|${r.qty}|${r.price_usd ?? ''}|${r.amount_usd ?? ''}|${r.amount_local ?? ''}|${r.broker ?? ''}\n`;
      });
    }

    // ── Month invested (reuse existing endpoint logic inline) ──
    const now2 = new Date();
    const y = now2.getUTCFullYear(), mo = now2.getUTCMonth() + 1;
    const currStart = `${y}-${String(mo).padStart(2,'0')}-01`;
    const prevMo = mo === 1 ? 12 : mo - 1, prevY = mo === 1 ? y - 1 : y;
    const prevStart = `${prevY}-${String(prevMo).padStart(2,'0')}-01`;
    const [cmRes, pmRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/transactions?select=amount_usd,amount_local&date=gte.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/transactions?select=amount_usd,amount_local&date=gte.${prevStart}&date=lt.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`, { headers: sbHeaders }),
    ]);
    const cmRows = await cmRes.json(), pmRows = await pmRes.json();
    const sumF = (rows, field) => Array.isArray(rows) ? rows.reduce((s,r) => s + (parseFloat(r[field])||0), 0) : 0;
    txSection += `\nMONTH_INVESTED\n`;
    txSection += `${y}-${String(mo).padStart(2,'0')} (corriente): ${fU(sumF(cmRows,'amount_usd'))} / ${fG(sumF(cmRows,'amount_local'))}\n`;
    txSection += `${prevY}-${String(prevMo).padStart(2,'0')} (anterior): ${fU(sumF(pmRows,'amount_usd'))} / ${fG(sumF(pmRows,'amount_local'))}`;

    // ── Assemble prompt ──
    const today = new Date().toLocaleDateString('es-AR', {
      timeZone: 'Europe/London',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const portfolioSummary =
      `PORTFOLIO\n` +
      `total: ${fU(totalUSD)} / ${fG(totalGBP)}\n` +
      `fx: 1 GBP = ${(1/fxRate).toFixed(4)} USD\n` +
      (dayChangeUSD != null ? `day_change: ${dayChangeUSD >= 0 ? '+' : ''}${fU(dayChangeUSD)} / ${dayChangeGBP >= 0 ? '+' : ''}${fG(dayChangeGBP)} (${sgn(dayPct)})\n` : '') +
      (chg7d  != null ? `7d: ${sgn(chg7d)}\n`  : '') +
      (chg30d != null ? `30d: ${sgn(chg30d)}\n` : '') +
      `cost_basis: ${fU(totalInvUSD)} / ${fG(totalInvGBP)}\n` +
      `total_pnl: ${totalPnlUSD >= 0 ? '+' : ''}${fU(totalPnlUSD)} / ${totalPnlGBP >= 0 ? '+' : ''}${fG(totalPnlGBP)} (${sgn(totalPnlPct)})`;

    const systemPrompt =
      `Sos el asesor financiero personal de Julián. Hoy es ${today}. La bolsa de Nueva York acaba de cerrar.\n\n` +
      `Generá un briefing financiero diario conciso en español. Máximo 400 palabras. Usá markdown (negrita, bullets).\n` +
      `Estructura:\n` +
      `1. **Cierre de mercado** — macro: VIX, índices, tasas, GBP/USD\n` +
      `2. **Tu portfolio hoy** — valor total, variación del día en USD y GBP, P&L acumulado, posiciones más impactadas\n` +
      `3. **Una observación concreta** — algo accionable o a monitorear\n\n` +
      `Sé directo. No repitas datos que ya están en los números.\n\n` +
      portfolioSummary + '\n\n' +
      posSection + '\n' +
      cashSection + '\n' +
      txSection + '\n\n' +
      (macroSection ? macroSection : '');

    res.json({ systemPrompt });

  } catch (e) {
    console.error('[briefing-context]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AI Chat — Agentic loop ────────────────────────────────────────────────────
//
// Cambios vs versión anterior de executeRunMontecarlo:
//   - invested y cash con tasas separadas (alineado con mcSimulate() de analytics.js)
//   - escenarios renombrados a bear/neutral/bull con valores exactos de MC_SCEN
//   - valores iniciales fetcheados de Supabase en tiempo real (no hardcodeados)
//   - bonus en meses 3/9, RSU en meses 1/4/7/10 (alineado con MC_BONUS_MONTHS/MC_RSU_MONTHS)
//   - goal_probabilities calculadas en el mismo loop de simulación
//   - N_SIMULATIONS 1000 → 2000
//   - executeRunMontecarlo es ahora async (await en el llamador)

const https = require('https');

// ── Tool definitions ──────────────────────────────────────────────────────────
const AI_TOOLS = [
  {
    name: 'query_db',
    description: `Query Julian's portfolio database for historical or detailed data not already in the system context.
Use when asked about: full transaction history, specific asset purchase price, past portfolio performance, RSU vest schedule, historical prices, or daily returns.
Do NOT use if the answer is already in the system context.`,
    input_schema: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          enum: [
            'transactions_by_ticker',
            'transactions_by_period',
            'transactions_all',
            'portfolio_history',
            'price_history',
            'rsu_vests',
            'positions_snapshot',
            'daily_returns',
          ],
          description: 'Query type. Pick the most specific one.',
        },
        filters: {
          type: 'object',
          description: 'Optional filters depending on query_type.',
          properties: {
            ticker:      { type: 'string',  description: "e.g. 'SPY', 'RSU_META', 'VWRP.L', 'BTC'" },
            from_date:   { type: 'string',  description: 'ISO date YYYY-MM-DD' },
            to_date:     { type: 'string',  description: 'ISO date YYYY-MM-DD' },
            limit:       { type: 'integer', description: 'Max rows. Default 20, max 200.' },
            vested_only: { type: 'boolean', description: 'rsu_vests only: true=vested, false=pending' },
          },
        },
      },
      required: ['query_type'],
    },
  },
  {
    name: 'run_montecarlo',
    description: `Run a Monte Carlo simulation on Julian's portfolio.
Use when the user wants future projections, probability of reaching a capital goal, or scenarios with custom parameters (different horizon, savings, RSU inclusion, etc.).
Returns median, p10/p25/p75/p90, goal probabilities for £30k/£100k/£200k, and optional target probability.

HORIZON: use months for specific dates (count months from TODAY exclusive to target inclusive). When using months, omit years.
FUTURE PARAM CHANGE (e.g. promotion in 6 months): chain two calls — first simulate to change date, use median as initial_capital_gbp for second call with new params.`,
    input_schema: {
      type: 'object',
      properties: {
        years: {
          type: 'integer',
          minimum: 1,
          maximum: 40,
          description: 'Horizon in whole years. Omit if using months.',
        },
        months: {
          type: 'integer',
          minimum: 1,
          maximum: 480,
          description: 'Horizon in months. Takes precedence over years. Use for specific target dates. Omit years when using this.',
        },
        monthly_contribution_gbp: {
          type: 'number',
          description: 'Monthly contribution in GBP. Default: £950.',
        },
        annual_bonus_gbp: {
          type: 'number',
          description: 'Annual bonus in GBP. Default: £8000.',
        },
        include_rsu: {
          type: 'boolean',
          description: 'Include future RSU vests as contributions. Default true.',
        },
        rsu_per_vest_override: {
          type: 'number',
          description: 'Override net RSU value per vest in GBP. Replaces dynamic calculation.',
        },
        target_gbp: {
          type: 'number',
          description: 'Capital target in GBP. If set, returns probability of reaching it.',
        },
        scenario: {
          type: 'string',
          enum: ['neutral', 'bull', 'bear'],
          description: 'neutral=historical (9% ret, 18% vol) | bull=optimistic (16%, 22%) | bear=conservative (3%, 25%). Default: neutral.',
        },
        initial_capital_gbp: {
          type: 'number',
          description: 'Starting capital in GBP. Overrides current portfolio value. Use for hypothetical scenarios.',
        },
      },
      required: ['years'],
    },
  },
];

// ── Ejecutores de tools ───────────────────────────────────────────────────────

async function executeQueryDb(input) {
  const { query_type, filters = {} } = input;
  const { ticker, from_date, to_date, vested_only } = filters;
  const limit = Math.min(filters.limit || 20, 200);

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept': 'application/json',
  };

  const sb = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return r.json();
  };

  let rows, description;

  switch (query_type) {
    case 'transactions_by_ticker': {
      if (!ticker) return { error: 'transactions_by_ticker requiere filters.ticker' };
      let qs = `transactions?ticker=eq.${encodeURIComponent(ticker)}&order=date.desc&limit=${limit}`;
      qs += `&select=date,ticker,type,asset_class,qty,price_usd,amount_usd,amount_local,fx_rate_to_usd,broker,notes`;
      rows = await sb(qs);
      description = `Transacciones de ${ticker} (últimas ${limit})`;
      break;
    }
    case 'transactions_by_period': {
      let qs = `transactions?order=date.desc&limit=${limit}`;
      qs += `&select=date,ticker,type,asset_class,qty,price_usd,amount_usd,amount_local,fx_rate_to_usd,broker`;
      if (from_date) qs += `&date=gte.${from_date}`;
      if (to_date)   qs += `&date=lte.${to_date}`;
      rows = await sb(qs);
      description = `Transacciones ${from_date || ''}–${to_date || 'hoy'}`;
      break;
    }
    case 'transactions_all': {
      let qs = `transactions?order=date.desc&limit=${limit}`;
      qs += `&select=date,ticker,type,asset_class,qty,price_usd,amount_usd,amount_local,fx_rate_to_usd,broker`;
      rows = await sb(qs);
      description = `Últimas ${limit} transacciones`;
      break;
    }
    case 'portfolio_history': {
      let qs = `portfolio_snapshots?order=captured_at.asc&limit=${limit}`;
      qs += `&select=captured_at,total_usd,total_gbp,fx_rate`;
      if (from_date) qs += `&captured_at=gte.${from_date}`;
      if (to_date)   qs += `&captured_at=lte.${to_date}T23:59:59Z`;
      rows = await sb(qs);
      description = `Historial del portfolio ${from_date || ''}–${to_date || 'hoy'}`;
      break;
    }
    case 'price_history': {
      if (!ticker) return { error: 'price_history requiere filters.ticker' };
      let qs = `price_snapshots?ticker=eq.${encodeURIComponent(ticker)}&order=captured_at.asc&limit=${limit}`;
      qs += `&select=ticker,price_usd,price_gbp,fx_rate,captured_at`;
      if (from_date) qs += `&captured_at=gte.${from_date}`;
      rows = await sb(qs);
      description = `Historial de precios de ${ticker}`;
      break;
    }
    case 'rsu_vests': {
      let qs = `rsu_vests?order=vest_date.asc&select=vest_date,units,vested,grant_id,granted_at`;
      if (vested_only === true)  qs += `&vested=eq.true`;
      if (vested_only === false) qs += `&vested=eq.false`;
      rows = await sb(qs);
      description = vested_only === true ? 'RSUs ya vestados' : vested_only === false ? 'RSUs pendientes' : 'Schedule completo de RSUs';
      break;
    }
    case 'positions_snapshot': {
      rows = await sb('positions?order=ticker.asc&select=ticker,name,category,qty,avg_cost_usd,avg_cost_gbp,initial_investment_usd,initial_investment_gbp,pricing_currency,managed_by');
      description = 'Snapshot de posiciones desde DB';
      break;
    }
    case 'daily_returns': {
      let qs = `daily_returns?order=date.desc&limit=${limit}&select=ticker,date,return_pct,close_usd`;
      if (ticker)    qs += `&ticker=eq.${encodeURIComponent(ticker)}`;
      if (from_date) qs += `&date=gte.${from_date}`;
      if (to_date)   qs += `&date=lte.${to_date}`;
      rows = await sb(qs);
      description = ticker ? `Retornos diarios de ${ticker}` : 'Retornos diarios (todos los tickers)';
      break;
    }
    default:
      return { error: `query_type desconocido: ${query_type}` };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { description, rows: [], message: 'Sin datos para los filtros especificados.' };
  }

  return { description, row_count: rows.length, rows };
}

async function executeRunMontecarlo(input) {
  const {
    years,
    months,
    monthly_contribution_gbp = 950,
    annual_bonus_gbp         = 8000,
    include_rsu              = true,
    rsu_per_vest_override    = null, // null = calcular dinámicamente; número = override manual del agente
    target_gbp               = null,
    scenario                 = 'neutral',
    initial_capital_gbp      = null, // null = usar portfolio real; 0 o cualquier número = override
  } = input;

  // Escenarios alineados con MC_SCEN en analytics.js
  const SCENARIOS = {
    bear:    { ret: 3,  vol: 25 },
    neutral: { ret: 9,  vol: 18 },
    bull:    { ret: 16, vol: 22 },
  };
  const scen = SCENARIOS[scenario] ?? SCENARIOS.neutral;

  // Horizonte: months tiene precedencia sobre years
  const totalMonths = (months != null) ? months : ((years ?? 5) * 12);

  // Tasas de cash (igual que defaults del frontend)
  const CASH_RET = 3;
  const CASH_VOL = 1;

  const RSU_MONTHS   = new Set([1, 4, 7, 10]);
  // Bonus: 50% en mes 3 (marzo) y 50% en mes 9 (sep) — alineado con MC_BONUS_MONTHS
  const BONUS_MONTHS = new Set([3, 9]);

  // ── Headers Supabase (compartido por RSU fetch y positions fetch) ──────────
  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept': 'application/json',
  };

  // RSU: valor neto por vest — calculado dinámicamente desde rsu_vests (próximos 8 quarters)
  // Si el agente pasa rsu_per_vest_override, se usa ese valor directamente.
  let RSU_PER_VEST = 2100; // valor inicial — se sobreescribe dinámicamente abajo (o con override del agente)
  if (rsu_per_vest_override !== null && typeof rsu_per_vest_override === 'number') {
    RSU_PER_VEST = rsu_per_vest_override;
  } else {
    try {
      const [rsuVestRes, metaPriceRes, fxSnapRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/rsu_vests?select=vest_date,units,vested&order=vest_date.asc`, { headers: sbHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/price_snapshots?ticker=eq.META&order=captured_at.desc&limit=1&select=price_usd`, { headers: sbHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/portfolio_snapshots?select=fx_rate&order=captured_at.desc&limit=1`, { headers: sbHeaders }),
      ]);
      const rsuRows    = await rsuVestRes.json();
      const priceRows  = await metaPriceRes.json();
      const fxRows     = await fxSnapRes.json();
      const metaUSD = (Array.isArray(priceRows) && priceRows[0]?.price_usd) ? parseFloat(priceRows[0].price_usd) : 600;
      const fxRate  = (Array.isArray(fxRows)    && fxRows[0]?.fx_rate)      ? parseFloat(fxRows[0].fx_rate)      : 0.79;
      if (Array.isArray(rsuRows) && rsuRows.length > 0) {
        // Agrupar por vest_date sumando units de distintos grants
        const grouped = {};
        rsuRows.forEach(r => {
          if (!grouped[r.vest_date]) grouped[r.vest_date] = { units: 0, vested: r.vested };
          grouped[r.vest_date].units += r.units;
          if (!r.vested) grouped[r.vest_date].vested = false;
        });
        const upcomingUnits = Object.entries(grouped)
          .filter(([, g]) => !g.vested)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, 8)
          .map(([, g]) => g.units);
        if (upcomingUnits.length > 0) {
          const avgUnits = upcomingUnits.reduce((s, u) => s + u, 0) / upcomingUnits.length;
          RSU_PER_VEST = Math.round(avgUnits * metaUSD * fxRate * 0.53);
        }
      }
    } catch (e) {
      console.warn('[montecarlo] error calculando RSU_PER_VEST dinámico, usando valor inicial £2100:', e.message);
    }
  }

  let startInvested = 8000; // fallbacks por si falla el fetch
  let startCash     = 4000;

  // Si el usuario especificó un capital inicial explícito, usarlo directamente
  // (incluye el caso 0 para simular "desde cero")
  if (initial_capital_gbp !== null) {
    startInvested = initial_capital_gbp;
    startCash     = 0;
  } else {

  try {
    const [posRes, snapRes, priceRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/positions?select=ticker,category,qty,avg_cost_usd,pricing_currency`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/portfolio_snapshots?select=fx_rate&order=captured_at.desc&limit=1`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/price_snapshots?select=ticker,price_usd&order=captured_at.desc&limit=50`, { headers: sbHeaders }),
    ]);

    const positions = await posRes.json();
    const snapRows  = await snapRes.json();
    const priceRows = await priceRes.json();

    const fxRate = (Array.isArray(snapRows) && snapRows[0]?.fx_rate)
      ? parseFloat(snapRows[0].fx_rate) : 0.79;

    // Mapa ticker → precio USD más reciente del worker
    const priceMap = {};
    if (Array.isArray(priceRows)) {
      priceRows.forEach(r => { if (!priceMap[r.ticker]) priceMap[r.ticker] = parseFloat(r.price_usd); });
    }

    if (Array.isArray(positions)) {
      let investedUSD = 0, cashUSD = 0;

      positions.forEach(p => {
        const qty = parseFloat(p.qty) || 0;
        if (qty <= 0) return;

        // Precio: snapshot reciente del worker si existe, fallback a avg_cost_usd
        const priceUSD = priceMap[p.ticker] ?? parseFloat(p.avg_cost_usd) ?? 0;
        // price_snapshots ya almacena todo en USD (el worker convierte GBP tickers)
        const valueUSD = priceUSD * qty;

        if (p.category === 'fiat') {
          // Para fiat en GBP (EMERGENCY_FUND, RENT_DEPOSIT, GBP_LIQUID):
          // qty está en GBP, así que convertimos a USD primero
          const isGBPfiat = p.pricing_currency === 'GBP';
          cashUSD += isGBPfiat ? qty / fxRate : valueUSD;
        } else {
          investedUSD += valueUSD;
        }
      });

      startInvested = Math.round(investedUSD * fxRate); // USD → GBP
      startCash     = Math.round(cashUSD     * fxRate); // USD → GBP
    }
  } catch (e) {
    console.warn('[montecarlo] error fetcheando posiciones, usando fallbacks:', e.message);
  }
  } // end else (initial_capital_gbp not specified)

  // ── Simulación alineada con mcSimulate() del frontend ──────────────────────
  const N_SIMULATIONS = 2000;
  const mr = scen.ret / 100 / 12;
  const mv = scen.vol / 100 / Math.sqrt(12);
  const cr = CASH_RET / 100 / 12;
  const cv = CASH_VOL / 100 / Math.sqrt(12);
  const M  = totalMonths;

  // Box-Muller (alineado con mcRandn() del frontend)
  function randn() {
    let u, v;
    do { u = Math.random(); } while (!u);
    do { v = Math.random(); } while (!v);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const nowMonth = new Date().getMonth(); // 0-based, igual que MC_NOW_MONTH

  // Goals que queremos trackear — solo los que caen dentro del horizonte
  const GOALS = [
    { label: '£30k',  target: 30000,  months: 12 },
    { label: '£100k', target: 100000, months: 36 },
    { label: '£200k', target: 200000, months: 60 },
  ].filter(g => g.months <= M);

  // milestoneSnaps[month] = Float32Array de N_SIMULATIONS valores a ese mes
  const milestoneSnaps = {};
  GOALS.forEach(g => { milestoneSnaps[g.months] = new Float32Array(N_SIMULATIONS); });

  const finalValues = new Float32Array(N_SIMULATIONS);

  for (let s = 0; s < N_SIMULATIONS; s++) {
    let inv  = startInvested;
    let cash = startCash;

    for (let m = 1; m <= M; m++) {
      // Crecer con mercado — invested y cash con tasas separadas
      inv  *= 1 + mr + mv * randn();
      cash *= 1 + cr + cv * randn();

      // Cash flows → invested (igual que frontend: new money goes to invested)
      const calMonth = (nowMonth + m) % 12;
      inv += monthly_contribution_gbp;
      if (BONUS_MONTHS.has(calMonth))               inv += annual_bonus_gbp / 2;
      if (include_rsu && RSU_MONTHS.has(calMonth))  inv += RSU_PER_VEST;

      const total = inv + cash;
      if (milestoneSnaps[m] !== undefined) milestoneSnaps[m][s] = total < 0 ? 0 : total;
    }

    finalValues[s] = Math.max(0, inv + cash);
  }

  finalValues.sort();

  const pct = (arr, p) => {
    const i = Math.floor(arr.length * p / 100);
    return arr[Math.min(i, arr.length - 1)];
  };

  const probAbove = (arr, target) => {
    let above = 0;
    for (let i = 0; i < arr.length; i++) { if (arr[i] >= target) above++; }
    return Math.round(above / arr.length * 100);
  };

  // Probabilidad custom target al final del horizonte
  let prob_target = null;
  if (target_gbp) {
    prob_target = probAbove(finalValues, target_gbp);
  }

  // Goal probabilities en sus milestones específicos
  const goal_probabilities = GOALS.map(g => ({
    label:       g.label,
    at_months:   g.months,
    probability: `${probAbove(milestoneSnaps[g.months], g.target)}%`,
  }));

  const fmt = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;

  return {
    scenario,
    horizon_months: M,
    horizon_label: M % 12 === 0 ? `${M / 12} año${M / 12 !== 1 ? 's' : ''}` : `${M} meses`,
    params: {
      start_invested_gbp:             fmt(startInvested),
      start_cash_gbp:                 fmt(startCash),
      start_total_gbp:                fmt(startInvested + startCash),
      capital_source:                 initial_capital_gbp !== null ? 'override manual' : 'portfolio real',
      monthly_contribution_gbp:       fmt(monthly_contribution_gbp),
      annual_bonus_gbp:               fmt(annual_bonus_gbp),
      rsu_per_vest_gbp:               include_rsu ? fmt(RSU_PER_VEST) : 'no incluido',
      assumed_annual_return_invested: `${scen.ret}%`,
      assumed_annual_vol_invested:    `${scen.vol}%`,
      assumed_annual_return_cash:     `${CASH_RET}%`,
    },
    results: {
      p10:    fmt(pct(finalValues, 10)),
      p25:    fmt(pct(finalValues, 25)),
      median: fmt(pct(finalValues, 50)),
      p75:    fmt(pct(finalValues, 75)),
      p90:    fmt(pct(finalValues, 90)),
    },
    target: target_gbp ? {
      target:      fmt(target_gbp),
      probability: `${prob_target}%`,
    } : null,
    goal_probabilities,
    simulations: N_SIMULATIONS,
  };
}

// ── Helper: llamada a Anthropic API ─────────────────────────────────────────
// Reintentos automáticos para 429 (rate limit) y 529 (overloaded).
// Estrategia: hasta 2 reintentos con backoff exponencial (2s → 4s).
function _callAnthropicOnce(anthropicKey, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(bodyStr),
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Timeout 90s')); });
    req.write(bodyStr);
    req.end();
  });
}

async function callAnthropic(anthropicKey, body) {
  const RETRYABLE = new Set([429, 529]);
  const MAX_RETRIES = 2;
  let attempt = 0;
  while (true) {
    const result = await _callAnthropicOnce(anthropicKey, body);
    if (!RETRYABLE.has(result.status) || attempt >= MAX_RETRIES) return result;
    attempt++;
    const delayMs = 2000 * attempt; // 2s, 4s
    console.warn(`[ai-chat] status ${result.status} — reintento ${attempt}/${MAX_RETRIES} en ${delayMs}ms`);
    await new Promise(r => setTimeout(r, delayMs));
  }
}

// ── DIAGNÓSTICO DE TOKENS — BORRAR DESPUÉS ────────────────────────────────────
// GET /api/token-diag  →  mide el costo real de tools vs sin tools
app.get('/api/token-diag', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'no key' });

  const SYSTEM = 'x';
  const MESSAGES = [{ role: 'user', content: 'x' }];

  async function probe(withTools) {
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      system: SYSTEM,
      messages: MESSAGES,
      ...(withTools ? { tools: AI_TOOLS } : {}),
    };
    const r = await callAnthropic(anthropicKey, body);
    return JSON.parse(r.body).usage?.input_tokens ?? null;
  }

  const [withTools, withoutTools] = await Promise.all([probe(true), probe(false)]);

  res.json({
    with_tools:    withTools,
    without_tools: withoutTools,
    tools_cost:    withTools - withoutTools,
    note: 'system="x" + message="x" en ambos casos',
  });
});
// ── FIN DIAGNÓSTICO ───────────────────────────────────────────────────────────

// ── Endpoint principal ───────────────────────────────────────────────────────
app.post('/api/ai-chat', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  const { model, max_tokens = 3000, system, messages } = req.body;
  const MAX_TOOL_ITERATIONS = 5;

  // ── Log de entrada ──────────────────────────────────────────────────────────
  const userMsg = messages?.findLast?.(m => m.role === 'user')?.content;
  console.log(`[ai-chat] ← request | model: ${model} | system: ${system?.length} chars | messages: ${messages?.length}`);
  console.log(`[ai-chat] ← user_msg: ${String(userMsg).slice(0, 200)}`);
  console.log(`[ai-chat] ← system_preview: ${system?.slice(0, 400)}`);

  const toolCallsLog  = [];
  let loopMessages    = [...messages];
  let finalResponse   = null;
  let iterations      = 0;

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const anthropicBody = {
        model,
        max_tokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: loopMessages,
        tools: AI_TOOLS,
      };

      console.log(`[ai-chat] iteración ${iterations} — mensajes: ${loopMessages.length}`);
      const raw = await callAnthropic(anthropicKey, anthropicBody);

      if (raw.status !== 200) {
        console.error('[ai-chat] Anthropic error:', raw.body.slice(0, 400));
        return res.status(raw.status).json(JSON.parse(raw.body));
      }

      const response = JSON.parse(raw.body);

      if (response.stop_reason === 'end_turn') {
        finalResponse = response;
        break;
      }

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

        if (toolUseBlocks.length === 0) {
          finalResponse = response;
          break;
        }

        loopMessages.push({ role: 'assistant', content: response.content });

        const toolResults = [];

        for (const toolBlock of toolUseBlocks) {
          const { id, name, input } = toolBlock;
          const startTime = Date.now();

          console.log(`[ai-chat] ejecutando tool: ${name}`, JSON.stringify(input));

          let result;
          try {
            if (name === 'query_db') {
              result = await executeQueryDb(input);
            } else if (name === 'run_montecarlo') {
              result = await executeRunMontecarlo(input); // async ahora
            } else {
              result = { error: `Tool desconocida: ${name}` };
            }
          } catch (toolErr) {
            console.error(`[ai-chat] tool ${name} error:`, toolErr.message);
            result = { error: toolErr.message };
          }

          const elapsed = Date.now() - startTime;

          // ── Log del resultado de la tool ──────────────────────────────────
          if (result?.error) {
            console.error(`[ai-chat] tool ${name} ERROR (${elapsed}ms):`, result.error);
          } else {
            const resultPreview = JSON.stringify(result).slice(0, 600);
            console.log(`[ai-chat] tool ${name} OK (${elapsed}ms) | rows: ${result?.row_count ?? '—'} | preview: ${resultPreview}`);
          }

          toolCallsLog.push({
            tool:      name,
            input:     input,
            elapsed_ms: elapsed,
            row_count: result?.row_count ?? null,
            error:     result?.error ?? null,
          });

          toolResults.push({
            type:        'tool_result',
            tool_use_id: id,
            content:     JSON.stringify(result),
          });
        }

        loopMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // max_tokens u otro stop_reason inesperado
      finalResponse = response;
      break;
    }

    if (!finalResponse) {
      console.warn('[ai-chat] límite de iteraciones alcanzado');
      finalResponse = {
        content: [{ type: 'text', text: 'Lo siento, la consulta requirió demasiados pasos. Intentá ser más específico.' }],
        stop_reason: 'max_iterations',
        usage: {},
      };
    }

    finalResponse._tool_calls_log = toolCallsLog;

    // ── Log de respuesta final ────────────────────────────────────────────────
    const finalText = finalResponse?.content?.find(b => b.type === 'text')?.text;
    const usage     = finalResponse?.usage;
    const cacheHit  = usage?.cache_read_input_tokens ?? 0;
    const cacheStr  = cacheHit > 0 ? ` | cache_read: ${cacheHit}` : '';
    console.log(`[ai-chat] → response | stop: ${finalResponse?.stop_reason} | iterations: ${iterations} | tokens in: ${usage?.input_tokens} out: ${usage?.output_tokens}${cacheStr}`);
    console.log(`[ai-chat] → reply_preview: ${finalText?.slice(0, 300)}`);

    if (toolCallsLog.length > 0) {
      console.log(`[ai-chat] tools usadas: ${toolCallsLog.map(t => t.tool).join(', ')} | iteraciones: ${iterations}`);
    }

    res.json(finalResponse);

  } catch (e) {
    console.error('[ai-chat] error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AI Chat History ───────────────────────────────────────────────────────────
// SQL to run once in Supabase:
//
// CREATE TABLE ai_conversations (
//   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
//   model         TEXT,
//   title         TEXT,
//   message_count INT DEFAULT 0
// );
//
// CREATE TABLE ai_messages (
//   id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   conversation_id UUID REFERENCES ai_conversations(id) ON DELETE CASCADE,
//   seq             INT NOT NULL,       -- 0-based, global within conversation
//   role            TEXT NOT NULL,      -- 'user' | 'assistant'
//   content         TEXT NOT NULL,
//   model           TEXT,              -- only set on assistant messages
//   input_tokens    INT,
//   output_tokens   INT,
//   created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
// );
// CREATE INDEX ON ai_messages(conversation_id, seq);
//
// -- Records exactly which messages were passed as context on each turn.
// -- turn_msg_seq: seq of the user message that triggered the turn.
// -- context_msg_seq: seq of each message included in messages[] sent to the API.
// CREATE TABLE ai_context_links (
//   id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   conversation_id UUID REFERENCES ai_conversations(id) ON DELETE CASCADE,
//   turn_msg_seq    INT NOT NULL,  -- the user message that triggered this turn
//   context_msg_seq INT NOT NULL,  -- a message included as context in that turn
//   created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
// );
// CREATE INDEX ON ai_context_links(conversation_id, turn_msg_seq);
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/ai-conversations  →  create new conversation, return { id }
app.post('/api/ai-conversations', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { model, title } = req.body || {};
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/ai_conversations`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
      },
      body: JSON.stringify({ model: model || null, title: title || null }),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    const rows = await sbRes.json();
    res.json({ id: rows[0]?.id });
  } catch(e) {
    console.error('[ai-conversations POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// POST /api/ai-messages  →  insert one message row, return { id }
app.post('/api/ai-messages', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { conversation_id, seq, role, content, model, input_tokens, output_tokens, context_start_seq, tool_calls } = req.body || {};
  if (!conversation_id || seq == null || !role || !content) {
    return res.status(400).json({ error: 'conversation_id, seq, role, content requeridos' });
  }
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/ai_messages`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
      },
      body: JSON.stringify({ conversation_id, seq, role, content,
        model: model ?? null, input_tokens: input_tokens ?? null, output_tokens: output_tokens ?? null,
        context_start_seq: context_start_seq ?? null,
        tool_calls: tool_calls ?? null }),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    const rows = await sbRes.json();
    // Best-effort: increment message_count
    fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_ai_msg_count`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_id: conversation_id }),
    }).catch(() => {});
    res.json({ id: rows[0]?.id ?? null });
  } catch(e) {
    console.error('[ai-messages POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// PATCH /api/ai-messages/:id/star  →  toggle starred on a message
app.patch('/api/ai-messages/:id/star', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { starred } = req.body || {};
  if (typeof starred !== 'boolean') return res.status(400).json({ error: 'starred (boolean) requerido' });
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/ai_messages?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ starred }),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/ai-messages/starred  →  all starred messages with conversation context
app.get('/api/ai-messages/starred', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    // Fetch starred messages joined with conversation title + started_at
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_messages?starred=eq.true&select=id,conversation_id,seq,role,content,created_at,ai_conversations(title,started_at)&order=created_at.desc&limit=50`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' } }
    );
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    res.json(await sbRes.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/ai-conversations  →  list conversations (newest first)
app.get('/api/ai-conversations', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_conversations?select=id,started_at,model,title,message_count&order=started_at.desc&limit=${limit}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' } }
    );
    res.json(await sbRes.json());
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// DELETE /api/ai-conversations/:id  →  delete conversation + cascade messages
app.delete('/api/ai-conversations/:id', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id requerido' });
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_conversations?id=eq.${id}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal',
        },
      }
    );
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    res.json({ ok: true });
  } catch(e) {
    console.error('[ai-conversations DELETE]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/ai-conversations/:id/messages  →  all messages ordered by seq
app.get('/api/ai-conversations/:id/messages', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_messages?conversation_id=eq.${req.params.id}&order=seq.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' } }
    );
    res.json(await sbRes.json());
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── HABITS API ────────────────────────────────────────────────────────────────
// Pegar estos endpoints en server.js, antes del catch-all app.get('*', ...)
//
// Tablas Supabase necesarias (ver DOCS.md para el schema completo):
//   habit_daily_logs   — un registro por día (UNIQUE on log_date)
//   habit_oneshots     — una sola fila con todos los contadores del año
//   habit_weight_logs  — historial de registros de peso
// ─────────────────────────────────────────────────────────────────────────────

// GET  /api/habits/daily/:date  →  trae el log del día (o 204 si no existe)
app.get('/api/habits/daily/:date', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { date } = req.params;
  // Validate basic date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_daily_logs?log_date=eq.${date}&limit=1`;
    const sbRes = await fetch(supaUrl, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json',
      },
    });

    const data = await sbRes.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(204).end();   // día sin registro aún
    }
    res.json(data[0]);

  } catch (e) {
    console.error('[habits/daily GET]', e.message);
    res.status(502).json({ error: e.message });
  }
});


// POST /api/habits/daily  →  upsert del día completo
// Body: { log_date, trained, piano, deepwork, food, food_note }
app.post('/api/habits/daily', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { log_date, trained, piano, deepwork, food, food_note } = req.body || {};
  if (!log_date) return res.status(400).json({ error: 'log_date requerido' });

  const payload = {
    log_date,
    trained:    trained    ?? null,
    piano:      piano      ?? null,
    deepwork:   deepwork   ?? null,
    food:       food       ?? null,
    food_note:  food_note  ?? null,
    updated_at: new Date().toISOString(),
  };

  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_daily_logs`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    });

    const text = await sbRes.text();
    if (!sbRes.ok) {
      console.error('[habits/daily POST] supabase error:', text.slice(0, 300));
      return res.status(sbRes.status).json({ error: text });
    }
    res.json({ ok: true });

  } catch (e) {
    console.error('[habits/daily POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});


// GET  /api/habits/oneshots  →  trae los contadores anuales
app.get('/api/habits/oneshots', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const year = new Date().getFullYear();
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_oneshots?year=eq.${year}&limit=1`;
    const sbRes = await fetch(supaUrl, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json',
      },
    });

    const data = await sbRes.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(204).end();
    }
    res.json(data[0]);

  } catch (e) {
    console.error('[habits/oneshots GET]', e.message);
    res.status(502).json({ error: e.message });
  }
});


// POST /api/habits/oneshots  →  upsert de contadores anuales
// Body: { year?, presentations, feedbacks, recordings, pianoLessons,
//         trips, devTalks, pscReviews, groupPlans, dates2nd }
app.post('/api/habits/oneshots', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const year = req.body?.year ?? new Date().getFullYear();
  const allowed = [
    'presentations','feedbacks','recordings','piano_lessons',
    'trips','dev_talks','psc_reviews','group_plans','dates_2nd',
  ];

  const payload = { year, updated_at: new Date().toISOString() };
  allowed.forEach(k => {
    // Accept both camelCase and snake_case from frontend
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (req.body[k]     !== undefined) payload[k] = req.body[k];
    if (req.body[camel] !== undefined) payload[k] = req.body[camel];
  });

  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_oneshots`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    });

    const text = await sbRes.text();
    if (!sbRes.ok) {
      console.error('[habits/oneshots POST] supabase error:', text.slice(0, 300));
      return res.status(sbRes.status).json({ error: text });
    }
    res.json({ ok: true });

  } catch (e) {
    console.error('[habits/oneshots POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});


// POST /api/habits/weight  →  inserta un registro de peso
// Body: { weight_kg, recorded_date? }
app.post('/api/habits/weight', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { weight_kg, recorded_date } = req.body || {};
  if (!weight_kg || isNaN(parseFloat(weight_kg))) {
    return res.status(400).json({ error: 'weight_kg requerido' });
  }

  const payload = {
    weight_kg:     parseFloat(weight_kg),
    recorded_date: recorded_date || new Date().toISOString().slice(0, 10),
    created_at:    new Date().toISOString(),
  };

  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_weight_logs`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(payload),
    });

    const text = await sbRes.text();
    if (!sbRes.ok) {
      console.error('[habits/weight POST] supabase error:', text.slice(0, 300));
      return res.status(sbRes.status).json({ error: text });
    }
    res.json({ ok: true });

  } catch (e) {
    console.error('[habits/weight POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});



// ── WEB PUSH / NOTIFICATIONS ──────────────────────────────────────────────────

const webpush = require('web-push');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT    || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// GET /api/push/vapid-public-key  →  devuelve la clave pública VAPID al frontend
app.get('/api/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || '';
  if (!key) return res.status(500).json({ error: 'VAPID not configured' });
  res.json({ publicKey: key });
});

// POST /api/push/subscribe  →  guarda la suscripción del browser en Supabase
// Body: { endpoint, keys: { p256dh, auth } }
app.post('/api/push/subscribe', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint y keys requeridos' });
  }
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/push_subscriptions`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth, updated_at: new Date().toISOString() }),
    });
    if (!sbRes.ok) {
      const t = await sbRes.text();
      return res.status(sbRes.status).json({ error: t });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/push/unsubscribe  →  elimina la suscripción
app.post('/api/push/unsubscribe', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── WATER ─────────────────────────────────────────────────────────────────────

// GET /api/water/today  →  ml totales de hoy (SUM incluye transacciones negativas)
app.get('/api/water/today', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const today = new Date().toISOString().slice(0, 10);
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/water_logs?log_date=eq.${today}&select=amount_ml`;
    const sbRes = await fetch(supaUrl, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' },
    });
    const rows = await sbRes.json();
    const total = Array.isArray(rows) ? rows.reduce((s, r) => s + (r.amount_ml || 0), 0) : 0;
    res.json({ total_ml: total, date: today });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/water/log  →  registra una ingesta de agua
// Body: { amount_ml, source? ('manual'|'notification'), response? }
app.post('/api/water/log', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { amount_ml, source = 'manual', response } = req.body || {};
  const amountInt = parseInt(amount_ml);
  if (amount_ml === undefined || amount_ml === null || isNaN(amountInt) || amountInt === 0) {
    return res.status(400).json({ error: 'amount_ml requerido (puede ser negativo)' });
  }

  const today = new Date().toISOString().slice(0, 10);
  try {
    // Insert water log
    const supaUrl = `${SUPABASE_URL}/rest/v1/water_logs`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ log_date: today, amount_ml: amountInt, source }),
    });
    if (!sbRes.ok) {
      const t = await sbRes.text();
      return res.status(sbRes.status).json({ error: t });
    }

    // If from notification, update adaptive state (yes response)
    if (source === 'notification' && response === 'yes') {
      await updateWaterNotifConsecutive('yes');
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/water/respond  →  registra respuesta "no tomé" para lógica adaptativa
app.post('/api/water/respond', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { response, water_ml_at_time = 0 } = req.body || {};
  try {
    // Log the response
    const logUrl = `${SUPABASE_URL}/rest/v1/water_notif_responses`;
    await fetch(logUrl, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ response, water_ml_at_time }),
    });

    if (response === 'no') await updateWaterNotifConsecutive('no');

    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Helper: update consecutive counters in water_notif_state
async function updateWaterNotifConsecutive(response) {
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/water_notif_state?id=eq.1`;
    const stateRes = await fetch(supaUrl, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' },
    });
    const rows = await stateRes.json();
    const state = Array.isArray(rows) && rows.length > 0 ? rows[0] : {};

    let patch;
    if (response === 'yes') {
      patch = { consecutive_yes: (state.consecutive_yes || 0) + 1, consecutive_no: 0 };
    } else {
      patch = { consecutive_no: (state.consecutive_no || 0) + 1, consecutive_yes: 0 };
    }
    patch.updated_at = new Date().toISOString();

    // Recalculate interval
    const baseInterval = 90;
    if (patch.consecutive_no >= 2)  patch.interval_minutes = 60;
    else if (patch.consecutive_yes >= 3) patch.interval_minutes = 120;
    else patch.interval_minutes = baseInterval;

    await fetch(`${SUPABASE_URL}/rest/v1/water_notif_state?id=eq.1`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.warn('[water] consecutive update failed:', e.message);
  }
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Personal Hub corriendo en puerto ${PORT}`);
});

// ── JACKET API PROXY ────────────────────────────────────────────────────────────
// Pegar en server.js, junto al resto de los endpoints POST.
//
// La variable de entorno JACKET_API_URL ya tiene el valor por defecto abajo,
// pero podés sobreescribirla en Railway si el deploy del bot cambia de URL.
//
// Node 18+ tiene fetch nativo. Si tu Railway usa Node < 18, instalá node-fetch:
//   npm install node-fetch
// y agregá al tope de server.js:
//   const fetch = require('node-fetch');

const JACKET_API_URL = process.env.JACKET_API_URL
  || 'https://api-service-production-b8b1.up.railway.app/predecir';

app.post('/api/abrigo', async (req, res) => {
  try {
    const { lat, lon, lead } = req.body;

    if (lat === undefined || lon === undefined || lead === undefined) {
      return res.status(400).json({ error: 'Faltan campos: lat, lon, lead' });
    }

    const upstream = await fetch(JACKET_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, lead }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[/api/abrigo] upstream error:', upstream.status, errText);
      return res.status(502).json({ error: 'Error en la API de predicción' });
    }

    const data = await upstream.json();
    res.json(data);

  } catch (err) {
    console.error('[/api/abrigo]', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});