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
    anthropicKey: process.env.ANTHROPIC_API_KEY || ''
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
// Recibe una imagen base64, la manda a Claude Vision, devuelve JSON con campos
// pre-rellenados para el formulario de transactions.
// Body: { image: "<base64>", mediaType: "image/jpeg" | "image/png" }
app.post('/api/ocr-transaction', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, mediaType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image requerida (base64)' });

  const prompt = `You are extracting financial transaction data from a broker screenshot.

BROKERS YOU WILL SEE:
1. Trading212 (dark UI) — two variants:
   a. USD-priced stock (e.g. SPY, MELI, NU, BRK.B, MSFT, ARKK.L, NDIA.L):
      - Header: "Market Buy {qty} {ticker}" and "-£{amount}"
      - FILLED QUANTITY: "{qty} {ticker}"
      - FILL PRICE: "1 {ticker} = ${price_usd}"
      - EXCHANGE RATE: "£1 = ${fx_rate}" (this is USD per GBP = fx_rate_to_usd)
      - FX FEE: £{fee}
      - TOTAL: £{amount_local}
      - asset_class: "stock", broker: "Trading212", exchange: infer from ticker
   b. GBP-priced stock (e.g. VWRP, VWRP.L):
      - Header: "Market Buy {qty} {ticker}" and "-£{amount}"
      - FILL PRICE: "1 {ticker} = £{price_gbp}" (NO exchange rate, NO FX fee)
      - TOTAL: £{amount_local}
      - pricing_currency: "GBP", asset_class: "stock", broker: "Trading212", exchange: "LSE"
      - fee_local: 0

2. Kraken (dark UI, Spanish language):
   - Header: "BTC comprados: £{amount}" (or other crypto)
   - Cantidad: {qty} BTC
   - Precio: {price_gbp} GBP  
   - Comisión: {fee} GBP  ← this is fee_local; amount_local = total - fee
   - Total: {total} GBP and ≈${total_usd}
   - Fecha: {date}
   - asset_class: "cripto", broker: "Kraken", exchange: null
   - IMPORTANT: amount_local = total_gbp - fee_local (e.g. £100 total - £0.99 fee = £99.01)

3. Schwab (not seen yet — if you see it, extract what you can)

TICKER MAPPING (broker display name → your DB ticker):
- SPY5 → SPY
- VWRP → VWRP.L
- ARKK → ARKK.L  
- NDIA → NDIA.L
- BTC → BTC
- ETH → ETH
- Keep others as-is (MELI, NU, MSFT, BRK.B, META, etc.)

DATE FORMAT: convert to YYYY-MM-DD. Examples:
- "06 Mar 2026" → "2026-03-06"
- "1 mar 2026" → "2026-03-01"

Respond ONLY with a valid JSON object, no markdown, no explanation:
{
  "ticker": string,
  "name": string or null,
  "type": "BUY" | "SELL" | "RSU_VEST",
  "asset_class": "stock" | "cripto" | "rsu" | "fiat",
  "date": "YYYY-MM-DD",
  "qty": number,
  "price_usd": number or null,
  "price_local": number or null,
  "amount_usd": number or null,
  "amount_local": number,
  "fee_local": number,
  "fx_rate_to_usd": number or null,
  "pricing_currency": "USD" | "GBP",
  "broker": string,
  "exchange": string or null,
  "confidence": "high" | "medium" | "low",
  "notes": string or null
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type:   'image',
              source: {
                type:       'base64',
                media_type: mediaType || 'image/jpeg',
                data:       image,
              },
            },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[ocr] Anthropic error status:', response.status, err.slice(0, 400));
      return res.status(502).json({ error: `Anthropic ${response.status}: ${err.slice(0, 200)}` });
    }

    const data  = await response.json();
    const text  = data.content?.[0]?.text || '';

    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      res.json({ ok: true, transaction: parsed });
    } catch(e) {
      console.error('[ocr] JSON parse error, raw:', text.slice(0, 300));
      res.status(422).json({ error: 'No se pudo parsear respuesta de Claude', raw: text.slice(0, 300) });
    }

  } catch(e) {
    console.error('[ocr] fetch error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Personal Hub corriendo en puerto ${PORT}`);
});
