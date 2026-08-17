'use strict';

const express = require('express');
const https   = require('https');
const router  = express.Router();

const { SUPABASE_URL, SUPABASE_KEY, isConfigured, headers, sb } = require('../lib/supabase-server');
const { getPortfolioCache, setPortfolioCache, getMacroCache, setMacroCache, fetchFundamentals, fetchMacro, MACRO_TICKERS, CACHE_TTL_MS } = require('./market-server');

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
    // 90s se quedaba corto: esta llamada es NO-streaming, así que no llega
    // ningún byte hasta que Anthropic termina de generar la respuesta entera.
    // Con Opus 5 a effort alto y preguntas largas/complejas, el modelo puede
    // tardar bastante más de 90s en terminar de pensar antes de devolver nada.
    req.setTimeout(240000, () => { req.destroy(); reject(new Error('Timeout 240s')); });
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

// ── Versión streaming de la llamada a Anthropic, usada en Fase 1 del loop
// agentic (ver /api/ai-chat más abajo). A diferencia de _callAnthropicOnce
// (no-streaming), acá Anthropic manda eventos SSE — incluyendo "ping"
// periódicos mientras genera — así que el socket nunca queda inactivo de
// verdad mientras el modelo está pensando. Esto evita depender de adivinar
// un número de timeout: mientras haya actividad real (aunque sea solo
// pings), el timeout de Node no dispara.
// Reconstruye el mismo shape que devolvería la API no-streaming
// ({ stop_reason, content, usage }) para no tener que tocar la lógica del
// loop de tools en /api/ai-chat.
function _callAnthropicStreamOnce(anthropicKey, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ ...body, stream: true });
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
      if (res.statusCode !== 200) {
        // Las respuestas de error de Anthropic NO son SSE, son un JSON plano.
        let errBody = '';
        res.on('data', chunk => { errBody += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: errBody }));
        return;
      }

      let buffer   = '';
      const blocks = []; // index -> { type, text, inputStr, id, name }
      let stopReason = null;
      const usage = { input_tokens: null, output_tokens: null };

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_start') {
              blocks[evt.index] = {
                type: evt.content_block.type,
                id:   evt.content_block.id,
                name: evt.content_block.name,
                text: '', inputStr: '', thinking: '', signature: '',
              };
            } else if (evt.type === 'content_block_delta') {
              const b = blocks[evt.index];
              if (!b) continue;
              if (evt.delta.type === 'text_delta')            b.text      += evt.delta.text;
              else if (evt.delta.type === 'input_json_delta') b.inputStr  += evt.delta.partial_json || '';
              else if (evt.delta.type === 'thinking_delta')   b.thinking  += evt.delta.thinking || '';
              else if (evt.delta.type === 'signature_delta')  b.signature += evt.delta.signature || '';
              // Se captura el thinking completo + signature (no solo un
              // preview) porque si el modelo hace thinking + tool_use en el
              // mismo turno, Anthropic espera el bloque de thinking íntegro
              // al reenviar el historial en la siguiente vuelta del loop —
              // mandar uno incompleto puede tirar 400.
            } else if (evt.type === 'message_start' && evt.message?.usage) {
              usage.input_tokens = evt.message.usage.input_tokens ?? null;
            } else if (evt.type === 'message_delta') {
              if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
              if (evt.usage) usage.output_tokens = evt.usage.output_tokens ?? usage.output_tokens;
            }
          } catch (_) {}
        }
      });

      res.on('end', () => {
        const content = blocks.filter(Boolean).map(b => {
          if (b.type === 'tool_use') {
            let input = {};
            try { input = JSON.parse(b.inputStr || '{}'); } catch (_) { /* input parcial/roto, se ejecuta con {} */ }
            return { type: 'tool_use', id: b.id, name: b.name, input };
          }
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
          return { type: b.type };
        });
        resolve({ status: 200, body: JSON.stringify({ stop_reason: stopReason, content, usage }) });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    // Igual se deja un timeout de red genuino (conexión colgada del todo,
    // sin ningún byte ni siquiera un ping) — pero con streaming esto ya no
    // debería dispararse por "el modelo está pensando mucho", solo por una
    // falla de red real.
    req.setTimeout(240000, () => { req.destroy(); reject(new Error('Timeout 240s')); });
    req.write(bodyStr);
    req.end();
  });
}

async function callAnthropicStreaming(anthropicKey, body) {
  const RETRYABLE = new Set([429, 529]);
  const MAX_RETRIES = 2;
  let attempt = 0;
  while (true) {
    const result = await _callAnthropicStreamOnce(anthropicKey, body);
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
    model: 'claude-sonnet-5',
    max_tokens: 512,
    output_config: { effort: 'low' },
    thinking: { type: 'disabled' },
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
    // Targeted snapshot queries: one anchor per period fetched directly.
    // Day anchor: last snapshot of YESTERDAY (London date), not a fixed 20h offset.
    // Fixes the bug where "now - 20h" lands on today's early-morning snapshot
    // (post-open price) instead of yesterday's close.
    const now0 = new Date();
    const iso  = d => d.toISOString();

    // Compute London offset dynamically (GMT=0, BST=+1)
    const londonOffset = (() => {
      const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' })
        .formatToParts(now0).find(p => p.type === 'timeZoneName').value;
      return s === 'GMT+1' ? 60 : 0;
    })();
    const londonNow   = new Date(now0.getTime() + londonOffset * 60000);
    const londonToday = londonNow.toISOString().slice(0, 10);
    // Anchor = midnight London today = end of yesterday
    const tDayAnchor  = new Date(londonToday + 'T00:00:00.000Z').toISOString();

    const t7d  = iso(new Date(now0 - 6  * 86400000));
    const t30d = iso(new Date(now0 - 29 * 86400000));

    const [positions, latestSnaps, snaps24h, snaps7d, snaps30d, txRows, cfRows] = await Promise.all([
      sb('positions?select=ticker,qty,avg_cost_usd,avg_cost_gbp,initial_investment_usd,initial_investment_gbp,net_invested_usd,net_invested_gbp,managed_by,category,pricing_currency,currency&order=ticker.asc'),
      sb('portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate&order=captured_at.desc&limit=1'),
      sb(`portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate&captured_at=lte.${tDayAnchor}&order=captured_at.desc&limit=1`),
      sb(`portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate&captured_at=lte.${t7d}&order=captured_at.desc&limit=1`),
      sb(`portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate&captured_at=lte.${t30d}&order=captured_at.desc&limit=1`),
      sb('transactions?select=date,ticker,type,qty,price_usd,amount_usd,amount_local,broker&order=date.desc&limit=5'),
      sb(`transactions?select=type,amount_usd&date=eq.${londonToday}&is_reinvestment=eq.false&type=in.(BUY,DEPOSIT,SELL,WITHDRAWAL)`),
    ]);

    if (!Array.isArray(positions) || !Array.isArray(latestSnaps)) {
      return res.status(502).json({ error: 'Failed to fetch portfolio data' });
    }

    const latestSnap = latestSnaps[0] || {};
    const snap24h    = Array.isArray(snaps24h) && snaps24h[0] ? snaps24h[0] : null;
    const snap7d     = Array.isArray(snaps7d)  && snaps7d[0]  ? snaps7d[0]  : null;
    const snap30d    = Array.isArray(snaps30d) && snaps30d[0] ? snaps30d[0] : null;

    const fxRate     = latestSnap.fx_rate || 0.79;
    const totalUSD   = latestSnap.total_usd || 0;
    const totalGBP   = latestSnap.total_gbp || (totalUSD * fxRate);

    // Per-ticker day% from price_snapshots: latest + anchor 20h ago, one query each
    // Build ticker list using original tickers (price_snapshots stores RSU_META, not META)
    const investedTickers = positions
      .filter(p => p.category !== 'fiat' && parseFloat(p.qty) > 0)
      .map(p => p.ticker);
    const tickerIn = investedTickers.map(t => encodeURIComponent(t)).join(',');

    const limit = investedTickers.length * 2;
    const [priceLatest, price24h, price7d, price30d] = tickerIn.length > 0 ? await Promise.all([
      sb(`price_snapshots?select=ticker,price_usd,price_gbp,fx_rate&ticker=in.(${tickerIn})&order=captured_at.desc&limit=${limit}`),
      sb(`price_snapshots?select=ticker,price_usd,price_gbp,fx_rate&ticker=in.(${tickerIn})&captured_at=lte.${tDayAnchor}&order=captured_at.desc&limit=${limit}`),
      sb(`price_snapshots?select=ticker,price_usd,price_gbp,fx_rate&ticker=in.(${tickerIn})&captured_at=lte.${t7d}&order=captured_at.desc&limit=${limit}`),
      sb(`price_snapshots?select=ticker,price_usd,price_gbp,fx_rate&ticker=in.(${tickerIn})&captured_at=lte.${t30d}&order=captured_at.desc&limit=${limit}`),
    ]) : [[], [], [], []];

    // Deduplicate: keep only the most recent row per ticker
    const dedup = rows => {
      const seen = {};
      (Array.isArray(rows) ? rows : []).forEach(r => { if (!seen[r.ticker]) seen[r.ticker] = r; });
      return seen;
    };
    const priceLatestMap = dedup(priceLatest);
    const price24hMap    = dedup(price24h);
    const price7dMap     = dedup(price7d);
    const price30dMap    = dedup(price30d);

    // portfolio_snapshots total_usd/total_gbp already include cash (worker saves full portfolio).
    // day/7d/30d changes use snapshot-native values on both sides — clean, no FX conversion needed.
    // % is computed against the prior snapshot total (which also includes cash) for consistency.
    const snap24hGBP   = snap24h ? (snap24h.total_gbp || snap24h.total_usd * fxRate) : null;
    const snap7dGBP    = snap7d  ? (snap7d.total_gbp  || snap7d.total_usd  * fxRate) : null;
    const snap30dGBP   = snap30d ? (snap30d.total_gbp || snap30d.total_usd * fxRate) : null;

    // Net cashflow today (London date) — excludes reinvestments and RSU_VEST.
    // Subtracted from day change so deposits/withdrawals don't distort the daily return.
    const netCFusd = (Array.isArray(cfRows) ? cfRows : []).reduce((acc, tx) => {
      if (tx.type === 'BUY' || tx.type === 'DEPOSIT') return acc + Number(tx.amount_usd || 0);
      if (tx.type === 'SELL' || tx.type === 'WITHDRAWAL') return acc - Number(tx.amount_usd || 0);
      return acc;
    }, 0);

    const dayChangeUSD = snap24h ? totalUSD - snap24h.total_usd - netCFusd : null;
    const dayChangeGBP = snap24h ? totalGBP - snap24hGBP - netCFusd * fxRate : null;
    const dayPctUSD    = snap24h && snap24h.total_usd > 0 ? (dayChangeUSD / snap24h.total_usd * 100) : null;
    const dayPctGBP    = snap24hGBP > 0 ? (dayChangeGBP / snap24hGBP * 100) : null;

    const chg7dUSD     = snap7d  && snap7d.total_usd > 0 ? ((totalUSD - snap7d.total_usd)  / snap7d.total_usd  * 100) : null;
    const chg30dUSD    = snap30d && snap30d.total_usd > 0 ? ((totalUSD - snap30d.total_usd) / snap30d.total_usd * 100) : null;
    const chg7dGBP     = snap7dGBP  > 0 ? ((totalGBP - snap7dGBP)  / snap7dGBP  * 100) : null;
    const chg30dGBP    = snap30dGBP > 0 ? ((totalGBP - snap30dGBP) / snap30dGBP * 100) : null;

    const investedPositions = positions.filter(p => p.category !== 'fiat' && parseFloat(p.qty) > 0);
    // Map RSU_META → META for Yahoo fetches; marketData keys use the Yahoo ticker
    const tickers = [...new Set(investedTickers.filter(Boolean).map(t => t === 'RSU_META' ? 'META' : t))];

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

    // Fetch macro fresh — always call Yahoo directly, update shared cache for other endpoints
    let macroSection = '';
    try {
      const macroResults = {};
      await Promise.allSettled(
        Object.keys(MACRO_TICKERS).map(async ticker => {
          try { macroResults[ticker] = { ...MACRO_TICKERS[ticker], ...await fetchMacro(ticker) }; }
          catch (e) { console.warn('[briefing-context] macro failed for', ticker, e.message); }
        })
      );
      if (Object.keys(macroResults).length > 0) {
        setMacroCache(macroResults);
        const f2   = v => v != null ? Number(v).toFixed(2) : '—';
        const sgnM = v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
        macroSection = 'MACRO\nticker|label|value|unit|7d|30d|trend\n';
        Object.entries(macroResults).forEach(([ticker, d]) => {
          if (!d || d.current == null) return;
          macroSection += `${ticker}|${d.label}|${f2(d.current)}|${d.unit}|${sgnM(d.chg7d)}|${sgnM(d.chg30d)}|${d.trend}\n`;
        });
        console.log('[briefing-context] macro loaded, tickers:', Object.keys(macroResults).length);
      }
    } catch (e) {
      console.warn('[briefing-context] macro fetch error:', e.message);
    }
    // Fetch Yahoo fallback for tickers missing 7d or 30d price_snapshot history.
    // Uses fetchMacro (yf.chart, 35d window) which returns ago7d, ago30d, chg7d, chg30d.
    // FX for GBP conversion: use the fx_rate from the 7d/30d snapshot anchor (same day).
    const tickersNeedingYahoo = investedPositions
      .map(p => p.ticker === 'RSU_META' ? 'META' : p.ticker)
      .filter(yt => !price7dMap[yt === 'META' ? 'RSU_META' : yt] || !price30dMap[yt === 'META' ? 'RSU_META' : yt]);
    const yahooHistMap = {};
    if (tickersNeedingYahoo.length > 0) {
      await Promise.allSettled(tickersNeedingYahoo.map(async yt => {
        try { yahooHistMap[yt] = await fetchMacro(yt); }
        catch (e) { console.warn('[briefing-context] yahoo hist failed for', yt, e.message); }
      }));
      console.log('[briefing-context] yahoo hist fallback for:', tickersNeedingYahoo);
    }

    const pricePct = (now, prev, field) => {
      if (!now || !prev) return null;
      const pNow = parseFloat(now[field]), pPrev = parseFloat(prev[field]);
      return pPrev > 0 ? (pNow - pPrev) / pPrev * 100 : null;
    };

    let posSection = 'POSITIONS\nticker|category|value_usd|value_gbp|weight%|invested_usd|invested_gbp|pnl_usd%|pnl_gbp%|day%_usd|day%_gbp|day_$_usd|day_$_gbp|7d%_usd|7d%_gbp|30d%_usd|30d%_gbp\n';
    let totalInvUSD = 0, totalInvGBP = 0, totalValUSD = 0;

    investedPositions.forEach(p => {
      const yticker   = p.ticker === 'RSU_META' ? 'META' : p.ticker;
      const md        = marketData[yticker] || {};
      const psNow     = priceLatestMap[p.ticker];
      const qty       = parseFloat(p.qty) || 0;
      const isGBP     = p.pricing_currency === 'GBP';
      // price_snapshots.price_usd ya viene convertido a USD por el worker (incluso para
      // tickers GBP como VWRP.L — ver DOCS.md worker.js), así que NO hay que dividir por
      // fxRate de nuevo. Esa doble conversión fue el bug de la vuelta anterior. El fallback
      // a marketData.regularMarketPrice sí es precio nativo de Yahoo y necesita la conversión.
      let valueUSD;
      if (psNow && psNow.price_usd != null && psNow.price_usd !== '') {
        valueUSD = parseFloat(psNow.price_usd) * qty;
      } else {
        const price = md.regularMarketPrice || parseFloat(p.avg_cost_usd) || 0;
        valueUSD = isGBP ? price * qty / fxRate : price * qty;
      }
      const valueGBP  = valueUSD * fxRate;
      // Cost basis: net_invested_usd/gbp (excluye reinversiones, mismo criterio que portfolio.js)
      // con fallback a initial_investment y por último avg_cost × qty.
      let invUSD = parseFloat(p.net_invested_usd) || 0;
      if (!invUSD) {
        invUSD = parseFloat(p.initial_investment_usd) || 0;
        if (!invUSD) invUSD = (parseFloat(p.avg_cost_usd) || 0) * qty;
      }
      let invGBP = parseFloat(p.net_invested_gbp) || 0;
      if (!invGBP) {
        invGBP = parseFloat(p.initial_investment_gbp) || 0;
        if (!invGBP) invGBP = (parseFloat(p.avg_cost_gbp) || 0) * qty;
      }
      const pnlUSD    = invUSD > 0 ? ((valueUSD - invUSD) / invUSD * 100) : null;
      const pnlGBP    = invGBP > 0 ? ((valueGBP - invGBP) / invGBP * 100) : null;

      const ps24h  = price24hMap[p.ticker];
      const ps7d   = price7dMap[p.ticker];
      const ps30d  = price30dMap[p.ticker];
      const yh     = yahooHistMap[yticker]; // Yahoo fallback data (chg7d, chg30d in USD)

      // day%: price_snapshots primary, Yahoo regularMarketChangePercent fallback
      let dayPctPosUSD = pricePct(psNow, ps24h, 'price_usd');
      let dayPctPosGBP = pricePct(psNow, ps24h, 'price_gbp');
      if (dayPctPosUSD === null && md.regularMarketChangePercent != null)
        dayPctPosUSD = md.regularMarketChangePercent * 100;

      // 7d%: price_snapshots primary. Fallback: Yahoo chg7d (USD only).
      // GBP: price_gbp from snapshot already embeds that day's FX. Yahoo fallback:
      // apply today's FX to ago7d price and compare vs today's price_gbp.
      let chg7dPosUSD  = pricePct(psNow, ps7d, 'price_usd');
      let chg7dPosGBP  = pricePct(psNow, ps7d, 'price_gbp');
      if (chg7dPosUSD === null && yh?.chg7d != null) {
        chg7dPosUSD = yh.chg7d;
        // GBP: (currentPrice*fxNow - ago7dPrice*fx7d) / (ago7dPrice*fx7d)
        // fx7d from snap7d anchor; if not available, use today's rate (less accurate but better than null)
        if (yh.current > 0 && yh.ago7d > 0) {
          const fx7d  = snap7d ? (snap7d.fx_rate || fxRate) : fxRate;
          const pNowGBP  = yh.current * fxRate;
          const p7dGBP   = yh.ago7d   * fx7d;
          if (p7dGBP > 0) chg7dPosGBP = (pNowGBP - p7dGBP) / p7dGBP * 100;
        }
      }

      // 30d%: same logic
      let chg30dPosUSD = pricePct(psNow, ps30d, 'price_usd');
      let chg30dPosGBP = pricePct(psNow, ps30d, 'price_gbp');
      if (chg30dPosUSD === null && yh?.chg30d != null) {
        chg30dPosUSD = yh.chg30d;
        if (yh.current > 0 && yh.ago30d > 0) {
          const fx30d = snap30d ? (snap30d.fx_rate || fxRate) : fxRate;
          const pNowGBP   = yh.current * fxRate;
          const p30dGBP   = yh.ago30d  * fx30d;
          if (p30dGBP > 0) chg30dPosGBP = (pNowGBP - p30dGBP) / p30dGBP * 100;
        }
      }

      totalValUSD += valueUSD;
      totalInvUSD += invUSD;
      totalInvGBP += invGBP;
      // Impacto del día en plata (no solo %) — para rankear por peso real en el portfolio,
      // no por variación porcentual pura (una posición chica con +4% puede pesar menos
      // en dólares que una grande con +0.5%).
      const dayDollarUSD = dayPctPosUSD != null ? valueUSD - (valueUSD / (1 + dayPctPosUSD / 100)) : null;
      const dayDollarGBP = dayPctPosGBP != null ? valueGBP - (valueGBP / (1 + dayPctPosGBP / 100)) : null;
      posSection += [p.ticker, p.category, fU(valueUSD), fG(valueGBP), '', fU(invUSD), fG(invGBP),
        pnlUSD       != null ? sgn(pnlUSD)       : '',
        pnlGBP       != null ? sgn(pnlGBP)       : '',
        dayPctPosUSD != null ? sgn(dayPctPosUSD) : '',
        dayPctPosGBP != null ? sgn(dayPctPosGBP) : '',
        dayDollarUSD != null ? (dayDollarUSD >= 0 ? '+' : '') + fU(dayDollarUSD) : '',
        dayDollarGBP != null ? (dayDollarGBP >= 0 ? '+' : '') + fG(dayDollarGBP) : '',
        chg7dPosUSD  != null ? sgn(chg7dPosUSD)  : '',
        chg7dPosGBP  != null ? sgn(chg7dPosGBP)  : '',
        chg30dPosUSD != null ? sgn(chg30dPosUSD) : '',
        chg30dPosGBP != null ? sgn(chg30dPosGBP) : '',
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

    // Cost basis includes cash (same logic as portfolio.js):
    // fiat positions use current qty as cost (no P&L), non-fiat use initial_investment.
    const cashPositions = positions.filter(p => p.category === 'fiat');
    // Cash basis: fiat positions use current value as cost (no P&L on cash)
    // ARS: use avg_cost_usd * qty (= 1/fx_usd_ars_avg * qty_ars = USD value). Never treat qty as USD.
    // Cash basis: net_invested_gbp/usd (recalculator, excluye reinversiones) como fuente
    // primaria — mismo criterio que portfolio.js. Fallback legacy: qty (GBP/otros) o
    // avg_cost_usd × qty (ARS) solo si no hay net_invested.
    let cashBasisUSD = 0, cashBasisGBP = 0;
    cashPositions.forEach(p => {
      const qty = parseFloat(p.qty) || 0;
      const netGBP = parseFloat(p.net_invested_gbp) || 0;
      const netUSD = parseFloat(p.net_invested_usd) || 0;
      if (p.managed_by === 'transactions' || netGBP || netUSD) {
        cashBasisGBP += netGBP;
        cashBasisUSD += netUSD;
      } else if (p.currency === 'GBP') {
        cashBasisGBP += qty;
        cashBasisUSD += qty / fxRate;
      } else if (p.currency === 'ARS') {
        const avgCostUsd = parseFloat(p.avg_cost_usd) || 0;
        cashBasisUSD += avgCostUsd > 0 ? qty * avgCostUsd : 0;
        cashBasisGBP += avgCostUsd > 0 ? (qty * avgCostUsd) * fxRate : 0;
      } else {
        cashBasisUSD += qty;
        cashBasisGBP += qty * fxRate;
      }
    });

    // cost basis = invested (non-fiat, locked-in FX) + cash (current face value)
    const costBasisUSD = totalInvUSD + cashBasisUSD;
    const costBasisGBP = totalInvGBP + cashBasisGBP;

    // Total EN VIVO (equity a precios actuales + cash) — mismo criterio que la app, que
    // recalcula el total con el precio más fresco por ticker en vez de leer un campo
    // pre-agregado. latestSnap.total_usd/gbp es el último tick del worker (~15 min) y puede
    // quedar unos dólares atrás si se movió algún precio o hubo un flujo desde entonces;
    // esa diferencia se filtraba directo al total_pnl. cashValueUSD/GBP usa el mismo criterio
    // de valorización que cashBasisUSD/GBP (face value para GBP/USD, avg_cost_usd × qty para ARS).
    let cashValueUSD = 0, cashValueGBP = 0;
    cashPositions.forEach(p => {
      const qty = parseFloat(p.qty) || 0;
      if (p.currency === 'GBP') {
        cashValueGBP += qty;
        cashValueUSD += qty / fxRate;
      } else if (p.currency === 'ARS') {
        const avgCostUsd = parseFloat(p.avg_cost_usd) || 0;
        const v = avgCostUsd > 0 ? qty * avgCostUsd : 0;
        cashValueUSD += v;
        cashValueGBP += v * fxRate;
      } else {
        cashValueUSD += qty;
        cashValueGBP += qty * fxRate;
      }
    });
    const liveTotalUSD = totalValUSD + cashValueUSD;
    const liveTotalGBP = totalValUSD * fxRate + cashValueGBP;

    // P&L = total en vivo - cost basis. day/7d/30d change siguen usando totalUSD/totalGBP
    // (snapshot a snapshot) más abajo — ahí sí conviene quedarse anclado al worker para que
    // USD y GBP salgan consistentes entre sí, igual que en portfolio.js.
    const totalPnlUSD    = liveTotalUSD - costBasisUSD;
    const totalPnlGBP    = liveTotalGBP - costBasisGBP;
    const totalPnlPctUSD = costBasisUSD > 0 ? (totalPnlUSD / costBasisUSD * 100) : 0;
    const totalPnlPctGBP = costBasisGBP > 0 ? (totalPnlGBP / costBasisGBP * 100) : 0;

    let cashSection = 'CASH\nticker|value_usd|value_gbp\n';
    cashPositions.forEach(p => {
      const qty = parseFloat(p.qty) || 0;
      let valUSD, valGBP;
      if (p.currency === 'GBP') {
        valGBP = qty;
        valUSD = qty / fxRate;
      } else if (p.currency === 'ARS') {
        const avgCostUsd = parseFloat(p.avg_cost_usd) || 0;
        valUSD = avgCostUsd > 0 ? qty * avgCostUsd : 0;
        valGBP = valUSD * fxRate;
      } else {
        valUSD = qty;
        valGBP = qty * fxRate;
      }
      cashSection += `${p.ticker}|${fU(valUSD)}|${fG(valGBP)}\n`;
    });

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
    const todayISO = new Date().toISOString().slice(0, 10);
    const [cmRows, pmRows, yesterdayBriefingRows, nextVestRows] = await Promise.all([
      sb(`transactions?select=amount_usd,amount_local&date=gte.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`),
      sb(`transactions?select=amount_usd,amount_local&date=gte.${prevStart}&date=lt.${currStart}&type=in.(BUY,RSU_VEST)&limit=500`),
      sb(`daily_briefings?select=content&order=date.desc&limit=1&date=lt.${todayISO}`),
      sb(`rsu_vests?select=vest_date,units&vested=eq.false&vest_date=gte.${todayISO}&order=vest_date.asc&limit=1`),
    ]);
    const sumF = (rows, field) => Array.isArray(rows) ? rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0) : 0;
    txSection += `\nMONTH_INVESTED\n`;
    txSection += `${y}-${String(mo).padStart(2, '0')} (corriente): ${fU(sumF(cmRows, 'amount_usd'))} / ${fG(sumF(cmRows, 'amount_local'))}\n`;
    txSection += `${prevY}-${String(prevMo).padStart(2, '0')} (anterior): ${fU(sumF(pmRows, 'amount_usd'))} / ${fG(sumF(pmRows, 'amount_local'))}`;

    // Build today string from londonToday (YYYY-MM-DD) to avoid timezone/locale off-by-one.
    // Append T12:00Z so the Date is unambiguously noon UTC on that date in all locales.
    const today = new Date(londonToday + 'T12:00:00.000Z').toLocaleDateString('es-AR', {
      timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    // Yesterday's briefing content
    const yesterdayBriefing = Array.isArray(yesterdayBriefingRows) && yesterdayBriefingRows[0]
      ? yesterdayBriefingRows[0].content : null;

    // Upcoming earnings within 7 days — solo lo que es relevante para el briefing de HOY
    // (earnings a 3-4 semanas no cambian ninguna decisión hoy; se vuelven a mostrar cuando
    // entren en la ventana de 7 días).
    const now7 = new Date();
    const in7d = new Date(now7.getTime() + 7 * 86400000);
    let earningsSection = '';
    const earningsList = [];
    investedPositions.forEach(p => {
      const yticker = p.ticker === 'RSU_META' ? 'META' : p.ticker;
      const md = marketData[yticker] || {};
      if (md.nextEarningsDate) {
        const ed = new Date(md.nextEarningsDate);
        if (ed >= now7 && ed <= in7d) {
          const displayTicker = p.ticker === 'RSU_META' ? 'META (RSU)' : p.ticker;
          earningsList.push({ ticker: displayTicker, date: md.nextEarningsDate, timing: md.earningsTiming || 'unknown' });
        }
      }
    });
    if (earningsList.length > 0) {
      earningsList.sort((a, b) => a.date.localeCompare(b.date));
      earningsSection = 'UPCOMING_EARNINGS (next 7 days)\nticker|date|timing\n';
      earningsList.forEach(e => { earningsSection += e.ticker + '|' + e.date + '|' + e.timing + '\n'; });
    }

    // Next RSU vest section
    let nextVestSection = '';
    const nextVest = Array.isArray(nextVestRows) && nextVestRows[0] ? nextVestRows[0] : null;
    if (nextVest) {
      const metaMD  = marketData['META'] || {};
      const psMetaNow = priceLatestMap['RSU_META'];
      // Same priority as the rest of the file: live price_snapshots first (worker updates
      // every 15 min), fundamentals cache only as fallback — this was previously skipped
      // here, so the vest amount didn't move with the actual META price.
      const metaPrice = (psMetaNow && psMetaNow.price_usd != null && psMetaNow.price_usd !== '')
        ? parseFloat(psMetaNow.price_usd)
        : (metaMD.regularMarketPrice || 0);
      const units   = parseFloat(nextVest.units) || 0;
      const grossUSD = units * metaPrice;
      const netUSD   = grossUSD * 0.53;
      const netGBP   = netUSD * fxRate;
      const vestDate = nextVest.vest_date;
      const daysTo   = Math.ceil((new Date(vestDate) - new Date()) / 86400000);
      nextVestSection =
        'NEXT_RSU_VEST\ndate|days_away|units|gross_usd|net_usd|net_gbp\n' +
        `${vestDate}|${daysTo}d|${units}|${fU(grossUSD)}|${fU(netUSD)}|${fG(netGBP)}\n`;
    }

    // ALLOCATION incl. liquid cash (excl. RENT_DEPOSIT and GBP_RECEIVABLE)
    // Allocation: equity + all non-locked cash (GBP_LIQUID + USD_CASH + EMERGENCY_FUND).
    // Emergency fund shown as its own line so model knows it's not deployable capital.
    // RENT_DEPOSIT and GBP_RECEIVABLE excluded (locked).
    const ALLOC_CASH_TICKERS = new Set(['EMERGENCY_FUND', 'GBP_LIQUID', 'USD_CASH']);
    let deployCashGBP = 0, deployCashUSD = 0;
    let emergencyGBP  = 0, emergencyUSD  = 0;
    let arsCashGBP    = 0, arsCashUSD    = 0;
    positions.filter(p => p.category === 'fiat').forEach(p => {
      const qty = parseFloat(p.qty) || 0;
      let usd, gbp;
      if (p.currency === 'GBP') {
        gbp = qty; usd = qty / fxRate;
      } else if (p.currency === 'ARS') {
        const avgCostUsd = parseFloat(p.avg_cost_usd) || 0;
        usd = avgCostUsd > 0 ? qty * avgCostUsd : 0;
        gbp = usd * fxRate;
      } else {
        usd = qty; gbp = qty * fxRate;
      }
      if (p.ticker === 'EMERGENCY_FUND')                   { emergencyUSD += usd; emergencyGBP += gbp; }
      else if (p.ticker === 'ARS_CASH')                    { arsCashUSD   += usd; arsCashGBP   += gbp; }
      else if (ALLOC_CASH_TICKERS.has(p.ticker))           { deployCashUSD += usd; deployCashGBP += gbp; }
    });
    const totalAllocUSD = totalValUSD + deployCashUSD + emergencyUSD + arsCashUSD;
    const totalAllocGBP = totalValUSD * fxRate + deployCashGBP + emergencyGBP + arsCashGBP;
    let allocationSection = '';
    if (totalAllocUSD > 0) {
      allocationSection = 'ALLOCATION (equity + liquid cash, excl. locked cash)\n';
      allocationSection += `note: weights over $${Math.round(totalAllocUSD).toLocaleString('en-US')} / £${Math.round(totalAllocGBP).toLocaleString('en-US')}\n`;
      allocationSection += `deployable_cash|${fU(deployCashUSD)}|${fG(deployCashGBP)}|${(deployCashUSD / totalAllocUSD * 100).toFixed(1)}%\n`;
      allocationSection += `emergency_fund|${fU(emergencyUSD)}|${fG(emergencyGBP)}|${(emergencyUSD / totalAllocUSD * 100).toFixed(1)}% (not investable)\n`;
      if (arsCashUSD > 0) allocationSection += `ARS_CASH|${fU(arsCashUSD)}|${fG(arsCashGBP)}|${(arsCashUSD / totalAllocUSD * 100).toFixed(1)}% (liquid, ARS)\n`;
      // equity positions sorted by weight descending
      const posWeights = investedPositions.map(p => {
        const yticker = p.ticker === 'RSU_META' ? 'META' : p.ticker;
        const md = marketData[yticker] || {};
        const psNow = priceLatestMap[p.ticker];
        const qty = parseFloat(p.qty) || 0;
        const isGBP = p.pricing_currency === 'GBP';
        let valueUSD;
        if (psNow && psNow.price_usd != null && psNow.price_usd !== '') {
          valueUSD = parseFloat(psNow.price_usd) * qty;
        } else {
          const price = md.regularMarketPrice || parseFloat(p.avg_cost_usd) || 0;
          valueUSD = isGBP ? price * qty / fxRate : price * qty;
        }
        return { ticker: p.ticker, valueUSD };
      }).sort((a, b) => b.valueUSD - a.valueUSD);
      posWeights.forEach(({ ticker, valueUSD }) => {
        allocationSection += ticker + '|' + fU(valueUSD) + '|' + fG(valueUSD * fxRate) + '|' + (valueUSD / totalAllocUSD * 100).toFixed(1) + '%\n';
      });
    }

    // total: en vivo (equity a precio actual + cash) — coincide con lo que muestra la app.
    // day_return_usd/gbp sigue usando totalUSD/totalGBP (snapshot a snapshot) más abajo.
    const portfolioSummary =
      `PORTFOLIO\n` +
      `total: ${fU(liveTotalUSD)} / ${fG(liveTotalGBP)} (equity + cash)\n` +
      `equity_only: ${fU(totalValUSD)} / ${fG(totalValUSD * fxRate)}\n` +
      `fx: 1 GBP = ${(1 / fxRate).toFixed(4)} USD\n` +
      (dayChangeUSD != null ? `day_return_usd: ${dayChangeUSD >= 0 ? '+' : ''}${fU(dayChangeUSD)} (${sgn(dayPctUSD)}) [rendimiento, excluye cashflows]\n` : '') +
      (dayChangeGBP != null ? `day_return_gbp: ${dayChangeGBP >= 0 ? '+' : ''}${fG(dayChangeGBP)} (${sgn(dayPctGBP)}) [rendimiento, excluye cashflows]\n` : '') +
      (netCFusd !== 0 ? `day_cashflow_usd: ${netCFusd >= 0 ? '+' : ''}${fU(netCFusd)} [capital ingresado/retirado, no es rendimiento]\nday_cashflow_gbp: ${netCFusd * fxRate >= 0 ? '+' : ''}${fG(netCFusd * fxRate)} [capital ingresado/retirado, no es rendimiento]\n` : '') +
      `cost_basis: ${fU(costBasisUSD)} / ${fG(costBasisGBP)} (invested + cash)\n` +
      `total_pnl_usd: ${totalPnlUSD >= 0 ? '+' : ''}${fU(totalPnlUSD)} (${sgn(totalPnlPctUSD)})\n` +
      `total_pnl_gbp: ${totalPnlGBP >= 0 ? '+' : ''}${fG(totalPnlGBP)} (${sgn(totalPnlPctGBP)})\n` +
      `note_pnl: pnl_gbp uses net_invested_gbp (fallback initial_investment_gbp, locked-in FX at purchase); USD positions converted at today's FX\n`;

    // HISTORICAL_PERFORMANCE
    let histSection = '';
    if (snap7d) {
      const chg7abs    = totalUSD - snap7d.total_usd;
      const chg7absGBP = totalGBP - snap7dGBP;
      histSection += `7d: ${chg7abs >= 0 ? '+' : ''}${fU(chg7abs)} (${fG(chg7absGBP)}) USD ${sgn(chg7dUSD)} / GBP ${sgn(chg7dGBP)}\n`;
    }
    if (snap30d) {
      const chg30abs    = totalUSD - snap30d.total_usd;
      const chg30absGBP = totalGBP - snap30dGBP;
      histSection += `30d: ${chg30abs >= 0 ? '+' : ''}${fU(chg30abs)} (${fG(chg30absGBP)}) USD ${sgn(chg30dUSD)} / GBP ${sgn(chg30dGBP)}\n`;
    }
    if (histSection) histSection = 'HISTORICAL_PERFORMANCE\n' + histSection;

    // PNL_ATTRIBUTION per category
    let pnlAttrSection = '';
    const byCategory = {};
    investedPositions.forEach(p => {
      const yticker  = p.ticker === 'RSU_META' ? 'META' : p.ticker;
      const md       = marketData[yticker] || {};
      const psNow    = priceLatestMap[p.ticker];
      const qty      = parseFloat(p.qty) || 0;
      const isGBP    = p.pricing_currency === 'GBP';
      let valueUSD;
      if (psNow && psNow.price_usd != null && psNow.price_usd !== '') {
        valueUSD = parseFloat(psNow.price_usd) * qty;
      } else {
        const price = md.regularMarketPrice || parseFloat(p.avg_cost_usd) || 0;
        valueUSD = isGBP ? price * qty / fxRate : price * qty;
      }
      let invUSD = parseFloat(p.net_invested_usd) || 0;
      if (!invUSD) {
        invUSD = parseFloat(p.initial_investment_usd) || 0;
        if (!invUSD) invUSD = (parseFloat(p.avg_cost_usd) || 0) * qty;
      }
      let invGBP = parseFloat(p.net_invested_gbp) || 0;
      if (!invGBP) {
        invGBP = parseFloat(p.initial_investment_gbp) || 0;
        if (!invGBP) invGBP = (parseFloat(p.avg_cost_gbp) || 0) * qty;
      }
      const cat      = p.category;
      if (!byCategory[cat]) byCategory[cat] = { valueUSD: 0, investedUSD: 0, investedGBP: 0 };
      byCategory[cat].valueUSD    += valueUSD;
      byCategory[cat].investedUSD += invUSD;
      byCategory[cat].investedGBP += invGBP;
    });
    if (Object.keys(byCategory).length > 0) {
      pnlAttrSection = 'PNL_ATTRIBUTION\ncategory|invested_usd|invested_gbp|current_usd|pnl_usd|pnl_gbp|pnl_usd%|pnl_gbp%\n';
      Object.entries(byCategory).forEach(([cat, d]) => {
        const pnlUSD    = d.valueUSD - d.investedUSD;
        const pnlGBP    = d.valueUSD * fxRate - d.investedGBP;
        const pnlPctUSD = d.investedUSD > 0 ? (pnlUSD / d.investedUSD * 100) : 0;
        const pnlPctGBP = d.investedGBP > 0 ? (pnlGBP / d.investedGBP * 100) : 0;
        pnlAttrSection += `${cat}|${fU(d.investedUSD)}|${fG(d.investedGBP)}|${fU(d.valueUSD)}|${pnlUSD >= 0 ? '+' : ''}${fU(pnlUSD)}|${pnlGBP >= 0 ? '+' : ''}${fG(pnlGBP)}|${sgn(pnlPctUSD)}|${sgn(pnlPctGBP)}\n`;
      });
    }

    const systemPrompt =
      `Sos el asesor financiero personal de Julián. Vive en Londres. Hoy es ${today}. La bolsa de Nueva York acaba de cerrar.\n\n` +
      `Generá un briefing financiero diario conciso en español. Máximo 600 palabras. Usá markdown (negrita, bullets).\n\n` +
      `Formato: nunca dejes más de un salto de línea en blanco entre bloques (tabla → texto, sección → sección). Un solo \\n en blanco, nunca dos o más.\n\n` +
      `Estructura (3 secciones, todas se generan siempre — lo que cambia es cuánto espacio ocupa cada una):\n\n` +
      `1. **Resumen del día** — Abrí con una tabla markdown de 2 columnas (USD | GBP), 3 filas: Valor total, Rendimiento del día (nominal + %), P&L acumulado (nominal + %). ` +
      `Después de la tabla, 1-2 líneas de prosa SOLO si hay algo que valga la pena señalar — ej: el gap USD/GBP (day%_usd vs day%_gbp del portfolio) SOLO si la diferencia supera ~0.3 puntos porcentuales. Si no hay nada relevante, no agregues prosa, la tabla sola alcanza.\n\n` +
      `2. **Qué importa hoy** — ` +
      `Posiciones destacadas: rankealas por day_$_usd (impacto real en plata), NO por day%_usd — una posición chica con +4% puede pesar menos en dólares que RSU_META con +0.5%. Mostrá 3-5 como máximo. No aclares el criterio de orden entre paréntesis (nada de "(por impacto nominal)" ni similar) — el orden se entiende solo. ` +
      `Macro: NO listes VIX/índices/tasas/FX como rutina. Mencioná un dato macro puntual solo si (a) VIX está por encima de 20, (b) algún índice o el VIX se movió más de ±2% en el día o ±5% en 7d, o (c) explica directamente el movimiento del portfolio de hoy. Si nada de eso pasa, omitila por completo — no hace falta ni una línea.\n\n` +
      `3. **Contexto y oportunidades** — 1 línea de estado siempre (% de RSU_META u otra posición sobre el equity total, próximo vest si existe). Mencioná deployable cash SOLO si es > $0 y hay algo concreto para hacer con eso — si es $0, no la menciones en absoluto. ` +
      `Expandila a uno o dos párrafos SOLO si hay algo realmente accionable o a monitorear: deployable_cash > $0 con destino claro, concentración de una sola posición > 30% del equity, vest a menos de 30 días, earnings en UPCOMING_EARNINGS (ya viene filtrado a 7 días — si la sección no aparece en los datos, es porque no hay ninguno, no lo menciones), o cualquier otra observación puntual sobre una posición o el mercado que valga la pena señalar hoy. ` +
      `Es UNA sola sección: si mencionás un ticker o dato al expandir, no lo repitas con otro ángulo más abajo — elegí el mejor punto y desarrollalo una vez. Si no se cumple ninguna condición, dejala en la línea de una sola oración y cerrá ahí.\n\n` +
      `Sé directo. No repitas el mismo dato en dos secciones (ej: no expliques el gap USD/GBP en la sección 1 y de nuevo en la 2, ni el mismo ticker con el mismo argumento en la sección 2 y la 3).\n` +
      `Earnings — IMPORTANTE: UPCOMING_EARNINGS trae una columna timing (BMO=antes de la apertura, AMC=después del cierre, unknown=no confirmado). Usala solo para saber si la reacción al reporte YA PUEDE verse en el precio de hoy — nunca para asumir causalidad automática: ` +
      `si timing=AMC y la fecha es HOY, el reporte se publica después del cierre — el precio de hoy todavía NO puede reflejar ninguna reacción, no lo menciones como explicación de nada de lo que pasó hoy. ` +
      `Si timing=AMC y la fecha es AYER, o timing=BMO y la fecha es HOY, el reporte ya salió y el precio de hoy podría estar reaccionando — pero earnings es una posible explicación entre varias (mercado en general, sector, flujo), no dés por hecho que el movimiento se debe al reporte solo porque el timing calza. Podés mencionar que reportó como contexto, sin afirmar causalidad, salvo que el movimiento sea claramente atípico para ese ticker. ` +
      `Si timing=unknown, no asumas nada de timing: describí el movimiento del día solo en base al precio.\n` +
      (yesterdayBriefing ? `Así cerró el briefing de ayer:\n${yesterdayBriefing}\nNo repitas la misma observación o recomendación hoy — buscá un ángulo distinto.\n` : '') +
      `\n` +
      portfolioSummary + '\n' +
      (histSection      ? histSection      + '\n' : '') +
      posSection + '\n' + cashSection + '\n' +
      (pnlAttrSection   ? pnlAttrSection   + '\n' : '') +
      (earningsSection  ? earningsSection  + '\n' : '') +
      (nextVestSection  ? nextVestSection  + '\n' : '') +
      (allocationSection ? allocationSection + '\n' : '') +
      txSection + '\n\n' +
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
      model: 'claude-sonnet-5',
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

  const { model, max_tokens = 4096, system, messages } = req.body;
  // Subido de 5 a 6: un colchón extra de iteraciones para consultas que
  // necesiten encadenar varias tools (ver nota más abajo sobre por qué esto
  // NO es lo que causaba el bug de "dice que va a hacer algo y no lo hace").
  const MAX_TOOL_ITERATIONS = 6;

  // Sonnet 5 usa adaptive thinking + effort en vez del thinking manual de las
  // versiones anteriores. La dejamos pensar adaptativamente (sin forzar
  // thinking:disabled) a esfuerzo medio.
  // (thinking:{type:'enabled', budget_tokens} rompe con 400 en Sonnet 5 — no tocar.)
  const modelExtraParams =
    model === 'claude-sonnet-5' ? { output_config: { effort: 'medium' } } :
    // Bajado de high a medium: high te estaba disparando el timeout con
    // preguntas largas/complejas (Opus a effort alto piensa mucho más antes
    // de responder). Medium mantiene buena calidad con latencia razonable —
    // ver DOCS.md para el detalle de la decisión.
    model === 'claude-opus-5'   ? { output_config: { effort: 'medium' } } :
    {};

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
    // Fase 1: tool loop, con streaming interno (callAnthropicStreaming) para
    // que el timeout no dependa de un número adivinado — ver esa función
    // más arriba para el porqué. El cliente NO ve nada de esta fase hasta
    // el tool_log al final; el streaming acá es solo para robustez de
    // conexión, no para mostrar progreso incremental en la UI.
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const anthropicBody = {
        model,
        max_tokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: loopMessages,
        tools: AI_TOOLS,
        ...modelExtraParams,
      };

      console.log(`[ai-chat] iteración ${iterations} — mensajes: ${loopMessages.length}`);
      const raw = await callAnthropicStreaming(anthropicKey, anthropicBody);

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

    // Fase 2: stream de la respuesta final.
    // IMPORTANTE: sin "tools" acá a propósito. Para este punto la fase 1 ya
    // resolvió el uso de tools (o llegó al máximo de iteraciones). Si acá se
    // le siguiera pasando `tools`, el modelo podía decidir pedir OTRA tool
    // en pleno streaming — y este endpoint solo parsea eventos de texto
    // (content_block_delta / text_delta), no tool_use. Eso generaba el bug:
    // el modelo escribía "voy a revisar tal cosa..." como preámbulo y después
    // intentaba una tool call que nunca se ejecutaba ni se mostraba — quedaba
    // la frase colgada sin resultado. Sacar tools de esta fase fuerza una
    // respuesta final solo de texto con lo que ya se obtuvo en fase 1.
    const streamReqBody = JSON.stringify({
      model, max_tokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: loopMessages,
      stream: true,
      ...modelExtraParams,
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
        let inputTokens = null, outputTokens = null, stopReason = null, thinkingTokens = null;
        let thinkingPreview = ''; // resumen del razonamiento (summarized thinking), solo para logs

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
              } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
                // Nunca se manda al cliente (por diseño, ver DOCS.md "Thinking blocks") —
                // solo se acumula acá para loggear un preview server-side.
                if (thinkingPreview.length < 500) thinkingPreview += evt.delta.thinking || '';
              } else if (evt.type === 'message_start' && evt.message?.usage) {
                inputTokens  = evt.message.usage.input_tokens  ?? null;
                outputTokens = evt.message.usage.output_tokens ?? null;
              } else if (evt.type === 'message_delta') {
                if (evt.usage) {
                  outputTokens   = evt.usage.output_tokens ?? outputTokens;
                  thinkingTokens = evt.usage.output_tokens_details?.thinking_tokens ?? thinkingTokens;
                }
                if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
              } else if (evt.type === 'message_stop') {
                const cacheHit = evt.message?.usage?.cache_read_input_tokens ?? 0;
                const truncWarn = stopReason === 'max_tokens'
                  ? ` ⚠️ CORTADO POR max_tokens (${max_tokens}) — subir el límite o el thinking se comió el presupuesto`
                  : '';
                // thinking_tokens está incluido DENTRO de output_tokens (no es aparte) —
                // se resta para aproximar cuánto fue texto visible real.
                const textTokens = (outputTokens != null && thinkingTokens != null)
                  ? outputTokens - thinkingTokens : null;
                const thinkingBreakdown = thinkingTokens != null
                  ? ` (thinking: ${thinkingTokens}, texto: ${textTokens})` : '';
                console.log(`[ai-chat] stream done | in: ${inputTokens} out: ${outputTokens}${thinkingBreakdown} | stop_reason: ${stopReason}${cacheHit > 0 ? ` cache_read: ${cacheHit}` : ''}${truncWarn}`);
                if (thinkingPreview) {
                  console.log(`[ai-chat] thinking preview (resumido, no el razonamiento crudo): ${thinkingPreview.slice(0, 300)}${thinkingPreview.length > 300 ? '…' : ''}`);
                }
                send({
                  type: 'done',
                  usage: { input_tokens: inputTokens, output_tokens: outputTokens, thinking_tokens: thinkingTokens },
                  stop_reason: stopReason,
                  truncated: stopReason === 'max_tokens',
                });
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
      // En streaming, Anthropic manda "ping" events mientras genera, así que
      // el timeout de inactividad rara vez debería dispararse acá — pero le
      // damos el mismo margen que a Fase 1 por consistencia y seguridad.
      streamReq.setTimeout(240000, () => { streamReq.destroy(); reject(new Error('Stream timeout 240s')); });
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
