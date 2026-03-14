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

// ── AI Chat Proxy ─────────────────────────────────────────────────────────────
// Relay del chat AI — evita llamadas directas desde el browser a Anthropic.
// Anthropic bloquea llamadas browser-side aunque la key tenga créditos.
app.post('/api/ai-chat', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const bodyStr = JSON.stringify(req.body);
  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'Content-Length':  Buffer.byteLength(bodyStr),
      'x-api-key':       anthropicKey,
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
      reqHttp.setTimeout(60000, () => { reqHttp.destroy(); reject(new Error('Timeout 60s')); });
      reqHttp.write(bodyStr);
      reqHttp.end();
    });

    console.log('[ai-chat] Anthropic status:', result.status);
    res.status(result.status).send(result.body);
  } catch(e) {
    console.error('[ai-chat] error:', e.message);
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


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Personal Hub corriendo en puerto ${PORT}`);
});
