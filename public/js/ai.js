// ── AI CHAT ────────────────────────────────────────────────────────────────
const aiHistory = [];

function buildMacroContext() {
  const md = window._macroData || {};
  if (!Object.keys(md).length) return null;

  const f2  = v => v != null ? Number(v).toFixed(2) : '—';
  const sgn = v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';

  let tsv = 'MACRO\nticker|label|value|unit|7d|30d|trend\n';
  Object.entries(md).forEach(([ticker, d]) => {
    if (!d || d.current == null) return;
    tsv += `${ticker}|${d.label}|${f2(d.current)}|${d.unit}|${sgn(d.chg7d)}|${sgn(d.chg30d)}|${d.trend}\n`;
  });
  return tsv.trim();
}

function buildWatchlistContext() {
  const wl = window._watchlistMeta || {};
  if (!Object.keys(wl).length) return null;

  const f2   = v => (v != null) ? Number(v).toFixed(2) : '';
  const fPct = v => (v != null) ? (Number(v) * 100).toFixed(2) + '%' : '';
  const fCap = v => v ? '$' + (v / 1e9).toFixed(1) + 'B' : '';
  const rPos = (p, lo, hi) => (!p || !lo || !hi || hi === lo) ? '' : ((p - lo) / (hi - lo) * 100).toFixed(0) + '%';
  const RL = { 1:'StrongBuy', 2:'Buy', 3:'Hold', 4:'Underperf', 5:'Sell' };

  const GROUPS = {
    'Core':      ['SPY','MELI','NU','BRK-B','VWRP.L'],
    'MegaTech':  ['GOOGL','NVDA','AAPL','TSLA','MSFT','AMZN','TSM'],
    'Defensive': ['KO','MCD','WMT','JNJ','XOM'],
    'ETF_US':    ['QQQ','DIA','IWM','VNQ','XLK','XLF','XLE','SOXX','ICLN'],
    'Dividend':  ['VIG','SCHD'],
    'EM':        ['EEM','INDA','EWZ','ARGT','ILF'],
    'China':     ['FXI','KWEB','BABA'],
    'Latam':     ['YPF','PBR','GGAL'],
    'Bonds':     ['TLT','IEF','HYG'],
    'UK':        ['IGLT.L','VUKE.L'],
    'Commod':    ['GLD','SLV','USO','PDBC'],
    'Crypto':    ['BTC-USD','ETH-USD','ADA-USD','SOL-USD'],
  };

  let tsv = 'WATCHLIST\ngroup|ticker|name|β|PE|fwdPE|yield|52wLo|52wHi|pos52w|target|consensus|nAnalysts|earnings|cap\n';
  Object.entries(GROUPS).forEach(([group, tickers]) => {
    tickers.forEach(t => {
      const d = wl[t];
      if (!d) return;
      const p = d.regularMarketPrice;
      tsv += [group, t, (d.name||'').replace(/,.*/, ''),
        f2(d.beta), f2(d.trailingPE), f2(d.forwardPE), fPct(d.dividendYield),
        f2(d.fiftyTwoWeekLow), f2(d.fiftyTwoWeekHigh), rPos(p, d.fiftyTwoWeekLow, d.fiftyTwoWeekHigh),
        f2(d.analystTarget), d.analystRating != null ? (RL[Math.round(d.analystRating)] || f2(d.analystRating)) : '',
        d.numberOfAnalysts || '', d.nextEarningsDate || '', fCap(d.marketCap)
      ].join('|') + '\n';
    });
  });
  return tsv.trim();
}

function buildHealthContext() {
  if (typeof computeHealthData !== 'function') return '';
  const d = computeHealthData();
  if (!d) return '';

  const topStock = d.topNonBroadETF.ticker === 'RSU_META' ? 'META' : d.topNonBroadETF.ticker;
  const sectors = Object.entries(d.sectorMap).sort((a, b) => b[1] - a[1]).map(([s, w]) => `${s} ${(w*100).toFixed(0)}%`).join(', ');

  let ctx = 'HEALTH_SCORE\n';
  ctx += `total: ${d.healthScore}/100 (weights: diversification 20%, risk_alignment 20%, valuation 15%, currency 15%, concentration 15%, income 15%)\n`;
  ctx += `note: excludes RENT_DEPOSIT + EMERGENCY_FUND from all scores except currency_exposure + income_momentum\n\n`;

  ctx += 'HEALTH_METRICS\n';
  ctx += `diversification: score ${d.subscores[0].score} | HHI_norm ${(d.hhiNorm*100).toFixed(1)}% | effective_positions ${d.effectiveN.toFixed(1)} | computed_over: investments_only (no cash/fiat)\n`;
  ctx += `risk_alignment: score ${d.subscores[1].score} | portfolio_beta ${d.portfolioBeta.toFixed(2)} | vol_est ${d.portfolioVol.toFixed(1)}% | correction_est -${d.ddCorrection.toFixed(0)}% | bear_est -${d.ddBearMarket.toFixed(0)}% | beta_includes_cash_at_0\n`;
  ctx += `valuation: score ${d.subscores[2].score}` + (d.portfolioPE ? ` | fwd_PE ${d.portfolioPE.toFixed(1)}x vs SPY ~21x` : ' | no PE data') + ` | investments_only\n`;
  ctx += `currency: score ${d.subscores[3].score} | GBP ${(d.gbpPct*100).toFixed(0)}% USD ${(d.usdPct*100).toFixed(0)}% | GBP=fiat_gbp+pricing_currency_GBP | USD=stocks+RSU+crypto\n`;
  ctx += `concentration: score ${d.subscores[4].score} | top_stock ${topStock} ${(d.topNonBroadETF.w*100).toFixed(1)}% | broad_ETFs (SPY,VWRP) exempt from penalty\n`;
  ctx += `income: score ${d.subscores[5].score} | annual_flow/portfolio ${(d.incomeRatio*100).toFixed(0)}% | denominator_includes_emergency_fund\n`;
  ctx += `sectors: ${sectors}\n`;

  return ctx;
}

function buildMarketContext() {
  const mm = window._marketMeta || {};

  const FALLBACK = {
    'META':    { beta: 1.3,  trailingPE: 25 },
    'SPY':     { beta: 1.0,  trailingPE: 22, dividendYield: 0.013 },
    'VWRP.L':  { beta: 0.95, trailingPE: 18 },
    'BRK-B':   { beta: 0.9,  trailingPE: 22 },
    'BTC-USD': { beta: 1.8 },
    'MELI':    { beta: 1.6,  trailingPE: 55 },
    'NU':      { beta: 1.5,  trailingPE: 40 },
    'ARKK':    { beta: 1.4 },
    'ARKK.L':  { beta: 1.4 },
  };

  const f2   = v => (v != null) ? Number(v).toFixed(2) : '';
  const fPct = v => (v != null) ? (Number(v) * 100).toFixed(2) + '%' : '';
  const fCap = v => v ? '$' + (v / 1e9).toFixed(1) + 'B' : '';
  const rPos = (p, lo, hi) => (!p || !lo || !hi || hi === lo) ? '' : ((p - lo) / (hi - lo) * 100).toFixed(0) + '%';
  const RL = { 1:'StrongBuy', 2:'Buy', 3:'Hold', 4:'Underperf', 5:'Sell' };

  const liveTickers  = Object.keys(mm);
  const allTickers   = [...new Set([...liveTickers, ...Object.keys(FALLBACK)])];
  const tickers      = allTickers.filter(t => mm[t] || FALLBACK[t]);

  let tsv = 'MARKET_FUNDAMENTALS\nsource: ' + (liveTickers.length > 0 ? 'Yahoo Finance live' : 'static fallbacks') + '\n';
  tsv += 'ticker|β|PE|fwdPE|P/B|yield|52wLo|52wHi|pos52w|MA50|MA200|price|target|consensus|nAnalysts|earnings|cap|shortRatio\n';

  tickers.forEach(t => {
    const live = mm[t] || {};
    const fb   = FALLBACK[t] || {};
    const price = live.regularMarketPrice ?? null;
    const lo52  = live.fiftyTwoWeekLow ?? null;
    const hi52  = live.fiftyTwoWeekHigh ?? null;
    // BRK.B P/B from Yahoo is a known data error
    const ptb   = (t === 'BRK.B' || t === 'BRK-B') ? null : (live.priceToBook ?? null);

    tsv += [t,
      f2(live.beta ?? fb.beta), f2(live.trailingPE ?? fb.trailingPE), f2(live.forwardPE),
      f2(ptb), fPct(live.dividendYield ?? fb.dividendYield),
      f2(lo52), f2(hi52), rPos(price, lo52, hi52),
      f2(live.fiftyDayAvg), f2(live.twoHundredDayAvg), f2(price),
      f2(live.analystTarget),
      live.analystRating != null ? (RL[Math.round(live.analystRating)] || f2(live.analystRating)) : '',
      live.numberOfAnalysts || '', live.nextEarningsDate || '', fCap(live.marketCap),
      f2(live.shortRatio)
    ].join('|') + '\n';
  });

  tsv += '\nCORRELATIONS_VS_SPY: META~0.70|VWRP.L~0.92|BRK-B~0.65|BTC~0.25|MELI~0.65|NU~0.55|ARKK~0.80';
  return tsv.trim();
}

function buildPortfolioContext() {
  if (!liveData) return 'Portfolio data not loaded yet.';
  const { totalUSD, changeUSD, breakdown, assets } = liveData;
  const rate = FX_RATE;
  const fG = v => '£' + Math.round(v * rate).toLocaleString('es-AR');
  const fU = v => '$' + Math.round(v).toLocaleString('en-US');

  const chgPct = totalUSD > 0 && changeUSD !== 0 ? (changeUSD / (totalUSD - changeUSD) * 100) : 0;

  let ctx = `PORTFOLIO\ntotal: ${fU(totalUSD)} (${fG(totalUSD)}) | day_change: ${changeUSD >= 0 ? '+' : ''}${fU(changeUSD)} (${changeUSD >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)\nfx: 1 USD = ${rate.toFixed(4)} GBP\n\n`;

  ctx += 'ALLOCATION\n';
  const cats = [
    ['acciones', breakdown.acciones],
    ['cripto', breakdown.cripto],
    ['rsu', breakdown.rsu],
    ['cash_liquid', breakdown.fiat_liquid],
    ['cash_locked', breakdown.fiat_locked],
  ];
  cats.forEach(([k, v]) => {
    if (v) ctx += `${k}: ${fU(v)} (${(v/totalUSD*100).toFixed(1)}%)\n`;
  });

  ctx += '\nPOSITIONS\nticker|name|weight%|value|qty|price|avg_cost|invested|pnl_usd%|pnl_gbp%|pnl_abs|day%\n';
  assets.filter(a => a.valueUSD > 0.5).forEach(({ pos, valueUSD, priceUSD, pctUSD, pctGBP, dayPct }) => {
    const meta = TICKER_META[pos.ticker] || { name: pos.ticker };
    const w = totalUSD > 0 ? (valueUSD / totalUSD * 100).toFixed(1) : '—';
    const pnlAbs = pctUSD !== null && pos.initial_investment_usd ? fU(valueUSD - Number(pos.initial_investment_usd)) : '';
    ctx += [pos.ticker, meta.name, w, fU(valueUSD), pos.qty,
      priceUSD ? '$' + priceUSD.toFixed(2) : '',
      pos.avg_cost_usd ? '$' + Number(pos.avg_cost_usd).toFixed(2) : '',
      pos.initial_investment_usd ? fU(Number(pos.initial_investment_usd)) : '',
      pctUSD !== null ? (pctUSD >= 0 ? '+' : '') + pctUSD.toFixed(2) + '%' : '',
      pctGBP !== null ? (pctGBP >= 0 ? '+' : '') + pctGBP.toFixed(2) + '%' : '',
      pnlAbs,
      dayPct !== null ? (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%' : ''
    ].join('|') + '\n';
  });

  // RSU vesting
  ctx += '\nRSU_META\n';
  const rsuP = getRSUPriceUSD();
  ctx += `meta_price: $${rsuP.toFixed(2)} | tax_rate: 47% | net_rate: 53%\n`;

  if (vestSchedule && vestSchedule.length > 0) {
    const upcoming = vestSchedule.filter(v => !v.vested);
    const vested   = vestSchedule.filter(v => v.vested);
    const totalU = vestSchedule.reduce((s,v) => s + v.units, 0);
    const vestedU = vested.reduce((s,v) => s + v.units, 0);
    const pendingU = upcoming.reduce((s,v) => s + v.units, 0);
    const accumBruto = upcoming.reduce((s,v) => s + v.units * rsuP, 0);
    const accumNeto  = accumBruto * NET_RATE;

    ctx += `total_units: ${totalU} | vested: ${vestedU} (${Math.round(vestedU/totalU*100)}%) | pending: ${pendingU}\n`;
    ctx += `pending_gross: ${fU(accumBruto)} | pending_net: ${fU(accumNeto)} (${fG(accumNeto)})\n`;

    if (upcoming.length > 0) {
      ctx += '\nVEST_SCHEDULE_PENDING\ndate|days|units|gross|net\n';
      upcoming.forEach(v => {
        const vU = v.units * rsuP;
        ctx += `${v.date}|${v.days}d|${v.units}|${fU(vU)}|${fU(vU * NET_RATE)}\n`;
      });
    }
    if (vested.length > 0) {
      ctx += '\nVEST_HISTORY\n';
      vested.forEach(v => ctx += `${v.date}: ${v.units} units (vested)\n`);
    }
  }

  return ctx.trim();
}

let aiModel = 'sonnet'; // 'sonnet' or 'opus'
const AI_MODELS = {
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-6'
};

function setAiModel(m) {
  aiModel = m;
  const sEl = document.getElementById('aiModelSonnet');
  const oEl = document.getElementById('aiModelOpus');
  if (m === 'sonnet') {
    sEl.style.background = 'var(--accent)'; sEl.style.color = '#fff';
    oEl.style.background = 'transparent'; oEl.style.color = 'var(--muted)';
  } else {
    oEl.style.background = 'linear-gradient(135deg, #e8824a, #d4602a)'; oEl.style.color = '#fff';
    sEl.style.background = 'transparent'; sEl.style.color = 'var(--muted)';
  }
}

function openAIChat() {
  document.getElementById('aiModal').classList.add('open');
  const app = document.getElementById('app');
  app.style.overflow = 'hidden';
  app.style.touchAction = 'none';
  setTimeout(() => document.getElementById('aiInput').focus(), 300);
}

// Wire textarea keyboard behavior once DOM is ready
(function() {
  function setupAiInput() {
    const input = document.getElementById('aiInput');
    if (!input) return;

    function resize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    input.addEventListener('input', resize);

    input.addEventListener('keydown', function(e) {
      // Shift+Enter → send
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        aiSendMsg();
        return;
      }

      if (e.key === 'Enter') {
        const val = input.value;
        const cursor = input.selectionStart;
        // Find current line
        const lineStart = val.lastIndexOf('\n', cursor - 1) + 1;
        const currentLine = val.slice(lineStart, cursor);

        // If current line is ONLY a bullet/number prefix (no content) → break out of list
        if (/^(\d+\. |[-•] )$/.test(currentLine)) {
          e.preventDefault();
          input.value = val.slice(0, lineStart) + val.slice(cursor);
          input.selectionStart = input.selectionEnd = lineStart;
          resize();
          return;
        }

        // If current line starts with a numbered bullet → auto-continue
        const numberedMatch = currentLine.match(/^(\d+)\. /);
        if (numberedMatch) {
          e.preventDefault();
          const nextNum = parseInt(numberedMatch[1]) + 1;
          const prefix = nextNum + '. ';
          const insert = '\n' + prefix;
          input.value = val.slice(0, cursor) + insert + val.slice(cursor);
          input.selectionStart = input.selectionEnd = cursor + insert.length;
          resize();
          return;
        }

        // Default: let Enter insert newline naturally (no preventDefault)
        setTimeout(resize, 0);
      }
    });
  }

  // Run after DOM — script is at bottom so this fires immediately
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAiInput);
  } else {
    setupAiInput();
  }
})();
function closeAIChat() {
  document.getElementById('aiModal').classList.remove('open');
  const app = document.getElementById('app');
  app.style.overflow = '';
  app.style.touchAction = '';
}
function aiQuick(msg) {
  document.getElementById('aiInput').value = msg;
  aiSendMsg();
}

async function aiSendMsg() {
  const input = document.getElementById('aiInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';

  // Add user message
  aiAddMsg('user', msg);
  aiHistory.push({ role: 'user', content: msg });

  // Thinking indicator with animated states
  const thinkingEl = aiAddMsg('thinking', '');
  thinkingEl.innerHTML = '<span class="ai-thinking-text">Analizando tu portfolio</span><span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';
  // Cycle through thinking messages
  const thinkingMsgs = ['Analizando tu portfolio', 'Procesando datos', 'Calculando métricas', 'Preparando respuesta'];
  let tmIdx = 0;
  const tmInterval = setInterval(() => {
    tmIdx = (tmIdx + 1) % thinkingMsgs.length;
    const textEl = thinkingEl.querySelector('.ai-thinking-text');
    if (textEl) textEl.textContent = thinkingMsgs[tmIdx];
  }, 1800);
  thinkingEl._tmInterval = tmInterval;

  try {
    const watchlistSection = buildWatchlistContext();
    const macroSection     = buildMacroContext();

    // Calculate USD vs GBP exposure dynamically from live portfolio
    let usdExposurePct = null;
    if (liveData && liveData.totalUSD > 0) {
      const usdAssets = liveData.assets.filter(a => {
        const pos = a.pos;
        const isGBP = (pos.category === 'fiat' && pos.currency === 'GBP') || pos.pricing_currency === 'GBP';
        return !isGBP;
      });
      const usdTotal = usdAssets.reduce((s, a) => s + a.valueUSD, 0);
      usdExposurePct = (usdTotal / liveData.totalUSD * 100).toFixed(0);
    }
    const fxLine = usdExposurePct !== null
      ? `FX risk: gana y gasta en GBP, pero ~${usdExposurePct}% del portfolio cotiza en USD — movimientos GBP/USD impactan directamente su patrimonio en libras`
      : `FX risk: gana y gasta en GBP, portfolio mixto USD/GBP — movimientos GBP/USD impactan su patrimonio en libras`;

    const systemPrompt = `Sos el asesor financiero personal de Julián. Respondé en español, directo y conciso. No uses markdown excesivo.

PROFILE
location: London, UK | currency: GBP | monthly_expenses: £4000
savings: £900-1000/mo | bonus_net: £9000-10000/yr (Mar+Sep, 50/50) | rsu: META quarterly ~£2500-2800 net/vest
emergency_fund: £2500 (EMERGENCY_FUND position, separate from GBP_LIQUID), intocable
cash_available: GBP_LIQUID = excedente para invertir (actualmente £500 aprox)
horizon: 5+ years | max_drawdown: 20% | no immediate liquidity needs beyond emergency fund
goals: £30k (end 2026) | £100k (end 2028) | £200k (end 2030)

CASHFLOW_ANALYSIS
annual_investable: ~£20k-22k salary+bonus + ~£11k-12k RSUs = £31k-34k/yr
promotion_possible_2-3yr: bonus +10%, savings +20%, RSUs +15% (no guarantee)
key_dates: Mar+Sep (bonus), quarterly (RSU vest)

RULES
- ${fxLine}
- META concentration risk: RSUs + held shares = largest single exposure
- VIX >30=panic, >20=elevated, <15=calm
- US10Y rising = pressure on growth + long bonds
- GBP/USD up = USD portfolio worth less in GBP
- Bonus months (Mar/Sep) = key investment decision points
- Promotion delta should go to investing, not expenses
- Use all provided data (fundamentals, macro, watchlist) for analysis

${buildPortfolioContext()}

${buildHealthContext()}
${buildMarketContext()}
${macroSection     ? '\n' + macroSection     : ''}
${watchlistSection ? '\n' + watchlistSection : ''}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': await getAnthropicKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: AI_MODELS[aiModel],
        max_tokens: aiModel === 'opus' ? 2048 : 1024,
        system: systemPrompt,
        messages: aiHistory.slice(-8) // keep last 8 turns for context
      })
    });

    const data = await res.json();
    clearInterval(thinkingEl._tmInterval);
    thinkingEl.remove();

    if (data.error) {
      aiAddMsg('assistant', '⚠️ Error: ' + (data.error.message || 'No se pudo conectar con la IA.'));
      aiHistory.pop();
      return;
    }

    const reply = data.content?.[0]?.text || '(sin respuesta)';
    aiAddMsg('assistant', reply);
    aiHistory.push({ role: 'assistant', content: reply });

  } catch(e) {
    clearInterval(thinkingEl._tmInterval);
    thinkingEl.remove();
    aiAddMsg('assistant', '⚠️ Error de conexión: ' + e.message);
    aiHistory.pop();
  }
}

async function getAnthropicKey() {
  // Fetch from server endpoint (keeps key out of frontend code)
  if (window._anthropicKey) return window._anthropicKey;
  const res = await fetch('/api/config');
  const cfg = await res.json();
  window._anthropicKey = cfg.anthropicKey;
  return window._anthropicKey;
}

function aiRenderMarkdown(text) {
  // Escape HTML first
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Tables: detect lines with | and render as table
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // Check if next line is separator (|---|---|)
      const sep = lines[i+1] || '';
      if (/^\|[-| :]+\|$/.test(sep.trim())) {
        const ths = line.split('|').slice(1,-1).map(c => '<th>' + c.trim() + '</th>').join('');
        const tableRows = [];
        i += 2; // skip header + separator
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          const cells = lines[i].split('|').slice(1,-1).map(c => '<td>' + c.trim() + '</td>').join('');
          tableRows.push('<tr>' + cells + '</tr>');
          i++;
        }
        out.push('<table class="ai-table"><thead><tr>' + ths + '</tr></thead><tbody>' + tableRows.join('') + '</tbody></table>');
        continue;
      }
    }
    out.push(line);
    i++;
  }
  text = out.join('\n');
  // Bold **text**
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic *text* (not inside words)
  text = text.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  // Headers
  text = text.replace(/^### (.+)$/gm, '<div class="ai-h3">$1</div>');
  text = text.replace(/^## (.+)$/gm, '<div class="ai-h2">$1</div>');
  text = text.replace(/^# (.+)$/gm, '<div class="ai-h1">$1</div>');
  // Bullet lists
  text = text.replace(/^[-•] (.+)$/gm, '<div class="ai-li">• $1</div>');
  // Newlines to <br>
  text = text.replace(/\n/g, '<br>');
  // Clean up extra <br> after block divs
  text = text.replace(/(<\/div>)<br>/g, '$1');
  text = text.replace(/<br>(<div)/g, '$1');
  return text;
}

function aiAddMsg(role, text) {
  const msgs = document.getElementById('aiMessages');
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  if (role === 'assistant' && text) {
    el.innerHTML = aiRenderMarkdown(text);
  } else {
    el.textContent = text;
  }
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}
// ── END AI CHAT ─────────────────────────────────────────────────────────────
