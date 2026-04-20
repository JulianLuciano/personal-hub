/**
 * recalculator.js
 * ---------------
 * Recalcula positions desde transactions usando weighted average cronológico.
 * - managed_by = 'transactions' → se recalcula desde cero
 * - managed_by = 'manual'       → no se toca
 *
 * Lógica de weighted average con reset en venta total:
 *   BUY / RSU_VEST → acumula qty + montos
 *   SELL           → reduce qty, descuenta costo proporcional
 *   qty == 0       → reset total (próxima compra arranca limpio)
 *
 * Acumulador paralelo net_invested:
 *   Igual que total_invested pero ignora transacciones con is_reinvestment = true.
 *   RSU_VEST siempre suma a net_invested (nunca es reinversión).
 *   SELL / WITHDRAWAL descuentan de ambos acumuladores proporcionalmente.
 *   Se usa en portfolio.js para el cost basis total del portfolio.
 *
 * Regla de ticker para RSU_META:
 *   transactions.ticker = 'META' AND type = 'RSU_VEST' → positions.ticker = 'RSU_META'
 *   transactions.ticker = 'META' AND type = 'BUY'      → positions.ticker = 'META'
 */

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
  );
}

/**
 * Determina el ticker de positions dado un row de transactions.
 */
function resolvePositionTicker(t) {
  if (t.ticker === 'META' && t.type === 'RSU_VEST') return 'RSU_META';
  return t.ticker;
}

/**
 * Mapea asset_class de transactions → category de positions.
 * transactions: 'stock' | 'cripto' | 'rsu' | 'fiat'
 * positions:    'acciones' | 'cripto' | 'rsu' | 'fiat'
 */
function resolveCategory(assetClass) {
  if (assetClass === 'stock') return 'acciones';
  return assetClass || 'acciones';
}

/**
 * Procesa todas las transactions en orden cronológico y devuelve
 * un mapa { positionTicker → calculatedFields }.
 */
function calculateFromTransactions(transactions) {
  // Estado por positionTicker
  const state = {};

  // Ordena por fecha ASC, y por created_at como desempate
  const sorted = [...transactions].sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return  1;
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return  1;
    return 0;
  });

  for (const t of sorted) {
    const posTicker = resolvePositionTicker(t);

    if (!state[posTicker]) {
      state[posTicker] = {
        qty:                  0,
        total_invested_usd:   0,
        total_invested_local: 0,  // always GBP (server ensures this for ARS too)
        total_fees_local:     0,
        // Acumulador paralelo: solo capital fresco (is_reinvestment = false)
        net_invested_usd:     0,
        net_invested_local:   0,
        // ARS only: weighted fx_usd_ars accumulator for fx_usd_ars_avg
        // Stores sum of (amtArs * fx_usd_ars) per tx to compute weighted average
        total_invested_ars:   0,  // sum of amount_ars (ARS notional invested)
        net_invested_ars:     0,
        // Metadata (tomada del primer registro, no cambia)
        name:                 t.name          || null,
        category:             resolveCategory(t.asset_class),
        currency:             t.local_currency || 'GBP',
        pricing_currency:     t.pricing_currency || 'USD',
        exchange:             t.exchange      || null,
        local_currency:       t.local_currency || 'GBP',
      };
    }

    const s          = state[posTicker];
    const qty        = Number(t.qty)          || 0;
    const amtUsd     = Number(t.amount_usd)   || 0;
    const amtLoc     = Number(t.amount_local) || 0;  // always GBP
    const amtArs     = Number(t.amount_ars)   || 0;  // ARS only, 0 for non-ARS
    const fxUsdArs   = Number(t.fx_usd_ars)   || 0;  // ARS/USD rate at tx time (ARS only)
    const fee        = Number(t.fee_local)    || 0;
    const isReinvest = t.is_reinvestment === true;
    const isARSTx    = s.currency === 'ARS';

    if (t.type === 'BUY') {
      s.qty                  += qty;  // ARS for ARS_CASH, units for others
      s.total_invested_usd   += amtUsd;
      s.total_invested_local += amtLoc;
      s.total_fees_local     += fee;
      if (isARSTx) s.total_invested_ars += amtArs;
      if (!isReinvest) {
        s.net_invested_usd   += amtUsd;
        s.net_invested_local += amtLoc;
        if (isARSTx) s.net_invested_ars += amtArs;
      }

    } else if (t.type === 'RSU_VEST') {
      s.qty                  += qty;
      s.total_invested_usd   += amtUsd;
      s.total_invested_local += amtLoc;
      s.total_fees_local     += fee;
      s.net_invested_usd     += amtUsd;
      s.net_invested_local   += amtLoc;

    } else if (t.type === 'SELL') {
      const avgTotalUsd = s.qty > 0 ? s.total_invested_usd   / s.qty : 0;
      const avgTotalLoc = s.qty > 0 ? s.total_invested_local / s.qty : 0;
      const avgNetUsd   = s.qty > 0 ? s.net_invested_usd     / s.qty : 0;
      const avgNetLoc   = s.qty > 0 ? s.net_invested_local   / s.qty : 0;

      s.qty                  -= qty;
      s.total_invested_usd   -= qty * avgTotalUsd;
      s.total_invested_local -= qty * avgTotalLoc;
      s.net_invested_usd     -= qty * avgNetUsd;
      s.net_invested_local   -= qty * avgNetLoc;
      s.total_fees_local     += fee;

      if (s.qty <= 0.0000001) {
        s.qty = 0; s.total_invested_usd = 0; s.total_invested_local = 0;
        s.net_invested_usd = 0; s.net_invested_local = 0;
      }

    } else if (t.type === 'DEPOSIT') {
      s.qty                  += qty;  // ARS for ARS_CASH
      s.total_invested_usd   += amtUsd;
      s.total_invested_local += amtLoc;
      if (isARSTx) s.total_invested_ars += amtArs;
      if (!isReinvest) {
        s.net_invested_usd   += amtUsd;
        s.net_invested_local += amtLoc;
        if (isARSTx) s.net_invested_ars += amtArs;
      }

    } else if (t.type === 'WITHDRAWAL') {
      // qty is ARS for ARS_CASH, units for others — proportional deduction works the same
      const avgTotalUsd = s.qty > 0 ? s.total_invested_usd   / s.qty : 0;
      const avgTotalLoc = s.qty > 0 ? s.total_invested_local / s.qty : 0;
      const avgTotalArs = s.qty > 0 ? s.total_invested_ars   / s.qty : 0;
      const avgNetUsd   = s.qty > 0 ? s.net_invested_usd     / s.qty : 0;
      const avgNetLoc   = s.qty > 0 ? s.net_invested_local   / s.qty : 0;
      const avgNetArs   = s.qty > 0 ? s.net_invested_ars     / s.qty : 0;

      s.qty                  -= qty;
      s.total_invested_usd   -= qty * avgTotalUsd;
      s.total_invested_local -= qty * avgTotalLoc;
      s.net_invested_usd     -= qty * avgNetUsd;
      s.net_invested_local   -= qty * avgNetLoc;
      if (isARSTx) {
        s.total_invested_ars -= qty * avgTotalArs;
        s.net_invested_ars   -= qty * avgNetArs;
      }

      if (s.qty <= 0.0000001) {
        s.qty = 0; s.total_invested_usd = 0; s.total_invested_local = 0;
        s.net_invested_usd = 0; s.net_invested_local = 0;
        s.total_invested_ars = 0; s.net_invested_ars = 0;
      }

    } else if (t.type === 'FX_CONVERSION') {
      // Por ahora no afecta positions — se puede extender
      console.log(`[recalculator] FX_CONVERSION ignorada para ${posTicker}`);
    }
  }

  return state;
}

/**
 * Convierte el estado calculado a un row listo para UPSERT en positions.
 *
 * amount_local es siempre GBP para todos los tickers (incluido ARS_CASH —
 * el server convierte ARS→USD→GBP antes de insertar la transaction).
 * Los campos _gbp y fx_gbp_usd_avg son por lo tanto siempre correctos y
 * el resto del sistema (portfolio, analytics, briefing) no necesita cambios.
 *
 * Para ARS_CASH además se populan qty_ars, initial_investment_ars, net_invested_ars
 * con los valores nativos en pesos, para uso futuro (display, reporting en ARS).
 */
function stateToRow(posTicker, s) {
  const qty   = Math.max(0, s.qty);  // ARS for ARS_CASH, units for others
  const isARS = s.currency === 'ARS';

  const invUsd = s.total_invested_usd;
  const invGbp = s.total_invested_local;  // always GBP
  const netUsd = Math.max(0, s.net_invested_usd);
  const netGbp = Math.max(0, s.net_invested_local);

  // fx_gbp_usd_avg: USD-per-GBP (~1.35) — same derivation for all tickers
  const fxGbpUsdAvg = invGbp > 0 ? Math.round((invUsd / invGbp) * 100000) / 100000 : null;

  // fx_usd_ars_avg: ARS-per-USD (~1414) — only for ARS_CASH
  // Derived as total ARS invested / total USD invested (weighted average)
  const fxUsdArsAvg = isARS && invUsd > 0
    ? Math.round((s.total_invested_ars / invUsd) * 100) / 100
    : null;

  // avg_cost_usd: USD value per unit
  //   Non-ARS: total_usd / qty (price paid in USD per share/coin)
  //   ARS:     1 / fx_usd_ars_avg = USD per 1 ARS (~0.000707)
  const avgCostUsd = isARS
    ? (fxUsdArsAvg ? Math.round((1 / fxUsdArsAvg) * 1e8) / 1e8 : null)
    : (qty > 0 ? Math.round((invUsd / qty) * 1000) / 1000 : null);

  // avg_cost_gbp: GBP value per unit
  //   Non-ARS: total_gbp / qty
  //   ARS:     avg_cost_usd / fx_gbp_usd_avg = GBP per 1 ARS (~0.000522)
  const avgCostGbp = isARS
    ? (avgCostUsd && fxGbpUsdAvg ? Math.round((avgCostUsd / fxGbpUsdAvg) * 1e8) / 1e8 : null)
    : (qty > 0 && invGbp > 0 ? Math.round((invGbp / qty) * 1000) / 1000 : null);

  return {
    ticker:                   posTicker,
    name:                     s.name,
    category:                 s.category,
    qty:                      isARS ? Math.round(Math.max(0, qty)) : Math.round(qty * 1e8) / 1e8,
    currency:                 s.currency,
    avg_cost_usd:             avgCostUsd,
    avg_cost_gbp:             avgCostGbp,
    fx_gbp_usd_avg:           fxGbpUsdAvg,
    fx_usd_ars_avg:           fxUsdArsAvg,
    initial_investment_usd:   Math.round(invUsd * 100) / 100,
    initial_investment_gbp:   Math.round(invGbp * 100) / 100,
    initial_investment_ars:   isARS ? Math.round(s.total_invested_ars * 100) / 100 : null,
    net_invested_usd:         Math.round(netUsd * 100) / 100,
    net_invested_gbp:         Math.round(netGbp * 100) / 100,
    net_invested_ars:         isARS ? Math.round(Math.max(0, s.net_invested_ars) * 100) / 100 : null,
    total_fees_local:         Math.round(s.total_fees_local * 100) / 100,
    pricing_currency:         s.pricing_currency,
    exchange:                 s.exchange,
    managed_by:               'transactions',
    updated_at:               new Date().toISOString(),
  };
}

/**
 * Función principal. Lee transactions, calcula, hace UPSERT en positions.
 * Solo actualiza updated_at cuando los valores cambian.
 *
 * @returns {{ updated: string[], inserted: string[], errors: string[] }}
 */
async function recalculatePositions() {
  const supabase = getSupabase();
  const result   = { updated: [], inserted: [], errors: [] };

  console.log('[recalculator] Iniciando recálculo de positions...');

  // 1. Leer todas las transactions
  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select('*');

  if (txError) {
    const msg = `Error leyendo transactions: ${txError.message}`;
    console.error('[recalculator]', msg);
    result.errors.push(msg);
    return result;
  }

  if (!transactions?.length) {
    console.log('[recalculator] No hay transactions, nada que recalcular.');
    return result;
  }

  console.log(`[recalculator] ${transactions.length} transactions leídas.`);

  // 2. Calcular weighted average por ticker
  const calculated = calculateFromTransactions(transactions);
  const newRows     = Object.entries(calculated).map(([ticker, s]) => stateToRow(ticker, s));

  console.log(`[recalculator] Tickers calculados: ${newRows.map(r => r.ticker).join(', ')}`);

  // 3. Leer posiciones actuales (solo managed_by = 'transactions') para comparar
  const { data: existing, error: posError } = await supabase
    .from('positions')
    .select('*')
    .eq('managed_by', 'transactions');

  if (posError) {
    const msg = `Error leyendo positions: ${posError.message}`;
    console.error('[recalculator]', msg);
    result.errors.push(msg);
    return result;
  }

  const existingMap = Object.fromEntries((existing || []).map(p => [p.ticker, p]));

  // 4. UPSERT solo si los valores cambiaron
  const FIELDS_TO_COMPARE = [
    'qty', 'avg_cost_usd', 'avg_cost_gbp', 'fx_gbp_usd_avg',
    'initial_investment_usd', 'initial_investment_gbp',
    'net_invested_usd', 'net_invested_gbp',
    'total_fees_local'
  ];
  const TEXT_FIELDS_TO_COMPARE = ['category'];

  const toUpsert = [];

  for (const row of newRows) {
    const curr = existingMap[row.ticker];

    if (!curr) {
      toUpsert.push(row);
      result.inserted.push(row.ticker);
      console.log(`[recalculator] NUEVO ticker: ${row.ticker}`);
      continue;
    }

    const numChanged = FIELDS_TO_COMPARE.some(f => {
      const a = Number(curr[f]) || 0;
      const b = Number(row[f])  || 0;
      return Math.abs(a - b) > 0.000001;
    });
    const txtChanged = TEXT_FIELDS_TO_COMPARE.some(f => curr[f] !== row[f]);
    const changed = numChanged || txtChanged;

    if (changed) {
      toUpsert.push(row);
      result.updated.push(row.ticker);
    } else {
      console.log(`[recalculator] Sin cambios: ${row.ticker}`);
      // No actualiza updated_at si no hay cambios
      delete row.updated_at;
    }
  }

  if (!toUpsert.length) {
    console.log('[recalculator] Nada cambió, sin UPSERTs.');
    return result;
  }

  const { error: upsertError } = await supabase
    .from('positions')
    .upsert(toUpsert, { onConflict: 'ticker' });

  if (upsertError) {
    const msg = `Error en UPSERT: ${upsertError.message}`;
    console.error('[recalculator]', msg);
    result.errors.push(msg);
  } else {
    console.log(`[recalculator] UPSERT OK — insertados: [${result.inserted.join(', ')}] actualizados: [${result.updated.join(', ')}]`);
  }

  return result;
}

module.exports = { recalculatePositions };
