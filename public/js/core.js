// Generate heatmap — must run after DOM is ready
function renderHeatmap() {
  const hm = document.getElementById('heatmap');
  if (!hm) return;
  for (let i = 0; i < 91; i++) {
    const cell = document.createElement('div');
    const r = Math.random();
    cell.className = 'hm-cell ' + (r < 0.2 ? '' : r < 0.4 ? 'l1' : r < 0.65 ? 'l2' : r < 0.85 ? 'l3' : 'l4');
    hm.appendChild(cell);
  }
}

let isDark = true;
function toggleTheme() {
  isDark = !isDark;
  document.getElementById('app').classList.toggle('light', !isDark);
  document.getElementById('themeBtn').innerHTML = isDark ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>` : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  const dt = document.getElementById('darkToggle');
  if (dt) dt.classList.toggle('on', isDark);
}

const navTitles = {
  today: ['Hábitos', ''],
  recipes: ['Mis Recetas 🍳', 'Tu repositorio personal'],
  portfolio: ['Portfolio', 'Cargando...'],
  analytics: ['Analytics 📊', 'Simulaciones y análisis'],
  settings: ['Configuración', 'julian@email.com'],
};

function switchNav(el, name) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  const t = navTitles[name] || navTitles.today;
  document.querySelector('.topbar-left h1').textContent = t[0];
  document.querySelector('.topbar-left p').textContent = t[1];

  // FABs only visible on portfolio + analytics
  const fabTabs = ['portfolio', 'analytics'];
  const showFabs = fabTabs.includes(name);
  const aiBubble = document.getElementById('aiBubble');
  const txFab    = document.getElementById('txFab');
  if (aiBubble) aiBubble.style.display = showFabs ? 'flex' : 'none';
  if (txFab)    txFab.style.display    = showFabs ? 'flex' : 'none';
  // h-sub-tabs live inside panel-today, no top-level show/hide needed
  if (name === 'portfolio') {
    requestAnimationFrame(() => requestAnimationFrame(drawChart));
    if (!liveData) loadPortfolio();
    else { updateLastUpdatedLabel(); }
    // Refresh label every 30s while on portfolio tab
    if (_lastUpdatedTimer) clearInterval(_lastUpdatedTimer);
    _lastUpdatedTimer = setInterval(() => {
      if (document.getElementById('panel-portfolio').classList.contains('active')) updateLastUpdatedLabel();
      else { clearInterval(_lastUpdatedTimer); _lastUpdatedTimer = null; }
    }, 30000);
  }
  if (name === 'analytics') {
    // Seed portfolio values from liveData if available
    if (typeof liveData !== 'undefined' && liveData && liveData.totalUSD) {
      const invEl = document.getElementById('mc-p-invested');
      const cashEl = document.getElementById('mc-p-cash');
      if (invEl) invEl.value = mcGetPortfolioInvested();
      if (cashEl) cashEl.value = mcGetPortfolioCash();
    }
    // Render health score
    if (typeof renderHealthScore === 'function') renderHealthScore();
  }
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');
}

function toggleHabit(el) {
  el.classList.toggle('done');
  el.classList.add('just-done');
  setTimeout(() => el.classList.remove('just-done'), 300);
  const check = el.querySelector('.habit-check');
  check.textContent = el.classList.contains('done') ? '✓' : '';
  updateProgress();
}

function updateProgress() {
  const items = document.querySelectorAll('#habitList .habit-item');
  const done = document.querySelectorAll('#habitList .habit-item.done').length;
  const total = items.length;
  const pct = Math.round((done / total) * 100);
  document.getElementById('pctLabel').textContent = pct + '%';
  document.getElementById('doneCount').textContent = done + ' de ' + total + ' hábitos hechos';
  const circumference = 201;
  document.getElementById('progressCircle').style.strokeDashoffset = circumference - (circumference * pct / 100);
}

const timerData = {
  'Carbonara': [
    {icon:'🍝', name:'Hervir pasta al dente', time:'10 min', mins:10},
    {icon:'🥓', name:'Dorar guanciale', time:'5 min', mins:5},
    {icon:'🥚', name:'Mezclar huevo + pecorino', time:'2 min', mins:2},
  ],
  'Risotto': [
    {icon:'🧅', name:'Sofrito de cebolla', time:'8 min', mins:8},
    {icon:'🍚', name:'Tostar el arroz', time:'3 min', mins:3},
    {icon:'🫗', name:'Agregar caldo de a poco', time:'18 min', mins:18},
  ],
  'Salmón': [
    {icon:'🧂', name:'Marinar el salmón', time:'15 min', mins:15},
    {icon:'🔥', name:'Sellar en sartén', time:'4 min', mins:4},
    {icon:'🫕', name:'Terminar en horno', time:'8 min', mins:8},
  ],
};

function openTimer(recipe) {
  const steps = timerData[recipe] || [];
  document.getElementById('modalTitle').textContent = recipe + ' — Timers';
  const list = document.getElementById('timerList');
  list.innerHTML = steps.map((s, i) => `
    <div class="timer-item" id="titem${i}">
      <div class="timer-icon">${s.icon}</div>
      <div class="timer-info">
        <div class="t-name">${s.name}</div>
        <div class="t-time" id="ttime${i}">${s.time}</div>
      </div>
      <button class="timer-btn" onclick="startTimer(${i}, ${s.mins})">▶ Start</button>
    </div>
  `).join('');
  document.getElementById('timerModal').classList.add('open');
}

function closeTimer() {
  document.getElementById('timerModal').classList.remove('open');
}

const activeTimers = {};
function startTimer(idx, mins) {
  if (activeTimers[idx]) return;
  let secs = mins * 60;
  const btn = document.querySelector('#titem' + idx + ' .timer-btn');
  btn.textContent = '⏸';
  activeTimers[idx] = setInterval(() => {
    secs--;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    document.getElementById('ttime' + idx).textContent = m + ':' + s.toString().padStart(2,'0') + ' restante';
    if (secs <= 0) {
      clearInterval(activeTimers[idx]);
      delete activeTimers[idx];
      document.getElementById('ttime' + idx).textContent = '✅ Listo!';
      btn.textContent = '✓';
      btn.style.background = 'var(--accent3)';
    }
  }, 1000);
}

// ── DATA ACCESS (via server proxy) ──
// Supabase credentials stay server-side. Frontend calls /api/db/* which proxies to Supabase.

async function sbFetch(path) {
  // path comes as '/rest/v1/positions?select=*'
  // transform to '/api/db/positions?select=*'
  const proxyPath = path.replace(/^\/rest\/v1\//, '/api/db/');
  const res = await fetch(proxyPath, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('[sbFetch] HTTP ' + res.status + ' for ' + path + ':', errText);
    throw new Error('HTTP ' + res.status + ': ' + errText.slice(0, 200));
  }
  return res.json();
}

// Live portfolio data (filled by loadPortfolio)
let liveData = null;
let lastSnapshotAt = null;
let _lastUpdatedTimer = null;

function updateLastUpdatedLabel() {
  if (!lastSnapshotAt) return;
  const diffMs = Date.now() - lastSnapshotAt.getTime();
  const diffMin = Math.round(diffMs / 60000);
  let label;
  if (diffMin < 1) label = 'Actualizado hace un momento';
  else if (diffMin === 1) label = 'Actualizado hace 1 min';
  else if (diffMin < 60) label = 'Actualizado hace ' + diffMin + ' min';
  else {
    const h = Math.floor(diffMin / 60);
    label = 'Actualizado hace ' + h + (h === 1 ? ' hora' : ' hs');
  }
  // Update the subtitle in the topbar when portfolio is active
  const sub = document.querySelector('.topbar-left p');
  if (sub && document.getElementById('panel-portfolio').classList.contains('active')) {
    sub.textContent = label;
  }
  // Store for navTitles
  navTitles.portfolio[1] = label;
}
let FX_RATE = 0.79;
let currentCurrency = 'GBP';

const TICKER_META = {
  'SPY':             { name: 'S&P 500 ETF',       logo: '📊', logoUrl: '/logos/spy.png',    cat: 'acciones', showTicker: true, whiteBg: true },
  'BRK.B':           { name: 'Berkshire',          logo: '🏦', logoUrl: '/logos/brkb.png',   cat: 'acciones', showTicker: true },
  'MELI':            { name: 'Mercado Libre',       logo: '🛒', logoUrl: '/logos/meli.png',   cat: 'acciones', showTicker: true, whiteBg: true },
  'NU':              { name: 'Nu Holdings',        logo: '💜', logoUrl: '/logos/nu.png',     cat: 'acciones', showTicker: true },
  'ARKK.L':          { name: 'ARK Innovation',     logo: '🚀', logoUrl: '/logos/arkk.png',   cat: 'acciones', showTicker: true },
  'VWRP.L':          { name: 'Vanguard All-World', logo: '🌍', logoUrl: '/logos/vwrp.png',   cat: 'acciones', showTicker: true },
  'MSFT':            { name: 'Microsoft',          logo: '🪟', logoUrl: '/logos/msft.png',   cat: 'acciones', showTicker: true },
  'NDIA.L':          { name: 'India ETF',          logo: '🇮🇳', logoUrl: '/logos/ndia.png',   cat: 'acciones', showTicker: true },
  'BTC':             { name: 'Bitcoin',            logo: '₿',  logoUrl: '/logos/btc.png',    cat: 'cripto',   showTicker: true },
  'ADA':             { name: 'ADA Cardano',        logo: '🔵', logoUrl: '/logos/ada.png',    cat: 'cripto',   showTicker: true },
  'RSU_META':        { name: 'META',               logo: '🏆', logoUrl: '/logos/meta.png',   cat: 'rsu',      showTicker: false },
  'GBP_LIQUID':      { name: 'Libras',             logo: '💷', logoUrl: '/logos/gbp.png',    cat: 'fiat',     showTicker: false },
  'GBP_RECEIVABLE':  { name: 'Deuda a cobrar',     logo: '📋', logoUrl: null,                cat: 'fiat',     showTicker: false },
  'USD_CASH':        { name: 'USD Cash',           logo: '💵', logoUrl: '/logos/usd.png',    cat: 'fiat',     showTicker: false },
  'RENT_DEPOSIT':    { name: 'Rent Deposit',       logo: '🏠', logoUrl: null,                cat: 'fiat',     showTicker: false },
  'EMERGENCY_FUND':  { name: 'Emergency Fund',     logo: '🛡️', logoUrl: null,                cat: 'fiat',     showTicker: false },
};

function fmtVal(usd, rate, sym) {
  const v = Math.round(usd * rate);
  if (Math.abs(v) >= 1000) return sym + v.toLocaleString('es-AR');
  return sym + v;
}

function fmtQty(qty, ticker) {
  if (ticker === 'BTC') return qty.toFixed(8);
  if (qty % 1 === 0) return qty.toString();
  return qty.toFixed(3);
}

// ── PULL-TO-REFRESH ──────────────────────────────────────────────────────────
(function() {
  const THRESHOLD = 110;  // px of dampened pull needed to trigger (feels heavy)
  const MAX_PULL  = 130;
  const DAMPEN    = 0.38; // resistance factor
  let startY = 0, currentPull = 0, active = false;

  const indicator = document.getElementById('ptr-indicator');
  const spinner   = document.getElementById('ptr-spinner');

  function isAtTop() {
    // Check all possible scroll containers
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const docTop  = document.documentElement.scrollTop || 0;
    const bodyTop = document.body.scrollTop || 0;
    return scrollY <= 0 && docTop <= 0 && bodyTop <= 0;
  }

  document.addEventListener('touchstart', function(e) {
    // Disable pull-to-refresh when any modal is open
    if (document.querySelector('.modal-overlay.open')) return;
    // ONLY activate when scroll is truly at the top
    if (!isAtTop()) return;
    active = true;
    startY = e.touches[0].clientY;
    currentPull = 0;
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!active) return;

    // Re-check scroll position — user may have started at top but content scrolled
    if (!isAtTop()) {
      active = false;
      currentPull = 0;
      indicator.classList.remove('visible', 'releasing');
      spinner.style.transform = '';
      return;
    }

    const rawDy = e.touches[0].clientY - startY;

    // If user scrolls up at any point, cancel entirely
    if (rawDy <= 0) {
      active = false;
      currentPull = 0;
      indicator.classList.remove('visible', 'releasing');
      spinner.style.transform = '';
      return;
    }

    // Only show indicator after significant downward pull (avoid accidental triggers)
    if (rawDy < 15) return;

    currentPull = Math.min(rawDy * DAMPEN, MAX_PULL);
    spinner.style.transform = `rotate(${currentPull * 2.5}deg)`;
    indicator.classList.add('visible');
    indicator.classList.toggle('releasing', currentPull >= THRESHOLD);
  }, { passive: true });

  function endPull() {
    if (!active) return;
    active = false;

    if (currentPull >= THRESHOLD) {
      indicator.classList.add('refreshing');
      indicator.classList.remove('releasing');
      setTimeout(() => location.reload(), 350);
    } else {
      // Not enough — cancel cleanly
      indicator.classList.remove('visible', 'releasing');
      spinner.style.transform = '';
      currentPull = 0;
    }
  }

  document.addEventListener('touchend',    endPull, { passive: true });
  document.addEventListener('touchcancel', endPull, { passive: true });
})();

// ── MODAL DRAG-TO-CLOSE ─────────────────────────────────────────────────────
// Strategy: attach touch listeners to the handle pill only (touch-action:none),
// then translate the whole sheet. This avoids conflict with the sheet's own scroll.
function initDragClose(overlayId, closeFn) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  const sheet = overlay.querySelector('.modal');
  const handle = sheet && sheet.querySelector('.modal-handle');
  if (!sheet || !handle) return;

  // Drag detection: listen on the sheet, but only activate when touch starts
  // within the top 80px (handle + header zone). Clicks pass through normally
  // because we only call preventDefault during an active drag move.
  let startY = 0, startClientTop = 0, currentY = 0, active = false;

  sheet.addEventListener('touchstart', function(e) {
    const rect = sheet.getBoundingClientRect();
    const localY = (e.touches[0].clientY - rect.top);
    if (localY > 80) return; // only top zone triggers drag
    active = true;
    startY = e.touches[0].clientY;
    startClientTop = rect.top;
    currentY = 0;
    sheet.style.transition = 'none';
    // Don't preventDefault here — lets clicks still fire on buttons inside
  }, { passive: true });

  sheet.addEventListener('touchmove', function(e) {
    if (!active) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) { active = false; sheet.style.transform = ''; return; }
    currentY = dy;
    sheet.style.transform = 'translateY(' + dy + 'px)';
    e.preventDefault(); // now safe to prevent scroll
  }, { passive: false });

  function onUp() {
    if (!active) return;
    active = false;
    sheet.style.transition = 'transform 0.25s ease';
    if (currentY > 72) {
      sheet.style.transform = 'translateY(110%)';
      setTimeout(() => {
        sheet.style.transform = '';
        sheet.style.transition = '';
        closeFn();
      }, 240);
    } else {
      sheet.style.transform = '';
      setTimeout(() => { sheet.style.transition = ''; }, 260);
    }
  }

  sheet.addEventListener('touchend',    onUp);
  sheet.addEventListener('touchcancel', onUp);

  // Also close on backdrop tap
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeFn();
  });
}

// Init after DOM ready — called once
function initAllModals() {
  initDragClose('posModal', closePosDetail);
  initDragClose('rsuModal', closeRSU);
  initDragClose('aiModal', closeAIChat);
  initDragClose('healthDetailModal', closeHealthDetail);
  initDragClose('scatterModal', closeScatterModal);
  initDragClose('perfDetailModal', closePerfDetail);
}
document.addEventListener('DOMContentLoaded', initAllModals);

// ── App init — load data on startup ──
document.addEventListener('DOMContentLoaded', function() {
  renderHeatmap();
  loadPortfolio();
  loadRSUVests();
});


// ── TOOLS NAVIGATION ───────────────────────────────────────────────────────────
// Pegar en core.js (al final, antes del cierre del módulo o del DOMContentLoaded)

function toolsOpenSub(name) {
  // Ocultar menú principal
  document.getElementById('tools-home').style.display = 'none';
  // Ocultar todos los sub-paneles
  document.querySelectorAll('[id^="tools-sub-"]').forEach(el => el.style.display = 'none');
  // Mostrar el pedido
  const sub = document.getElementById(`tools-sub-${name}`);
  if (sub) sub.style.display = 'block';

  // Si es jacket, renderizarlo (por si acaso no se llamó en DOMContentLoaded)
  if (name === 'jacket' && typeof renderJacket === 'function') {
    if (!document.getElementById('jacketPanel')?.firstChild) {
      renderJacket();
      JACKET_STATE.step = 'ask_coords';
      JACKET_STATE.hoursAhead = 0;
    }
  }

  // Actualizar topbar title
  const titles = { recipes: 'Recetario', jacket: 'Predictor de abrigo' };
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl && titles[name]) titleEl.textContent = titles[name];
}

function toolsBack() {
  // Mostrar menú principal, ocultar sub-paneles
  document.getElementById('tools-home').style.display = 'block';
  document.querySelectorAll('[id^="tools-sub-"]').forEach(el => el.style.display = 'none');

  // Restaurar topbar
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl) titleEl.textContent = 'Tools';
}

