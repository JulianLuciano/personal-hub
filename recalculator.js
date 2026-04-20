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
        qty:                    0,
        total_invested_usd:     0,
        total_invested_local:   0,
        total_fees_local:       0,
        // Acumulador paralelo: solo capital fresco (is_reinvestment = false)
        net_invested_usd:       0,
        net_invested_local:     0,
        // ARS only: GBP-equivalent accumulators (amount_usd / fx_gbp_usd at tx time)
        // Used so _gbp fields and fx_gbp_usd_avg are meaningful (~1.35) instead of ARS/USD (~1400)
        total_invested_gbp_equiv: 0,
        net_invested_gbp_equiv:   0,
        // Metadata (tomada del primer registro, no cambia)
        name:                   t.name          || null,
        category:               resolveCategory(t.asset_class),
        currency:               t.local_currency || 'GBP',
        pricing_currency:       t.pricing_currency || 'USD',
        exchange:               t.exchange      || null,
        local_currency:         t.local_currency || 'GBP',
      };
    }

    const s           = state[posTicker];
    const qty         = Number(t.qty)            || 0;
    const amtUsd      = Number(t.amount_usd)     || 0;
    const amtLoc      = Number(t.amount_local)   || 0;
    const fee         = Number(t.fee_local)      || 0;
    const isReinvest  = t.is_reinvestment === true;
    // For ARS: amount_local = ARS (not GBP), so _gbp fields need a GBP equivalent.
    // GBP equiv = amount_usd * fx_gbp_usd_at_tx_time. That rate isn't stored in the
    // transaction, so we use amount_usd * FX_FALLBACK (1.35). This is acceptable:
    // fx_gbp_usd_avg for ARS_CASH is informational only and not used for P&L calculations.
    const isARSTx  = s.currency === 'ARS';
    const gbpEquiv = isARSTx ? amtUsd * 1.35 : amtLoc;

    if (t.type === 'BUY') {
      s.qty                      += qty;
      s.total_invested_usd       += amtUsd;
      s.total_invested_local     += amtLoc;
      s.total_invested_gbp_equiv += gbpEquiv;
      s.total_fees_local         += fee;
      // Solo suma a net_invested si es capital fresco
      if (!isReinvest) {
        s.net_invested_usd       += amtUsd;
        s.net_invested_local     += amtLoc;
        s.net_invested_gbp_equiv += gbpEquiv;
      }

    } else if (t.type === 'RSU_VEST') {
      // RSU siempre es capital real, nunca reinversión
      s.qty                      += qty;
      s.total_invested_usd       += amtUsd;
      s.total_invested_local     += amtLoc;
      s.total_invested_gbp_equiv += gbpEquiv;
      s.total_fees_local         += fee;
      s.net_invested_usd         += amtUsd;
      s.net_invested_local       += amtLoc;
      s.net_invested_gbp_equiv   += gbpEquiv;

    } else if (t.type === 'SELL') {
      // Descuenta costo proporcional al qty vendido en ambos acumuladores
      const avgTotalUsd  = s.qty > 0 ? s.total_invested_usd       / s.qty : 0;
      const avgTotalLoc  = s.qty > 0 ? s.total_invested_local     / s.qty : 0;
      const avgTotalGbp  = s.qty > 0 ? s.total_invested_gbp_equiv / s.qty : 0;
      const avgNetUsd    = s.qty > 0 ? s.net_invested_usd         / s.qty : 0;
      const avgNetLoc    = s.qty > 0 ? s.net_invested_local       / s.qty : 0;
      const avgNetGbp    = s.qty > 0 ? s.net_invested_gbp_equiv   / s.qty : 0;

      s.qty                      -= qty;
      s.total_invested_usd       -= qty * avgTotalUsd;
      s.total_invested_local     -= qty * avgTotalLoc;
      s.total_invested_gbp_equiv -= qty * avgTotalGbp;
      s.net_invested_usd         -= qty * avgNetUsd;
      s.net_invested_local       -= qty * avgNetLoc;
      s.net_invested_gbp_equiv   -= qty * avgNetGbp;
      s.total_fees_local         += fee;

      // Reset si quedó en cero (o negativo por floating point)
      if (s.qty <= 0.0000001) {
        s.qty                      = 0;
        s.total_invested_usd       = 0;
        s.total_invested_local     = 0;
        s.total_invested_gbp_equiv = 0;
        s.net_invested_usd         = 0;
        s.net_invested_local       = 0;
        s.net_invested_gbp_equiv   = 0;
        // total_fees_local se acumula histórico, no se resetea
      }

    } else if (t.type === 'DEPOSIT') {
      s.qty                      += qty;
      s.total_invested_usd       += amtUsd;
      s.total_invested_local     += amtLoc;
      s.total_invested_gbp_equiv += gbpEquiv;
      // Solo suma a net_invested si es capital fresco
      if (!isReinvest) {
        s.net_invested_usd       += amtUsd;
        s.net_invested_local     += amtLoc;
        s.net_invested_gbp_equiv += gbpEquiv;
      }

    } else if (t.type === 'WITHDRAWAL') {
      // Descuenta costo proporcional al qty retirado en ambos acumuladores
      const avgTotalUsd  = s.qty > 0 ? s.total_invested_usd       / s.qty : 0;
      const avgTotalLoc  = s.qty > 0 ? s.total_invested_local     / s.qty : 0;
      const avgTotalGbp  = s.qty > 0 ? s.total_invested_gbp_equiv / s.qty : 0;
      const avgNetUsd    = s.qty > 0 ? s.net_invested_usd         / s.qty : 0;
      const avgNetLoc    = s.qty > 0 ? s.net_invested_local       / s.qty : 0;
      const avgNetGbp    = s.qty > 0 ? s.net_invested_gbp_equiv   / s.qty : 0;

      s.qty                      -= qty;
      s.total_invested_usd       -= qty * avgTotalUsd;
      s.total_invested_local     -= qty * avgTotalLoc;
      s.total_invested_gbp_equiv -= qty * avgTotalGbp;
      s.net_invested_usd         -= qty * avgNetUsd;
      s.net_invested_local       -= qty * avgNetLoc;
      s.net_invested_gbp_equiv   -= qty * avgNetGbp;

      if (s.qty <= 0.0000001) {
        s.qty                      = 0;
        s.total_invested_usd       = 0;
        s.total_invested_local     = 0;
        s.total_invested_gbp_equiv = 0;
        s.net_invested_usd         = 0;
        s.net_invested_local       = 0;
        s.net_invested_gbp_equiv   = 0;
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
 * Convenciones por moneda:
 *   GBP: amount_local=GBP, amount_usd=GBP*fx  → _gbp fields = GBP, fx_gbp_usd_avg = USD/GBP (~1.35)
 *   USD: amount_local=GBP equiv, amount_usd=USD → mismo tratamiento que GBP
 *   ARS: amount_local=ARS, amount_usd=ARS/fx   → _gbp fields deben ser GBP equiv = usd * fx_gbp_usd
 *        fx_gbp_usd_avg no se puede derivar de amount_local/amount_usd (eso da ARS/USD ~1400)
 *        En su lugar: fx_gbp_usd_avg = acumulado de (amtUsd * fxGbpUsd) / amtUsd total
 *        Lo aproximamos con total_invested_gbp_equiv que acumulamos en el state para ARS.
 */
function stateToRow(posTicker, s) {
  const qty    = Math.max(0, s.qty);
  const isARS  = s.currency === 'ARS';

  const invUsd = s.total_invested_usd;
  const netUsd = Math.max(0, s.net_invested_usd);

  // For ARS: _local fields hold ARS (not GBP), so we use the GBP-equiv accumulators instead
  // For GBP/USD: _local fields hold GBP as usual
  const invGbp = isARS ? s.total_invested_gbp_equiv : s.total_invested_local;
  const netGbp = isARS ? Math.max(0, s.net_invested_gbp_equiv) : Math.max(0, s.net_invested_local);

  const avgCostUsd = qty > 0 ? invUsd / qty : null;
  const avgCostGbp = qty > 0 && invGbp > 0 ? invGbp / qty : null;

  // fx_gbp_usd_avg: USD-per-GBP (~1.35)
  // For ARS: derive from gbp_equiv and usd accumulators
  // For GBP/USD: derive from usd / local (existing logic)
  const fxAvg = isARS
    ? (invGbp > 0 ? Math.round((invUsd / invGbp) * 100000) / 100000 : null)
    : (invGbp > 0 ? Math.round((invUsd / invGbp) * 100000) / 100000 : null);

  return {
    ticker:                   posTicker,
    name:                     s.name,
    category:                 s.category,
    qty:                      Math.round(qty * 1e8) / 1e8,
    currency:                 s.currency,
    avg_cost_usd:             avgCostUsd !== null ? Math.round(avgCostUsd * 1000) / 1000 : null,
    avg_cost_gbp:             avgCostGbp !== null ? Math.round(avgCostGbp * 1000) / 1000 : null,
    fx_gbp_usd_avg:           fxAvg,
    initial_investment_usd:   Math.round(invUsd * 100) / 100,
    initial_investment_gbp:   Math.round(invGbp * 100) / 100,
    net_invested_usd:         Math.round(netUsd * 100) / 100,
    net_invested_gbp:         Math.round(netGbp * 100) / 100,
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
