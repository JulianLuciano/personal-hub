'use strict';

const express = require('express');
const https   = require('https');
const router  = express.Router();

const { SUPABASE_URL, SUPABASE_KEY, isConfigured, headers, sb } = require('../lib/supabase-server');
const { getPortfolioCache, setPortfolioCache, getMacroCache, fetchFundamentals, CACHE_TTL_MS } = require('./market-server');

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
  {
    name: 'run_montecarlo_target',
    description: `Run an INVERSE Monte Carlo simulation: given a capital target in GBP, returns the distribution of how many months it takes to reach it.
Use when the user asks "when will I reach £X?", "how long until I have £X?", "¿cuándo llego a £X?", "¿en cuánto tiempo tengo £X?", or any question where the goal is a capital amount and the unknown is time.
Do NOT use for questions where the horizon is known — use run_montecarlo for those.
Returns p10/p25/p50/p75/p90 of months-to-target, plus probability of reaching target within common horizons (1y, 2y, 3y, 5y, 10y).
If p90 > max_horizon_months, reports that as "unlikely within N years".`,
    input_schema: {
      type: 'object',
      properties: {
        target_gbp: {
          type: 'number',
          description: 'Capital target in GBP. Required.',
        },
        max_horizon_months: {
          type: 'integer',
          minimum: 12,
          maximum: 240,
          description: 'Maximum months to simulate. Default: 180 (15 years). Increase only if target is very large.',
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
          description: 'Override net RSU value per vest in GBP.',
        },
        scenario: {
          type: 'string',
          enum: ['neutral', 'bull', 'bear'],
          description: 'neutral=historical (9% ret, 18% vol) | bull=optimistic (16%, 22%) | bear=conservative (3%, 25%). Default: neutral.',
        },
        initial_capital_gbp: {
          type: 'number',
          description: 'Starting capital in GBP. Overrides current portfolio value.',
        },
      },
      required: ['target_gbp'],
    },
  },
];

// ── Helpers compartidos entre los dos Monte Carlo ─────────────────────────────

function randn() {
  let u, v;
  do { u = Math.random(); } while (!u);
  do { v = Math.random(); } while (!v);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function fetchRsuPerVest() {
  let RSU_PER_VEST = 2100;
  try {
    const [rsuRows, priceRows, fxRows] = await Promise.all([
      sb('rsu_vests?select=vest_date,units,vested&order=vest_date.asc'),
      sb('price_snapshots?ticker=eq.META&order=captured_at.desc&limit=1&select=price_usd'),
      sb('portfolio_snapshots?select=fx_rate&order=captured_at.desc&limit=1'),
    ]);
    const metaUSD = (Array.isArray(priceRows) && priceRows[0]?.price_usd) ? parseFloat(priceRows[0].price_usd) : 600;
    const fxRate  = (Array.isArray(fxRows)    && fxRows[0]?.fx_rate)      ? parseFloat(fxRows[0].fx_rate)      : 0.79;

    if (Array.isArray(rsuRows) && rsuRows.length > 0) {
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
    console.warn('[montecarlo] RSU_PER_VEST fallback £2100:', e.message);
  }
  return RSU_PER_VEST;
}

async function fetchStartCapital() {
  let startInvested = 8000, startCash = 4000;
  try {
    const [positions, snapRows, priceRows] = await Promise.all([
      sb('positions?select=ticker,category,qty,avg_cost_usd,pricing_currency'),
      sb('portfolio_snapshots?select=fx_rate&order=captured_at.desc&limit=1'),
      sb('price_snapshots?select=ticker,price_usd&order=captured_at.desc&limit=50'),
    ]);

    const fxRate = (Array.isArray(snapRows) && snapRows[0]?.fx_rate)
      ? parseFloat(snapRows[0].fx_rate) : 0.79;

    const priceMap = {};
    if (Array.isArray(priceRows)) {
      priceRows.forEach(r => { if (!priceMap[r.ticker]) priceMap[r.ticker] = parseFloat(r.price_usd); });
    }

    if (Array.isArray(positions)) {
      let investedUSD = 0, cashUSD = 0;
      positions.forEach(p => {
        const qty = parseFloat(p.qty) || 0;
        if (qty <= 0) return;
        const priceUSD = priceMap[p.ticker] ?? parseFloat(p.avg_cost_usd) ?? 0;
        const valueUSD = priceUSD * qty;
        if (p.category === 'fiat') {
          cashUSD += p.pricing_currency === 'GBP' ? qty / fxRate : valueUSD;
        } else {
          investedUSD += valueUSD;
        }
      });
      startInvested = Math.round(investedUSD * fxRate);
      startCash     = Math.round(cashUSD     * fxRate);
    }
  } catch (e) {
    console.warn('[montecarlo] posiciones fallback:', e.message);
  }
  return { startInvested, startCash };
}

// ── Tool executors ────────────────────────────────────────────────────────────

async function executeQueryDb(input) {
  const { query_type, filters = {} } = input;
  const { ticker, from_date, to_date, vested_only } = filters;
  const limit = Math.min(filters.limit || 20, 200);

  let rows, description;

  switch (query_type) {
    case 'transactions_by_ticker': {
      if (!ticker) return { error: 'transactions_by_ticker requiere filters.ticker' };
      rows = await sb(`transactions?ticker=eq.${encodeURIComponent(ticker)}&order=date.desc&limit=${limit}&select=date,ticker,type,asset_class,qty,price_usd,amount_usd,amount_local,fx_rate_to_usd,broker,notes`);
      description = `Transacciones de ${ticker} (últimas ${limit})`;
      break;
    }
    case 'transactions_by_period': {
      let qs = `transactions?order=date.desc&limit=${limit}&select=date,ticker,type,asset_class,qty,price_usd,amount_usd,amount_local,fx_rate_to_usd,broker`;
      if (from_date) qs += `&date=gte.${from_date}`;
      if (to_date)   qs += `&date=lte.${to_date}`;
      rows = await sb(qs);
      description = `Transacciones ${from_date || ''}–${to_date || 'hoy'}`;
      break;
    }
    case 'transactions_all': {
      rows = await sb(`transactions?order=date.desc&limit=${limit}&select=date,ticker,type,asset_class,qty,price_usd,amount_usd,amount_local,fx_rate_to_usd,broker`);
      description = `Últimas ${limit} transacciones`;
      break;
    }
    case 'portfolio_history': {
      let qs = `portfolio_snapshots?order=captured_at.asc&limit=${limit}&select=captured_at,total_usd,total_gbp,fx_rate`;
      if (from_date) qs += `&captured_at=gte.${from_date}`;
      if (to_date)   qs += `&captured_at=lte.${to_date}T23:59:59Z`;
      rows = await sb(qs);
      description = `Historial del portfolio ${from_date || ''}–${to_date || 'hoy'}`;
      break;
    }
    case 'price_history': {
      if (!ticker) return { error: 'price_history requiere filters.ticker' };
      let qs = `price_snapshots?ticker=eq.${encodeURIComponent(ticker)}&order=captured_at.asc&limit=${limit}&select=ticker,price_usd,price_gbp,fx_rate,captured_at`;
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
    rsu_per_vest_override    = null,
    target_gbp               = null,
    scenario                 = 'neutral',
    initial_capital_gbp      = null,
  } = input;

  const SCENARIOS = { bear: { ret: 3, vol: 25 }, neutral: { ret: 9, vol: 18 }, bull: { ret: 16, vol: 22 } };
  const scen = SCENARIOS[scenario] ?? SCENARIOS.neutral;
  const totalMonths = (months != null) ? months : ((years ?? 5) * 12);
  const CASH_RET = 3, CASH_VOL = 1;
  const RSU_MONTHS   = new Set([1, 4, 7, 10]);
  const BONUS_MONTHS = new Set([3, 9]);

  const RSU_PER_VEST = (rsu_per_vest_override !== null && typeof rsu_per_vest_override === 'number')
    ? rsu_per_vest_override
    : await fetchRsuPerVest();

  let startInvested, startCash;
  if (initial_capital_gbp !== null) {
    startInvested = initial_capital_gbp;
    startCash     = 0;
  } else {
    ({ startInvested, startCash } = await fetchStartCapital());
  }

  const N_SIMULATIONS = 2000;
  const mr = scen.ret / 100 / 12;
  const mv = scen.vol / 100 / Math.sqrt(12);
  const cr = CASH_RET  / 100 / 12;
  const cv = CASH_VOL  / 100 / Math.sqrt(12);
  const M  = totalMonths;
  const nowMonth = new Date().getMonth();

  const GOALS = [
    { label: '£30k',  target: 30000,  months: 12 },
    { label: '£100k', target: 100000, months: 36 },
    { label: '£200k', target: 200000, months: 60 },
  ].filter(g => g.months <= M);

  const milestoneSnaps = {};
  GOALS.forEach(g => { milestoneSnaps[g.months] = new Float32Array(N_SIMULATIONS); });

  const finalValues = new Float32Array(N_SIMULATIONS);

  for (let s = 0; s < N_SIMULATIONS; s++) {
    let inv  = startInvested;
    let cash = startCash;
    for (let m = 1; m <= M; m++) {
      inv  *= 1 + mr + mv * randn();
      cash *= 1 + cr + cv * randn();
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

  const pct      = (arr, p) => { const i = Math.floor(arr.length * p / 100); return arr[Math.min(i, arr.length - 1)]; };
  const probAbove = (arr, target) => { let n = 0; for (let i = 0; i < arr.length; i++) { if (arr[i] >= target) n++; } return Math.round(n / arr.length * 100); };
  const fmt      = v => `£${Math.round(v).toLocaleString('en-GB')}`;

  const prob_target        = target_gbp ? probAbove(finalValues, target_gbp) : null;
  const goal_probabilities = GOALS.map(g => ({
    label:       g.label,
    at_months:   g.months,
    probability: `${probAbove(milestoneSnaps[g.months], g.target)}%`,
  }));

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
    target: target_gbp ? { target: fmt(target_gbp), probability: `${prob_target}%` } : null,
    goal_probabilities,
    simulations: N_SIMULATIONS,
  };
}

async function executeRunMontecarloTarget(input) {
  const {
    target_gbp,
    max_horizon_months       = 180,
    monthly_contribution_gbp = 950,
    annual_bonus_gbp         = 8000,
    include_rsu              = true,
    rsu_per_vest_override    = null,
    scenario                 = 'neutral',
    initial_capital_gbp      = null,
  } = input;

  if (!target_gbp || target_gbp <= 0) return { error: 'target_gbp es requerido y debe ser > 0' };

  const SCENARIOS = { bear: { ret: 3, vol: 25 }, neutral: { ret: 9, vol: 18 }, bull: { ret: 16, vol: 22 } };
  const scen = SCENARIOS[scenario] ?? SCENARIOS.neutral;
  const CASH_RET = 3, CASH_VOL = 1;
  const RSU_MONTHS   = new Set([1, 4, 7, 10]);
  const BONUS_MONTHS = new Set([3, 9]);
  const N_SIMULATIONS = 2000;
  const M = Math.min(max_horizon_months, 240);

  const RSU_PER_VEST = (rsu_per_vest_override !== null && typeof rsu_per_vest_override === 'number')
    ? rsu_per_vest_override
    : await fetchRsuPerVest();

  let startInvested, startCash;
  if (initial_capital_gbp !== null) {
    startInvested = initial_capital_gbp;
    startCash     = 0;
  } else {
    ({ startInvested, startCash } = await fetchStartCapital());
  }

  const mr = scen.ret / 100 / 12;
  const mv = scen.vol / 100 / Math.sqrt(12);
  const cr = CASH_RET  / 100 / 12;
  const cv = CASH_VOL  / 100 / Math.sqrt(12);
  const nowMonth = new Date().getMonth();

  const crossingMonths = new Array(N_SIMULATIONS);
  for (let s = 0; s < N_SIMULATIONS; s++) {
    let inv  = startInvested;
    let cash = startCash;
    let crossed = Infinity;
    for (let m = 1; m <= M; m++) {
      inv  *= 1 + mr + mv * randn();
      cash *= 1 + cr + cv * randn();
      const calMonth = (nowMonth + m) % 12;
      inv += monthly_contribution_gbp;
      if (BONUS_MONTHS.has(calMonth))               inv += annual_bonus_gbp / 2;
      if (include_rsu && RSU_MONTHS.has(calMonth))  inv += RSU_PER_VEST;
      if (inv + cash >= target_gbp) { crossed = m; break; }
    }
    crossingMonths[s] = crossed;
  }

  const reached     = crossingMonths.filter(m => m !== Infinity).sort((a, b) => a - b);
  const notReachedN = N_SIMULATIONS - reached.length;
  const pctReached  = Math.round(reached.length / N_SIMULATIONS * 100);

  const pct  = (arr, p) => { if (!arr.length) return null; const i = Math.floor(arr.length * p / 100); return arr[Math.min(i, arr.length - 1)]; };
  const fmtM = m => {
    if (m == null) return null;
    const y = Math.floor(m / 12), mo = m % 12;
    if (y === 0) return `${mo} meses`;
    if (mo === 0) return `${y} año${y !== 1 ? 's' : ''}`;
    return `${y} año${y !== 1 ? 's' : ''} y ${mo} mes${mo !== 1 ? 'es' : ''}`;
  };
  const fmt  = v => `£${Math.round(v).toLocaleString('en-GB')}`;

  const HORIZONS = [12, 24, 36, 60, 120];
  const prob_by_horizon = HORIZONS
    .filter(h => h <= M)
    .map(h => ({
      horizon:     fmtM(h),
      months:      h,
      probability: `${Math.round(crossingMonths.filter(m => m <= h).length / N_SIMULATIONS * 100)}%`,
    }));

  return {
    scenario,
    target:      fmt(target_gbp),
    pct_reached: `${pctReached}%`,
    note: notReachedN > 0
      ? `${notReachedN}/${N_SIMULATIONS} simulaciones no alcanzaron el target en ${fmtM(M)}`
      : `Todas las simulaciones alcanzan el target dentro de ${fmtM(M)}`,
    params: {
      start_total_gbp:          fmt(startInvested + startCash),
      monthly_contribution_gbp: fmt(monthly_contribution_gbp),
      annual_bonus_gbp:         fmt(annual_bonus_gbp),
      rsu_per_vest_gbp:         include_rsu ? fmt(RSU_PER_VEST) : 'no incluido',
      assumed_annual_return:    `${scen.ret}%`,
      assumed_annual_vol:       `${scen.vol}%`,
    },
    months_to_target: reached.length > 0 ? {
      p10:    fmtM(pct(reached, 10)),
      p25:    fmtM(pct(reached, 25)),
      median: fmtM(pct(reached, 50)),
      p75:    fmtM(pct(reached, 75)),
      p90:    fmtM(pct(reached, 90)),
    } : null,
    months_raw: reached.length > 0 ? {
      p10: pct(reached, 10), p25: pct(reached, 25), p50: pct(reached, 50),
      p75: pct(reached, 75), p90: pct(reached, 90),
    } : null,
    prob_by_horizon,
    simulations: N_SIMULATIONS,
  };
}

// ── Anthropic API caller ──────────────────────────────────────────────────────

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
    const delayMs = 2000 * attempt;
    console.warn(`[ai-chat] status ${result.status} — reintento ${attempt}/${MAX_RETRIES} en ${delayMs}ms`);
    await new Promise(r => setTimeout(r, delayMs));
  }
}

// ── OCR Transaction ───────────────────────────────────────────────────────────

router.post('/ocr-transaction', async (req, res) => {
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
    } catch (e) {
      console.error('[ocr] parse error:', text.slice(0, 300));
      res.status(422).json({ error: 'Parse error', raw: text.slice(0, 300) });
    }
  } catch (e) {
    console.error('[ocr] error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AI context helpers ────────────────────────────────────────────────────────

router.get('/ai-transactions-context', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const txRows = await sb('transactions?select=date,ticker,type,qty,price_usd,amount_usd,amount_local,broker&order=date.desc&limit=5');

    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
    const currStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const prevM = m === 1 ? 12 : m - 1, prevY = m === 1 ? y - 1 : y;
    const prevStart = `${prevY}-${String(prevM).padStart(2, '0')}-01`;

    const [currRows, prevRows] = await Promise.all([
      sb(`transactions?select=amount_usd,amount_local&date=gte.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`),
      sb(`transactions?select=amount_usd,amount_local&date=gte.${prevStart}&date=lt.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`),
    ]);

    const sumUSD = rows => Array.isArray(rows) ? rows.reduce((s, r) => s + (parseFloat(r.amount_usd)   || 0), 0) : 0;
    const sumGBP = rows => Array.isArray(rows) ? rows.reduce((s, r) => s + (parseFloat(r.amount_local) || 0), 0) : 0;

    const currLabel = `${y}-${String(m).padStart(2, '0')}`;
    const prevLabel = `${prevY}-${String(prevM).padStart(2, '0')}`;

    let tsv = 'RECENT_TRANSACTIONS (últimas 5)\ndate|ticker|type|qty|price_usd|amount_usd|amount_gbp|broker\n';
    if (Array.isArray(txRows)) {
      txRows.forEach(r => {
        tsv += `${r.date}|${r.ticker}|${r.type}|${r.qty}|${r.price_usd ?? ''}|${r.amount_usd ?? ''}|${r.amount_local ?? ''}|${r.broker ?? ''}\n`;
      });
    }
    tsv += `\nMONTH_INVESTED\n`;
    tsv += `${currLabel} (corriente): $${Math.round(sumUSD(currRows)).toLocaleString()} USD / £${Math.round(sumGBP(currRows)).toLocaleString()} GBP\n`;
    tsv += `${prevLabel} (anterior):  $${Math.round(sumUSD(prevRows)).toLocaleString()} USD / £${Math.round(sumGBP(prevRows)).toLocaleString()} GBP`;

    res.json({ tsv: tsv.trim() });
  } catch (e) {
    console.error('[ai-transactions-context]', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.get('/ai-correlation-context', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const [corrRows, positions, priceRows] = await Promise.all([
      sb('correlation_matrix?period_days=eq.90&select=ticker_a,ticker_b,correlation&limit=500'),
      sb('positions?select=ticker,qty,category,pricing_currency&order=ticker.asc'),
      sb('price_snapshots?select=ticker,price_usd&order=captured_at.desc&limit=50'),
    ]);

    if (!Array.isArray(corrRows) || !Array.isArray(positions)) return res.json({ tsv: null });

    const priceMap = {};
    if (Array.isArray(priceRows)) {
      priceRows.forEach(r => { if (!priceMap[r.ticker]) priceMap[r.ticker] = parseFloat(r.price_usd) || 0; });
    }

    const EXCLUDED = new Set(['RENT_DEPOSIT', 'EMERGENCY_FUND', 'GBP_LIQUID']);
    const portfolioAssets = positions.filter(p =>
      p.category !== 'fiat' && !EXCLUDED.has(p.ticker) &&
      (priceMap[p.ticker] || 0) * (parseFloat(p.qty) || 0) > 0.5
    );

    if (portfolioAssets.length < 2) return res.json({ tsv: null });

    const values   = portfolioAssets.map(p => (priceMap[p.ticker] || 0) * (parseFloat(p.qty) || 0));
    const totalUSD = values.reduce((s, v) => s + v, 0);
    if (totalUSD === 0) return res.json({ tsv: null });

    const weights = {};
    portfolioAssets.forEach((p, i) => { weights[p.ticker] = values[i] / totalUSD; });

    const dispT  = t => t.replace('RSU_META', 'META').replace('.L', '');
    const corrMap = {};
    corrRows.forEach(r => { corrMap[`${r.ticker_a}|${r.ticker_b}`] = r.correlation; });
    const getCorr = (a, b) => corrMap[`${a}|${b}`] ?? corrMap[`${b}|${a}`] ?? null;

    const tickers = portfolioAssets.map(p => p.ticker);

    const corrVsSpy  = [];
    tickers.forEach(t => { const c = getCorr(t, 'SPY'); if (c !== null) corrVsSpy.push(`${dispT(t)}: ${c.toFixed(2)}`); });

    const corrVsPort = [];
    tickers.forEach(ti => {
      let ws = 0, wt = 0;
      tickers.forEach(tj => { const c = ti === tj ? 1.0 : getCorr(ti, tj); if (c !== null) { ws += weights[tj] * c; wt += weights[tj]; } });
      if (wt > 0.5) corrVsPort.push(`${dispT(ti)}: ${(ws / wt).toFixed(2)}`);
    });

    const highPairs = [];
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const c = getCorr(tickers[i], tickers[j]);
        if (c !== null && Math.abs(c) >= 0.7) highPairs.push(`${dispT(tickers[i])}-${dispT(tickers[j])}: ${c.toFixed(2)}`);
      }
    }

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

router.get('/briefing-context', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  const fU  = v => '$' + Math.round(v).toLocaleString('en-US');
  const fG  = v => '£' + Math.round(v).toLocaleString('en-US');
  const sgn = (v, decimals = 2) => (v >= 0 ? '+' : '') + Number(v).toFixed(decimals) + '%';

  try {
    const [positions, snapshots, txRows] = await Promise.all([
      sb('positions?select=ticker,qty,avg_cost_usd,initial_investment_usd,initial_investment_gbp,category,pricing_currency,currency&order=ticker.asc'),
      sb('portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate,breakdown&order=captured_at.desc&limit=300'),
      sb('transactions?select=date,ticker,type,qty,price_usd,amount_usd,amount_local,broker&order=date.desc&limit=5'),
    ]);

    if (!Array.isArray(positions) || !Array.isArray(snapshots)) {
      return res.status(502).json({ error: 'Failed to fetch portfolio data' });
    }

    const latestSnap = snapshots[0] || {};
    const fxRate     = latestSnap.fx_rate || 0.79;
    const totalUSD   = latestSnap.total_usd || 0;
    const totalGBP   = latestSnap.total_gbp || (totalUSD * fxRate);
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

    const investedPositions = positions.filter(p => p.category !== 'fiat' && parseFloat(p.qty) > 0);
    const tickers = investedPositions.map(p => p.ticker === 'RSU_META' ? 'META' : p.ticker).filter(Boolean);

    let marketData = {};
    if (tickers.length > 0 && fetchFundamentals) {
      const { data: cachedData, tickers: cachedTickers, cachedAt } = getPortfolioCache();
      const cacheValid = cachedData && cachedTickers &&
        tickers.every(t => cachedTickers.includes(t)) &&
        (Date.now() - cachedAt) < CACHE_TTL_MS;

      if (cacheValid) {
        marketData = cachedData;
        console.log('[briefing-context] using portfolioCache for market data');
      } else {
        console.log('[briefing-context] fetching fresh fundamentals for', tickers.length, 'tickers');
        const results = {};
        await Promise.allSettled(tickers.map(async t => {
          try { results[t] = await fetchFundamentals(t); }
          catch (e) { console.warn('[briefing-context] fundamentals failed for', t, e.message); }
        }));
        marketData = results;
        if (Object.keys(results).length > 0) setPortfolioCache(results, tickers);
      }
    }

    const macroCache = getMacroCache();
    let macroSection = '';
    if (macroCache) {
      const f2   = v => v != null ? Number(v).toFixed(2) : '—';
      const sgnM = v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
      macroSection = 'MACRO\nticker|label|value|unit|7d|30d|trend\n';
      Object.entries(macroCache).forEach(([ticker, d]) => {
        if (!d || d.current == null) return;
        macroSection += `${ticker}|${d.label}|${f2(d.current)}|${d.unit}|${sgnM(d.chg7d)}|${sgnM(d.chg30d)}|${d.trend}\n`;
      });
    }

    let posSection = 'POSITIONS\nticker|category|value_usd|value_gbp|weight%|invested_usd|invested_gbp|pnl_usd%|pnl_gbp%|day%\n';
    let totalInvUSD = 0, totalInvGBP = 0, totalValUSD = 0;

    investedPositions.forEach(p => {
      const yticker   = p.ticker === 'RSU_META' ? 'META' : p.ticker;
      const md        = marketData[yticker] || {};
      const price     = md.regularMarketPrice || parseFloat(p.avg_cost_usd) || 0;
      const qty       = parseFloat(p.qty) || 0;
      const isGBP     = p.pricing_currency === 'GBP';
      const valueUSD  = isGBP ? price * qty / fxRate : price * qty;
      const valueGBP  = valueUSD * fxRate;
      const invUSD    = parseFloat(p.initial_investment_usd) || 0;
      const invGBP    = parseFloat(p.initial_investment_gbp) || invUSD * fxRate;
      const pnlUSD    = invUSD > 0 ? ((valueUSD - invUSD) / invUSD * 100) : null;
      const pnlGBP    = invGBP > 0 ? ((valueGBP - invGBP) / invGBP * 100) : null;
      const dayPctPos = md.regularMarketChangePercent != null ? md.regularMarketChangePercent * 100 : null;
      totalValUSD += valueUSD;
      totalInvUSD += invUSD;
      totalInvGBP += invGBP;
      posSection += [p.ticker, p.category, fU(valueUSD), fG(valueGBP), '', fU(invUSD), fG(invGBP),
        pnlUSD != null ? sgn(pnlUSD) : '', pnlGBP != null ? sgn(pnlGBP) : '',
        dayPctPos != null ? sgn(dayPctPos) : ''].join('|') + '\n';
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

    const totalPnlUSD = totalValUSD - totalInvUSD;
    const totalPnlGBP = totalValUSD * fxRate - totalInvGBP;
    const totalPnlPct = totalInvUSD > 0 ? (totalPnlUSD / totalInvUSD * 100) : 0;

    const cashPositions = positions.filter(p => p.category === 'fiat');
    let cashSection = 'CASH\nticker|value_gbp\n';
    cashPositions.forEach(p => { cashSection += `${p.ticker}|${fG(parseFloat(p.qty) || 0)}\n`; });

    let txSection = 'RECENT_TRANSACTIONS (últimas 5)\ndate|ticker|type|qty|price_usd|amount_usd|amount_gbp|broker\n';
    if (Array.isArray(txRows)) {
      txRows.forEach(r => {
        txSection += `${r.date}|${r.ticker}|${r.type}|${r.qty}|${r.price_usd ?? ''}|${r.amount_usd ?? ''}|${r.amount_local ?? ''}|${r.broker ?? ''}\n`;
      });
    }

    const now2 = new Date();
    const y = now2.getUTCFullYear(), mo = now2.getUTCMonth() + 1;
    const currStart = `${y}-${String(mo).padStart(2, '0')}-01`;
    const prevMo = mo === 1 ? 12 : mo - 1, prevY = mo === 1 ? y - 1 : y;
    const prevStart = `${prevY}-${String(prevMo).padStart(2, '0')}-01`;
    const [cmRows, pmRows] = await Promise.all([
      sb(`transactions?select=amount_usd,amount_local&date=gte.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`),
      sb(`transactions?select=amount_usd,amount_local&date=gte.${prevStart}&date=lt.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`),
    ]);
    const sumF = (rows, field) => Array.isArray(rows) ? rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0) : 0;
    txSection += `\nMONTH_INVESTED\n`;
    txSection += `${y}-${String(mo).padStart(2, '0')} (corriente): ${fU(sumF(cmRows, 'amount_usd'))} / ${fG(sumF(cmRows, 'amount_local'))}\n`;
    txSection += `${prevY}-${String(prevMo).padStart(2, '0')} (anterior): ${fU(sumF(pmRows, 'amount_usd'))} / ${fG(sumF(pmRows, 'amount_local'))}`;

    const today = new Date().toLocaleDateString('es-AR', {
      timeZone: 'Europe/London', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const portfolioSummary =
      `PORTFOLIO\n` +
      `total: ${fU(totalUSD)} / ${fG(totalGBP)}\n` +
      `fx: 1 GBP = ${(1 / fxRate).toFixed(4)} USD\n` +
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
      portfolioSummary + '\n\n' + posSection + '\n' + cashSection + '\n' + txSection + '\n\n' +
      (macroSection ? macroSection : '');

    res.json({ systemPrompt });
  } catch (e) {
    console.error('[briefing-context]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Token diagnostics ─────────────────────────────────────────────────────────

router.get('/token-diag', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'no key' });

  async function probe(withTools) {
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      system: 'x',
      messages: [{ role: 'user', content: 'x' }],
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

// ── AI Chat — Agentic loop (SSE) ──────────────────────────────────────────────

router.post('/ai-chat', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  const { model, max_tokens = 3000, system, messages } = req.body;
  const MAX_TOOL_ITERATIONS = 5;

  const userMsg = messages?.findLast?.(m => m.role === 'user')?.content;
  console.log(`[ai-chat] ← request | model: ${model} | system: ${system?.length} chars | messages: ${messages?.length}`);
  console.log(`[ai-chat] ← user_msg: ${String(userMsg).slice(0, 200)}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };

  const toolCallsLog = [];
  let loopMessages   = [...messages];
  let iterations     = 0;

  try {
    // Fase 1: tool loop (non-streaming)
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
        send({ type: 'error', message: `Anthropic ${raw.status}` });
        return res.end();
      }

      const response = JSON.parse(raw.body);
      if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') break;

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      loopMessages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        const { id, name, input } = toolBlock;
        const startTime = Date.now();
        console.log(`[ai-chat] ejecutando tool: ${name}`, JSON.stringify(input));

        let result;
        try {
          if      (name === 'query_db')             result = await executeQueryDb(input);
          else if (name === 'run_montecarlo')        result = await executeRunMontecarlo(input);
          else if (name === 'run_montecarlo_target') result = await executeRunMontecarloTarget(input);
          else                                       result = { error: `Tool desconocida: ${name}` };
        } catch (toolErr) {
          console.error(`[ai-chat] tool ${name} error:`, toolErr.message);
          result = { error: toolErr.message };
        }

        const elapsed = Date.now() - startTime;
        if (result?.error) {
          console.error(`[ai-chat] tool ${name} ERROR (${elapsed}ms):`, result.error);
        } else {
          console.log(`[ai-chat] tool ${name} OK (${elapsed}ms) | rows: ${result?.row_count ?? '—'}`);
        }

        toolCallsLog.push({ tool: name, input, elapsed_ms: elapsed, row_count: result?.row_count ?? null, error: result?.error ?? null });
        toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) });
      }

      loopMessages.push({ role: 'user', content: toolResults });
    }

    if (toolCallsLog.length > 0) {
      send({ type: 'tool_log', log: toolCallsLog });
      console.log(`[ai-chat] tools usadas: ${toolCallsLog.map(t => t.tool).join(', ')} | iteraciones: ${iterations}`);
    }

    // Fase 2: stream de la respuesta final
    const streamReqBody = JSON.stringify({
      model, max_tokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: loopMessages,
      tools: AI_TOOLS,
      stream: true,
    });

    await new Promise((resolve, reject) => {
      const streamReq = https.request({
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':      'application/json',
          'Content-Length':    Buffer.byteLength(streamReqBody),
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta':    'prompt-caching-2024-07-31',
        },
      }, (streamRes) => {
        let buffer = '';
        let inputTokens = null, outputTokens = null;

        streamRes.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                send({ type: 'delta', text: evt.delta.text });
              } else if (evt.type === 'message_start' && evt.message?.usage) {
                inputTokens  = evt.message.usage.input_tokens  ?? null;
                outputTokens = evt.message.usage.output_tokens ?? null;
              } else if (evt.type === 'message_delta' && evt.usage) {
                outputTokens = evt.usage.output_tokens ?? outputTokens;
              } else if (evt.type === 'message_stop') {
                const cacheHit = evt.message?.usage?.cache_read_input_tokens ?? 0;
                console.log(`[ai-chat] stream done | in: ${inputTokens} out: ${outputTokens}${cacheHit > 0 ? ` cache_read: ${cacheHit}` : ''}`);
                send({ type: 'done', usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
              }
            } catch (_) {}
          }
        });

        streamRes.on('end', () => {
          if (buffer.trim().startsWith('data: ')) {
            try {
              const evt = JSON.parse(buffer.slice(6).trim());
              if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                send({ type: 'delta', text: evt.delta.text });
              }
            } catch (_) {}
          }
          resolve();
        });

        streamRes.on('error', reject);
      });

      streamReq.on('error', reject);
      streamReq.setTimeout(90000, () => { streamReq.destroy(); reject(new Error('Stream timeout 90s')); });
      streamReq.write(streamReqBody);
      streamReq.end();
    });

    res.end();

  } catch (e) {
    console.error('[ai-chat] error:', e.message);
    send({ type: 'error', message: e.message });
    res.end();
  }
});

// ── AI Chat History ───────────────────────────────────────────────────────────

router.post('/ai-conversations', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { model, title } = req.body || {};
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/ai_conversations`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify({ model: model || null, title: title || null }),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    const rows = await sbRes.json();
    res.json({ id: rows[0]?.id });
  } catch (e) {
    console.error('[ai-conversations POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.post('/ai-messages', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { conversation_id, seq, role, content, model, input_tokens, output_tokens, context_start_seq, tool_calls } = req.body || {};
  if (!conversation_id || seq == null || !role || !content) {
    return res.status(400).json({ error: 'conversation_id, seq, role, content requeridos' });
  }
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/ai_messages`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify({ conversation_id, seq, role, content,
        model: model ?? null, input_tokens: input_tokens ?? null, output_tokens: output_tokens ?? null,
        context_start_seq: context_start_seq ?? null, tool_calls: tool_calls ?? null }),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    const rows = await sbRes.json();
    // Best-effort: increment message_count
    fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_ai_msg_count`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ conv_id: conversation_id }),
    }).catch(() => {});
    res.json({ id: rows[0]?.id ?? null });
  } catch (e) {
    console.error('[ai-messages POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.patch('/ai-messages/:id/star', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { starred } = req.body || {};
  if (typeof starred !== 'boolean') return res.status(400).json({ error: 'starred (boolean) requerido' });
  try {
    await sb(`ai_messages?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ starred }),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/ai-messages/starred', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const rows = await sb('ai_messages?starred=eq.true&select=id,conversation_id,seq,role,content,created_at,ai_conversations(title,started_at)&order=created_at.desc&limit=50');
    res.json(rows);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/ai-conversations/search', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    const [msgRows, titleRows] = await Promise.all([
      sb(`ai_messages?content=ilike.*${encodeURIComponent(q)}*&select=conversation_id&limit=200`),
      sb(`ai_conversations?title=ilike.*${encodeURIComponent(q)}*&select=id&limit=50`),
    ]);

    const ids = new Set();
    if (Array.isArray(msgRows))   msgRows.forEach(r => ids.add(r.conversation_id));
    if (Array.isArray(titleRows)) titleRows.forEach(r => ids.add(r.id));
    if (ids.size === 0) return res.json([]);

    const idList = [...ids].slice(0, 50).map(id => `"${id}"`).join(',');
    const rows = await sb(`ai_conversations?id=in.(${idList})&select=id,started_at,model,title,message_count&order=started_at.desc`);
    res.json(rows);
  } catch (e) {
    console.error('[ai-conversations/search]', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.get('/ai-conversations', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  try {
    const rows = await sb(`ai_conversations?select=id,started_at,model,title,message_count&order=started_at.desc&limit=${limit}`);
    res.json(rows);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.delete('/ai-conversations/:id', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id requerido' });
  try {
    await sb(`ai_conversations?id=eq.${id}`, {
      method: 'DELETE',
      headers: { 'Prefer': 'return=minimal' },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[ai-conversations DELETE]', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.get('/ai-conversations/:id/messages', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const rows = await sb(`ai_messages?conversation_id=eq.${req.params.id}&order=seq.asc`);
    res.json(rows);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
