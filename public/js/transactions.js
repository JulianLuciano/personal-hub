// ── Transaction Panel ────────────────────────────────────────────────────────

const TX_DEFAULTS = { broker: 'Trading212', exchange: 'NASDAQ', feeLocal: '0.15' };

const TX_TICKER_META = {
  'MELI':    { name: 'Mercado Libre',       assetClass: 'acciones', exchange: 'NASDAQ', pricing: 'USD' },
  'SPY':     { name: 'S&P 500 ETF',         assetClass: 'acciones', exchange: 'NYSE',   pricing: 'USD' },
  'BRK.B':   { name: 'Berkshire Hathaway',  assetClass: 'acciones', exchange: 'NYSE',   pricing: 'USD' },
  'NU':      { name: 'Nu Holdings',         assetClass: 'acciones', exchange: 'NYSE',   pricing: 'USD' },
  'MSFT':    { name: 'Microsoft',           assetClass: 'acciones', exchange: 'NASDAQ', pricing: 'USD' },
  'META':    { name: 'Meta RSU',            assetClass: 'rsu',      exchange: 'NASDAQ', pricing: 'USD' },
  'VWRP.L': { name: 'Vanguard All World',   assetClass: 'acciones', exchange: 'LSE',    pricing: 'GBP' },
  'ARKK.L': { name: 'ARK Innovation ETF',  assetClass: 'acciones', exchange: 'LSE',    pricing: 'USD' },
  'NDIA.L': { name: 'India ETF',           assetClass: 'acciones', exchange: 'LSE',    pricing: 'USD' },
  'BTC':     { name: 'Bitcoin',             assetClass: 'cripto',   exchange: '',       pricing: 'USD' },
};

let _txPricingCurrency = 'USD';
let _txDbPricingCurrency = 'USD';

function setDbPricingCurrency(cur) {
  _txDbPricingCurrency = cur;
  const usdBtn = document.getElementById('txPricingDbUSD');
  const gbpBtn = document.getElementById('txPricingDbGBP');
  if (!usdBtn || !gbpBtn) return;
  if (cur === 'USD') {
    usdBtn.style.cssText = 'padding:3px 10px;border-radius:6px;border:1.5px solid var(--accent);background:rgba(108,99,255,0.15);color:var(--accent);font-size:11px;font-weight:700;cursor:pointer';
    gbpBtn.style.cssText = 'padding:3px 10px;border-radius:6px;border:1.5px solid var(--border);background:none;color:var(--muted);font-size:11px;font-weight:700;cursor:pointer';
  } else {
    gbpBtn.style.cssText = 'padding:3px 10px;border-radius:6px;border:1.5px solid var(--accent);background:rgba(108,99,255,0.15);color:var(--accent);font-size:11px;font-weight:700;cursor:pointer';
    usdBtn.style.cssText = 'padding:3px 10px;border-radius:6px;border:1.5px solid var(--border);background:none;color:var(--muted);font-size:11px;font-weight:700;cursor:pointer';
  }
}

function openTxPanel() {
  document.getElementById('txDate').value = new Date().toISOString().slice(0, 10);
  setTxStatus('', '');
  _txPricingCurrency = 'USD';
  setPricingCurrency('USD');
  setDbPricingCurrency('USD');
  document.getElementById('txOverlay').classList.add('open');
  document.getElementById('txPanel').classList.add('open');
}

function closeTxPanel() {
  document.getElementById('txOverlay').classList.remove('open');
  document.getElementById('txPanel').classList.remove('open');
}

function setTxStatus(msg, type) {
  const el = document.getElementById('txStatus');
  el.textContent = msg;
  el.className = 'tx-status' + (type ? ' ' + type : '');
}

function setPricingCurrency(cur) {
  _txPricingCurrency = cur;
  setDbPricingCurrency(cur);  // keep db toggle in sync by default
  const usdBtn = document.getElementById('txPricingUSD');
  const gbpBtn = document.getElementById('txPricingGBP');
  const mainLabel    = document.getElementById('txPriceMainLabel');
  const derivedLabel = document.getElementById('txPriceDerivedLabel');
  if (cur === 'USD') {
    usdBtn.style.cssText = 'flex:1;padding:7px;border-radius:8px;border:1.5px solid var(--accent);background:rgba(108,99,255,0.15);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer';
    gbpBtn.style.cssText = 'flex:1;padding:7px;border-radius:8px;border:1.5px solid var(--border);background:none;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer';
    mainLabel.textContent    = 'Price USD';
    derivedLabel.textContent = 'Price GBP';
  } else {
    gbpBtn.style.cssText = 'flex:1;padding:7px;border-radius:8px;border:1.5px solid var(--accent);background:rgba(108,99,255,0.15);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer';
    usdBtn.style.cssText = 'flex:1;padding:7px;border-radius:8px;border:1.5px solid var(--border);background:none;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer';
    mainLabel.textContent    = 'Price GBP';
    derivedLabel.textContent = 'Price USD';
  }
  recalcDerivedPrice();
}

function recalcDerivedPrice() {
  const main = getTxNum('txPriceMain');
  const fx   = getTxNum('txFxRate');
  if (!main || !fx) return;
  const derived = _txPricingCurrency === 'USD' ? (main / fx) : (main * fx);
  document.getElementById('txPriceDerived').value = derived;
}

function getPriceUsd() {
  const main = getTxNum('txPriceMain');
  const fx   = getTxNum('txFxRate');
  if (_txPricingCurrency === 'USD') return main;
  return fx ? main * fx : 0;
}

function getPriceLocal() {
  const main = getTxNum('txPriceMain');
  const fx   = getTxNum('txFxRate');
  if (_txPricingCurrency === 'GBP') return main;
  return fx ? main / fx : 0;
}

async function onTxTickerBlur() {
  const ticker = document.getElementById('txTicker').value.trim().toUpperCase();
  if (!ticker) return;
  const meta = TX_TICKER_META[ticker];
  if (meta) {
    document.getElementById('txName').value       = meta.name;
    document.getElementById('txAssetClass').value = meta.assetClass;
    document.getElementById('txExchange').value   = meta.exchange;
    if (ticker === 'META') {
      document.getElementById('txType').value     = 'RSU_VEST';
      document.getElementById('txBroker').value   = 'Schwab';
      document.getElementById('txFeeLocal').value = '0.00';
    }
    if (meta.pricing === 'GBP') setPricingCurrency('GBP');
  } else {
    try {
      const res  = await fetch(`/api/db/positions?ticker=eq.${encodeURIComponent(ticker)}&select=name,category`);
      const rows = await res.json();
      if (rows?.[0]?.name) {
        document.getElementById('txName').value       = rows[0].name;
        document.getElementById('txAssetClass').value = rows[0].category || 'acciones';
      }
    } catch(e) {}
  }
}

function onTxTypeChange() {
  const type = document.getElementById('txType').value;
  if (type === 'RSU_VEST') {
    document.getElementById('txBroker').value     = 'Schwab';
    document.getElementById('txFeeLocal').value   = '0.00';
    document.getElementById('txAssetClass').value = 'rsu';
  } else {
    document.getElementById('txBroker').value   = 'Trading212';
    document.getElementById('txFeeLocal').value = TX_DEFAULTS.feeLocal;
  }
  // Reinvestment toggle: visible only for BUY (RSU_VEST is always fresh capital)
  const reinvestRow = document.getElementById('txReinvestRow');
  if (reinvestRow) {
    reinvestRow.style.display = (type === 'BUY') ? 'flex' : 'none';
    if (type !== 'BUY') document.getElementById('txIsReinvestment').checked = false;
  }
}

function onTxBrokerChange() {
  document.getElementById('txBrokerOther').style.display =
    document.getElementById('txBroker').value === '_other' ? 'block' : 'none';
}

function onTxExchangeChange() {
  document.getElementById('txExchangeOther').style.display =
    document.getElementById('txExchange').value === '_other' ? 'block' : 'none';
}

function getTxBrokerValue() {
  const sel = document.getElementById('txBroker').value;
  if (sel === '_other') return document.getElementById('txBrokerOther').value.trim() || null;
  return sel;
}

function getTxExchangeValue() {
  const sel = document.getElementById('txExchange').value;
  if (sel === '_other') return document.getElementById('txExchangeOther').value.trim() || null;
  if (sel === '') return null;
  return sel;
}

async function fetchTxPrice() {
  const ticker = document.getElementById('txTicker').value.trim().toUpperCase();
  if (!ticker) { setTxStatus('Ingresá un ticker primero', 'err'); return; }
  const btn = document.getElementById('txFetchBtn');
  btn.disabled = true; btn.textContent = '...';
  setTxStatus('Buscando precio y FX...', '');
  const YAHOO_MAP = { 'BRK.B': 'BRK-B', 'BTC': 'BTC-USD', 'ADA': 'ADA-USD', 'ETH': 'ETH-USD', 'SOL': 'SOL-USD' };
  const yahooTicker = YAHOO_MAP[ticker] || ticker;
  try {
    const [mktRes, fxRes] = await Promise.all([
      fetch(`/api/market-data?tickers=${encodeURIComponent(yahooTicker)}`),
      fetch(`/api/market-data?tickers=GBPUSD%3DX`),
    ]);
    const mktJson = await mktRes.json();
    const fxJson  = await fxRes.json();
    const data    = mktJson.data?.[yahooTicker];
    const fxData  = fxJson.data?.['GBPUSD=X'];
    const msgs    = [];
    if (fxData?.regularMarketPrice) {
      document.getElementById('txFxRate').value = fxData.regularMarketPrice.toFixed(5);
      msgs.push(`FX: ${fxData.regularMarketPrice.toFixed(4)}`);
    }
    if (data?.regularMarketPrice) {
      document.getElementById('txPriceMain').value = data.regularMarketPrice;
      onTxPriceMainChange();
      msgs.push(`Precio: $${data.regularMarketPrice}`);
    } else {
      setTxStatus('No se encontró precio', 'err');
    }
    if (msgs.length) setTxStatus(msgs.join(' · '), 'ok');
  } catch(e) {
    setTxStatus('Error al buscar precio', 'err');
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Live';
  }
}

function getTxNum(id) { return parseFloat(document.getElementById(id).value) || 0; }

function recalcAmounts() {
  const priceUsd = getPriceUsd();
  const fx       = getTxNum('txFxRate');
  const qty      = getTxNum('txQty');
  if (qty && priceUsd) {
    document.getElementById('txAmountUsd').value   = qty * priceUsd;
    if (fx) document.getElementById('txAmountLocal').value = qty * priceUsd / fx;
  }
}

function onTxPriceMainChange() {
  recalcDerivedPrice();
  recalcAmounts();
}

function onTxFxChange() {
  recalcDerivedPrice();
  recalcAmounts();
}

function onTxQtyChange() {
  recalcAmounts();
}

async function submitTransaction() {
  const ticker      = document.getElementById('txTicker').value.trim().toUpperCase();
  const name        = document.getElementById('txName').value.trim() || ticker;
  const type        = document.getElementById('txType').value;
  const assetClass  = document.getElementById('txAssetClass').value;
  const date        = document.getElementById('txDate').value;
  const qty         = parseFloat(document.getElementById('txQty').value);
  const amountUsd   = parseFloat(document.getElementById('txAmountUsd').value);
  const amountLocal = parseFloat(document.getElementById('txAmountLocal').value);
  const feeLocal    = parseFloat(document.getElementById('txFeeLocal').value) || 0;
  const fxRate      = parseFloat(document.getElementById('txFxRate').value)   || null;
  const broker      = getTxBrokerValue();
  const exchange    = getTxExchangeValue();
  const notes       = document.getElementById('txNotes').value.trim() || null;
  const priceUsd    = getPriceUsd() || null;
  const priceLocal  = getPriceLocal() || null;
  const meta        = TX_TICKER_META[ticker];
  const pricingCurrency = _txDbPricingCurrency;
  const isReinvestment  = document.getElementById('txIsReinvestment')?.checked === true;

  if (!ticker)             { setTxStatus('Ticker requerido', 'err'); return; }
  if (!date)               { setTxStatus('Fecha requerida', 'err'); return; }
  if (!qty || isNaN(qty))  { setTxStatus('Qty requerida', 'err'); return; }
  if (!amountUsd  || isNaN(amountUsd))   { setTxStatus('Amount USD requerido', 'err'); return; }
  if (!amountLocal || isNaN(amountLocal)){ setTxStatus('Amount GBP requerido', 'err'); return; }

  const btn = document.getElementById('txSubmitBtn');
  btn.disabled = true;
  setTxStatus('Guardando...', '');

  const payload = {
    date, ticker, name, type,
    asset_class:      assetClass,
    qty:              qty.toString(),
    price_usd:        priceUsd,
    price_local:      priceLocal,
    amount_usd:       amountUsd,
    amount_local:     amountLocal,
    fee_local:        feeLocal,
    fx_rate_to_usd:   fxRate,
    local_currency:   'GBP',
    pricing_currency: pricingCurrency,
    exchange,
    broker,
    notes,
    is_reinvestment: isReinvestment,
  };

  try {
    const insertRes = await fetch('/api/db/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(payload),
    });
    if (!insertRes.ok) {
      const err = await insertRes.text();
      setTxStatus('Error: ' + err.slice(0, 80), 'err');
      btn.disabled = false;
      return;
    }
    setTxStatus('Guardado. Recalculando...', '');
    const recalcRes = await fetch('/api/recalculate-positions', { method: 'POST' });
    const recalc    = await recalcRes.json();
    if (recalc.ok) {
      const n = (recalc.updated?.length || 0) + (recalc.inserted?.length || 0);
      setTxStatus(`✓ Listo — ${n} posición(es) actualizadas`, 'ok');
    } else {
      setTxStatus('Guardado, error en recálculo: ' + (recalc.error || ''), 'err');
    }
    if (document.getElementById('txHistoryBody').classList.contains('open')) loadTxHistory();
    ['txQty','txPriceMain','txPriceDerived','txAmountUsd','txAmountLocal','txFxRate','txNotes'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('txFeeLocal').value = TX_DEFAULTS.feeLocal;
  } catch(e) {
    setTxStatus('Error inesperado: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function toggleTxHistory() {
  const toggle = document.getElementById('txHistToggle');
  const body   = document.getElementById('txHistoryBody');
  const isOpen = body.classList.contains('open');
  toggle.classList.toggle('open', !isOpen);
  body.classList.toggle('open', !isOpen);
  if (!isOpen) loadTxHistory();
}

async function loadTxHistory() {
  const container = document.getElementById('txHistoryContent');
  container.innerHTML = '<span style="color:var(--muted)">Cargando...</span>';
  try {
    const res  = await fetch('/api/db/transactions?order=date.desc&limit=30');
    const rows = await res.json();
    if (!rows?.length) {
      container.innerHTML = '<span style="color:var(--muted);font-size:13px">Sin transacciones</span>';
      return;
    }
    const fmt      = v => v != null ? Number(v).toLocaleString('es-AR', { maximumFractionDigits: 4 }) : '—';
    const fmtDate  = d => d ? d.slice(5).replace('-', '/') : '—';
    const typeLabel = { BUY: 'Compra', SELL: 'Venta', RSU_VEST: 'RSU', FX_CONVERSION: 'FX' };
    container.innerHTML = `
      <div style="overflow-x:auto;margin-top:8px">
        <table class="tx-hist-table">
          <thead><tr>
            <th>Fecha</th><th>Ticker</th><th>Tipo</th><th>Qty</th><th>£ Total</th><th>Fee</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${fmtDate(r.date)}</td>
              <td style="font-weight:700">${r.ticker}</td>
              <td><span class="tx-hist-badge ${r.type}">${typeLabel[r.type] || r.type}</span></td>
              <td>${fmt(r.qty)}</td>
              <td>${fmt(r.amount_local)}</td>
              <td>${fmt(r.fee_local)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch(e) {
    container.innerHTML = '<span style="color:var(--accent2)">Error al cargar historial</span>';
  }
}

// ── OCR ───────────────────────────────────────────────────────────────────────

async function handleTxImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const btn = document.getElementById('txOcrBtn');
  btn.innerHTML = '⏳ <span>Leyendo...</span>';
  btn.disabled = true;
  setTxStatus('Procesando imagen...', '');

  try {
    // Comprimir imagen a max 1200px y calidad 0.85 — suficiente para OCR, reduce tamaño ~80%
    const base64 = await compressImageToBase64(file, 1200, 0.85);
    const mediaType = 'image/jpeg'; // canvas siempre exporta jpeg

    setTxStatus('Leyendo screenshot...', '');

    const res = await fetch('/api/ocr-transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mediaType }),
    });

    const json = await res.json();

    if (!json.ok || !json.transaction) {
      setTxStatus('Error: ' + (json.error || JSON.stringify(json)), 'err');
      return;
    }

    fillFormFromOcr(json.transaction);
    const conf = json.transaction.confidence;
    setTxStatus(
      conf === 'high'   ? '✓ Screenshot leído correctamente' :
      conf === 'medium' ? '✓ Leído — verificá precio y qty' :
                          '⚠ Leído con baja confianza — revisá todo',
      conf === 'high' ? 'ok' : ''
    );
    // Botón verde por 3 segundos
    btn.innerHTML = '✅ <span>Leído</span>';
    btn.style.background = 'linear-gradient(135deg,#22c55e,#16a34a)';
    setTimeout(() => {
      btn.innerHTML = '📷 <span>Leer screen</span>';
      btn.style.background = 'linear-gradient(135deg,var(--accent),#a78bfa)';
    }, 3000);

  } catch(e) {
    setTxStatus('Error: ' + e.message, 'err');
  } finally {
    btn.innerHTML = '📷 <span>Leer screen</span>';
    btn.disabled = false;
    event.target.value = '';
  }
}

function compressImageToBase64(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Calcular dimensiones manteniendo aspect ratio
      let w = img.width;
      let h = img.height;
      if (w > maxWidth) {
        h = Math.round(h * maxWidth / w);
        w = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      // Exportar como JPEG base64 (sin el prefijo data:...)
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo cargar la imagen')); };
    img.src = url;
  });
}

function fillFormFromOcr(tx) {
  const ASSET_CLASS_MAP  = { stock: 'acciones', cripto: 'cripto', rsu: 'rsu', fiat: 'fiat' };
  const KNOWN_EXCHANGES  = ['NASDAQ', 'NYSE', 'LSE', ''];

  // Ticker
  if (tx.ticker) document.getElementById('txTicker').value = tx.ticker;

  // Name — usa TX_TICKER_META como fallback si OCR no trajo nombre
  const metaName = TX_TICKER_META[tx.ticker]?.name;
  document.getElementById('txName').value = tx.name || metaName || '';

  // Type
  if (tx.type) document.getElementById('txType').value = tx.type;

  // Asset class — Kraken siempre es cripto independientemente de lo que diga el OCR
  const ac = tx.broker === 'Kraken' ? 'cripto' : (ASSET_CLASS_MAP[tx.asset_class] || tx.asset_class || 'acciones');
  document.getElementById('txAssetClass').value = ac;

  // Date
  if (tx.date) document.getElementById('txDate').value = tx.date;

  // Pricing currency toggle
  const pricing = tx.pricing_currency || 'USD';
  setPricingCurrency(pricing);
  // Kraken: precio en GBP pero el activo cotiza en USD
  if (tx.broker === 'Kraken') setDbPricingCurrency('USD');

  // Price
  if (pricing === 'GBP' && tx.price_local) {
    document.getElementById('txPriceMain').value = tx.price_local;
  } else if (pricing === 'USD' && tx.price_usd) {
    document.getElementById('txPriceMain').value = tx.price_usd;
  }

  // FX rate
  if (tx.fx_rate_to_usd) document.getElementById('txFxRate').value = tx.fx_rate_to_usd;

  recalcDerivedPrice();

  // Qty
  if (tx.qty) document.getElementById('txQty').value = tx.qty;

  // Amounts — calcular con lógica consistente
  const feeVal      = parseFloat(tx.fee_local) || 0;
  const amtLocalRaw = parseFloat(tx.amount_local) || 0;
  const fxVal       = parseFloat(tx.fx_rate_to_usd) || 0;

  // amount_local siempre = total_gbp - fee (aplica a Trading212 y Kraken)
  const amtLocal = amtLocalRaw - feeVal;

  // amount_usd = amount_local * fx_rate (si hay fx rate)
  const amtUsd = tx.amount_usd
    ? parseFloat(tx.amount_usd)
    : (fxVal ? amtLocal * fxVal : 0);

  if (amtLocal) document.getElementById('txAmountLocal').value = amtLocal;
  if (amtUsd)   document.getElementById('txAmountUsd').value   = amtUsd;

  // Fee
  document.getElementById('txFeeLocal').value = tx.fee_local ?? 0;

  // Broker
  const brokerSel  = document.getElementById('txBroker');
  const brokerOpts = Array.from(brokerSel.options).map(o => o.value);
  if (tx.broker && brokerOpts.includes(tx.broker)) {
    brokerSel.value = tx.broker;
    document.getElementById('txBrokerOther').style.display = 'none';
  } else if (tx.broker) {
    brokerSel.value = '_other';
    document.getElementById('txBrokerOther').style.display = 'block';
    document.getElementById('txBrokerOther').value = tx.broker;
  }

  // Exchange — OCR primero, luego TX_TICKER_META como fallback
  const exchFromMeta = TX_TICKER_META[tx.ticker]?.exchange ?? null;
  const exchVal      = tx.exchange !== undefined ? tx.exchange : exchFromMeta;
  const exchSel      = document.getElementById('txExchange');

  if (exchVal === null || exchVal === '') {
    exchSel.value = '';
    document.getElementById('txExchangeOther').style.display = 'none';
  } else if (KNOWN_EXCHANGES.includes(exchVal)) {
    exchSel.value = exchVal;
    document.getElementById('txExchangeOther').style.display = 'none';
  } else {
    exchSel.value = '_other';
    document.getElementById('txExchangeOther').style.display = 'block';
    document.getElementById('txExchangeOther').value = exchVal;
  }

  // Notes
  if (tx.notes) document.getElementById('txNotes').value = tx.notes;
}

// ── Saldos / manual positions ──────────────────────────────────────────────

let _saldosData = [];

function switchTxTab(tab) {
  const txForm         = document.getElementById('txForm');
  const txHistSection  = document.getElementById('txHistorySection');
  const saldosPane     = document.getElementById('saldosPane');
  const tabTx          = document.getElementById('tabTx');
  const tabSaldos      = document.getElementById('tabSaldos');
  const ocrBtn         = document.getElementById('txOcrBtn');
  const title          = document.getElementById('txPanelTitle');

  if (tab === 'saldos') {
    txForm.style.display        = 'none';
    if (txHistSection) txHistSection.style.display = 'none';
    saldosPane.style.display    = 'block';
    tabTx.classList.remove('active');
    tabSaldos.classList.add('active');
    if (ocrBtn) ocrBtn.style.display = 'none';
    title.textContent = 'Saldos';
    loadSaldos();
  } else {
    txForm.style.display        = 'block';
    if (txHistSection) txHistSection.style.display = 'block';
    saldosPane.style.display    = 'none';
    tabTx.classList.add('active');
    tabSaldos.classList.remove('active');
    if (ocrBtn) ocrBtn.style.display = 'flex';
    title.textContent = 'Nueva transacción';
  }
}

async function loadSaldos() {
  const listEl = document.getElementById('saldosList');
  listEl.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">Cargando...</div>';
  try {
    // Include fiat positions managed by transactions (after first save they migrate)
    const [manual, fiatTx] = await Promise.all([
      sbFetch('/rest/v1/positions?select=*&managed_by=eq.manual'),
      sbFetch('/rest/v1/positions?select=*&managed_by=eq.transactions&category=eq.fiat'),
    ]);
    _saldosData = [...manual, ...fiatTx];
    renderSaldos();
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--accent2);font-size:13px;text-align:center;padding:16px">${e.message}</div>`;
  }
}

function renderSaldos() {
  const listEl = document.getElementById('saldosList');
  if (!_saldosData.length) {
    listEl.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0">No hay posiciones manuales.</div>';
    return;
  }

  const rate = FX_RATE || 0.79;  // GBP-per-USD, used for display conversion

  listEl.innerHTML = _saldosData.map(pos => {
    const meta        = TICKER_META[pos.ticker] || { name: pos.name || pos.ticker, logo: '💰' };
    const isGBP       = pos.currency === 'GBP';
    const isUSD       = pos.currency === 'USD';
    const qty         = Number(pos.qty) || 0;
    const valueUSD    = isGBP ? qty / rate : qty;
    const valueGBP    = isGBP ? qty : qty * rate;
    const currSymbol  = isGBP ? '£' : '$';
    const secSymbol   = isGBP ? '$' : '£';
    const secVal      = isGBP ? valueUSD : valueGBP;

    // FX display: always "USD per GBP" (~1.27), i.e. 1/FX_RATE
    // pos.fx_gbp_usd_avg is stored as USD-per-GBP in the DB (same convention as transactions)
    const fxDisplay = pos.fx_gbp_usd_avg
      ? Number(pos.fx_gbp_usd_avg).toFixed(5)
      : (1 / rate).toFixed(5);

    const logoHtml = TICKER_META[pos.ticker]?.logoUrl
      ? `<img src="${TICKER_META[pos.ticker].logoUrl}" style="width:28px;height:28px;border-radius:50%;object-fit:cover"
           onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
         <span style="display:none;font-size:22px">${meta.logo || '💰'}</span>`
      : `<span style="font-size:22px">${meta.logo || '💰'}</span>`;

    // Show FX row for both GBP and USD positions
    const showFxRow = isGBP || isUSD;
    const fxLabel   = isGBP ? 'FX £→$' : 'FX $→£';

    return `
      <div class="saldo-card" id="saldo-${pos.ticker}" onclick="toggleSaldoEdit('${pos.ticker}')">
        <div class="saldo-main-row">
          <div class="saldo-logo">${logoHtml}</div>
          <div class="saldo-info">
            <div class="saldo-name">${meta.name || pos.name || pos.ticker}</div>
            <div class="saldo-meta">${pos.ticker}${pos.notes ? ' · ' + pos.notes : ''}</div>
          </div>
          <div class="saldo-value">
            <div class="saldo-amount">${currSymbol}${Math.round(qty).toLocaleString('es-AR')}</div>
            <div class="saldo-amount-secondary">${secSymbol}${Math.round(secVal).toLocaleString('es-AR')}</div>
          </div>
        </div>
        <div class="saldo-edit-row" onclick="event.stopPropagation()">
          <div class="saldo-edit-line1">
            <input class="saldo-input" id="saldo-input-${pos.ticker}" type="number"
              value="${qty}" step="${isGBP ? 100 : 1}" placeholder="${currSymbol}0"
              onkeydown="if(event.key==='Enter') saveSaldo('${pos.ticker}')">
            ${showFxRow ? `
            <span style="font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0">${fxLabel}</span>
            <input id="saldo-fx-${pos.ticker}" type="number"
              value="${fxDisplay}" step="0.0001" placeholder="1.34"
              style="width:72px;flex-shrink:0;font-size:12px;padding:7px 6px;border-radius:8px;border:1.5px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--font-num);text-align:right;outline:none">
            <button onclick="fetchSaldoFx('${pos.ticker}');event.stopPropagation()"
              id="saldo-fx-btn-${pos.ticker}"
              style="font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--accent);cursor:pointer;white-space:nowrap;flex-shrink:0">⚡</button>
            ` : ''}
          </div>
          <div class="reinvest-row" style="margin-top:2px">
            <input type="checkbox" id="saldo-reinvest-${pos.ticker}">
            <label for="saldo-reinvest-${pos.ticker}">Reinversión — no suma al cost basis</label>
          </div>
          <button class="saldo-save-btn" onclick="saveSaldo('${pos.ticker}')">Guardar</button>
        </div>
      </div>`;
  }).join('');
}

async function fetchSaldoFx(ticker) {
  const btn   = document.getElementById('saldo-fx-btn-' + ticker);
  const input = document.getElementById('saldo-fx-' + ticker);
  if (!input) return;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const res  = await fetch('/api/market-data?tickers=GBPUSD%3DX');
    const json = await res.json();
    const fx   = json.data?.['GBPUSD=X']?.regularMarketPrice;
    if (fx) input.value = fx.toFixed(5);
  } catch(e) {
    // silently fail — user can type manually
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Live'; }
  }
}

function toggleSaldoEdit(ticker) {
  const card = document.getElementById('saldo-' + ticker);
  if (!card) return;
  const isEditing = card.classList.contains('editing');
  // Cierra todos primero
  document.querySelectorAll('.saldo-card.editing').forEach(c => c.classList.remove('editing'));
  if (!isEditing) {
    card.classList.add('editing');
    // Auto-fetch live FX when opening the card
    fetchSaldoFx(ticker);
  }
}

async function saveSaldo(ticker) {
  const statusEl = document.getElementById('saldosStatus');
  const inp      = document.getElementById('saldo-input-' + ticker);
  if (!inp) return;

  const newQty = parseFloat(inp.value);
  if (isNaN(newQty) || newQty < 0) {
    statusEl.style.color = 'var(--accent2)';
    statusEl.textContent = 'Valor inválido.';
    return;
  }

  // Read FX input if present (GBP and USD positions)
  const fxInp  = document.getElementById('saldo-fx-' + ticker);
  const fxRate = fxInp ? (parseFloat(fxInp.value) || (1 / (FX_RATE || 0.79))) : undefined;

  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Guardando...';

  try {
    const body = { ticker, qty: newQty };
    if (fxRate !== undefined) body.fx_rate = fxRate;
    const reinvestChk = document.getElementById('saldo-reinvest-' + ticker);
    if (reinvestChk) body.is_reinvestment = reinvestChk.checked === true;

    const res  = await fetch('/api/positions/manual', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error del servidor');

    // Actualizar estado local y re-render
    const pos = _saldosData.find(p => p.ticker === ticker);
    if (pos) pos.qty = newQty;
    renderSaldos();

    statusEl.style.color = 'var(--accent3)';
    statusEl.textContent = data.message === 'Sin cambios' ? '— Sin cambios' : `✓ ${ticker} actualizado`;
    setTimeout(() => { statusEl.textContent = ''; }, 3000);

    // Recargar portfolio en background
    loadPortfolio().catch(() => {});

  } catch (e) {
    statusEl.style.color = 'var(--accent2)';
    statusEl.textContent = 'Error: ' + e.message;
  }
}

// ── END Saldos ──────────────────────────────────────────────────────────────
