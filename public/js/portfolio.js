async function loadPortfolio() {
  try {
    // Fetch positions
    const posData = await sbFetch('/rest/v1/positions?select=*');

    // Enrich TICKER_META names from DB — so adding new tickers never requires code changes
    posData.forEach(p => {
      if (!p.ticker || !p.name) return;
      if (TICKER_META[p.ticker]) {
        TICKER_META[p.ticker].name = p.name;  // always trust DB name
      } else {
        // New ticker not in TICKER_META yet — create a minimal entry
        TICKER_META[p.ticker] = { name: p.name, logo: '💰', logoUrl: null, cat: p.category, showTicker: true };
      }
    });

    // Fetch latest price for each ticker (one call per ticker using limit=1 order)
    const tickers = posData.filter(p => ['acciones','cripto','rsu'].includes(p.category)).map(p => {
      if (p.ticker === 'BTC') return 'BTC-USD';
      if (p.ticker === 'RSU_META') return 'META';
      if (p.ticker === 'BRK.B') return 'BRK-B';
      return p.ticker;
    });

    // Get latest snapshot for all tickers at once — fetch enough to find yesterday's prices
    // Fetch today's latest prices (1 per ticker)
    const priceDataToday = await sbFetch('/rest/v1/price_snapshots?select=ticker,price_usd,captured_at&order=captured_at.desc&limit=200');

    const prices = {};
    const latestTsPerTicker = {};
    function normTicker(t) {
      return t === 'BTC-USD' ? 'BTC' : t === 'BRK-B' ? 'BRK.B' : t === 'META' ? 'RSU_META' : t;
    }
    priceDataToday.forEach(row => {
      const t = normTicker(row.ticker);
      if (!prices[t]) {
        prices[t] = row.price_usd;
        latestTsPerTicker[t] = new Date(row.captured_at).getTime();
      }
    });

    // Helper: has a given exchange opened today (UTC) yet?
    // Returns true if the market has already opened for its first session today.
    // We use UTC time throughout. DST is handled by comparing against UTC offsets:
    //   NYSE/NASDAQ: opens 14:30 UTC (winter/EST) or 13:30 UTC (summer/EDT)
    //     DST in US: 2nd Sun March → 1st Sun Nov. During DST open = 13:30 UTC.
    //   LSE: opens 08:00 UTC (winter/GMT) or 07:00 UTC (summer/BST)
    //     DST in UK: last Sun March → last Sun Oct. During BST open = 07:00 UTC.
    function marketOpenedTodayUTC(exchange) {
      const now = new Date();
      const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
      const month = now.getUTCMonth() + 1; // 1-12
      const day   = now.getUTCDate();
      const dow   = now.getUTCDay(); // 0=Sun

      // Weekends: markets closed, treat as "not opened today"
      if (dow === 0 || dow === 6) return false;

      if (exchange === 'LSE') {
        // BST: last Sunday of March through last Sunday of October
        // Approximation: month 4-9 always BST, Mar/Oct check last-Sunday
        let bst = (month >= 4 && month <= 9);
        if (month === 3) {
          // Last Sunday of March: find last Sun on or before day 31
          const lastSun = 31 - ((new Date(Date.UTC(now.getUTCFullYear(), 2, 31)).getUTCDay() + 7 - 0) % 7);
          bst = day >= lastSun && dow !== 0; // on/after transition (not the Sun itself before 1am)
        } else if (month === 10) {
          const lastSun = 31 - ((new Date(Date.UTC(now.getUTCFullYear(), 9, 31)).getUTCDay() + 7 - 0) % 7);
          bst = day < lastSun;
        }
        const openUTC = bst ? 7.0 : 8.0;
        return utcH >= openUTC;
      } else {
        // NYSE/NASDAQ — EDT (UTC-4) in summer, EST (UTC-5) in winter
        // US DST: 2nd Sunday of March through 1st Sunday of November
        let edt = false;
        if (month > 3 && month < 11) edt = true;
        else if (month === 3) {
          // 2nd Sunday of March
          const firstSun = (7 - new Date(Date.UTC(now.getUTCFullYear(), 2, 1)).getUTCDay()) % 7 + 1;
          const secondSun = firstSun + 7;
          edt = day >= secondSun;
        } else if (month === 11) {
          // 1st Sunday of November
          const firstSun = (7 - new Date(Date.UTC(now.getUTCFullYear(), 10, 1)).getUTCDay()) % 7 + 1;
          edt = day < firstSun;
        }
        const openUTC = edt ? 13.5 : 14.5; // 9:30 ET = 13:30 or 14:30 UTC
        return utcH >= openUTC;
      }
    }

    // Which "day" to use as baseline for each ticker's daily variation:
    // If the market hasn't opened yet today, today's price == yesterday's close
    // so we compare yesterday vs the day before (2d ago).
    // Crypto is always open so always use today vs yesterday.
    function baselineDayForTicker(ticker) {
      if (ticker === 'BTC') return 'today';
      const lseTickers = ['VWRP.L', 'ARKK.L', 'NDIA.L'];
      const exchange = lseTickers.includes(ticker) ? 'LSE' : 'NYSE';
      return marketOpenedTodayUTC(exchange) ? 'today' : 'yesterday';
    }

    const todayUTC     = new Date().toISOString().slice(0, 10);
    const yesterdayUTC = new Date(Date.now() -     24*60*60*1000).toISOString().slice(0, 10);
    const twoDaysUTC   = new Date(Date.now() - 2 * 24*60*60*1000).toISOString().slice(0, 10);

    // Fetch yesterday prices (always needed)
    const ydStart = yesterdayUTC + 'T00:00:00.000Z';
    const ydEnd   = todayUTC     + 'T00:00:00.000Z';
    const priceDataYest = await sbFetch(
      '/rest/v1/price_snapshots?select=ticker,price_usd,captured_at' +
      '&captured_at=gte.' + ydStart + '&captured_at=lt.' + ydEnd +
      '&order=captured_at.desc&limit=500'
    );
    const pricesYesterday = {};
    priceDataYest.forEach(row => {
      const t = normTicker(row.ticker);
      if (!pricesYesterday[t]) pricesYesterday[t] = row.price_usd;
    });

    // Fetch day-before-yesterday prices (needed when market hasn't opened yet)
    const d2Start = twoDaysUTC   + 'T00:00:00.000Z';
    const d2End   = yesterdayUTC + 'T00:00:00.000Z';
    const priceDataD2 = await sbFetch(
      '/rest/v1/price_snapshots?select=ticker,price_usd,captured_at' +
      '&captured_at=gte.' + d2Start + '&captured_at=lt.' + d2End +
      '&order=captured_at.desc&limit=500'
    );
    const pricesDayBefore = {};
    priceDataD2.forEach(row => {
      const t = normTicker(row.ticker);
      if (!pricesDayBefore[t]) pricesDayBefore[t] = row.price_usd;
    });

    console.log('[Portfolio] prices today:', prices);
    console.log('[Portfolio] prices yesterday:', pricesYesterday);
    console.log('[Portfolio] prices day-before:', pricesDayBefore);

    // Get snapshots: select total_usd AND total_gbp for accurate per-currency % change
    const snapData = await sbFetch('/rest/v1/portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate&order=captured_at.desc&limit=150');
    if (snapData.length > 0) {
      FX_RATE = snapData[0].fx_rate;
      lastSnapshotAt = new Date(snapData[0].captured_at);
      updateLastUpdatedLabel();
    }
    const todayDay = snapData.length > 0 ? new Date(snapData[0].captured_at).toISOString().slice(0,10) : null;
    const yesterdaySnap   = snapData.find(s => new Date(s.captured_at).toISOString().slice(0,10) !== todayDay) || null;
    const yesterdayDay    = yesterdaySnap ? new Date(yesterdaySnap.captured_at).toISOString().slice(0,10) : null;
    const dayBeforeSnapObj = yesterdayDay
      ? snapData.find(s => new Date(s.captured_at).toISOString().slice(0,10) !== todayDay && new Date(s.captured_at).toISOString().slice(0,10) !== yesterdayDay)
      : null;

    // Calculate values
    let totalUSD = 0;
    const breakdown = { acciones: 0, cripto: 0, rsu: 0, fiat: 0, fiat_gbp: 0, fiat_usd: 0, fiat_liquid: 0, fiat_locked: 0 };
    const assets = [];

    for (const pos of posData) {
      let valueUSD = 0;
      let priceUSD = null;
      let pricePaidUSD = pos.avg_cost_usd;

      if (pos.category === 'fiat') {
        if (pos.currency === 'GBP') {
          valueUSD = pos.qty / FX_RATE;
          breakdown.fiat_gbp += pos.qty;  // store raw GBP for worker compat
        } else {
          valueUSD = pos.qty;
          breakdown.fiat_usd += pos.qty;
        }
        breakdown.fiat += valueUSD;
        // Track liquid vs locked (rent deposit + receivable = not liquid)
        const isLocked = (pos.ticker === 'RENT_DEPOSIT' || pos.ticker === 'GBP_RECEIVABLE');
        const isEmergency = pos.ticker === 'EMERGENCY_FUND';
        if (isLocked) breakdown.fiat_locked += valueUSD;
        else if (isEmergency) breakdown.fiat_liquid += valueUSD; // emergency counts as liquid
        else breakdown.fiat_liquid += valueUSD;
      } else {
        priceUSD = prices[pos.ticker];

        if (priceUSD) {
          valueUSD = pos.qty * priceUSD;
          const bkey = pos.category === 'cripto' ? 'cripto' : pos.category;
          breakdown[bkey] = (breakdown[bkey] || 0) + valueUSD;
        }
      }

      totalUSD += valueUSD;

      // P&L (vs cost basis) — calculated in both currencies separately
      // because avg_cost_gbp/usd are weighted averages at time-of-purchase FX rates
      let pctUSD = null, pctGBP = null;
      if (priceUSD) {
        const avgUSD = Number(pos.avg_cost_usd);
        const avgGBP = Number(pos.avg_cost_gbp);
        if (avgUSD) pctUSD = ((priceUSD - avgUSD) / avgUSD) * 100;
        if (avgGBP && FX_RATE) {
          const priceGBP = priceUSD * FX_RATE;
          pctGBP = ((priceGBP - avgGBP) / avgGBP) * 100;
        }
      }

      // Daily variation in USD — baseline depends on whether market opened today
      let dayPct = null, dayPctGBP = null;
      const baseline = baselineDayForTicker(pos.ticker === 'RSU_META' ? 'META' : pos.ticker);
      // FX rates for daily GBP calculation — from portfolio_snapshots (price_snapshots is USD-only)
      const fxToday = snapData.length > 0 ? Number(snapData[0].fx_rate) : FX_RATE;
      const fxYest  = yesterdaySnap ? Number(yesterdaySnap.fx_rate) : FX_RATE;
      const fxD2    = dayBeforeSnapObj ? Number(dayBeforeSnapObj.fx_rate) : fxYest;
      if (baseline === 'today') {
        // Normal: today's price vs yesterday's close
        const prevPrice = pricesYesterday[pos.ticker];
        if (priceUSD && prevPrice) {
          dayPct = ((priceUSD - prevPrice) / prevPrice) * 100;
          // GBP version: convert each price to GBP at the FX of that day's snapshot
          const priceGBP     = priceUSD   * fxToday;
          const prevPriceGBP = prevPrice  * fxYest;
          dayPctGBP = ((priceGBP - prevPriceGBP) / prevPriceGBP) * 100;
        }
      } else {
        // Market hasn't opened yet: compare yesterday's close vs day-before close
        const prevPrice = pricesYesterday[pos.ticker];
        const d2Price   = pricesDayBefore[pos.ticker];
        if (prevPrice && d2Price) {
          dayPct = ((prevPrice - d2Price) / d2Price) * 100;
          const prevPriceGBP = prevPrice * fxYest;
          const d2PriceGBP   = d2Price   * fxD2;
          dayPctGBP = ((prevPriceGBP - d2PriceGBP) / d2PriceGBP) * 100;
        }
      }

      assets.push({ pos, valueUSD, priceUSD, pctUSD, pctGBP, dayPct, dayPctGBP });
    }

    // ── Cost basis: total capital ever deployed (investments + current cash) ──
    // Fiat: always use current qty (face value) — it IS the current value, no P&L possible.
    //   This means moving cash → investment doesn't change total cost basis:
    //   fiat drops by X, investment initial_investment rises by X → net zero.
    // Non-fiat: use initial_investment (what you actually paid), fallback to avg_cost × qty.
    let costBasisUSD = 0;
    let costBasisGBP = 0;
    for (const pos of posData) {
      if (pos.category === 'fiat') {
        // Always use live qty — fiat has no P&L, its "cost" = its current balance
        const qty = Number(pos.qty) || 0;
        if (pos.currency === 'GBP') {
          costBasisGBP += qty;
          costBasisUSD += qty / FX_RATE;
        } else {
          costBasisUSD += qty;
          costBasisGBP += qty * FX_RATE;
        }
      } else {
        // Non-fiat: use initial_investment in native currency, fallback to avg_cost × qty
        const invUSD = Number(pos.initial_investment_usd);
        const invGBP = Number(pos.initial_investment_gbp);
        if (invUSD) {
          costBasisUSD += invUSD;
        } else {
          const avg = Number(pos.avg_cost_usd);
          if (avg) costBasisUSD += avg * Number(pos.qty);
        }
        if (invGBP) {
          costBasisGBP += invGBP;
        } else {
          const avg = Number(pos.avg_cost_gbp);
          if (avg) costBasisGBP += avg * Number(pos.qty);
        }
      }
    }

    // ── Portfolio daily change ──────────────────────────────────────────────────
    // Both USD and GBP changes are computed from the snapshot table's NATIVE values.
    // snapData[0].total_gbp is the GBP total recorded by the worker at that moment
    // (with its own FX rate) — no conversion from totalUSD needed.
    // USD change uses live totalUSD (bottom-up) vs yesterday snapshot — that's intentional:
    // it captures price moves that happened since the last snapshot.
    // GBP change uses snapData[0].total_gbp (latest today snapshot) vs yesterday snapshot —
    // both come from the table and carry their own FX, so the diff is clean.
    let changeUSD = 0, changeGBP = 0;
    const lseOpened = marketOpenedTodayUTC('LSE');
    const todaySnap = snapData.length > 0 ? snapData[0] : null; // most recent snapshot (today)
    if (lseOpened) {
      // Normal: today vs yesterday
      if (todaySnap && yesterdaySnap) {
        changeUSD = totalUSD - Number(yesterdaySnap.total_usd);
        const todayGBP = Number(todaySnap.total_gbp) || (Number(todaySnap.total_usd) * (Number(todaySnap.fx_rate) || FX_RATE));
        const prevGBP  = Number(yesterdaySnap.total_gbp) || (Number(yesterdaySnap.total_usd) * (Number(yesterdaySnap.fx_rate) || FX_RATE));
        changeGBP = todayGBP - prevGBP;
      }
    } else {
      // Pre-market: yesterday vs day-before
      if (yesterdaySnap && dayBeforeSnapObj) {
        changeUSD = Number(yesterdaySnap.total_usd) - Number(dayBeforeSnapObj.total_usd);
        const yGBP  = Number(yesterdaySnap.total_gbp)    || (Number(yesterdaySnap.total_usd)    * (Number(yesterdaySnap.fx_rate)    || FX_RATE));
        const d2GBP = Number(dayBeforeSnapObj.total_gbp)  || (Number(dayBeforeSnapObj.total_usd) * (Number(dayBeforeSnapObj.fx_rate)  || FX_RATE));
        changeGBP = yGBP - d2GBP;
      } else if (todaySnap && yesterdaySnap) {
        // Fallback: market hasn't opened but no day-before snapshot available
        changeUSD = totalUSD - Number(yesterdaySnap.total_usd);
        const todayGBP = Number(todaySnap.total_gbp) || (Number(todaySnap.total_usd) * (Number(todaySnap.fx_rate) || FX_RATE));
        const prevGBP  = Number(yesterdaySnap.total_gbp) || (Number(yesterdaySnap.total_usd) * (Number(yesterdaySnap.fx_rate) || FX_RATE));
        changeGBP = todayGBP - prevGBP;
      }
    }

    // totalGBP from the latest snapshot — native value, not converted from totalUSD
    const totalGBP = todaySnap
      ? (Number(todaySnap.total_gbp) || (Number(todaySnap.total_usd) * (Number(todaySnap.fx_rate) || FX_RATE)))
      : totalUSD * FX_RATE;
    liveData = { totalUSD, totalGBP, changeUSD, changeGBP, breakdown, assets, prices, costBasisUSD, costBasisGBP, snapshots: snapData };

    // Fetch fundamentals from Yahoo (via our server proxy) — fire-and-forget,
    // result lands in window._marketMeta before user opens AI chat.
    // Pass the actual live tickers so the server fetches exactly what's in the portfolio.
    if (!window._marketMeta) {
      const liveTickers = assets
        .filter(a => a.valueUSD > 0.5 && a.pos.category !== 'fiat')
        .map(a => a.pos.ticker === 'RSU_META' ? 'META' : a.pos.ticker)
        .filter((t, i, arr) => arr.indexOf(t) === i) // dedupe
        .join(',');
      fetch('/api/market-data' + (liveTickers ? '?tickers=' + liveTickers : ''))
        .then(r => r.json())
        .then(json => { if (json && json.data) window._marketMeta = json.data; })
        .catch(() => {});
    }

    // Fetch watchlist (broader market universe for AI recommendations) — also fire-and-forget
    if (!window._watchlistMeta) {
      fetch('/api/watchlist-data')
        .then(r => r.json())
        .then(json => { if (json && json.data) window._watchlistMeta = json.data; })
        .catch(() => {});
    }

    // Fetch macro indicators with historical evolution
    if (!window._macroData) {
      fetch('/api/macro-data')
        .then(r => r.json())
        .then(json => { if (json && json.data) window._macroData = json.data; })
        .catch(() => {});
    }
    renderPortfolio();

  } catch(e) {
    console.error('Error cargando portfolio:', e);
    document.getElementById('portfolioSpinner').innerHTML =
      '<div style="font-size:12px;color:var(--muted);text-align:center;padding:20px">Error cargando datos.<br>Reintentando...</div>';
    setTimeout(loadPortfolio, 10000);
  }
}


// ── CHANGE MODE (historical vs daily) ────────────────────────────────────────
let chgMode = 'hist'; // 'hist' | 'day' — toggles infinitely on swipe

function fmtChgSpan(val) {
  if (val === null || val === undefined || val === '') return '<span style="color:var(--muted)">—</span>';
  const r = parseFloat(Number(val).toFixed(2));
  if (r === 0) return '<span style="color:var(--muted)">0.00%</span>';
  const col = r > 0 ? 'var(--accent3)' : 'var(--accent2)';
  return '<span style="color:' + col + '">' + (r > 0 ? '↑ +' : '↓ ') + r.toFixed(2) + '%</span>';
}
function renderChgHtml(pct, dayPct) {
  // 8 slots of 72px: h|d|h|d|h|d|h|d  (h=hist, d=day)
  // Start at slot index 3 (hist) so there's room to swipe left too.
  // hist at even indices, day at odd.
  // chgMode hist → nearest even slot → index 2 → tx=-144
  // chgMode day  → nearest odd  slot → index 3 → tx=-216
  const SW = 72;
  const tx = chgMode === 'hist' ? -(14 * SW) : -(15 * SW);
  const h = fmtChgSpan(pct);
  const d = fmtChgSpan(dayPct);
  const s = function(v) {
    return '<div style="min-width:' + SW + 'px;max-width:' + SW + 'px;font-size:12px;line-height:16px;text-align:right;white-space:nowrap">' + v + '</div>';
  };
  return '<div class="chg-ribbon-wrap" style="overflow:hidden;width:' + SW + 'px;height:16px;flex-shrink:0;display:inline-flex;align-items:center">' +
    '<div class="chg-ribbon" style="display:flex;flex-direction:row;transform:translateX(' + tx + 'px);transition:none;will-change:transform">' +
      s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d)+s(h)+s(d) +
    '</div></div>';
}

// Ribbon swipe — tracks absolute tape position, snaps to nearest slot
(function() {
  const SLOT_W = 72;
  const N_SLOTS = 30; // total slots in ribbon
  const TOTAL_W = SLOT_W * N_SLOTS; // 576px

  // hist at even slot indices (0,2,4,6), day at odd (1,3,5,7)
  // Starting canonical: hist=index2 tx=-144, day=index3 tx=-216
  const HOME = { hist: -(14 * SLOT_W), day: -(15 * SLOT_W) };

  let currentTx = HOME[chgMode]; // absolute translateX of ribbon right now
  let sx = 0, sy = 0, active = false, locked = false, dragX = 0;
  let lastX = 0, lastT = 0, velX = 0;

  function getList()    { return document.getElementById('assetList'); }
  function allRibbons() { return document.querySelectorAll('.chg-ribbon'); }

  function setRibbons(tx, dur) {
    // Clamp so ribbon never shows empty space
    const minTx = -(TOTAL_W - SLOT_W); // -504
    const maxTx = 0;
    tx = Math.max(minTx, Math.min(maxTx, tx));
    allRibbons().forEach(r => {
      r.style.transition = dur ? 'transform ' + dur + 'ms cubic-bezier(0.25,0.46,0.45,0.94)' : 'none';
      r.style.transform  = 'translateX(' + tx + 'px)';
    });
    return tx;
  }

  // Given a translateX, what mode is showing? Even slot index = hist, odd = day
  function modeAtTx(tx) {
    const idx = Math.round(-tx / SLOT_W);
    return idx % 2 === 0 ? 'hist' : 'day';
  }

  // Snap tx to nearest slot boundary
  function nearestSlotTx(tx) {
    return -Math.round(-tx / SLOT_W) * SLOT_W;
  }

  function updatePill(mode) {
    const h = document.getElementById('chgPillHist');
    const d = document.getElementById('chgPillDay');
    if (!h || !d) return;
    h.style.background = mode === 'hist' ? 'var(--accent)' : 'transparent';
    h.style.color      = mode === 'hist' ? '#fff' : 'var(--muted)';
    d.style.background = mode === 'day'  ? 'var(--accent)' : 'transparent';
    d.style.color      = mode === 'day'  ? '#fff' : 'var(--muted)';
  }

  document.addEventListener('touchstart', function(e) {
    const list = getList();
    if (!list || !list.contains(e.target)) return;
    active = true; locked = false; dragX = 0; velX = 0;
    sx = lastX = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    lastT = Date.now();
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!active) return;
    const cx = e.touches[0].clientX;
    const dx = cx - sx;
    const dy = Math.abs(e.touches[0].clientY - sy);
    if (!locked) {
      if (dy > 12) { active = false; return; }
      if (Math.abs(dx) > 6) locked = true;
    }
    if (!locked) return;
    window._ribbonDragged = false; // will be set true on meaningful drag
    const now = Date.now(), dt = now - lastT || 1;
    velX = (cx - lastX) / dt;
    lastX = cx; lastT = now;
    dragX = dx;
    if (Math.abs(dragX) > 4) window._ribbonDragged = true;
    setRibbons(currentTx + dragX, false);
  }, { passive: true });

  function onEnd() {
    if (!active || !locked) { active = false; locked = false; return; }
    active = false; locked = false;

    const liveTx = currentTx + dragX;
    let snapTx;

    if (Math.abs(velX) > 0.4) {
      // Fast flick: move exactly 1 slot in flick direction from currentTx
      const dir = velX < 0 ? -1 : 1;
      snapTx = nearestSlotTx(currentTx) + dir * SLOT_W;
    } else {
      // Slow drag: snap to nearest slot to where finger stopped
      snapTx = nearestSlotTx(liveTx);
    }

    // Clamp and apply
    const minTx = -(TOTAL_W - SLOT_W);
    snapTx = Math.max(minTx, Math.min(0, snapTx));
    currentTx = snapTx;

    const newMode = modeAtTx(currentTx);
    if (newMode !== chgMode) {
      chgMode = newMode;
      updatePill(chgMode);
    }

    const remaining = Math.abs(snapTx - liveTx);
    const dur = Math.min(300, Math.max(160, remaining * 1.5));
    setRibbons(liveTx, false);
    requestAnimationFrame(() => { setRibbons(snapTx, dur); });
  }

  document.addEventListener('touchend',    onEnd, { passive: true });
  document.addEventListener('touchcancel', onEnd, { passive: true });

  window.setChgMode = function(mode) {
    if (mode === chgMode) return;
    chgMode = mode;
    currentTx = HOME[mode];
    updatePill(mode);
    setRibbons(currentTx, 220);
  };
  window._refreshChgRibbons = function() {
    // Re-sync currentTx when cards are re-rendered (mode may have changed)
    currentTx = HOME[chgMode];
  };
})();


// Market open/closed detection
function getMarketStatus(ticker, category) {
  if (category === 'cripto') return 'open'; // 24/7
  if (category === 'fiat') return null; // no dot

  const now = new Date();
  // Use UTC offsets: NYSE = UTC-5 (EST) / UTC-4 (EDT), LSE = UTC+0 (GMT) / UTC+1 (BST)
  const utcH = now.getUTCHours(), utcM = now.getUTCMinutes(), utcD = now.getUTCDay();
  if (utcD === 0 || utcD === 6) return 'closed'; // weekend

  const totalUtcMins = utcH * 60 + utcM;

  // LSE: tickers ending in .L (ARKK.L, VWRP.L) — 08:00–16:30 London time
  // BST (last Sun Mar → last Sun Oct): UTC+1, otherwise UTC+0
  if (ticker.endsWith('.L')) {
    const month = now.getUTCMonth(); // 0=Jan
    const isBST = month >= 2 && month <= 9; // approx Mar–Oct
    const offsetMins = isBST ? 60 : 0;
    const localMins = totalUtcMins + offsetMins;
    return (localMins >= 480 && localMins < 990) ? 'open' : 'closed'; // 8:00–16:30
  }

  // NYSE: SPY, BRK.B, MELI, NU — 09:30–16:00 ET
  // EDT (2nd Sun Mar → 1st Sun Nov): UTC-4, otherwise EST UTC-5
  const month = now.getUTCMonth();
  const isEDT = month >= 2 && month <= 9; // approx Mar–Oct
  const offsetMins = isEDT ? -240 : -300;
  const localMins = totalUtcMins + offsetMins;
  return (localMins >= 570 && localMins < 960) ? 'open' : 'closed'; // 9:30–16:00
}

function renderPortfolio() {
  if (!liveData) return;
  const { totalUSD, totalGBP, changeUSD, changeGBP, costBasisUSD, costBasisGBP, breakdown, assets } = liveData;
  const isGBP = currentCurrency === 'GBP';
  const rate = isGBP ? FX_RATE : 1;
  const sym = isGBP ? '£' : '$';

  // Total
  document.getElementById('portfolioTotal').textContent = isGBP
    ? '£' + Math.round(totalGBP).toLocaleString('es-AR')
    : fmtVal(totalUSD, 1, '$');

  // Change — use native GBP or USD change from snapshot (no FX conversion needed)
  const changeEl = document.getElementById('portfolioChange');
  const changeDisplay   = isGBP ? (changeGBP || 0) : (changeUSD || 0);
  const totalDisplay    = isGBP ? totalGBP : totalUSD;
  const prevDisplay     = totalDisplay - changeDisplay;
  const changePct       = prevDisplay > 0 ? (changeDisplay / prevDisplay) * 100 : 0;
  // changeDisplay is already in native currency (GBP or USD) — rate=1 so fmtVal does not double-convert
  const changeFormatted = fmtVal(Math.abs(changeDisplay), 1, sym);
  const arrow      = changeDisplay >= 0 ? '↑' : '↓';
  const changeColor = changeDisplay > 0 ? 'var(--accent3)' : changeDisplay < 0 ? 'var(--accent2)' : 'var(--muted)';
  changeEl.className = 'portfolio-change';
  changeEl.style.color = changeColor;
  changeEl.innerHTML = arrow + ' ' + changeFormatted + ' · ' + (changeDisplay >= 0 ? '+' : '') + changePct.toFixed(2) + '% vs ayer';

  // Cost basis line — use native currency to avoid FX round-trip errors
  const cbEl = document.getElementById('portfolioCostBasis');
  const cbValEl = document.getElementById('cbValue');
  const cbNative = isGBP ? costBasisGBP : costBasisUSD;
  if (cbEl && cbValEl && cbNative) {
    cbValEl.textContent = sym + Math.round(cbNative).toLocaleString('es-AR');
    if (valuesHidden) maskElement(cbValEl);
  }

  // Alloc bar (4 cats)
  const CATS = ['acciones','cripto','rsu','fiat'];
  const CAT_LABELS = ['Acciones','Cripto','RSUs','Cash'];
  const segs = document.querySelectorAll('.alloc-seg');
  const items = document.querySelectorAll('.alloc-item');
  // First 3 cats (acciones, cripto, rsu) use segs[0..2]
  ['acciones','cripto','rsu'].forEach((cat, i) => {
    const pct = totalUSD > 0 ? Math.round((breakdown[cat] || 0) / totalUSD * 100) : 0;
    if (segs[i]) {
      if (!segs[i].dataset.animated) {
        segs[i].dataset.animated = '1';
        segs[i].style.width = '0%';
        const targetPct = pct;
        requestAnimationFrame(() => setTimeout(() => { segs[i].style.width = targetPct + '%'; }, 30 + i * 60));
      } else {
        segs[i].style.width = pct + '%';
      }
    }
    if (items[i]) items[i].lastChild.textContent = ' ' + CAT_LABELS[i] + ' ' + pct + '%';
  });
  // Cash seg: split into liquid (solid) + locked (striped)
  const cashPct = totalUSD > 0 ? (breakdown.fiat || 0) / totalUSD * 100 : 0;
  const lockedPct = totalUSD > 0 ? (breakdown.fiat_locked || 0) / totalUSD * 100 : 0;
  const liquidPct = cashPct - lockedPct;
  const cashSegs = document.getElementById('cashAllocSegs');
  if (cashSegs) {
    const lockedFrac = cashPct > 0 ? (lockedPct / cashPct * 100) : 0;
    const liquidFrac = 100 - lockedFrac;
    cashSegs.innerHTML =
      '<div style="flex:' + liquidFrac + ';background:#4fc3f7;height:100%"></div>' +
      (lockedFrac > 0 ? '<div style="flex:' + lockedFrac + ';height:100%;background:repeating-linear-gradient(45deg,#4fc3f7,#4fc3f7 2px,#2a6f7f 2px,#2a6f7f 5px)"></div>' : '');
  }
  // Cash alloc bar total width
  const cashSeg = document.querySelector('#allocBar .alloc-seg:nth-child(4), #cashAllocSegs')?.parentElement;
  // Update the cashAllocSegs container width via the parent flex container
  // The cashAllocSegs already fills remaining space; set width on its wrapper:
  const cashWrapper = document.getElementById('cashAllocSegs');
  if (cashWrapper) {
    cashWrapper.style.transition = 'width 0.7s cubic-bezier(0.4,0,0.2,1)';
    // Animate from 0 on first render
    if (!cashWrapper.dataset.animated) {
      cashWrapper.style.width = '0%';
      cashWrapper.dataset.animated = '1';
      requestAnimationFrame(() => setTimeout(() => { cashWrapper.style.width = Math.round(cashPct) + '%'; }, 30));
    } else {
      cashWrapper.style.width = Math.round(cashPct) + '%';
    }
  }
  if (items[3]) items[3].lastChild.textContent = ' Cash ' + Math.round(cashPct) + '%';

  // Pie legend: pl0=acciones pl1=cripto pl2=rsu pl3=cash liquid pl4=cash locked
  [breakdown.acciones, breakdown.cripto, breakdown.rsu, breakdown.fiat_liquid, breakdown.fiat_locked].forEach((v, i) => {
    const el = document.getElementById('pl' + i);
    if (el) el.textContent = fmtVal(v || 0, rate, sym);
  });
  const pieTotal = document.getElementById('pieTotal');
  if (pieTotal) pieTotal.textContent = fmtVal(totalUSD, rate, sym);

  // Asset cards — sorted by value desc, hide zero values; locked fiat always last
  // Merge GBP_LIQUID + EMERGENCY_FUND into a single "Libras" card
  const mergedAssets = [];
  let librasValue = 0, librasQty = 0;
  let librasFound = false;
  assets.forEach(a => {
    if (a.pos.ticker === 'GBP_LIQUID' || a.pos.ticker === 'EMERGENCY_FUND') {
      librasValue += a.valueUSD;
      librasQty += Number(a.pos.qty);
      librasFound = true;
    } else if (a.valueUSD > 0.5) {
      mergedAssets.push(a);
    }
  });
  if (librasFound && librasValue > 0.5) {
    mergedAssets.push({
      pos: { ticker: 'GBP_LIQUID', category: 'fiat', currency: 'GBP', qty: librasQty },
      valueUSD: librasValue, priceUSD: null, pctUSD: null, pctGBP: null, dayPct: null, dayPctGBP: null,
      _merged: true,
    });
  }
  const sorted = mergedAssets.sort((a, b) => {
    const order = t => t === 'RENT_DEPOSIT' ? 2 : t === 'GBP_RECEIVABLE' ? 1 : 0;
    const oa = order(a.pos.ticker), ob = order(b.pos.ticker);
    if (oa !== ob) return oa - ob;
    return b.valueUSD - a.valueUSD;
  });
  const assetList = document.getElementById('assetList');
  assetList.innerHTML = '';
  sorted.forEach(({ pos, valueUSD, pctUSD, pctGBP, dayPct, dayPctGBP }) => {
    const pct = isGBP ? pctGBP : pctUSD;
    const meta = TICKER_META[pos.ticker] || { name: pos.ticker, logo: '💰', cat: pos.category, showTicker: true };
    const isLockedFiat = (pos.ticker === 'RENT_DEPOSIT' || pos.ticker === 'GBP_RECEIVABLE');
    const valStr = fmtVal(valueUSD, rate, sym);
    const qtyStr = fmtQty(pos.qty, pos.ticker);
    // Subtitle: show ticker+qty for stocks/crypto, nothing for fiat
    let subLabel;
    if (meta.showTicker) {
      subLabel = pos.ticker + ' · <span class="asset-sub-qty">' + qtyStr + '</span>';
    } else if (meta.rsu) {
      subLabel = 'Meta · <span class="asset-sub-qty">' + Number(pos.qty).toFixed(3) + '</span>';
    } else {
      const lockedBadge = isLockedFiat ? ' · <span style="font-size:10px;color:#2a8f9f;background:rgba(42,143,159,0.15);padding:1px 5px;border-radius:4px">bloqueado</span>' : '';
      subLabel = '<span class="asset-sub-qty">' + (pos.currency === 'GBP' ? '£' + pos.qty.toLocaleString('es-AR') : '$' + pos.qty.toLocaleString('es-AR')) + '</span>' + lockedBadge;
    }
    // Change badge — driven by chgMode ('hist' or 'day')
    // In GBP mode use dayPctGBP (price converted at per-day FX), in USD mode use dayPct
    const dayPctDisplay = isGBP ? (dayPctGBP ?? dayPct) : dayPct;
    const chgHtml = renderChgHtml(pct, dayPctDisplay);
    const ticker = pos.ticker;
    const rsuClick = meta.rsu
      ? ' onclick="if(window._ribbonDragged){window._ribbonDragged=false;return;}openRSU()" style="cursor:pointer"'
      : pos.category !== 'fiat'
        ? ' onclick="if(window._ribbonDragged){window._ribbonDragged=false;return;}openPosDetail(\''+ticker+'\')" style="cursor:pointer"'
        : '';
    const rsuArrowOverride = pos.category !== 'fiat' && !meta.rsu ? '<div style="font-size:13px;color:var(--muted);line-height:16px">›</div>' : '';
    const rsuArrow = meta.rsu ? '<div style="font-size:13px;color:var(--muted);line-height:16px">›</div>' : rsuArrowOverride;
    const fit = meta.whiteBg ? 'contain' : 'cover';
    const pad = meta.whiteBg ? '4px' : '0';
    const logoBlock = meta.logoUrl
      ? '<img src="' + meta.logoUrl + '" style="width:44px;height:44px;border-radius:50%;flex-shrink:0;object-fit:' + fit + ';background:#fff;padding:' + pad + '" onerror="this.style.display=\'none\';this.insertAdjacentHTML(\'afterend\',\'<div style=&quot;width:44px;height:44px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0&quot;>' + meta.logo + '</div>\')">'
      : '<div style="width:44px;height:44px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">' + meta.logo + '</div>';

    assetList.innerHTML += '<div class="asset-card" data-cat="' + meta.cat + '" data-pct="' + (pct !== null ? pct.toFixed(4) : '') + '" data-pctusd="' + (pctUSD !== null ? pctUSD.toFixed(4) : '') + '" data-pctgbp="' + (pctGBP !== null ? pctGBP.toFixed(4) : '') + '" data-daypct="' + (dayPct !== null ? dayPct.toFixed(4) : '') + '"' + rsuClick + '>' +
      logoBlock +
      '<div class="asset-info"><div class="asset-name">' + meta.name + '</div>' +
      '<div class="asset-sub">' + subLabel + (() => {
        const status = getMarketStatus(pos.ticker, pos.category);
        return status ? '<span class="market-dot ' + status + '" title="Mercado ' + (status === 'open' ? 'abierto' : 'cerrado') + '"></span>' : '';
      })() + '</div></div>' +
      '<div class="asset-right"><div class="asset-val">' + valStr + '</div>' +
      '<div style="display:flex;flex-direction:row;align-items:center;gap:2px;justify-content:flex-end;margin-top:2px;line-height:16px">' + chgHtml + rsuArrow + '</div></div></div>';
  });

  // Hide spinner, show list
  document.getElementById('portfolioSpinner').style.display = 'none';
  assetList.style.display = 'flex';
  document.getElementById('chgModePill').style.display = 'flex';
  if (window._refreshChgRibbons) window._refreshChgRibbons();

  // Render equity breakdown pie
  renderEquityPie();

  // Render asset category pie (main ribbon right card)
  renderAssetPie();

  // Render P&L attribution
  renderPnlAttribution();

  // Load active period chart, then preload all others in background
  loadChartData();
  preloadAllPeriods();
}

// ── P&L ATTRIBUTION CHART ──────────────────────────────────────────────
let pnlAttrMode = 'hist'; // 'hist' = total P&L, 'day' = daily

let pnlCollapsed = true; // default collapsed
function togglePnlCollapse() {
  pnlCollapsed = !pnlCollapsed;
  const body = document.getElementById('pnlAttrBody');
  const chevron = document.getElementById('pnlChevron');
  if (body) body.style.display = pnlCollapsed ? 'none' : '';
  if (chevron) chevron.style.transform = pnlCollapsed ? 'rotate(-90deg)' : '';
}

function setPnlAttrMode(mode) {
  pnlAttrMode = mode;
  const hEl = document.getElementById('pnlModeHist');
  const dEl = document.getElementById('pnlModeDay');
  if (mode === 'hist') {
    hEl.style.background = 'var(--accent)'; hEl.style.color = '#fff';
    dEl.style.background = 'transparent'; dEl.style.color = 'var(--muted)';
  } else {
    dEl.style.background = 'var(--accent)'; dEl.style.color = '#fff';
    hEl.style.background = 'transparent'; hEl.style.color = 'var(--muted)';
  }
  renderPnlAttribution();
}

function renderPnlAttribution() {
  if (!liveData) return;
  const card = document.getElementById('pnlAttributionCard');
  const barsEl = document.getElementById('pnlAttrBars');
  const totalEl = document.getElementById('pnlAttrTotal');
  const { assets } = liveData;
  const isGBP = currentCurrency === 'GBP';
  const rate = isGBP ? FX_RATE : 1;
  const sym = isGBP ? '£' : '$';

  // Yesterday's FX — from the snapshot used as daily baseline.
  // Used in daily attribution to convert USD contributions to GBP at yesterday's rate,
  // so the sum matches the snapshot-based changeGBP shown in the tab header.
  const _snaps = liveData.snapshots || [];
  const _todayDay = _snaps.length > 0 ? new Date(_snaps[0].captured_at).toISOString().slice(0,10) : null;
  const _yesterdaySnap = _snaps.find(s => new Date(s.captured_at).toISOString().slice(0,10) !== _todayDay) || null;
  const fxYesterday = _yesterdaySnap ? Number(_yesterdaySnap.fx_rate) : FX_RATE;

  const contribs = [];
  let fiatGBPContribUSD = 0;     // hist mode: GBP cash FX P&L vs initial investment
  let fiatGBPDayContribUSD = 0;  // day mode: GBP cash daily FX move in USD terms
  let hasFiatGBP = false;
  let hasFiatGBPDay = false;
  assets.forEach(({ pos, valueUSD, dayPct, dayPctGBP, pctUSD }) => {
    if (pos.category === 'fiat') {
      if (pos.currency !== 'GBP' || valueUSD < 1) return;
      if (pnlAttrMode === 'hist') {
        // Historic: FX P&L in USD — only meaningful in USD mode
        if (isGBP) return;
        const inv = Number(pos.initial_investment_usd);
        if (!inv) return;
        fiatGBPContribUSD += valueUSD - inv;
        hasFiatGBP = true;
      } else {
        // Daily: same GBP qty at today's FX vs yesterday's FX — USD mode only
        if (isGBP) return;
        const gbpQty = Number(pos.qty);
        if (!gbpQty || !fxYesterday) return;
        fiatGBPDayContribUSD += valueUSD - (gbpQty / fxYesterday);
        hasFiatGBPDay = true;
      }
      return;
    }

    if (valueUSD < 1) return;

    if (pnlAttrMode === 'day') {
      // Daily contribution — use dayPctGBP in GBP mode (accounts for FX moves per snapshot)
      // and dayPct in USD mode. This ensures sum == header change in both currencies.
      if (isGBP) {
        if (!dayPctGBP) return;
        const valueGBP  = valueUSD * FX_RATE;
        const prevValueGBP = valueGBP / (1 + dayPctGBP / 100);
        const contribGBP   = prevValueGBP * (dayPctGBP / 100);
        contribs.push({ ticker: pos.ticker, contribUSD: contribGBP / FX_RATE, contribDisplay: contribGBP });
      } else {
        if (!dayPct) return;
        const prevValue  = valueUSD / (1 + dayPct / 100);
        const contribUSD = prevValue * (dayPct / 100);
        contribs.push({ ticker: pos.ticker, contribUSD, contribDisplay: contribUSD });
      }
    } else {
      // Historic P&L contribution — use native currency to match cost basis
      if (isGBP) {
        const invGBP = Number(pos.initial_investment_gbp);
        const avgGBP = Number(pos.avg_cost_gbp);
        const qty = Number(pos.qty);
        const basisGBP = invGBP ? invGBP : (avgGBP ? avgGBP * qty : 0);
        const valueGBP = valueUSD * FX_RATE;
        if (!basisGBP && valueGBP < 1) return;
        contribs.push({ ticker: pos.ticker, contribUSD: valueUSD - (basisGBP / FX_RATE), contribDisplay: valueGBP - basisGBP });
      } else {
        const inv = Number(pos.initial_investment_usd);
        const avg = Number(pos.avg_cost_usd);
        const qty = Number(pos.qty);
        const basis = inv ? inv : (avg ? avg * qty : 0);
        if (!basis && valueUSD < 1) return;
        const contribUSD = valueUSD - basis;
        contribs.push({ ticker: pos.ticker, contribUSD, contribDisplay: contribUSD });
      }
    }
  });

  // Libras line — hist mode USD: FX P&L on GBP cash vs initial investment
  if (hasFiatGBP && Math.abs(fiatGBPContribUSD) >= 0.01) {
    contribs.push({ ticker: 'Libras', contribUSD: fiatGBPContribUSD, contribDisplay: fiatGBPContribUSD });
  }
  // Libras line — day mode USD: daily FX move on GBP cash holdings
  if (hasFiatGBPDay && Math.abs(fiatGBPDayContribUSD) >= 0.01) {
    contribs.push({ ticker: 'Libras', contribUSD: fiatGBPDayContribUSD, contribDisplay: fiatGBPDayContribUSD });
  }

  if (!contribs.length || contribs.every(c => Math.abs(c.contribUSD) < 0.01)) {
    card.style.display = 'none';
    return;
  }

  contribs.sort((a, b) => {
    // Libras always last
    if (a.ticker === 'Libras') return 1;
    if (b.ticker === 'Libras') return -1;
    return Math.abs(b.contribUSD) - Math.abs(a.contribUSD);
  });

  const totalContrib = contribs.reduce((s, c) => s + c.contribDisplay, 0);
  const totalColor = totalContrib >= 0 ? 'var(--accent3)' : 'var(--accent2)';
  totalEl.style.color = totalColor;
  totalEl.textContent = (totalContrib >= 0 ? '+' : '-') + sym + Math.abs(totalContrib).toFixed(2);
  if (valuesHidden) maskElement(totalEl);

  const maxAbs = Math.max(...contribs.map(c => Math.abs(c.contribDisplay)), 0.01);

  let html = '';
  contribs.forEach(c => {
    const pct = (Math.abs(c.contribDisplay) / maxAbs) * 45;
    const isUp = c.contribDisplay >= 0;
    const barColor = isUp ? 'var(--accent3)' : 'var(--accent2)';
    const barStyle = isUp
      ? `left:50%;width:${pct}%;background:${barColor}`
      : `right:50%;width:${pct}%;background:${barColor}`;
    const valStr = (isUp ? '+' : '-') + sym + Math.abs(c.contribDisplay).toFixed(2);
    const valCls = isUp ? 'up' : 'down';

    html += `<div class="pnl-attr-row">
      <div class="pnl-attr-ticker">${c.ticker}</div>
      <div class="pnl-attr-track">
        <div class="pnl-attr-center"></div>
        <div class="pnl-attr-bar" style="${barStyle}"></div>
      </div>
      <div class="pnl-attr-val ${valCls} pnl-attr-hideable">${valStr}</div>
    </div>`;
  });

  barsEl.innerHTML = html;
  card.style.display = '';

  // Apply mask if values are hidden
  if (valuesHidden) {
    document.querySelectorAll('.pnl-attr-hideable').forEach(el => maskElement(el));
  }
}

// ── MAIN RIBBON DRAG (Portfolio ↔ Pie por Tipo de Activo) ─────────────────
(function() {
  let mrDragStartX = 0;
  let mrDragStartY = 0;
  let mrDragCurX   = 0;
  let mrCurrentOffset = 0; // 0 = left card (portfolio), negative = right card (asset pie)
  let mrTargetOffset  = 0;
  let mrOnRight    = false;
  let mrPointerDown = false;
  let mrIsHorizDrag = false;
  let mrIsVertDrag  = false;

  function mrGetCardWidth() {
    const outer = document.getElementById('mainRibbonOuter');
    return outer ? outer.offsetWidth + 10 : 330;
  }

  function mrSetPos(x, animate) {
    const track = document.getElementById('mainRibbonTrack');
    if (!track) return;
    track.style.transition = animate
      ? 'transform 0.38s cubic-bezier(0.25,0.46,0.45,0.94)'
      : 'none';
    track.style.transform = `translateX(${x}px)`;
    // Update dots — neutral white, no accent color
    const dot0 = document.getElementById('mrDot0');
    const dot1 = document.getElementById('mrDot1');
    const W = mrGetCardWidth();
    const progress = Math.max(0, Math.min(1, -x / W));
    if (dot0) { dot0.style.opacity = String(0.55 - progress * 0.35); dot0.style.transform = `scaleX(${1 + (1 - progress) * 0.8})`; }
    if (dot1) { dot1.style.opacity = String(0.2 + progress * 0.35);  dot1.style.transform = `scaleX(${1 + progress * 0.8})`; }
  }

  function mrClamp(raw) {
    const W = mrGetCardWidth();
    const minOff = -W;
    if (raw > 0) return raw * 0.2;
    if (raw < minOff) return minOff - (raw - minOff) * -0.2;
    return raw;
  }

  function mrSnap(velocity) {
    const W = mrGetCardWidth();
    const cur = mrCurrentOffset;
    const halfW = -(W * 0.5);
    let goRight;
    if (Math.abs(velocity) > 0.5) {
      goRight = velocity < -0.5;
    } else {
      goRight = cur < halfW;
    }
    if (goRight) {
      mrTargetOffset = -W;
      mrOnRight = true;
    } else {
      mrTargetOffset = 0;
      mrOnRight = false;
    }
    mrSetPos(mrTargetOffset, true);
    mrCurrentOffset = mrTargetOffset;
  }

  document.addEventListener('DOMContentLoaded', function() {
    const outer = document.getElementById('mainRibbonOuter');
    if (!outer) return;

    let lastX = 0, lastT = 0, velX = 0;

    outer.addEventListener('pointerdown', function(e) {
      mrPointerDown = true;
      mrIsHorizDrag = false;
      mrIsVertDrag  = false;
      mrDragStartX  = e.clientX;
      mrDragStartY  = e.clientY;
      mrDragCurX    = mrCurrentOffset;
      lastX = e.clientX;
      lastT = performance.now();
      velX  = 0;
    }, { passive: true });

    document.addEventListener('pointermove', function(e) {
      if (!mrPointerDown) return;
      const dx = e.clientX - mrDragStartX;
      const dy = e.clientY - mrDragStartY;
      if (!mrIsHorizDrag && !mrIsVertDrag) {
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          if (Math.abs(dx) > Math.abs(dy) * 1.4) mrIsHorizDrag = true;
          else mrIsVertDrag = true;
        }
      }
      if (!mrIsHorizDrag) return;
      e.preventDefault();
      const now = performance.now();
      const dt = now - lastT || 16;
      velX = (e.clientX - lastX) / dt;
      lastX = e.clientX; lastT = now;
      const raw = mrDragCurX + dx;
      mrSetPos(mrClamp(raw), false);
      mrCurrentOffset = mrClamp(raw);
    }, { passive: false });

    document.addEventListener('pointerup', function() {
      if (!mrPointerDown) return;
      mrPointerDown = false;
      if (!mrIsHorizDrag) return;
      mrSnap(velX);
      if (mrOnRight) setTimeout(renderAssetPie, 60);
    });

    document.addEventListener('pointercancel', function() {
      if (!mrPointerDown) return;
      mrPointerDown = false;
      mrSnap(0);
    });
  });

  window._mainRibbonSnapLeft  = function() { mrTargetOffset=0; mrOnRight=false; mrSetPos(0,true); mrCurrentOffset=0; };
  window._mainRibbonSnapRight = function() { const W=mrGetCardWidth(); mrTargetOffset=-W; mrOnRight=true; mrSetPos(-W,true); mrCurrentOffset=-W; setTimeout(renderAssetPie,60); };
})();

// ── ASSET PIE (por tipo de activo: Acciones / Cripto / RSU / Cash) ─────────
const ASSET_CAT_COLORS = {
  acciones:    '#43e97b',
  cripto:      '#ff6584',
  rsu:         '#f7b731',
  fiat_liquid: '#4fc3f7',
  fiat_locked: '#4fc3f7', // same base color — pattern applied at draw time
};
const ASSET_CAT_LABELS = {
  acciones:    'Acciones',
  cripto:      'Cripto',
  rsu:         'RSUs',
  fiat_liquid: 'Líquido',
  fiat_locked: 'Ilíquido',
};

// Build a striped canvas pattern matching the alloc bar locked-cash style
function makeLockedPattern(ctx) {
  const sz = 7; // tile size (matches 45deg stripe: 2px solid + 5px gap = 7px)
  const offscreen = document.createElement('canvas');
  offscreen.width  = sz;
  offscreen.height = sz;
  const oc = offscreen.getContext('2d');
  oc.fillStyle = '#2a6f7f';
  oc.fillRect(0, 0, sz, sz);
  oc.strokeStyle = '#4fc3f7';
  oc.lineWidth = 2;
  // Draw 45-degree stripes across the tile (repeat at corners for seamless tiling)
  for (let i = -sz; i <= sz * 2; i += sz) {
    oc.beginPath();
    oc.moveTo(i, 0);
    oc.lineTo(i + sz, sz);
    oc.stroke();
  }
  return ctx.createPattern(offscreen, 'repeat');
}

let assetPieSlices   = [];
let assetFocusCat    = null;
let assetPieAnimReq  = null;
let assetPieAnimProg = 1;
let assetPieAnimFrom = null;

function drawAssetPieFrame(prog, focusCat, slices, totalUSD) {
  const canvas = document.getElementById('assetPieCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const SIZE = 130;
  canvas.width  = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, SIZE, SIZE);

  const cx = SIZE / 2, cy = SIZE / 2;
  const BASE_R = 52, BASE_r = 33;
  const EXPAND = 10;
  const easedProg = easeInOut(prog);

  let angle = -Math.PI / 2;
  slices.forEach(s => {
    const sweep = (s.valueUSD / totalUSD) * Math.PI * 2;
    const isFocused = focusCat && s.cat === focusCat;
    const isOther   = focusCat && s.cat !== focusCat;

    const R = BASE_R + (isFocused ? EXPAND * easedProg : isOther ? -3 * easedProg : 0);
    const r = BASE_r + (isFocused ? -2 * easedProg : 0);

    const bisect = angle + sweep / 2;
    const offset = isFocused ? EXPAND * 0.6 * easedProg : 0;
    const ox = Math.cos(bisect) * offset;
    const oy = Math.sin(bisect) * offset;
    const alpha = isOther ? 1 - 0.55 * easedProg : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.arc(cx, cy, r, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = s.cat === 'fiat_locked' ? (makeLockedPattern(ctx) || '#4fc3f7') : s.color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, R + 1, angle, angle + sweep);
    ctx.arc(cx, cy, r - 1, angle + sweep, angle, true);
    ctx.closePath();
    ctx.strokeStyle = 'var(--bg)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    s._angle = angle;
    s._sweep = sweep;
    angle += sweep;
  });

  // Center label
  const center    = document.getElementById('assetPieCenter');
  const centerSub = document.getElementById('assetPieCenterSub');
  if (center && centerSub) {
    const isGBP2 = currentCurrency === 'GBP';
    const rate2  = isGBP2 ? FX_RATE : 1;
    const sym2   = isGBP2 ? '£' : '$';
    if (focusCat && easedProg > 0.5) {
      const fs = slices.find(s => s.cat === focusCat);
      if (fs) {
        const pct = ((fs.valueUSD / totalUSD) * 100).toFixed(1);
        center.textContent    = pct + '%';
        centerSub.textContent = ASSET_CAT_LABELS[focusCat] || focusCat;
        center.style.color    = fs.color;
      }
    } else {
      center.textContent    = fmtVal(totalUSD, rate2, sym2);
      center.style.color    = '';
      centerSub.textContent = 'total';
      if (valuesHidden) maskElement(center);
    }
  }
}

function animateAssetPie(targetCat, slices, totalUSD) {
  if (assetPieAnimReq) cancelAnimationFrame(assetPieAnimReq);
  const focusing  = !!targetCat;
  const DURATION  = 280;
  const startTime = performance.now();

  if (targetCat && assetFocusCat && targetCat !== assetFocusCat) {
    assetFocusCat    = null;
    assetPieAnimProg = 0;
  }

  function step(now) {
    const t = Math.min((now - startTime) / DURATION, 1);
    assetPieAnimProg = focusing ? t : 1 - t;
    const drawCat = focusing ? targetCat : assetPieAnimFrom;
    drawAssetPieFrame(assetPieAnimProg, drawCat, slices, totalUSD);

    // Legend
    const legend = document.getElementById('assetPieLegend');
    if (legend) {
      const dimAmount = easeInOut(assetPieAnimProg);
      legend.querySelectorAll('.asset-pie-row').forEach(row => {
        const isF = drawCat && row.dataset.cat === drawCat;
        const isO = drawCat && row.dataset.cat !== drawCat;
        row.style.opacity    = isO ? String(1 - 0.55 * dimAmount) : '1';
        row.style.fontWeight = isF && dimAmount > 0.5 ? '700' : '';
        row.style.transform  = isF && dimAmount > 0.5 ? 'scale(1.03)' : 'scale(1)';
      });
    }

    if (t < 1) {
      assetPieAnimReq = requestAnimationFrame(step);
    } else {
      assetFocusCat    = targetCat;
      assetPieAnimReq  = null;
    }
  }
  assetPieAnimFrom = assetFocusCat;
  assetPieAnimReq  = requestAnimationFrame(step);
}

function focusAssetSlice(cat, slices, totalUSD) {
  if (assetFocusCat === cat) {
    animateAssetPie(null, slices, totalUSD);
  } else {
    animateAssetPie(cat, slices, totalUSD);
  }
}

function hitTestAssetPie(e) {
  const canvas = document.getElementById('assetPieCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const cx2 = rect.left + rect.width  / 2;
  const cy2 = rect.top  + rect.height / 2;
  const touch = e.changedTouches ? e.changedTouches[0] : e;
  const dx = touch.clientX - cx2;
  const dy = touch.clientY - cy2;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const SIZE = 130;
  const scale = rect.width / SIZE;
  const BASE_R = 52 * scale, BASE_r = 33 * scale;
  if (dist < BASE_r || dist > BASE_R + 12 * scale) return null;
  let ang = Math.atan2(dy, dx);
  if (ang < -Math.PI / 2) ang += Math.PI * 2;
  for (const s of assetPieSlices) {
    let normAng = ang + Math.PI / 2;
    if (normAng < 0) normAng += Math.PI * 2;
    let normA0 = s._angle + Math.PI / 2;
    if (normA0 < 0) normA0 += Math.PI * 2;
    let normA1 = normA0 + s._sweep;
    if (normAng >= normA0 && normAng <= normA1) return s.cat;
  }
  return null;
}

function renderAssetPie() {
  if (!liveData) return;
  const { breakdown, totalUSD } = liveData;
  const isGBP = currentCurrency === 'GBP';
  const rate = isGBP ? FX_RATE : 1;
  const sym = isGBP ? '£' : '$';

  // Use fiat_liquid / fiat_locked as separate slices (mirrors the alloc pie logic)
  const CATS = ['acciones','cripto','rsu','fiat_liquid','fiat_locked'];
  const slices = [];
  let total = 0;
  CATS.forEach(cat => {
    const v = breakdown[cat] || 0;
    if (v <= 0.5) return;
    slices.push({ cat, valueUSD: v, color: ASSET_CAT_COLORS[cat] || '#aaa' });
    total += v;
  });

  slices.sort((a, b) => b.valueUSD - a.valueUSD);
  assetPieSlices = slices;

  if (total === 0) {
    const canvas = document.getElementById('assetPieCanvas');
    if (canvas) {
      const dpr = window.devicePixelRatio || 1;
      const SIZE = 130;
      canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;
      canvas.style.width = SIZE + 'px'; canvas.style.height = SIZE + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.beginPath();
      ctx.arc(SIZE/2, SIZE/2, 52, 0, Math.PI * 2);
      ctx.arc(SIZE/2, SIZE/2, 33, Math.PI * 2, 0, true);
      ctx.fillStyle = 'var(--surface2)'; ctx.fill();
    }
  } else {
    if (assetFocusCat && !slices.find(s => s.cat === assetFocusCat)) {
      assetFocusCat = null; assetPieAnimProg = 1;
    }
    drawAssetPieFrame(assetFocusCat ? assetPieAnimProg : 1, assetFocusCat, slices, total);
  }

  // Center
  if (!assetFocusCat) {
    const center = document.getElementById('assetPieCenter');
    const centerSub = document.getElementById('assetPieCenterSub');
    if (center) {
      center.textContent = fmtVal(total, rate, sym);
      center.style.color = '';
      delete center.dataset.real;
      if (valuesHidden) maskElement(center);
    }
    if (centerSub) centerSub.textContent = 'total';
  }

  // Legend
  const legend = document.getElementById('assetPieLegend');
  if (!legend) return;
  legend.innerHTML = '';
  slices.forEach(s => {
    const pct = total > 0 ? ((s.valueUSD / total) * 100).toFixed(1) : '0.0';
    const valStr = fmtVal(s.valueUSD, rate, sym);
    const row = document.createElement('div');
    row.className = 'asset-pie-row';
    row.dataset.cat = s.cat;
    row.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer;transition:opacity 0.22s,transform 0.22s,font-weight 0.1s;border-radius:8px;padding:2px 4px;margin:-2px -4px';
    row.innerHTML =
      (s.cat === 'fiat_locked'
        ? '<div style="width:8px;height:8px;border-radius:50%;background:repeating-linear-gradient(45deg,#4fc3f7,#4fc3f7 2px,#2a6f7f 2px,#2a6f7f 4px);flex-shrink:0"></div>'
        : '<div style="width:8px;height:8px;border-radius:50%;background:' + s.color + ';flex-shrink:0"></div>') +
      '<span style="font-size:11px;color:var(--muted);flex:1;white-space:nowrap">' + (ASSET_CAT_LABELS[s.cat] || s.cat) + '</span>' +
      '<span style="font-size:11px;font-weight:700;flex-shrink:0">' + pct + '%</span>' +
      '<span class="asset-pie-val" style="font-size:10px;color:var(--muted);flex-shrink:0;min-width:36px;text-align:right">' + valStr + '</span>';
    row.addEventListener('click', function() {
      focusAssetSlice(s.cat, assetPieSlices, assetPieSlices.reduce((a,b)=>a+b.valueUSD,0));
    });
    legend.appendChild(row);
  });

  if (valuesHidden) {
    legend.querySelectorAll('.asset-pie-val').forEach(maskElement);
  }
}

// Asset pie canvas tap
(function() {
  let tapping = false, tapX = 0, tapY = 0;
  const getCanvas = () => document.getElementById('assetPieCanvas');
  document.addEventListener('touchstart', function(e) {
    const c = getCanvas();
    if (!c) return;
    const t = e.touches[0];
    const rect = c.getBoundingClientRect();
    if (t.clientX < rect.left || t.clientX > rect.right || t.clientY < rect.top || t.clientY > rect.bottom) return;
    tapping = true; tapX = t.clientX; tapY = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', function(e) {
    if (!tapping) return;
    tapping = false;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - tapX) > 10 || Math.abs(t.clientY - tapY) > 10) return;
    const cat = hitTestAssetPie(e);
    const total = assetPieSlices.reduce((a,b) => a + b.valueUSD, 0);
    if (cat) {
      focusAssetSlice(cat, assetPieSlices, total);
    } else if (assetFocusCat) {
      animateAssetPie(null, assetPieSlices, total);
    }
  }, { passive: true });
  document.addEventListener('touchend', function(e) {
    if (!assetFocusCat) return;
    const c  = getCanvas();
    const lg = document.getElementById('assetPieLegend');
    const t  = e.changedTouches[0];
    const inCanvas = c  && (() => { const r=c.getBoundingClientRect(); return t.clientX>=r.left && t.clientX<=r.right && t.clientY>=r.top && t.clientY<=r.bottom; })();
    const inLegend = lg && (() => { const r=lg.getBoundingClientRect(); return t.clientX>=r.left && t.clientX<=r.right && t.clientY>=r.top && t.clientY<=r.bottom; })();
    if (!inCanvas && !inLegend) {
      animateAssetPie(null, assetPieSlices, assetPieSlices.reduce((a,b)=>a+b.valueUSD,0));
    }
  }, { passive: true });
})();

// ── EQUITY PIE (ticker-level) ──────────────────────────────────────────

// Colors per ticker (acciones palette: shades of green; cripto=red; rsu=amber)
const EQUITY_TICKER_COLORS = {
  'SPY':      '#43e97b',
  'BRK.B':    '#00c853',
  'MELI':     '#1de9b6',
  'NU':       '#69f0ae',
  'BTC':      '#ff6584',
  'RSU_META': '#f7b731',
  'ARKK.L':   '#a78bfa',
  'VWRP.L':   '#60a5fa',
  'MSFT':     '#00b4d8',
  'NDIA.L':   '#f97316',
};

let equityActiveCats = new Set(['acciones','cripto','rsu']);
let equityPieCollapsed = false;

function toggleEquityPie() { /* no-op — cards are now side-by-side in ribbon */ }

// ── CARD RIBBON DRAG (Evolución ↔ Renta Variable) ─────────────────────────
(function() {
  const SPRING_TENSION = 0.18; // how fast it springs back
  const MAX_OVERDRAG   = 80;   // max pixels you can pull past the "edge"
  const REVEAL_THRESHOLD = 60; // how far you drag before it "sticks" to right card

  let ribbonDragStartX = 0;
  let ribbonDragStartY = 0;
  let ribbonDragCurX   = 0;
  let ribbonCurrentOffset = 0; // 0 = left card, negative = shifted right
  let ribbonTargetOffset  = 0;
  let ribbonDragging   = false;
  let ribbonAnimReq    = null;
  let ribbonOnRight    = false; // true when fully on equity card
  let ribbonPointerDown = false;
  let ribbonIsHorizDrag = false; // confirmed horizontal drag
  let ribbonIsVertDrag  = false; // confirmed vertical drag (suppress horiz)

  function getCardWidth() {
    const outer = document.getElementById('cardRibbonOuter');
    return outer ? outer.offsetWidth + 10 : 330; // +10 for the gap
  }

  function setRibbonPos(x, animate) {
    const track = document.getElementById('cardRibbonTrack');
    if (!track) return;
    if (animate) {
      track.style.transition = 'transform 0.38s cubic-bezier(0.25,0.46,0.45,0.94)';
    } else {
      track.style.transition = 'none';
    }
    track.style.transform = `translateX(${x}px)`;
  }

  function clampOffset(raw) {
    const W = getCardWidth();
    const minOff = -(W); // fully on right card
    // Rubber band: allow overdrag with resistance
    if (raw > 0) return raw * 0.2; // overdrag left (no card there)
    if (raw < minOff) return minOff - (raw - minOff) * -0.2; // overdrag right
    return raw;
  }

  function snapRibbon(velocity) {
    const W = getCardWidth();
    const cur = ribbonCurrentOffset; // negative = shifted toward right card
    const halfW = -(W * 0.5);       // midpoint

    // Snap toward whichever side cur is closest to, with velocity bias
    // velocity > 0 = dragging right (toward left card), < 0 = dragging left (toward right card)
    let goRight;
    if (Math.abs(velocity) > 0.5) {
      // Velocity dominant: positive vel → go to left card (snap left), negative → right card
      goRight = velocity < -0.5;
    } else {
      // Position dominant: past midpoint → snap to that side
      goRight = cur < halfW;
    }

    if (goRight) {
      ribbonTargetOffset = -W;
      ribbonOnRight = true;
    } else {
      ribbonTargetOffset = 0;
      ribbonOnRight = false;
    }
    setRibbonPos(ribbonTargetOffset, true);
    ribbonCurrentOffset = ribbonTargetOffset;
    updateArrowHint();
  }

  function updateArrowHint() {
    // Arrows are static per-card, nothing to update dynamically
  }

  // Attach events to the outer container
  document.addEventListener('DOMContentLoaded', function() {
    const outer = document.getElementById('cardRibbonOuter');
    if (!outer) return;

    let lastX = 0, lastT = 0, velX = 0;

    outer.addEventListener('pointerdown', function(e) {
      // Don't intercept touches on the chart canvas (hover area)
      if (e.target.closest('#chartWrap') || e.target.closest('#portfolioChart') || e.target.closest('#chartDotOverlay')) return;
      ribbonPointerDown = true;
      ribbonDragging = false;
      ribbonIsHorizDrag = false;
      ribbonIsVertDrag  = false;
      ribbonDragStartX  = e.clientX;
      ribbonDragStartY  = e.clientY;
      ribbonDragCurX    = ribbonCurrentOffset;
      lastX = e.clientX;
      lastT = performance.now();
      velX  = 0;
    }, { passive: true });

    document.addEventListener('pointermove', function(e) {
      if (!ribbonPointerDown) return;
      const dx = e.clientX - ribbonDragStartX;
      const dy = e.clientY - ribbonDragStartY;
      const absDx = Math.abs(dx), absDy = Math.abs(dy);

      // Determine drag direction once we have enough movement
      if (!ribbonIsHorizDrag && !ribbonIsVertDrag) {
        if (absDx > 6 || absDy > 6) {
          if (absDx > absDy * 1.4) ribbonIsHorizDrag = true;
          else ribbonIsVertDrag = true;
        }
      }
      if (!ribbonIsHorizDrag) return;

      ribbonDragging = true;
      e.preventDefault();
      const now = performance.now();
      const dt = now - lastT || 16;
      velX = (e.clientX - lastX) / dt;
      lastX = e.clientX; lastT = now;

      const raw = ribbonDragCurX + dx;
      setRibbonPos(clampOffset(raw), false);
      ribbonCurrentOffset = clampOffset(raw);
    }, { passive: false });

    document.addEventListener('pointerup', function(e) {
      if (!ribbonPointerDown) return;
      ribbonPointerDown = false;
      if (!ribbonIsHorizDrag) return;
      snapRibbon(velX);
      // If snapped to equity card, redraw pie
      if (ribbonOnRight) setTimeout(renderEquityPie, 60);
    });

    document.addEventListener('pointercancel', function() {
      if (!ribbonPointerDown) return;
      ribbonPointerDown = false;
      snapRibbon(0);
    });
  });

  // Expose for external use if needed
  window._ribbonSnapLeft  = function() { ribbonTargetOffset=0; ribbonOnRight=false; setRibbonPos(0,true); ribbonCurrentOffset=0; updateArrowHint(); };
  window._ribbonSnapRight = function() { const W=getCardWidth(); ribbonTargetOffset=-W; ribbonOnRight=true; setRibbonPos(-W,true); ribbonCurrentOffset=-W; updateArrowHint(); setTimeout(renderEquityPie,60); };
})();

function toggleEquityCat(el) {
  const cat = el.dataset.cat;
  if (equityActiveCats.has(cat)) {
    if (equityActiveCats.size <= 1) return; // keep at least one active
    equityActiveCats.delete(cat);
    el.style.opacity = '0.35';
  } else {
    equityActiveCats.add(cat);
    el.style.opacity = '1';
  }

  if (equityFocusTicker) {
    // Phase 1: animate unfocus on current slices, then re-render new slices
    const oldSlices   = equityPieSlices.slice();
    const oldTotal    = oldSlices.reduce((a, b) => a + b.valueUSD, 0);
    const fromTicker  = equityFocusTicker;

    if (equityPieAnimReq) { cancelAnimationFrame(equityPieAnimReq); equityPieAnimReq = null; }
    equityFocusTicker = null;

    const DURATION  = 260;
    const startTime = performance.now();
    const startProg = equityPieAnimProg;

    function unfocusStep(now) {
      const t = Math.min((now - startTime) / DURATION, 1);
      equityPieAnimProg = startProg * (1 - t); // goes from startProg → 0
      drawEquityPieFrame(equityPieAnimProg, fromTicker, oldSlices, oldTotal);

      // Fade legend rows back to normal during unfocus
      const legend = document.getElementById('equityPieLegend');
      if (legend) {
        const dimAmount = easeInOut(equityPieAnimProg);
        legend.querySelectorAll('.pie-legend-row').forEach(row => {
          const isF = row.dataset.ticker === fromTicker;
          const isO = row.dataset.ticker !== fromTicker;
          row.style.opacity    = isO ? String(1 - 0.55 * dimAmount) : '1';
          row.style.fontWeight = isF && dimAmount > 0.5 ? '700' : '';
          row.style.transform  = isF && dimAmount > 0.5 ? 'scale(1.03)' : 'scale(1)';
        });
      }

      if (t < 1) {
        equityPieAnimReq = requestAnimationFrame(unfocusStep);
      } else {
        equityPieAnimProg = 1;
        equityPieAnimReq  = null;
        // Phase 2: re-render with new cat set (morphs via renderEquityPie)
        renderEquityPie();
      }
    }
    equityPieAnimReq = requestAnimationFrame(unfocusStep);
  } else {
    // No focus active — just re-render directly
    equityPieAnimProg = 1;
    if (equityPieAnimReq) { cancelAnimationFrame(equityPieAnimReq); equityPieAnimReq = null; }
    renderEquityPie();
  }
}

// ── EQUITY PIE FOCUS STATE ───────────────────────────────────────────────────
let equityFocusTicker = null;   // null = all normal; string = focused ticker
let equityPieSlices   = [];     // last computed slices (for hit-testing canvas taps)
let equityPieAnimReq  = null;   // requestAnimationFrame id
let equityPieAnimProg = 1;      // 0..1 animation progress (1 = complete)
let equityPieAnimDir  = 1;      // 1 = focusing, -1 = unfocusing
let equityPieAnimFrom = null;   // ticker we're animating from

function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

function drawEquityPieFrame(prog, focusTicker, slices, totalUSD) {
  const canvas = document.getElementById('equityPie');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const SIZE = 130;
  canvas.width  = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, SIZE, SIZE);

  const cx = SIZE / 2, cy = SIZE / 2;
  const BASE_R = 52, BASE_r = 33;
  const EXPAND = 10; // how far focused slice pops out
  const easedProg = easeInOut(prog);

  let angle = -Math.PI / 2;
  slices.forEach(s => {
    const sweep = (s.valueUSD / totalUSD) * Math.PI * 2;
    const isFocused = focusTicker && s.ticker === focusTicker;
    const isOther   = focusTicker && s.ticker !== focusTicker;

    // Radii: focused slice grows outward, others shrink slightly
    const R = BASE_R + (isFocused ? EXPAND * easedProg : isOther ? -3 * easedProg : 0);
    const r = BASE_r + (isFocused ? -2 * easedProg : 0);

    // Offset focused slice away from center along its bisector
    const bisect = angle + sweep / 2;
    const offset = isFocused ? EXPAND * 0.6 * easedProg : 0;
    const ox = Math.cos(bisect) * offset;
    const oy = Math.sin(bisect) * offset;

    // Opacity: others fade when something is focused
    const alpha = isOther ? 1 - 0.55 * easedProg : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.arc(cx, cy, r, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    // Gap stroke
    ctx.beginPath();
    ctx.arc(cx, cy, R + 1, angle, angle + sweep);
    ctx.arc(cx, cy, r - 1, angle + sweep, angle, true);
    ctx.closePath();
    ctx.strokeStyle = 'var(--bg)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Store midpoint for hit testing
    s._angle = angle;
    s._sweep = sweep;
    angle += sweep;
  });

  // Center label
  const center    = document.getElementById('equityPieCenter');
  const centerSub = document.getElementById('equityPieCenterSub');
  if (center && centerSub) {
    if (focusTicker && easedProg > 0.5) {
      const fs = slices.find(s => s.ticker === focusTicker);
      if (fs) {
        const pct = ((fs.valueUSD / totalUSD) * 100).toFixed(1);
        center.textContent    = pct + '%';
        centerSub.textContent = fs.label;
        center.style.color    = fs.color;
      }
    } else if (!focusTicker || easedProg <= 0.5) {
      // Unfocusing or no focus — show total
      const isGBP2 = currentCurrency === 'GBP';
      center.textContent    = fmtVal(totalUSD, isGBP2 ? FX_RATE : 1, isGBP2 ? '£' : '$');
      center.style.color    = '';
      centerSub.textContent = equityActiveCats.size < 3 ? [...equityActiveCats].join('+') : 'renta variable';
      if (valuesHidden) maskElement(center);
    }
  }
}

function animateEquityPie(targetTicker, slices, totalUSD) {
  if (equityPieAnimReq) cancelAnimationFrame(equityPieAnimReq);
  const startProg = equityPieAnimProg;
  const focusing  = !!targetTicker;
  const DURATION  = 280; // ms
  const startTime = performance.now();

  // If we're switching focus from one ticker to another, restart from 0
  if (targetTicker && equityFocusTicker && targetTicker !== equityFocusTicker) {
    equityFocusTicker = null;
    equityPieAnimProg = 0;
  }

  function step(now) {
    const t = Math.min((now - startTime) / DURATION, 1);
    equityPieAnimProg = focusing ? t : 1 - t;
    const drawTicker = focusing ? targetTicker : equityPieAnimFrom;
    drawEquityPieFrame(equityPieAnimProg, drawTicker, slices, totalUSD);

    // Update legend opacity
    const legend = document.getElementById('equityPieLegend');
    if (legend) {
      legend.querySelectorAll('.pie-legend-row').forEach(row => {
        const isF = drawTicker && row.dataset.ticker === drawTicker;
        const isO = drawTicker && row.dataset.ticker !== drawTicker;
        // When unfocusing (focusing=false), equityPieAnimProg goes 1→0, so opacity restores
        const dimAmount = easeInOut(equityPieAnimProg);
        row.style.opacity    = isO ? String(1 - 0.55 * dimAmount) : '1';
        row.style.fontWeight = isF && dimAmount > 0.5 ? '700' : '';
        row.style.transform  = isF && dimAmount > 0.5 ? 'scale(1.03)' : 'scale(1)';
      });
    }

    if (t < 1) {
      equityPieAnimReq = requestAnimationFrame(step);
    } else {
      equityFocusTicker = targetTicker;
      equityPieAnimReq  = null;
    }
  }
  equityPieAnimFrom = equityFocusTicker;
  equityPieAnimReq  = requestAnimationFrame(step);
}

function focusEquitySlice(ticker, slices, totalUSD) {
  if (equityFocusTicker === ticker) {
    // Already focused → unfocus
    animateEquityPie(null, slices, totalUSD);
  } else {
    animateEquityPie(ticker, slices, totalUSD);
  }
}

// Hit test canvas tap: returns ticker string or null
function hitTestEquityPie(e) {
  const canvas = document.getElementById('equityPie');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const cx2 = rect.left + rect.width  / 2;
  const cy2 = rect.top  + rect.height / 2;
  const touch = e.changedTouches ? e.changedTouches[0] : e;
  const dx = touch.clientX - cx2;
  const dy = touch.clientY - cy2;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const SIZE = 130;
  const scale = rect.width / SIZE;
  const BASE_R = 52 * scale, BASE_r = 33 * scale;
  if (dist < BASE_r || dist > BASE_R + 12 * scale) return null; // center hole or outside
  let ang = Math.atan2(dy, dx);
  if (ang < -Math.PI / 2) ang += Math.PI * 2; // normalize to start from -π/2
  for (const s of equityPieSlices) {
    let a0 = s._angle, a1 = s._angle + s._sweep;
    // Normalize ang relative to -π/2 start
    let normAng = ang + Math.PI / 2;
    if (normAng < 0) normAng += Math.PI * 2;
    let normA0 = a0 + Math.PI / 2;
    if (normA0 < 0) normA0 += Math.PI * 2;
    let normA1 = normA0 + s._sweep;
    if (normAng >= normA0 && normAng <= normA1) return s.ticker;
  }
  return null;
}

function renderEquityPie() {
  if (!liveData) return;
  const { assets } = liveData;
  const isGBP = currentCurrency === 'GBP';
  const rate = isGBP ? FX_RATE : 1;
  const sym = isGBP ? '£' : '$';

  // Build slices only from equity categories that are active
  const CAT_MAP = {
    'acciones': 'acciones',
    'cripto':   'cripto',
    'rsu':      'rsu',
  };

  const slices = [];
  let totalUSD = 0;
  assets.forEach(({ pos, valueUSD }) => {
    const cat = CAT_MAP[pos.category];
    if (!cat || !equityActiveCats.has(cat)) return;
    if (valueUSD <= 0.5) return;
    const color = EQUITY_TICKER_COLORS[pos.ticker] || '#aaa';
    const label = (pos.ticker === 'RSU_META') ? 'META' : pos.ticker;
    slices.push({ ticker: pos.ticker, label, color, valueUSD, cat });
    totalUSD += valueUSD;
  });

  // Sort descending
  slices.sort((a, b) => b.valueUSD - a.valueUSD);

  // Store slices globally for hit testing and animation
  equityPieSlices = slices;

  // Draw via frame function (handles focus animation)
  if (totalUSD === 0) {
    const canvas = document.getElementById('equityPie');
    if (canvas) {
      const dpr = window.devicePixelRatio || 1;
      const SIZE = 130;
      canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;
      canvas.style.width = SIZE + 'px'; canvas.style.height = SIZE + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.beginPath();
      ctx.arc(SIZE/2, SIZE/2, 52, 0, Math.PI * 2);
      ctx.arc(SIZE/2, SIZE/2, 33, Math.PI * 2, 0, true);
      ctx.fillStyle = 'var(--surface2)'; ctx.fill();
    }
  } else {
    // Reset focus if categories changed
    if (equityFocusTicker && !slices.find(s => s.ticker === equityFocusTicker)) {
      equityFocusTicker = null; equityPieAnimProg = 1;
    }
    drawEquityPieFrame(equityFocusTicker ? equityPieAnimProg : 1, equityFocusTicker, slices, totalUSD);
  }

  // Center label (only update if not in focus state)
  if (!equityFocusTicker) {
    const center = document.getElementById('equityPieCenter');
    const centerSub = document.getElementById('equityPieCenterSub');
    if (center) {
      center.textContent = fmtVal(totalUSD, rate, sym);
      center.style.color = '';
      delete center.dataset.real;
      if (valuesHidden) maskElement(center);
    }
    if (centerSub) {
      centerSub.textContent = equityActiveCats.size < 3 ? [...equityActiveCats].join('+') : 'renta variable';
    }
  }

  // Legend
  const legend = document.getElementById('equityPieLegend');
  if (!legend) return;
  legend.innerHTML = '';
  slices.forEach(s => {
    const pct = totalUSD > 0 ? ((s.valueUSD / totalUSD) * 100).toFixed(1) : '0.0';
    const valStr = fmtVal(s.valueUSD, rate, sym);
    const row = document.createElement('div');
    row.className = 'pie-legend-row';
    row.dataset.ticker = s.ticker;
    row.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer;transition:opacity 0.22s,transform 0.22s,font-weight 0.1s;border-radius:8px;padding:2px 4px;margin:-2px -4px';
    row.innerHTML =
      '<div style="width:8px;height:8px;border-radius:50%;background:' + s.color + ';flex-shrink:0;transition:transform 0.22s"></div>' +
      '<span style="font-size:11px;color:var(--muted);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + s.label + '</span>' +
      '<span style="font-size:11px;font-weight:700;flex-shrink:0">' + pct + '%</span>' +
      '<span class="equity-val" style="font-size:10px;color:var(--muted);flex-shrink:0;min-width:36px;text-align:right">' + valStr + '</span>';
    row.addEventListener('click', function() {
      focusEquitySlice(s.ticker, equityPieSlices, equityPieSlices.reduce((a,b)=>a+b.valueUSD,0));
    });
    legend.appendChild(row);
  });

  // Re-apply hide mask
  if (valuesHidden) {
    legend.querySelectorAll('.equity-val').forEach(maskElement);
  }
}

// Equity pie canvas tap
(function() {
  let tapping = false, tapX = 0, tapY = 0;
  const getCanvas = () => document.getElementById('equityPie');
  document.addEventListener('touchstart', function(e) {
    const c = getCanvas();
    if (!c) return;
    const t = e.touches[0];
    const rect = c.getBoundingClientRect();
    if (t.clientX < rect.left || t.clientX > rect.right || t.clientY < rect.top || t.clientY > rect.bottom) return;
    tapping = true; tapX = t.clientX; tapY = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', function(e) {
    if (!tapping) return;
    tapping = false;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - tapX) > 10 || Math.abs(t.clientY - tapY) > 10) return;
    const ticker = hitTestEquityPie(e);
    const total = equityPieSlices.reduce((a,b) => a + b.valueUSD, 0);
    if (ticker) {
      focusEquitySlice(ticker, equityPieSlices, total);
    } else if (equityFocusTicker) {
      // Tap inside canvas but outside slices (center hole) → unfocus
      animateEquityPie(null, equityPieSlices, total);
    }
  }, { passive: true });
  // Tap outside canvas/legend → unfocus
  document.addEventListener('touchend', function(e) {
    if (!equityFocusTicker) return;
    const c  = getCanvas();
    const lg = document.getElementById('equityPieLegend');
    const t  = e.changedTouches[0];
    const inCanvas = c  && (() => { const r=c.getBoundingClientRect();  return t.clientX>=r.left && t.clientX<=r.right  && t.clientY>=r.top && t.clientY<=r.bottom; })();
    const inLegend = lg && (() => { const r=lg.getBoundingClientRect(); return t.clientX>=r.left && t.clientX<=r.right  && t.clientY>=r.top && t.clientY<=r.bottom; })();
    if (!inCanvas && !inLegend) {
      animateEquityPie(null, equityPieSlices, equityPieSlices.reduce((a,b)=>a+b.valueUSD,0));
    }
  }, { passive: true });
})();


let valuesHidden = false;
const MASK = '*****';


function blurElement(el) {
  if (!el) return;
  el.style.filter = 'blur(6px)';
  el.style.userSelect = 'none';
}
function unblurElement(el) {
  if (!el) return;
  el.style.filter = '';
  el.style.userSelect = '';
}
function maskElement(el) {
  if (!el) return;
  if (!el.dataset.real) el.dataset.real = el.textContent;
  el.textContent = MASK;
}
function unmaskElement(el) {
  if (!el) return;
  if (el.dataset.real) { el.textContent = el.dataset.real; delete el.dataset.real; }
}

// For alloc-items: only mask the text node at the end, preserving the color dot child span
function maskAllocItem(el) {
  if (!el) return;
  // Walk child nodes to find the text node at the end
  for (let i = el.childNodes.length - 1; i >= 0; i--) {
    const node = el.childNodes[i];
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
      if (!el.dataset.realText) el.dataset.realText = node.textContent;
      node.textContent = ' ' + MASK;
      return;
    }
  }
}
function unmaskAllocItem(el) {
  if (!el || el.dataset.realText === undefined) return;
  for (let i = el.childNodes.length - 1; i >= 0; i--) {
    const node = el.childNodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent = el.dataset.realText;
      delete el.dataset.realText;
      return;
    }
  }
}


// RSU subtitle partial mask:
// - unit counts (standalone numbers) → *** (3 stars)
// - percentage (number followed by %) → ** (2 stars)
function maskRsuSubtitle(el) {
  if (!el) return;
  if (!el.dataset.realHtml) el.dataset.realHtml = el.innerHTML;
  // First replace "N%" with "**%", then remaining standalone numbers with "***"
  el.innerHTML = el.innerHTML
    .replace(/\b(\d+(?:\.\d+)?)(?=%)/g, '**')
    .replace(/\b\d+(?:\.\d+)?\b/g, '***');
}
function unmaskRsuSubtitle(el) {
  if (!el || !el.dataset.realHtml) return;
  el.innerHTML = el.dataset.realHtml;
  delete el.dataset.realHtml;
}

function maskUnits(el) {
  if (!el) return;
  if (!el.dataset.real) el.dataset.real = el.textContent;
  el.textContent = '***';
}
function toggleHideValues() {
  valuesHidden = !valuesHidden;
  document.getElementById('eyeBtn').innerHTML = valuesHidden ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>` : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

  // Only mask pure monetary value elements — NOT category labels/pct, NOT axis labels
  const ids = ['portfolioTotal','pieTotal','pl0','pl1','pl2','pl3','pl4'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    valuesHidden ? maskElement(el) : unmaskElement(el);
  });

  // portfolioChange (monetary + pct change)
  const chg = document.getElementById('portfolioChange');
  if (chg) valuesHidden ? maskElement(chg) : unmaskElement(chg);

  // asset monetary values — mask with *****
  document.querySelectorAll('.asset-val').forEach(el => valuesHidden ? maskElement(el) : unmaskElement(el));
  // asset sub quantities — blur
  document.querySelectorAll('.asset-sub-qty').forEach(el => valuesHidden ? blurElement(el) : unblurElement(el));

  // equity pie center + legend values
  const equityCenter = document.getElementById('equityPieCenter');
  if (equityCenter) valuesHidden ? maskElement(equityCenter) : unmaskElement(equityCenter);
  document.querySelectorAll('.equity-val').forEach(el => valuesHidden ? maskElement(el) : unmaskElement(el));

  // asset category pie center + legend values
  const assetCenter = document.getElementById('assetPieCenter');
  if (assetCenter) valuesHidden ? maskElement(assetCenter) : unmaskElement(assetCenter);
  document.querySelectorAll('.asset-pie-val').forEach(el => valuesHidden ? maskElement(el) : unmaskElement(el));

  // P&L attribution values
  document.querySelectorAll('.pnl-attr-hideable').forEach(el => valuesHidden ? maskElement(el) : unmaskElement(el));

  // Cost basis value
  const cbValToggle = document.getElementById('cbValue');
  if (cbValToggle) valuesHidden ? maskElement(cbValToggle) : unmaskElement(cbValToggle);

  // posModal + RSU modal monetary values (only if modal is open)
  document.querySelectorAll('.modal-money-val').forEach(el => valuesHidden ? maskElement(el) : unmaskElement(el));
  document.querySelectorAll('.modal-units-val').forEach(el => valuesHidden ? maskUnits(el) : unmaskElement(el));
  document.querySelectorAll('.rsu-row-val, .rsu-acum-num').forEach(el => valuesHidden ? maskElement(el) : unmaskElement(el));
  document.querySelectorAll('.rsu-units-val').forEach(el => valuesHidden ? maskUnits(el) : unmaskElement(el));
  const rsuSubEl = document.getElementById('rsuSubtitle');
  if (rsuSubEl) valuesHidden ? maskRsuSubtitle(rsuSubEl) : unmaskRsuSubtitle(rsuSubEl);

  // Re-apply axis mask state (axis shows/hides based on valuesHidden)
  applyAxisMask();
  // Redraw vest chart if RSU modal is open (to show/hide bar labels)
  if (document.getElementById('rsuModal').classList.contains('open') && vestSchedule.length) {
    const _isGBP = rsuCurrency === 'GBP';
    const _rate = _isGBP ? FX_RATE : 1;
    const _sym = _isGBP ? '£' : '$';
    const _nm = rsuNet ? NET_RATE : 1;
    const _upcoming = vestSchedule.filter(v => !v.vested);
    const _slice = _upcoming.slice(0, visibleQuarters);
    drawVestChart(_rate, _sym, _slice, getRSUPriceUSD(), _nm);
  }
}

function applyAxisMask() {
  const ids = ['yTop','yMid','yBot'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (valuesHidden) {
      if (!el.dataset.real) el.dataset.real = el.textContent;
      el.textContent = '·····';
    } else {
      if (el.dataset.real) { el.textContent = el.dataset.real; delete el.dataset.real; }
    }
  });
}

// Patch renderPortfolio to re-apply mask after re-render
const _origRender = typeof renderPortfolio === 'function' ? renderPortfolio : null;

function setCurrency(cur) {
  currentCurrency = cur;
  const isGBP = cur === 'GBP';
  document.getElementById('btnGBP').style.background = isGBP ? 'var(--accent)' : 'transparent';
  document.getElementById('btnGBP').style.color = isGBP ? '#fff' : 'var(--muted)';
  document.getElementById('btnUSD').style.background = !isGBP ? 'var(--accent)' : 'transparent';
  document.getElementById('btnUSD').style.color = !isGBP ? '#fff' : 'var(--muted)';
  // No cache invalidation needed — cache stores raw snaps, conversion happens at draw time
  renderPortfolio();
  renderEquityPie();
  renderAssetPie();
  loadChartData();
}

// Period tabs
document.querySelectorAll('.period-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.period-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    chartPeriod = t.textContent.trim();
    loadChartData();
  });
});

// Category data for chart — populated from Supabase portfolio_snapshots
const CAT_COLORS = {
  acciones: '#43e97b',
  cripto:   '#ff6584',
  rsu:      '#f7b731',
  fiat:     '#4fc3f7',
};
const catData = {
  acciones:     { color: '#43e97b', points: [] },
  cripto:       { color: '#ff6584', points: [] },
  rsu:          { color: '#f7b731', points: [] },
  fiat:         { color: '#4fc3f7', points: [] },
  fiat_locked:  { color: '#4fc3f7', points: [], dashed: true },
};
let activeCats = new Set(['acciones','cripto','rsu','fiat']);
let chartPeriod = '1S';  // current period selection
let totalMode = true;

function toggleTotalMode() {
  totalMode = !totalMode;
  const knob = document.getElementById('totalToggleKnob');
  const toggle = document.getElementById('totalToggle');
  const filters = document.getElementById('catFilters');
  knob.style.transform = totalMode ? 'translateX(18px)' : 'translateX(0)';
  toggle.style.background = totalMode ? 'var(--accent)' : 'var(--surface2)';
  // Dim chips when in total mode
  filters.style.opacity = totalMode ? '0.4' : '1';
  filters.style.pointerEvents = totalMode ? 'none' : 'auto';
  drawChart();
}

function fmtY(v) {
  const sym = currentCurrency === 'GBP' ? '£' : '$';
  if (v >= 1000) return sym + (v/1000).toFixed(1) + 'k';
  return sym + Math.round(v);
}

function setYAxis(min, max) {
  const mid = (min + max) / 2;
  const elTop = document.getElementById('yTop');
  const elMid = document.getElementById('yMid');
  const elBot = document.getElementById('yBot');
  // Clear any saved real values first so applyAxisMask saves the new ones
  [elTop, elMid, elBot].forEach(el => { if (el) delete el.dataset.real; });
  if (elTop) elTop.textContent = fmtY(max);
  if (elMid) elMid.textContent = fmtY(mid);
  if (elBot) elBot.textContent = fmtY(min);
  // Re-apply mask if needed
  if (typeof valuesHidden !== 'undefined' && valuesHidden) applyAxisMask();
}

// In-memory cache for chart data — keyed by period+currency, lives for the page session.
// Invalidated when the user switches GBP/USD so points get recomputed.
// ── Chart cache ────────────────────────────────────────────────────────────
// Stores raw snaps (server-downsampled) keyed by period only — no currency suffix.
// Conversion GBP/USD is done at draw time from the raw snaps, so switching
// currency never requires a refetch.
const chartCache = {};  // { '1S': [...snaps], '1M': [...snaps], ... }

// Fetch one period from the server and store in cache. Returns the snaps array.
async function fetchPeriod(period) {
  if (chartCache[period]) return chartCache[period];
  try {
    const snaps = await fetch('/api/chart/' + period).then(r => r.json());
    if (Array.isArray(snaps) && snaps.length >= 2) {
      chartCache[period] = snaps;
      console.log(`[chart] period=${period} fetched ${snaps.length} pts`);
    } else {
      console.warn(`[chart] period=${period} returned ${Array.isArray(snaps) ? snaps.length : 'err'} pts`);
    }
    return snaps || [];
  } catch(e) {
    console.error(`[chart] period=${period} fetch error:`, e);
    return [];
  }
}

// Preload all 5 periods in parallel in the background.
// Called once after loadPortfolio() completes so it doesn't block the initial render.
async function preloadAllPeriods() {
  const PERIODS = ['1S', '1M', '3M', '6M', '1A'];
  await Promise.all(PERIODS.map(p => fetchPeriod(p)));
  console.log('[chart] all periods preloaded');
}

// Invalidate cache (used when data needs refreshing — e.g. manual position edit).
// Currency switches no longer need this since conversion is done at draw time.
function invalidateChartCache() {
  Object.keys(chartCache).forEach(k => delete chartCache[k]);
}

// Convert raw snaps to catData points for the given currency, then draw.
function applySnapsToCatData(snaps) {
  // Strip weekend snapshots (UTC day: 0 = Sunday, 6 = Saturday).
  // Remaining points are packed together — no gaps, no placeholders.
  // X axis always spans exactly the data available.
  const weekdaySnaps = snaps.filter(s => {
    const day = new Date(s.captured_at).getUTCDay();
    return day !== 0 && day !== 6;
  });

  const isGBP = currentCurrency === 'GBP';
  const CATS = ['acciones', 'cripto', 'rsu', 'fiat'];
  CATS.forEach(cat => { catData[cat].points = []; });

  // Store dates for tooltip
  chartSnapDates = weekdaySnaps.map(s => new Date(s.captured_at));

  // Build x-axis labels (~4 evenly spaced)
  const labelEl = document.getElementById('chartXLabels');
  if (labelEl && weekdaySnaps.length > 0) {
    const indices = [0, Math.floor(weekdaySnaps.length / 3), Math.floor(2 * weekdaySnaps.length / 3), weekdaySnaps.length - 1];
    const spans = labelEl.querySelectorAll('span');
    indices.forEach((idx, i) => {
      if (spans[i] && weekdaySnaps[idx]) {
        const d = new Date(weekdaySnaps[idx].captured_at);
        spans[i].textContent = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
      }
    });
  }

  weekdaySnaps.forEach(snap => {
    const b = snap.breakdown || {};
    const fxR = snap.fx_rate || 0.79;
    // Fiat: handle old format (fiat in USD) and new format (fiat_gbp + fiat_usd stored separately)
    let fiatUSD;
    if (b.fiat_gbp !== undefined || b.fiat_usd !== undefined) {
      fiatUSD = (b.fiat_gbp || 0) / fxR + (b.fiat_usd || 0);
    } else {
      fiatUSD = b.fiat || 0;
    }
    let fiatVal, accionesVal, criptoVal, rsuVal;
    if (isGBP) {
      fiatVal     = fiatUSD * fxR;
      accionesVal = (b.acciones || 0) * fxR;
      criptoVal   = (b.cripto   || 0) * fxR;
      rsuVal      = (b.rsu      || 0) * fxR;
    } else {
      fiatVal     = fiatUSD;
      accionesVal = (b.acciones || 0);
      criptoVal   = (b.cripto   || 0);
      rsuVal      = (b.rsu      || 0);
    }
    catData.acciones.points.push(accionesVal);
    catData.cripto.points.push(criptoVal);
    catData.rsu.points.push(rsuVal);
    catData.fiat.points.push(fiatVal);
    const lockedRatio = liveData && liveData.breakdown.fiat > 0
      ? liveData.breakdown.fiat_locked / liveData.breakdown.fiat : 0;
    catData.fiat_locked.points.push(fiatVal * lockedRatio);
  });
}

// Load chart data for the active period.
// Serves from cache if available (instant), otherwise fetches from server.
// Since the cache stores raw snaps, currency switches just re-call this —
// no refetch needed, applySnapsToCatData handles the conversion on the fly.
async function loadChartData() {
  const cached = chartCache[chartPeriod];

  if (cached) {
    console.log(`[chart] period=${chartPeriod} → cache hit (${cached.length} pts)`);
    applySnapsToCatData(cached);
    drawChart();
    return;
  }

  // Not cached yet (edge case: preload still in flight or failed)
  const snaps = await fetchPeriod(chartPeriod);

  if (!snaps || snaps.length < 2) {
    ['acciones', 'cripto', 'rsu', 'fiat', 'fiat_locked'].forEach(cat => { catData[cat].points = []; });
    drawChart();
    return;
  }

  applySnapsToCatData(snaps);
  drawChart();
}

let chartSnapDates = [];  // populated by loadChartData
let chartLastCoords = [];  // last drawn line coords for hover dot (totalMode)
let chartAllCatCoords = {};  // individual mode: cat -> coords array

function clearDotOverlay() {
  const ov = document.getElementById('chartDotOverlay');
  if (!ov) return;
  const dpr = window.devicePixelRatio || 1;
  const W = ov.parentElement.offsetWidth;
  const H = 90;
  ov.width = W * dpr;
  ov.height = H * dpr;
  ov.style.width = W + 'px';
  ov.style.height = H + 'px';
  ov.getContext('2d').clearRect(0, 0, W * dpr, H * dpr);
}

function drawDotAt(idx) {
  const ov = document.getElementById('chartDotOverlay');
  if (!ov) return;
  const dpr = window.devicePixelRatio || 1;
  const W = ov.parentElement.offsetWidth;
  const H = 90;
  ov.width = W * dpr;
  ov.height = H * dpr;
  ov.style.width = W + 'px';
  ov.style.height = H + 'px';
  const ctx = ov.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Collect all coord sets to draw dots on
  let coordSets = [];
  if (totalMode) {
    if (chartLastCoords.length) coordSets = [chartLastCoords];
  } else {
    coordSets = Object.values(chartAllCatCoords);
  }
  if (!coordSets.length) return;

  // Draw shared vertical crosshair at x of first set
  const firstPt = coordSets[0][Math.min(idx, coordSets[0].length - 1)];
  if (firstPt) {
    ctx.beginPath();
    ctx.moveTo(firstPt.x, 0);
    ctx.lineTo(firstPt.x, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw dot on each line
  coordSets.forEach(coords => {
    if (!coords.length) return;
    const pt = coords[Math.min(idx, coords.length - 1)];
    if (!pt) return;
    const color = pt.color || '#43e97b';
    // Outer ring
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color + '33';
    ctx.fill();
    // Inner dot
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

function drawChart() {
  chartLastCoords = [];
  chartAllCatCoords = {};
  const canvas = document.getElementById('portfolioChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.offsetWidth;
  const H = 90;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // If no data yet, show placeholder
  const hasPts = catData.acciones.points.length > 1;
  if (!hasPts) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '11px DM Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Acumulando datos...', W/2, H/2);
    return;
  }

  const padT = 6, padB = 6;

  function drawGrid(min, max) {
    const mid = (min + max) / 2;
    [min, mid, max].forEach(v => {
      const y = H - padB - ((v - min) / (max - min || 1)) * (H - padT - padB);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  if (totalMode) {
    const allCats = [...activeCats];
    if (allCats.length === 0) return;
    const len = Math.max(...allCats.map(cat => (catData[cat]?.points || []).length));
    if (len < 2) return;
    const totalPts = Array.from({length: len}, (_, i) =>
      allCats.reduce((sum, cat) => sum + (catData[cat]?.points[i] || 0), 0)
    );
    const min = Math.min(...totalPts), max = Math.max(...totalPts);
    const range = max - min || 1;
    setYAxis(min, max);
    drawGrid(min, max);
    const step = W / (len - 1);
    const coords = totalPts.map((v, i) => ({
      x: i * step,
      y: H - padB - ((v - min) / range) * (H - padT - padB)
    }));
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#43e97b40');
    grad.addColorStop(1, '#43e97b00');
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = '#43e97b'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    chartLastCoords = coords.map(c => ({ ...c, color: '#43e97b' }));
    clearDotOverlay();
    return;
  }

  const cats = [...activeCats];
  if (cats.length === 0) return;
  const allPts = cats.flatMap(cat => catData[cat]?.points || []);
  if (allPts.length === 0) return;
  const globalMin = Math.min(...allPts);
  const globalMax = Math.max(...allPts);
  const globalRange = globalMax - globalMin || 1;
  setYAxis(globalMin, globalMax);
  drawGrid(globalMin, globalMax);

  cats.forEach(cat => {
    if (cat === 'fiat_locked') return; // drawn separately
    const d = catData[cat];
    if (!d || d.points.length < 2) return;
    const pts = d.points;
    const step = W / (pts.length - 1);
    const coords = pts.map((v, i) => ({
      x: i * step,
      y: H - padB - ((v - globalMin) / globalRange) * (H - padT - padB)
    }));
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, d.color + '28');
    grad.addColorStop(1, d.color + '00');
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = d.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    // Draw fiat_locked as dashed line on top of fiat
    if (cat === 'fiat' && catData.fiat_locked.points.length > 1) {
      const lkPts = catData.fiat_locked.points;
      const lkStep = W / (lkPts.length - 1);
      const lkCoords = lkPts.map((v, i) => ({
        x: i * lkStep,
        y: H - padB - ((v - globalMin) / globalRange) * (H - padT - padB)
      }));
      ctx.beginPath();
      ctx.moveTo(lkCoords[0].x, lkCoords[0].y);
      lkCoords.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = '#2a8f9f'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    chartAllCatCoords[cat] = coords.map(c => ({ ...c, color: d.color }));
    if (!chartLastCoords.length) chartLastCoords = chartAllCatCoords[cat];
  });
  clearDotOverlay();
}

function toggleCat(el) {
  const cat = el.dataset.cat;
  const isActive = activeCats.has(cat);
  // Don't allow deselecting all
  if (isActive && activeCats.size === 1) return; // always keep at least one
  if (isActive) {
    activeCats.delete(cat);
    el.style.opacity = '0.35';
    el.style.background = 'transparent';
  } else {
    activeCats.add(cat);
    el.style.opacity = '1';
    // Restore color bg
    const colors = { acciones: 'rgba(67,233,123,0.1)', cripto: 'rgba(255,101,132,0.1)', rsu: 'rgba(247,183,49,0.1)', fiat: 'rgba(79,195,247,0.1)' };
    el.style.background = colors[cat];
  }
  drawChart();
}

function switchPosTab(el, cat) {
  document.querySelectorAll('.pos-tab').forEach(t => {
    t.style.background = 'var(--surface)';
    t.style.color = 'var(--muted)';
    t.style.border = '1px solid var(--border)';
  });
  el.style.background = 'var(--accent)';
  el.style.color = '#fff';
  el.style.border = '1px solid var(--accent)';

  document.querySelectorAll('#assetList .asset-card').forEach(card => {
    if (cat === 'all' || card.dataset.cat === cat) {
      card.style.display = 'flex';
    } else {
      card.style.display = 'none';
    }
  });
}

// Init chart after DOM ready
// Init totalMode ON state
(function() {
  const filters = document.getElementById('catFilters');
  if (filters) { filters.style.opacity = '0.4'; filters.style.pointerEvents = 'none'; }
})();
// drawChart needs panel visible — called on switchNav to portfolio

// ─── Chart tooltip ───
(function() {
  function getChartValue(x, W) {
    const allCats = [...activeCats];
    const len = Math.max(...allCats.map(cat => (catData[cat]?.points || []).length));
    if (len < 2) return null;
    const idx = Math.max(0, Math.min(len - 1, Math.round((x / W) * (len - 1))));
    const val = allCats.reduce((sum, cat) => sum + (catData[cat]?.points[idx] || 0), 0);
    // Per-cat values for individual mode
    const catVals = {};
    allCats.forEach(cat => { catVals[cat] = catData[cat]?.points[idx] || 0; });
    return { val, idx, catVals };
  }

  const CAT_LABEL_MAP = { acciones: 'Acc', cripto: 'Cri', rsu: 'RSU', fiat: 'Cash' };
  const CAT_COLOR_MAP = { acciones: '#43e97b', cripto: '#ff6584', rsu: '#f7b731', fiat: '#4fc3f7' };

  function showTip(clientX, clientY) {
    const canvas = document.getElementById('portfolioChart');
    const tooltip = document.getElementById('chartTooltip');
    if (!canvas || !tooltip) return false;
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top - 20 || clientY > rect.bottom + 20) return false;
    const result = getChartValue(clientX - rect.left, rect.width);
    if (!result) return false;
    const sym = currentCurrency === 'GBP' ? '£' : '$';
    const date = chartSnapDates[result.idx];
    if (date) document.getElementById('ttDate').textContent = date.toLocaleDateString('es-AR', { day:'numeric', month:'short' });

    if (totalMode) {
      document.getElementById('ttVal').textContent = valuesHidden ? '*****' : sym + Math.round(result.val).toLocaleString('es-AR');
    } else {
      // Show per-cat breakdown
      const cats = [...activeCats];
      if (valuesHidden) {
        document.getElementById('ttVal').textContent = '*****';
      } else {
        document.getElementById('ttVal').innerHTML = cats.map(cat => {
          const v = result.catVals[cat] || 0;
          const color = CAT_COLOR_MAP[cat] || '#fff';
          return '<span style="color:' + color + '">' + CAT_LABEL_MAP[cat] + ' ' + sym + Math.round(v).toLocaleString('es-AR') + '</span>';
        }).join('<br>');
      }
    }

    drawDotAt(result.idx);
    const wrap = document.getElementById('chartWrap');
    const wRect = wrap.getBoundingClientRect();
    let left = clientX - wRect.left + 10;
    if (left + 140 > wRect.width) left = clientX - wRect.left - 145;
    tooltip.style.left = left + 'px';
    tooltip.style.top = '4px';
    tooltip.classList.add('visible');
    return true;
  }

  document.addEventListener('mousemove', function(e) {
    if (!showTip(e.clientX, e.clientY)) {
      const t = document.getElementById('chartTooltip');
      if (t) t.classList.remove('visible');
      clearDotOverlay();
    }
  });
  let tooltipPinned = false;
  document.addEventListener('touchmove', function(e) {
    if (e.touches[0]) {
      // While dragging finger, show tooltip but don't pin — pin only on tap (touchend)
      showTip(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });
  document.addEventListener('touchend', function(e) {
    const t = document.getElementById('chartTooltip');
    if (!t) return;
    const canvas  = document.getElementById('portfolioChart');
    if (!canvas) return;
    const rect    = canvas.getBoundingClientRect();
    const tipRect = t.getBoundingClientRect();
    const tx = e.changedTouches[0].clientX, ty = e.changedTouches[0].clientY;
    const onTip   = tx >= tipRect.left && tx <= tipRect.right && ty >= tipRect.top && ty <= tipRect.bottom;
    const onChart = tx >= rect.left && tx <= rect.right && ty >= rect.top - 20 && ty <= rect.bottom + 20;

    const tipVisible = t.classList.contains('visible');
    if (onTip && tipVisible) {
      // Tap on visible tooltip bubble → always hide
      tooltipPinned = false;
      t.classList.remove('visible');
      clearDotOverlay();
    } else if (onChart && !onTip) {
      // Tap on chart (not on bubble) → pin/show
      tooltipPinned = true;
      showTip(tx, ty);
    } else if (!onChart) {
      // Tap outside chart — hide
      tooltipPinned = false;
      t.classList.remove('visible');
      clearDotOverlay();
    }
  });
})();

// ─── Swiper (portfolio header bar ↔ pie) ───
let swipeX0 = 0, allocSlide = 0;
function swipeStart(e) { swipeX0 = e.clientX; }
function swipeEnd(e) {
  const dx = e.clientX - swipeX0;
  if (Math.abs(dx) < 30) return;
  allocSlide = dx < 0 ? 1 : 0;
  document.getElementById('hSlide0').style.display = allocSlide === 0 ? 'block' : 'none';
  document.getElementById('hSlide1').style.display = allocSlide === 1 ? 'block' : 'none';
  if (allocSlide === 1) { setTimeout(drawPie, 50); }
}

// ── ALLOC PIE (header) focus state ──────────────────────────────────────────
let allocFocusCat   = null;
let allocPieSlices  = [];
let allocPieAnimReq = null;
let allocPieAnimProg = 1;

function buildAllocSlices() {
  const bd  = liveData ? liveData.breakdown : { acciones:1, cripto:0.1, rsu:2.5, fiat:6 };
  const tot = (bd.acciones||0) + (bd.cripto||0) + (bd.rsu||0) + (bd.fiat||0) || 1;
  const liquid = Math.max(0, (bd.fiat||0) - (bd.fiat_locked||0));
  const locked = bd.fiat_locked || 0;
  return [
    { cat:'acciones', label:'Acciones', pct:(bd.acciones||0)/tot, color:'#43e97b', pattern:null },
    { cat:'cripto',   label:'Cripto',   pct:(bd.cripto||0)/tot,   color:'#ff6584', pattern:null },
    { cat:'rsu',      label:'RSUs',     pct:(bd.rsu||0)/tot,      color:'f7b731',  color:'#f7b731', pattern:null },
    { cat:'liquid',   label:'Líquido',  pct:liquid/tot,           color:'#4fc3f7', pattern:null },
    { cat:'locked',   label:'Ilíquido', pct:locked/tot,           color:'#2a8f9f', pattern:'stripe' },
  ].filter(s => s.pct > 0.001);
}

function drawAllocPieFrame(prog, focusCat, slices) {
  const canvas = document.getElementById('allocPie');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const SIZE = 130;
  canvas.width  = SIZE * dpr; canvas.height = SIZE * dpr;
  canvas.style.width = SIZE + 'px'; canvas.style.height = SIZE + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const cx = SIZE/2, cy = SIZE/2, R = SIZE*0.38, iR = SIZE*0.25;
  const EXPAND = 9;
  const easedProg = easeInOut(prog);

  // Stripe pattern
  const patCanvas = document.createElement('canvas');
  patCanvas.width = 6; patCanvas.height = 6;
  const patCtx = patCanvas.getContext('2d');
  patCtx.strokeStyle = '#4fc3f7'; patCtx.lineWidth = 1.5;
  patCtx.beginPath(); patCtx.moveTo(0,6); patCtx.lineTo(6,0); patCtx.stroke();
  const stripePattern = ctx.createPattern(patCanvas, 'repeat');

  ctx.clearRect(0, 0, SIZE, SIZE);
  let angle = -Math.PI / 2;
  slices.forEach(s => {
    const sweep    = s.pct * Math.PI * 2;
    const isFocused = focusCat && s.cat === focusCat;
    const isOther   = focusCat && s.cat !== focusCat;
    const r  = R  + (isFocused ? EXPAND * easedProg : isOther ? -3 * easedProg : 0);
    const ir = iR + (isFocused ? -2 * easedProg : 0);
    const bisect = angle + sweep / 2;
    const offset = isFocused ? EXPAND * 0.5 * easedProg : 0;
    const ox = Math.cos(bisect) * offset, oy = Math.sin(bisect) * offset;
    ctx.save();
    ctx.globalAlpha = isOther ? 1 - 0.55 * easedProg : 1;
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.arc(cx, cy, ir, angle + sweep, angle, true);
    ctx.closePath();
    if (s.pattern === 'stripe') {
      ctx.fillStyle = '#1a5f6f'; ctx.fill();
      ctx.fillStyle = stripePattern;
    } else {
      ctx.fillStyle = s.color;
    }
    ctx.fill();
    ctx.restore();
    s._angle = angle; s._sweep = sweep;
    angle += sweep;
  });

  // Center: show % if focused
  const pieTotal = document.getElementById('pieTotal');
  if (pieTotal) {
    if (focusCat && easedProg > 0.5) {
      const fs = slices.find(s => s.cat === focusCat);
      if (fs) { pieTotal.textContent = (fs.pct * 100).toFixed(1) + '%'; pieTotal.style.color = fs.color; }
    } else {
      const isGBP2 = currentCurrency === 'GBP';
      const tot2 = liveData ? liveData.totalUSD : 0;
      pieTotal.textContent = fmtVal(tot2, isGBP2 ? FX_RATE : 1, isGBP2 ? '£' : '$');
      pieTotal.style.color = '';
      if (valuesHidden) maskElement(pieTotal);
    }
  }
  // Legend rows
  const pieLegend = document.getElementById('pieLegend');
  if (pieLegend) {
    pieLegend.querySelectorAll('.alloc-legend-row').forEach(row => {
      const isF = focusCat && row.dataset.cat === focusCat;
      const isO = focusCat && row.dataset.cat !== focusCat;
      const dimAmount = easeInOut(prog);
      row.style.opacity   = isO ? String(1 - 0.55 * dimAmount) : '1';
      row.style.transform = isF && dimAmount > 0.5 ? 'scale(1.03)' : 'scale(1)';
    });
  }
}

function animateAllocPie(targetCat) {
  if (allocPieAnimReq) cancelAnimationFrame(allocPieAnimReq);
  const focusing  = !!targetCat;
  const DURATION  = 280;
  const startTime = performance.now();
  const slices    = buildAllocSlices();
  allocPieSlices  = slices;
  if (targetCat && allocFocusCat && targetCat !== allocFocusCat) {
    allocFocusCat = null; allocPieAnimProg = 0;
  }
  const fromCat = allocFocusCat;
  function step(now) {
    const t = Math.min((now - startTime) / DURATION, 1);
    allocPieAnimProg = focusing ? t : 1 - t;
    const drawCat = focusing ? targetCat : fromCat;
    drawAllocPieFrame(allocPieAnimProg, drawCat, slices);
    if (t < 1) { allocPieAnimReq = requestAnimationFrame(step); }
    else { allocFocusCat = targetCat; allocPieAnimReq = null; }
  }
  allocPieAnimReq = requestAnimationFrame(step);
}

function focusAllocSlice(cat) {
  if (allocFocusCat === cat) animateAllocPie(null);
  else animateAllocPie(cat);
}

function hitTestAllocPie(e) {
  const canvas = document.getElementById('allocPie');
  if (!canvas) return null;
  const rect   = canvas.getBoundingClientRect();
  const touch  = e.changedTouches ? e.changedTouches[0] : e;
  const dx = touch.clientX - (rect.left + rect.width  / 2);
  const dy = touch.clientY - (rect.top  + rect.height / 2);
  const dist  = Math.sqrt(dx*dx + dy*dy);
  const SIZE  = 130, scale = rect.width / SIZE;
  const R = SIZE * 0.38 * scale, iR = SIZE * 0.25 * scale;
  if (dist < iR || dist > R + 10 * scale) return null;
  let ang = Math.atan2(dy, dx) + Math.PI / 2;
  if (ang < 0) ang += Math.PI * 2;
  for (const s of allocPieSlices) {
    let a0 = s._angle + Math.PI / 2;
    if (a0 < 0) a0 += Math.PI * 2;
    const a1 = a0 + s._sweep;
    if (ang >= a0 && ang <= a1) return s.cat;
  }
  return null;
}

// Draw pie chart
function drawPie() {
  const slices = buildAllocSlices();
  allocPieSlices = slices;
  drawAllocPieFrame(allocFocusCat ? allocPieAnimProg : 1, allocFocusCat, slices);
}

// Tap handler for allocPie
(function() {
  let tapping = false, tapX = 0, tapY = 0;
  const getCanvas = () => document.getElementById('allocPie');
  document.addEventListener('touchstart', function(e) {
    const c = getCanvas(); if (!c) return;
    const t = e.touches[0], rect = c.getBoundingClientRect();
    if (t.clientX < rect.left || t.clientX > rect.right || t.clientY < rect.top || t.clientY > rect.bottom) return;
    tapping = true; tapX = t.clientX; tapY = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', function(e) {
    if (!tapping) return; tapping = false;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - tapX) > 10 || Math.abs(t.clientY - tapY) > 10) return;
    const cat = hitTestAllocPie(e);
    if (cat) { focusAllocSlice(cat); }
    else if (allocFocusCat) { animateAllocPie(null); }
  }, { passive: true });
  // Tap outside → unfocus
  document.addEventListener('touchend', function(e) {
    if (!allocFocusCat) return;
    const c = getCanvas(), lg = document.getElementById('pieLegend');
    const t = e.changedTouches[0];
    const inC  = c  && (() => { const r=c.getBoundingClientRect();  return t.clientX>=r.left&&t.clientX<=r.right&&t.clientY>=r.top&&t.clientY<=r.bottom; })();
    const inLg = lg && (() => { const r=lg.getBoundingClientRect(); return t.clientX>=r.left&&t.clientX<=r.right&&t.clientY>=r.top&&t.clientY<=r.bottom; })();
    if (!inC && !inLg) animateAllocPie(null);
  }, { passive: true });
})();

// pie legend now handled inside renderPortfolio()

// ─── RSU Modal ───
// Full vest schedule (16 quarters = 4 years)
// vestSchedule is loaded from Supabase rsu_vests table in openRSU()
let vestSchedule = [];  // populated from Supabase: { date, units, days, vested, vest_date }
let rsuLoadedOnce = false;

async function loadRSUVests() {
  try {
    const rows = await sbFetch('/rest/v1/rsu_vests?select=*&order=vest_date.asc');
    console.log('[RSU] rows from Supabase:', rows);
    if (!Array.isArray(rows)) {
      console.error('[RSU] Expected array, got:', rows);
      vestSchedule = [];
      rsuLoadedOnce = true;
      const sub = document.getElementById('rsuSubtitle');
      if (sub) sub.textContent = 'Error cargando datos';
      return;
    }
    const today = new Date();
    today.setHours(0,0,0,0);

    vestSchedule = rows.map(r => {
      const vestDate = new Date(r.vest_date);
      vestDate.setHours(0,0,0,0);
      const diffMs = vestDate - today;
      const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
      // Format date like "May '26"
      const d = new Date(r.vest_date);
      const monthShort = d.toLocaleDateString('en-US', { month: 'short' });
      const yearShort = "'" + String(d.getFullYear()).slice(2);
      return {
        date: monthShort + ' ' + yearShort,
        vest_date: r.vest_date,
        units: r.units,
        days: days,
        vested: r.vested,
      };
    });

    // Summary stats for subtitle
    const totalUnits = rows.reduce((s, r) => s + r.units, 0);
    const vestedUnits = rows.filter(r => r.vested).reduce((s, r) => s + r.units, 0);
    const pendingUnits = totalUnits - vestedUnits;
    const sub = document.getElementById('rsuSubtitle');
    if (sub) {
      const pct = totalUnits > 0 ? Math.round((vestedUnits / totalUnits) * 100) : 0;
      sub.textContent = totalUnits + ' units totales · ' + pendingUnits + ' por vestear (' + pct + '% vesteado)';
    }

    rsuLoadedOnce = true;
  } catch(e) {
    console.error('Error loading RSU vests:', e);
    vestSchedule = [];
  }
}

// Get live META price from already-loaded prices map
function getRSUPriceUSD() {
  // prices map uses 'RSU_META' key for META price
  if (liveData && liveData.assets) {
    const metaAsset = liveData.assets.find(a => a.pos.ticker === 'RSU_META');
    if (metaAsset && metaAsset.priceUSD) return metaAsset.priceUSD;
  }
  return 600; // fallback
}
let rsuCurrency = 'GBP';
let rsuNet = false;  // false = bruto, true = neto (53% of bruto)
const NET_RATE = 0.53;
let visibleQuarters = 4;

function setRsuCurrency(cur) {
  rsuCurrency = cur;
  const isGBP = cur === 'GBP';
  document.getElementById('rsuBtnGBP').style.background = isGBP ? '#4fc3f7' : 'transparent';
  document.getElementById('rsuBtnGBP').style.color = isGBP ? '#000' : 'var(--muted)';
  document.getElementById('rsuBtnUSD').style.background = isGBP ? 'transparent' : '#4fc3f7';
  document.getElementById('rsuBtnUSD').style.color = isGBP ? 'var(--muted)' : '#000';
  refreshRSU();
  if (valuesHidden) {
    document.querySelectorAll('.modal-money-val, .rsu-row-val, .rsu-acum-num').forEach(maskElement);
    document.querySelectorAll('.modal-units-val, .rsu-units-val').forEach(maskUnits);
    const _rsuSub = document.getElementById('rsuSubtitle');
    if (_rsuSub) maskRsuSubtitle(_rsuSub);
  }
}

function setRsuNet(isNet) {
  rsuNet = isNet;
  document.getElementById('rsuBtnBruto').style.background = isNet ? 'transparent' : '#f7b731';
  document.getElementById('rsuBtnBruto').style.color = isNet ? 'var(--muted)' : '#000';
  document.getElementById('rsuBtnNeto').style.background = isNet ? '#f7b731' : 'transparent';
  document.getElementById('rsuBtnNeto').style.color = isNet ? '#000' : 'var(--muted)';
  refreshRSU();
  if (valuesHidden) {
    document.querySelectorAll('.modal-money-val, .rsu-row-val, .rsu-acum-num').forEach(maskElement);
    document.querySelectorAll('.modal-units-val, .rsu-units-val').forEach(maskUnits);
    const _rsuSub = document.getElementById('rsuSubtitle');
    if (_rsuSub) maskRsuSubtitle(_rsuSub);
  }
}

function setQuarters(n, el) {
  visibleQuarters = n;
  document.querySelectorAll('.q-btn').forEach(b => {
    b.style.background = 'var(--surface)';
    b.style.color = 'var(--muted)';
  });
  el.style.background = '#4fc3f7';
  el.style.color = '#000';
  refreshRSU();
  // Re-apply mask immediately (before chart setTimeout fires)
  if (valuesHidden) {
    document.querySelectorAll('.modal-money-val, .rsu-row-val, .rsu-acum-num').forEach(maskElement);
    document.querySelectorAll('.modal-units-val, .rsu-units-val').forEach(maskUnits);
    const rsuSubEl = document.getElementById('rsuSubtitle');
    if (rsuSubEl) maskRsuSubtitle(rsuSubEl);
  }
}

async function openRSU() {
  rsuCurrency = currentCurrency;
  const isGBP = rsuCurrency === 'GBP';
  document.getElementById('rsuBtnGBP').style.background = isGBP ? '#4fc3f7' : 'transparent';
  document.getElementById('rsuBtnGBP').style.color = isGBP ? '#000' : 'var(--muted)';
  document.getElementById('rsuBtnUSD').style.background = isGBP ? 'transparent' : '#4fc3f7';
  document.getElementById('rsuBtnUSD').style.color = isGBP ? 'var(--muted)' : '#000';
  document.getElementById('rsuModal').classList.add('open');
  if (!rsuLoadedOnce) {
    await loadRSUVests();
  }
  refreshRSU();
}

function refreshRSU() {
  if (!vestSchedule.length) return;
  const isGBP = rsuCurrency === 'GBP';
  const rate = isGBP ? FX_RATE : 1;
  const sym = isGBP ? '£' : '$';
  const RSU_PRICE_USD = getRSUPriceUSD();

  // Separate vested vs upcoming
  const upcoming = vestSchedule.filter(v => !v.vested);
  const allVests = vestSchedule; // includes vested ones for table

  const slice = upcoming.slice(0, visibleQuarters);

  // Apply gross/net multiplier
  const netMult = rsuNet ? NET_RATE : 1;
  const labelSuffix = rsuNet ? 'valor neto estimado (53%)' : 'valor bruto estimado';

  // Next vest card — first upcoming vest
  const next = upcoming[0];
  if (next) {
    document.getElementById('nextVestDate').textContent = next.date;
    const daysEl = document.getElementById('daysToVest');
    if (daysEl) daysEl.textContent = next.days > 0 ? next.days : 'hoy';
    // Update full subtitle including units
    const subEl = document.getElementById('nextVestSub');
    if (subEl) subEl.innerHTML = (next.days > 0 ? 'en <span id="daysToVest">' + next.days + '</span> días' : '<span id="daysToVest">hoy</span>') + ' · <span class="rsu-units-val">' + next.units + '</span> units';
    const nextVal = Math.round(next.units * RSU_PRICE_USD * rate * netMult);
    document.getElementById('nextVestVal').textContent = sym + nextVal.toLocaleString();
    const lblEl = document.getElementById('nextVestLabel');
    if (lblEl) lblEl.textContent = labelSuffix;
  }

  // Accum total for visible upcoming quarters
  const totalAccum = slice.reduce((s,v) => s + Math.round(v.units * RSU_PRICE_USD * rate * netMult), 0);
  document.getElementById('accumTotal').textContent = sym + totalAccum.toLocaleString();
  document.getElementById('qLabel').textContent = slice.length;

  // X-axis labels
  const labelsEl = document.getElementById('vestXLabels');
  const step = slice.length > 8 ? 2 : 1;
  labelsEl.innerHTML = slice.map((v,i) => i % step === 0 ? `<span>${v.date}</span>` : '<span></span>').join('');

  // Vest table: show all upcoming vests (with vested ones grayed at top if any)
  let accum = 0;
  const tableEl = document.getElementById('vestTable');

  // Show vested rows first (grayed), then upcoming
  const vestedRows = allVests.filter(v => v.vested);
  const upcomingRows = upcoming;
  const tableRows = [...vestedRows, ...upcomingRows];

  tableEl.innerHTML = tableRows.map((v, i) => {
    const val = Math.round(v.units * RSU_PRICE_USD * rate * netMult);
    const isVested = v.vested;
    const isNext = !isVested && v === upcomingRows[0];
    accum += val;
    const rowBorder = isNext ? 'border:1.5px solid rgba(79,195,247,0.4)' : '';
    const dotColor = isVested ? '#43e97b' : isNext ? '#4fc3f7' : 'var(--border)';
    const valColor = isVested ? 'var(--muted)' : '#4fc3f7';
    const daysLabel = isVested
      ? '<span style="color:#43e97b">✓ Vesteado</span>'
      : (v.days > 0 ? 'en ' + v.days + ' días' : 'hoy') + ' · <span class="rsu-units-val">' + v.units + '</span> units';
    return `<div style="display:flex;align-items:center;gap:12px;background:var(--surface2);border-radius:14px;padding:12px 14px;opacity:${isVested?'0.5':'1'};${rowBorder}">
      <div style="width:8px;height:8px;border-radius:50%;background:${dotColor}"></div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${v.date}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${daysLabel}</div>
      </div>
      <div style="text-align:right">
        <div class="rsu-row-val" style="font-family:var(--font-num);font-size:14px;font-weight:700;color:${valColor}">${sym}${val.toLocaleString()}</div>
        <div style="font-size:10px;color:var(--muted)">acum: <span class="rsu-acum-num">${sym}${accum.toLocaleString()}</span></div>
      </div>
    </div>`;
  }).join('');

  setTimeout(() => {
    drawVestChart(rate, sym, slice, RSU_PRICE_USD, netMult);
    if (valuesHidden) {
      document.querySelectorAll('.modal-money-val, .rsu-row-val, .rsu-acum-num').forEach(maskElement);
    document.querySelectorAll('.modal-units-val, .rsu-units-val').forEach(maskUnits);
      const rsuSubEl = document.getElementById('rsuSubtitle');
      if (rsuSubEl) maskRsuSubtitle(rsuSubEl);
    }
  }, 60);
}

function closeRSU() {
  document.getElementById('rsuModal').classList.remove('open');
}

function drawVestChart(rate, sym, slice, RSU_PRICE_USD, netMult) {
  const canvas = document.getElementById('vestChart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.offsetWidth - 32;
  const H = 130;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const vals = slice.map(v => Math.round(v.units * RSU_PRICE_USD * rate * (netMult || 1)));
  const accums = vals.reduce((acc, v, i) => { acc.push((acc[i-1]||0) + v); return acc; }, []);
  const maxVal = Math.max(...accums, 1);
  const n = vals.length;
  const barW = Math.max(4, (W / n) * (n > 10 ? 0.7 : 0.55));
  const gap = W / n;
  const padB = 8, padT = 18;
  const showLabels = !valuesHidden;

  vals.forEach((v, i) => {
    const x = i * gap + (gap - barW) / 2;
    const availH = H - padB - padT;
    // Accumulated bar
    const accumH = (accums[i] / maxVal) * availH;
    ctx.fillStyle = 'rgba(79,195,247,0.2)';
    ctx.beginPath();
    ctx.roundRect(x, H - padB - accumH, barW, accumH, [4,4,0,0]);
    ctx.fill();
    // Accumulated label
    if (showLabels) {
      ctx.fillStyle = 'rgba(79,195,247,0.7)';
      ctx.font = `${n > 10 ? 7 : 8}px DM Sans, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(sym + (accums[i]/1000).toFixed(1)+'k', x + barW/2, H - padB - accumH - 3);
    }
    // Period bar
    if (v > 0) {
      const periodH = (v / maxVal) * availH;
      ctx.fillStyle = '#4fc3f7';
      ctx.beginPath();
      ctx.roundRect(x, H - padB - periodH, barW, periodH, [4,4,0,0]);
      ctx.fill();
      // Period label
      if (showLabels) {
        ctx.fillStyle = '#4fc3f7';
        ctx.font = `bold ${n > 10 ? 8 : 9}px DM Sans, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(sym + (v/1000).toFixed(1)+'k', x + barW/2, H - padB - periodH - 3);
      }
    }
  });
}

setTimeout(drawPie, 200);

// ─── Position Detail Modal ───
let posDetailTicker = null;

let posModalCurrency = 'GBP';

function setPosModalCurrency(cur) {
  posModalCurrency = cur;
  document.getElementById('posBtnGBP').style.background = cur === 'GBP' ? 'var(--accent)' : 'transparent';
  document.getElementById('posBtnGBP').style.color = cur === 'GBP' ? '#fff' : 'var(--muted)';
  document.getElementById('posBtnUSD').style.background = cur === 'USD' ? 'var(--accent)' : 'transparent';
  document.getElementById('posBtnUSD').style.color = cur === 'USD' ? '#fff' : 'var(--muted)';
  if (posDetailTicker) {
    renderPosModalValues(posDetailTicker);
    const meta = TICKER_META[posDetailTicker] || {};
    drawPosChart(posDetailTicker, meta);
  }
}

function renderPosModalValues(ticker) {
  const asset = liveData && liveData.assets.find(a => a.pos.ticker === ticker);
  if (!asset) return;
  const { pos, valueUSD, priceUSD } = asset;
  console.log('[PosModal] ticker:', ticker, 'priceUSD:', priceUSD, 'valueUSD:', valueUSD, 'avg_cost_usd:', pos.avg_cost_usd, 'qty:', pos.qty);
  const isGBP = posModalCurrency === 'GBP';
  const rate = isGBP ? FX_RATE : 1;
  const sym = isGBP ? '\u00a3' : '$';

  // Price in selected currency
  const fmtPrice = v => {
    const val = v * rate;
    return sym + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  // Price: priceUSD is always in USD (worker converts LSE GBP→USD before storing)
  // Display in selected currency
  const priceDisplay = priceUSD ? priceUSD * rate : null;
  document.getElementById('posModalPrice').textContent = priceDisplay
    ? sym + priceDisplay.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
    : '\u2014';

  // Position value
  document.getElementById('posModalValue').textContent = fmtVal(valueUSD, rate, sym);
  document.getElementById('posModalQtyNum').textContent = fmtQty(pos.qty, ticker);

  // P&L: (currentPriceUSD - avgCostUSD) * qty => convert to display currency
  const pnlEl = document.getElementById('posModalPnl');
  const pnlPctEl = document.getElementById('posModalPnlPct');
  // Use native avg cost in each currency to avoid FX distortion
  const avgCostNative = isGBP ? Number(pos.avg_cost_gbp) : Number(pos.avg_cost_usd);
  const priceNative = isGBP ? (priceUSD * FX_RATE) : priceUSD;

  if (priceNative && avgCostNative) {
    const pnlNative = (priceNative - avgCostNative) * pos.qty;
    const pnlPct = ((priceNative - avgCostNative) / avgCostNative) * 100;
    const pnlDisplay = Math.abs(pnlNative).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    pnlEl.textContent = (pnlNative >= 0 ? '+' : '-') + sym + pnlDisplay;
    pnlEl.style.color = pnlNative >= 0 ? 'var(--accent3)' : 'var(--accent2)';
    pnlPctEl.textContent = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '% vs costo';
    pnlPctEl.style.color = pnlEl.style.color;
  } else {
    pnlEl.textContent = '\u2014'; pnlEl.style.color = 'var(--muted)';
    pnlPctEl.textContent = 'sin costo promedio';
  }

  // Avg cost per share in selected currency
  const avgEl = document.getElementById('posModalAvg');
  if (avgCostNative) {
    avgEl.textContent = sym + avgCostNative.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else {
    avgEl.textContent = '\u2014';
  }

  // Portfolio share (always %)
  const share = liveData && liveData.totalUSD > 0 ? (valueUSD / liveData.totalUSD * 100) : 0;
  document.getElementById('posModalShare').textContent = share.toFixed(1) + '%';
  // Re-apply hide mask if active
  if (valuesHidden) {
    document.querySelectorAll('.modal-money-val').forEach(maskElement);
    document.querySelectorAll('.modal-units-val').forEach(maskUnits);
  }
}

async function openPosDetail(ticker) {
  posDetailTicker = ticker;
  posModalCurrency = currentCurrency; // inherit main toggle
  document.getElementById('posModal').classList.add('open');

  // Sync currency toggle buttons to current state
  const isGBPInit = posModalCurrency === 'GBP';
  document.getElementById('posBtnGBP').style.background = isGBPInit ? 'var(--accent)' : 'transparent';
  document.getElementById('posBtnGBP').style.color = isGBPInit ? '#fff' : 'var(--muted)';
  document.getElementById('posBtnUSD').style.background = !isGBPInit ? 'var(--accent)' : 'transparent';
  document.getElementById('posBtnUSD').style.color = !isGBPInit ? '#fff' : 'var(--muted)';

  const meta = TICKER_META[ticker] || { name: ticker, logo: '\ud83d\udcb0', logoUrl: null };

  // Logo — mirror portfolio card logic: whiteBg = white circle + contain + padding, else cover
  const logoEl = document.getElementById('posModalLogo');
  if (meta.logoUrl) {
    const fit = meta.whiteBg ? 'contain' : 'cover';
    const pad = meta.whiteBg ? '4px' : '0';
    const bg = meta.whiteBg ? '#fff' : 'transparent';
    logoEl.style.background = bg;
    logoEl.innerHTML = '<img src="' + meta.logoUrl + '" style="width:48px;height:48px;border-radius:50%;object-fit:' + fit + ';padding:' + pad + ';background:' + bg + '">';
  } else {
    logoEl.style.background = '#ffffff22';
    logoEl.textContent = meta.logo;
  }
  document.getElementById('posModalName').textContent = meta.name;
  document.getElementById('posModalTicker').textContent = ticker;

  // Day change (% is currency-neutral)
  const asset = liveData && liveData.assets.find(a => a.pos.ticker === ticker);
  if (asset) {
    const dayEl = document.getElementById('posModalDayChg');
    const { dayPct } = asset;
    if (dayPct !== null && dayPct !== undefined) {
      const rounded = parseFloat(dayPct.toFixed(2));
      dayEl.textContent = (rounded >= 0 ? '+' : '') + rounded.toFixed(2) + '%';
      dayEl.style.color = rounded > 0 ? 'var(--accent3)' : rounded < 0 ? 'var(--accent2)' : 'var(--muted)';
    } else {
      dayEl.textContent = '\u2014';
      dayEl.style.color = 'var(--muted)';
    }
  }

  // Render monetary values
  renderPosModalValues(ticker);

  // Load 30d chart
  await drawPosChart(ticker, meta);
}

function closePosDetail() {
  document.getElementById('posModal').classList.remove('open');
}

async function drawPosChart(ticker, meta) {
  const canvas = document.getElementById('posModalChart');
  if (!canvas) return;

  // Map ticker to price_snapshots ticker format
  // New worker stores DB tickers; old worker stored Yahoo tickers for some
  // Query both variants to handle historical data
  const snapTickerAlt = ticker === 'BRK.B' ? 'BRK-B' : ticker === 'BTC' ? 'BTC-USD' : null;
  const snapTicker = ticker === 'RSU_META' ? 'META' : ticker;

  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const tickerFilter = snapTickerAlt
      ? 'ticker=in.(' + snapTicker + ',' + snapTickerAlt + ')'
      : 'ticker=eq.' + snapTicker;
    const rows = await sbFetch('/rest/v1/price_snapshots?select=price_usd,captured_at&' + tickerFilter + '&order=captured_at.asc&captured_at=gte.' + since);
    if (!rows || rows.length < 2) {
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const W0 = canvas.getBoundingClientRect().width || canvas.parentElement.clientWidth;
      canvas.width = Math.floor(W0 * dpr);
      canvas.height = 60 * dpr;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.font = '11px DM Sans';
      ctx.textAlign = 'center';
      ctx.fillText('Sin datos suficientes', canvas.parentElement.offsetWidth / 2, 30);
      return;
    }

    let prices;
    if (posModalCurrency === 'GBP') {
      // Fetch historical fx_rates from portfolio_snapshots for the same window
      // so each price_usd is multiplied by the fx at that moment, not today's fx
      const fxRows = await sbFetch(
        '/rest/v1/portfolio_snapshots?select=captured_at,fx_rate&order=captured_at.asc&captured_at=gte.' + since
      );
      // Build sorted array of {ts, fx}
      const fxSeries = (fxRows || []).map(r => ({ ts: new Date(r.captured_at).getTime(), fx: r.fx_rate }));
      // For each price row, find closest fx_rate by timestamp
      prices = rows.map(r => {
        const ts = new Date(r.captured_at).getTime();
        let closest = fxSeries[0];
        let minDiff = Infinity;
        for (const f of fxSeries) {
          const d = Math.abs(f.ts - ts);
          if (d < minDiff) { minDiff = d; closest = f; }
        }
        const fx = closest ? closest.fx : FX_RATE;
        return r.price_usd * fx;
      });
    } else {
      prices = rows.map(r => r.price_usd);
    }

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.getBoundingClientRect().width || canvas.parentElement.clientWidth;
    const H = 60;
    canvas.width = Math.floor(W * dpr);
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
    const padT = 4, padB = 4;
    const step = W / (prices.length - 1);
    const coords = prices.map((v, i) => ({
      x: i * step,
      y: padT + (1 - (v - min) / range) * (H - padT - padB)
    }));

    const isUp = prices[prices.length-1] >= prices[0];
    const lineColor = isUp ? '#43e97b' : '#ff6584';

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, lineColor + '30');
    grad.addColorStop(1, lineColor + '00');
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

    // Date label
    if (rows.length > 0) {
      const startDate = new Date(rows[0].captured_at);
      document.getElementById('posModalChartStart').textContent =
        startDate.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
    }
  } catch(e) {
    console.error('Error loading price history:', e);
  }
}




