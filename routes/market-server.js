'use strict';

const express = require('express');
const router  = express.Router();

// ── yahoo-finance2 ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
} catch (e) {
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
    modules: ['summaryDetail', 'defaultKeyStatistics', 'price', 'financialData', 'calendarEvents', 'assetProfile'],
  });

  const sd = q.summaryDetail        || {};
  const ks = q.defaultKeyStatistics || {};
  const pr = q.price                || {};
  const fd = q.financialData        || {};
  const ce = q.calendarEvents       || {};
  const ap = q.assetProfile         || {};
  const n  = v => (v !== undefined && v !== null ? v : null);

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
    analystRating:      n(fd.recommendationMean),
    analystTarget:      n(fd.targetMeanPrice),
    numberOfAnalysts:   n(fd.numberOfAnalystOpinions),
    nextEarningsDate:   nextEarnings instanceof Date
      ? nextEarnings.toISOString().slice(0, 10)
      : typeof nextEarnings === 'string' ? nextEarnings.slice(0, 10) : null,
    sector:             ap.sector   || null,
    industry:           ap.industry || null,
  };
}

// ── Caches ────────────────────────────────────────────────────────────────────

let portfolioCache = null, portfolioCachedAt = 0, portfolioTickers = null;
let watchlistCache = null, watchlistCachedAt = 0;
let macroCache     = null, macroCachedAt     = 0;

// ── Macro ─────────────────────────────────────────────────────────────────────

const MACRO_TICKERS = {
  '^VIX':     { label: 'VIX (Fear Index)',      unit: 'pts' },
  '^TNX':     { label: 'US 10Y Treasury Yield', unit: '%'  },
  '^IRX':     { label: 'US 3M Treasury Yield',  unit: '%'  },
  'GBP=X':    { label: 'GBP/USD',               unit: 'USD per GBP' },
  'EURUSD=X': { label: 'EUR/USD',               unit: 'USD per EUR' },
  '^IXIC':    { label: 'Nasdaq Composite',       unit: 'pts' },
  '^FTSE':    { label: 'FTSE 100',               unit: 'pts' },
};

async function fetchMacro(yahooTicker) {
  if (!yf) throw new Error('yahoo-finance2 not loaded');

  const period1 = new Date();
  period1.setDate(period1.getDate() - 35);

  const result = await yf.chart(yahooTicker, { period1, interval: '1d' });
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

// ── Market status (NYSE / LSE open-closed, horarios traducidos a hora de Londres) ──
//
// No hardcodeamos offsets UTC ni rangos de meses para DST (a diferencia del viejo
// getMarketStatus del frontend). En cambio:
//   1. Calculamos el instante UTC exacto de apertura/cierre de cada sesión usando
//      Intl.DateTimeFormat para leer el offset real de cada timezone hoy (tzOffsetMinutes).
//      Esto absorbe el cambio de horario de verano de EEUU y UK automáticamente,
//      incluida la ventana de ~1-3 semanas donde están desfasados entre sí.
//   2. Ese mismo instante UTC se formatea en Europe/London para mostrarlo (formatLondonTime),
//      así Julián siempre ve el horario en su propia zona sin importar dónde esté.
//   3. Para el estado abierto/cerrado (el dot) consultamos `marketState` directo de Yahoo
//      sobre un índice de referencia de cada plaza, que contempla feriados de mercado
//      (Thanksgiving, Christmas Day, etc.) — el cálculo de horario por sí solo no los conoce.

const MARKET_STATUS_TTL = 60 * 1000; // 1 min — el estado (abierto/cerrado) debe estar fresco

const SESSION_HOURS = {
  nyse: { open: { h: 9, m: 30 }, close: { h: 16, m: 0  }, timeZone: 'America/New_York', quoteTicker: '^GSPC' },
  lse:  { open: { h: 8, m: 0  }, close: { h: 16, m: 30 }, timeZone: 'Europe/London',    quoteTicker: '^FTSE' },
};

let marketStatusCache = null, marketStatusCachedAt = 0;

// Offset (en minutos) de `timeZone` respecto a UTC, en el instante `date`.
function tzOffsetMinutes(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asIfUTC - date.getTime()) / 60000);
}

// Formatea un instante UTC como "HH:MM" hora de Londres.
function formatLondonTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

// Dado un horario "hh:mm" en la timezone local de la plaza (ej. 9:30 America/New_York),
// devuelve el instante UTC correspondiente a HOY. offsetMin ya refleja si esa plaza está
// en horario de verano o no en este momento, sin tablas de fechas hardcodeadas.
function sessionBoundaryUTC(timeZone, hh, mm) {
  const now = new Date();
  const offsetMin = tzOffsetMinutes(timeZone, now);
  const todayUTCMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUTCMidnight + (hh * 60 + mm - offsetMin) * 60000);
}

async function computeMarketStatus() {
  const results = {};
  await Promise.all(Object.entries(SESSION_HOURS).map(async ([key, cfg]) => {
    const openUTC  = sessionBoundaryUTC(cfg.timeZone, cfg.open.h,  cfg.open.m);
    const closeUTC = sessionBoundaryUTC(cfg.timeZone, cfg.close.h, cfg.close.m);

    let marketState = null, isOpen = null;
    try {
      const q = await yf.quote(cfg.quoteTicker);
      marketState = q?.marketState || null;
      isOpen = marketState === 'REGULAR';
    } catch (e) {
      console.warn(`[market-status] ${key}:`, e.message);
    }

    // Fallback si falla la consulta a Yahoo: derivar del horario calculado (sin feriados)
    if (isOpen === null) {
      const now = new Date();
      const dow = now.getUTCDay();
      isOpen = dow !== 0 && dow !== 6 && now >= openUTC && now < closeUTC;
    }

    results[key] = {
      openLondon:  formatLondonTime(openUTC),
      closeLondon: formatLondonTime(closeUTC),
      marketState,
      isOpen,
    };
  }));
  return results;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/market-data', async (req, res) => {
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

router.get('/market-status', async (req, res) => {
  if (marketStatusCache && (Date.now() - marketStatusCachedAt) < MARKET_STATUS_TTL) {
    return res.json({ data: marketStatusCache, cached: true, cachedAt: marketStatusCachedAt });
  }

  try {
    const data = await computeMarketStatus();
    marketStatusCache    = data;
    marketStatusCachedAt = Date.now();
    res.json({ data, cached: false, cachedAt: marketStatusCachedAt });
  } catch (e) {
    console.warn('[market-status] fetch error:', e.message);
    // Si hay cache vieja, mejor devolver eso que un error
    if (marketStatusCache) return res.json({ data: marketStatusCache, cached: true, cachedAt: marketStatusCachedAt, stale: true });
    res.status(500).json({ error: e.message });
  }
});

router.get('/macro-data', async (req, res) => {
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

router.get('/watchlist-data', async (req, res) => {
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

// ── Price History (relative performance / base-100 chart) ────────────────────

// window → { period1 offset in days, interval }
const PRICE_HISTORY_WINDOWS = {
  '1W': { days: 8,   interval: '1h'  },
  '1M': { days: 32,  interval: '90m' },
  '3M': { days: 95,  interval: '1d'  },
  '6M': { days: 185, interval: '1d'  },
  '1A': { days: 370, interval: '1d'  },
  'YTD': { ytd: true, interval: '1d' },
};

// Map internal tickers → Yahoo tickers (same logic used elsewhere in the app)
function toYahooTicker(ticker) {
  if (ticker === 'RSU_META') return 'META';
  if (ticker === 'BTC')      return 'BTC-USD';
  if (ticker === 'ADA')      return 'ADA-USD';
  return ticker;
}

// Small per-window cache: key = `${window}:${ticker}`, val = { data, cachedAt }
const priceHistoryCache = {};
const PRICE_HISTORY_TTL = 15 * 60 * 1000; // 15 min

router.get('/price-history', async (req, res) => {
  const win = (req.query.window || '1M').toUpperCase();
  const cfg = PRICE_HISTORY_WINDOWS[win];
  if (!cfg) return res.status(400).json({ error: `Unknown window: ${win}` });

  const requestedRaw = req.query.tickers
    ? req.query.tickers.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  if (!requestedRaw.length) return res.json({ data: {}, errors: {}, window: win });

  // Build period1
  let period1;
  if (cfg.ytd) {
    period1 = new Date(new Date().getFullYear(), 0, 1); // Jan 1 current year
  } else {
    period1 = new Date();
    period1.setDate(period1.getDate() - cfg.days);
  }

  const results = {}, errors = {};

  await Promise.allSettled(requestedRaw.map(async rawTicker => {
    const yticker = toYahooTicker(rawTicker);
    const cacheKey = `${win}:${yticker}`;
    const cached = priceHistoryCache[cacheKey];
    if (cached && (Date.now() - cached.cachedAt) < PRICE_HISTORY_TTL) {
      results[rawTicker] = cached.data;
      return;
    }

    try {
      const chart = await yf.chart(yticker, {
        period1,
        interval: cfg.interval,
        // includePrePost: false keeps cleaner data
      });
      const quotes = (chart?.quotes || []).filter(q => q.close != null);
      if (!quotes.length) { errors[rawTicker] = 'No data'; return; }

      // Normalise to base-100 at first point
      const base = quotes[0].close;
      const series = quotes.map(q => ({
        t: q.date instanceof Date ? q.date.getTime() : new Date(q.date).getTime(),
        v: Math.round((q.close / base) * 10000) / 100, // 4 decimals → 2dp
      }));

      priceHistoryCache[cacheKey] = { data: series, cachedAt: Date.now() };
      results[rawTicker] = series;
    } catch (e) {
      errors[rawTicker] = e.message;
      console.warn(`[price-history] ${yticker} (${win}):`, e.message);
    }
  }));

  res.json({ data: results, errors, window: win, interval: cfg.interval });
});

module.exports = {
  router,
  getPortfolioCache: () => ({ data: portfolioCache, tickers: portfolioTickers, cachedAt: portfolioCachedAt }),
  setPortfolioCache: (data, tickers) => {
    portfolioCache    = data;
    portfolioTickers  = tickers;
    portfolioCachedAt = Date.now();
  },
  getMacroCache:     () => macroCache,
  setMacroCache:     (data) => { macroCache = data; macroCachedAt = Date.now(); },
  fetchFundamentals,
  fetchMacro,
  MACRO_TICKERS,
  CACHE_TTL_MS,
};
