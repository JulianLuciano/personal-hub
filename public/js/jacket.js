// ── JACKET MODULE ──────────────────────────────────────────────────────────────
// Responsabilidad: predictor de abrigo integrado en la tab Tools
// Replica exactamente la lógica del bot de Telegram (bot.py + utils.py)
// Para iterar: pasá solo jacket.js

// ── HELPERS (equivalentes a utils.py) ─────────────────────────────────────────

function jacketTemperaturaEmoji(apparent_temperature) {
  if (apparent_temperature > 30)          return '🥵';
  if (apparent_temperature > 25)          return '☀️☀️';
  if (apparent_temperature > 16)          return '☀️';
  if (apparent_temperature > 11)          return '🌤️';
  if (apparent_temperature > 6.5)         return '☁️☁️';
  return '🥶';
}

function jacketAbrigo(clase) {
  const map = {
    'en cuero':              '🤽🏻‍♂️',
    'remera':                '👕',
    'rompevientos':          '🌬️🧥',
    'sweater':               '👕👕',
    'campera':               '🧥',
    'buzo':                  '🧥',
    'buzo/hoodie':           '🧥',
    'camperon':              '🧥🧥',
    'camperon y buzo':       '🧥🧥🧣',
    'camperon buzo y termica':'🧥🧤🧣',
  };
  return map[clase] || '🧥';
}

function jacketLluviaMsj(prob, intensidad) {
  if (intensidad >= 2)          return 'Llevar ☔️ es imprescindible — hay lluvia intensa.';
  if (prob < 30)                return 'No hace falta llevar ☔️.';
  if (prob < 50)                return 'Llevar ☔️ es opcional.';
  if (prob < 70)                return 'Es recomendable llevar ☔️.';
  return 'Llevar ☔️ es imprescindible.';
}

// ── SHORTCUTS (equivalentes a location_shortcuts en bot.py) ────────────────────

const JACKET_SHORTCUTS = {
  'cordoba':        { lat: -31.4580911, lon: -64.2199552, label: 'Córdoba' },
  'córdoba':        { lat: -31.4580911, lon: -64.2199552, label: 'Córdoba' },
  'cba':            { lat: -31.4580911, lon: -64.2199552, label: 'Córdoba' },
  'casa':           { lat: -34.5821438, lon: -58.4303663, label: 'Buenos Aires' },
  'baires':         { lat: -34.5821438, lon: -58.4303663, label: 'Buenos Aires' },
  'caba':           { lat: -34.5821438, lon: -58.4303663, label: 'Buenos Aires' },
  'buenosaires':    { lat: -34.5821438, lon: -58.4303663, label: 'Buenos Aires' },
  'bsas':           { lat: -34.5821438, lon: -58.4303663, label: 'Buenos Aires' },
  'capitalfederal': { lat: -34.5821438, lon: -58.4303663, label: 'Buenos Aires' },
  'london':         { lat: 51.5074,     lon: -0.1278,     label: 'London' },
  'londres':        { lat: 51.5074,     lon: -0.1278,     label: 'London' },
};

// Normaliza texto igual que el bot: minúsculas, sin espacios, sin tildes
function jacketNormalize(text) {
  return text.toLowerCase()
    .replace(/\s+/g, '')
    .replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i')
    .replace(/ó/g,'o').replace(/ú/g,'u');
}

// ── STATE ──────────────────────────────────────────────────────────────────────

const JACKET_STATE = {
  step: 'idle',      // idle | ask_hours | ask_coords
  hoursAhead: 0,
  lastResult: null,  // último resultado de la API
};

// ── RENDER PRINCIPAL ───────────────────────────────────────────────────────────

function renderJacket() {
  const container = document.getElementById('jacketPanel');
  if (!container) return;

  container.innerHTML = `
    <div class="jacket-wrap">

      <!-- HERO CARD: selector de modo -->
      <div class="jacket-hero-card">
        <div class="jacket-hero-label">¿Para cuándo?</div>
        <div class="jacket-mode-row">
          <button class="jacket-mode-btn active" data-lead="0"  onclick="jacketSelectMode(this, 0)">Ahora</button>
          <button class="jacket-mode-btn"         data-lead="2"  onclick="jacketSelectMode(this, 2)">+2h</button>
          <button class="jacket-mode-btn"         data-lead="3"  onclick="jacketSelectMode(this, 3)">+3h</button>
          <button class="jacket-mode-btn"         data-lead="4"  onclick="jacketSelectMode(this, 4)">+4h</button>
          <button class="jacket-mode-btn"         data-lead="-1" onclick="jacketSelectMode(this, -1)">N hs</button>
        </div>

        <!-- Input horas (visible solo en modo N hs) -->
        <div class="jacket-nhs-row" id="jacketNhsRow" style="display:none">
          <input class="jacket-input" id="jacketHoursInput" type="number" min="1" max="48"
            placeholder="Horas adelante (1–48)"
            oninput="jacketValidateHours(this)">
          <div class="jacket-input-hint" id="jacketHoursHint"></div>
        </div>
      </div>

      <!-- LOCATION CARD -->
      <div class="jacket-loc-card">
        <div class="jacket-hero-label">Ubicación</div>

        <!-- Shortcuts rápidos -->
        <div class="jacket-shortcut-row">
          <button class="jacket-shortcut" onclick="jacketUseShortcut('london')">🇬🇧 London</button>
          <button class="jacket-shortcut" onclick="jacketUseShortcut('cordoba')">🏡 Córdoba</button>
          <button class="jacket-shortcut" onclick="jacketUseShortcut('caba')">🏙️ Buenos Aires</button>
        </div>

        <!-- Input lat,lon manual -->
        <input class="jacket-input" id="jacketCoordsInput" type="text"
          placeholder="lat,lon  (ej: -34.58,-58.42)"
          oninput="jacketValidateCoords()"
          onkeydown="if(event.key==='Enter') jacketSubmit()">
        <div class="jacket-input-hint" id="jacketCoordsHint"></div>

        <!-- Botón GPS -->
        <button class="jacket-gps-btn" onclick="jacketUseGPS()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
          Usar mi ubicación
        </button>
      </div>

      <!-- CTA -->
      <button class="jacket-submit-btn" id="jacketSubmitBtn" onclick="jacketSubmit()">
        Ver recomendación
      </button>

      <!-- RESULTADO -->
      <div class="jacket-result" id="jacketResult" style="display:none"></div>

    </div>
  `;
}

// ── MODO ───────────────────────────────────────────────────────────────────────

function jacketSelectMode(el, lead) {
  document.querySelectorAll('.jacket-mode-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');

  const nhsRow = document.getElementById('jacketNhsRow');
  if (lead === -1) {
    JACKET_STATE.step = 'ask_hours';
    nhsRow.style.display = 'block';
    JACKET_STATE.hoursAhead = null;
  } else {
    JACKET_STATE.step = 'ask_coords';
    JACKET_STATE.hoursAhead = lead;
    nhsRow.style.display = 'none';
  }
}

function jacketValidateHours(input) {
  const val = parseInt(input.value);
  const hint = document.getElementById('jacketHoursHint');
  if (!val || val < 1 || val > 48) {
    hint.textContent = 'Ingresá un número entre 1 y 48';
    hint.className = 'jacket-input-hint error';
    JACKET_STATE.hoursAhead = null;
  } else {
    hint.textContent = `+${val} horas`;
    hint.className = 'jacket-input-hint ok';
    JACKET_STATE.hoursAhead = val;
  }
}

// ── UBICACIÓN ──────────────────────────────────────────────────────────────────

function jacketUseShortcut(key) {
  const s = JACKET_SHORTCUTS[key];
  if (!s) return;
  const input = document.getElementById('jacketCoordsInput');
  input.value = `${s.lat},${s.lon}`;
  jacketValidateCoords();
  // highlight visual del shortcut activo
  document.querySelectorAll('.jacket-shortcut').forEach(b => b.classList.remove('active'));
  document.querySelector(`.jacket-shortcut[onclick*="${key}"]`)?.classList.add('active');
}

function jacketValidateCoords() {
  const raw = document.getElementById('jacketCoordsInput').value.trim();
  const hint = document.getElementById('jacketCoordsHint');

  // ¿Es un shortcut?
  const norm = jacketNormalize(raw);
  if (JACKET_SHORTCUTS[norm]) {
    hint.textContent = `📍 ${JACKET_SHORTCUTS[norm].label}`;
    hint.className = 'jacket-input-hint ok';
    return true;
  }

  // ¿Es lat,lon?
  const cleaned = raw.replace(/[()]/g, '').replace(/\s/g, '');
  const parts = cleaned.split(',');
  if (parts.length === 2) {
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      hint.textContent = `✓ ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      hint.className = 'jacket-input-hint ok';
      return true;
    }
  }

  if (raw.length > 0) {
    hint.textContent = 'Formato: lat,lon  o  nombre de ciudad';
    hint.className = 'jacket-input-hint error';
  } else {
    hint.textContent = '';
    hint.className = 'jacket-input-hint';
  }
  return false;
}

function jacketUseGPS() {
  const btn = document.querySelector('.jacket-gps-btn');
  if (!navigator.geolocation) {
    jacketShowError('Tu browser no soporta geolocalización.');
    return;
  }
  btn.textContent = 'Obteniendo ubicación...';
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude.toFixed(6);
      const lon = pos.coords.longitude.toFixed(6);
      document.getElementById('jacketCoordsInput').value = `${lat},${lon}`;
      jacketValidateCoords();
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> Ubicación obtenida`;
      btn.disabled = false;
    },
    err => {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> Usar mi ubicación`;
      btn.disabled = false;
      jacketShowError('No se pudo obtener la ubicación. Ingresá las coordenadas manualmente.');
    },
    { timeout: 10000 }
  );
}

// ── RESOLUCIÓN DE COORDENADAS ───────────────────────────────────────────────────

function jacketResolveCoords() {
  const raw = document.getElementById('jacketCoordsInput').value.trim();
  if (!raw) return null;

  const norm = jacketNormalize(raw);
  if (JACKET_SHORTCUTS[norm]) return JACKET_SHORTCUTS[norm];

  const cleaned = raw.replace(/[()]/g, '').replace(/\s/g, '');
  const parts = cleaned.split(',');
  if (parts.length === 2) {
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (!isNaN(lat) && !isNaN(lon)) return { lat, lon, label: null };
  }
  return null;
}

// ── SUBMIT ─────────────────────────────────────────────────────────────────────

async function jacketSubmit() {
  // Validar horas si es modo N hs
  if (JACKET_STATE.step === 'ask_hours') {
    if (!JACKET_STATE.hoursAhead) {
      document.getElementById('jacketHoursHint').textContent = 'Ingresá un número entre 1 y 48';
      document.getElementById('jacketHoursHint').className = 'jacket-input-hint error';
      return;
    }
  } else {
    // Si no se eligió ningún modo explícito, default a 0
    if (JACKET_STATE.hoursAhead === undefined || JACKET_STATE.hoursAhead === null) {
      JACKET_STATE.hoursAhead = 0;
    }
  }

  const coords = jacketResolveCoords();
  if (!coords) {
    jacketValidateCoords();
    return;
  }

  jacketSetLoading(true);

  try {
    const res = await fetch('/api/abrigo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: coords.lat, lon: coords.lon, lead: JACKET_STATE.hoursAhead }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    JACKET_STATE.lastResult = data;
    jacketRenderResult(data, coords.label);

  } catch (err) {
    jacketShowError('Error al consultar la predicción. Revisá tu conexión.');
    console.error('[jacket]', err);
  } finally {
    jacketSetLoading(false);
  }
}

// ── RENDER RESULTADO ───────────────────────────────────────────────────────────
// Replica process_coordinates en bot.py

function jacketRenderResult(data, locationLabel) {
  const hoursAhead = JACKET_STATE.hoursAhead;

  const class_1st     = data.class_1st;
  const prob_1st      = Math.round(data.prob_1st * 100);
  const class_2nd     = data.class_2nd;
  const prob_2nd      = Math.round(data.prob_2nd * 100);
  const temperature   = data.temperature;
  const humidity      = data.humidity;
  const wind          = data.weather_wind_speed_10m * 3.6;
  const apparent      = data.apparent_temperature;
  const hour_geo      = data.hour_geo;
  const minute        = data.minute;
  const precipitation_prob = Math.round(data.precipitation_prob * 100 * 10) / 10;
  const precipitation = data.precipitation;

  const emoji1  = jacketAbrigo(class_1st);
  const emoji2  = jacketAbrigo(class_2nd);
  const tempEmj = jacketTemperaturaEmoji(apparent);
  const verbo   = (minute >= 30 || hoursAhead > 0) ? 'será' : 'es';

  // ¿Mostrar segunda opción?
  const showSecond = data.prob_1st <= 0.6 && (data.prob_2nd > 0.25 || (data.prob_1st - data.prob_2nd < 0.10));

  // Tiempo prefix
  const timePrefix = hoursAhead > 0 ? `dentro de ${hoursAhead} hora${hoursAhead > 1 ? 's' : ''}, ` : '';

  // Lluvia
  const lluviaMsj = jacketLluviaMsj(precipitation_prob, precipitation);

  const locLabel = locationLabel || '';

  const resultEl = document.getElementById('jacketResult');
  resultEl.style.display = 'block';
  resultEl.innerHTML = `
    <div class="jacket-result-card">

      <!-- Clima header -->
      <div class="jacket-result-header">
        <div class="jacket-result-temp">${apparent.toFixed(1)}° ${tempEmj}</div>
        <div class="jacket-result-sub">
          ${locLabel ? `<span class="jacket-result-loc">📍 ${locLabel}</span>` : ''}
          ${timePrefix}a las <strong>${hour_geo}</strong> hs
        </div>
      </div>

      <!-- Métricas clima -->
      <div class="jacket-climate-grid">
        <div class="jacket-climate-item">
          <div class="jacket-climate-val">${temperature.toFixed(1)}°</div>
          <div class="jacket-climate-lbl">Temperatura</div>
        </div>
        <div class="jacket-climate-item">
          <div class="jacket-climate-val">${humidity.toFixed(0)}%</div>
          <div class="jacket-climate-lbl">Humedad</div>
        </div>
        <div class="jacket-climate-item">
          <div class="jacket-climate-val">${wind.toFixed(1)}</div>
          <div class="jacket-climate-lbl">Viento km/h</div>
        </div>
      </div>

      <!-- Recomendación principal -->
      <div class="jacket-rec-main">
        <div class="jacket-rec-emoji">${emoji1}</div>
        <div class="jacket-rec-info">
          <div class="jacket-rec-name">${class_1st}</div>
          <div class="jacket-rec-prob">${prob_1st}% de probabilidad</div>
          <div class="jacket-rec-bar-wrap">
            <div class="jacket-rec-bar" style="width:${prob_1st}%"></div>
          </div>
        </div>
      </div>

      ${showSecond ? `
      <!-- Segunda opción -->
      <div class="jacket-rec-second">
        <div class="jacket-rec-second-label">Alternativa</div>
        <div class="jacket-rec-second-inner">
          <span class="jacket-rec-second-emoji">${emoji2}</span>
          <span class="jacket-rec-second-name">${class_2nd}</span>
          <span class="jacket-rec-second-prob">${prob_2nd}%</span>
        </div>
      </div>` : ''}

      <!-- Lluvia accordion -->
      <div class="jacket-rain-row" onclick="jacketToggleRain(this)">
        <span>☔️ ¿Va a llover?</span>
        <svg class="jacket-rain-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="jacket-rain-detail" id="jacketRainDetail" style="display:none">
        <div class="jacket-rain-prob-row">
          <span>Probabilidad</span>
          <strong>${precipitation_prob}%</strong>
        </div>
        <div class="jacket-rain-bar-wrap">
          <div class="jacket-rain-bar" style="width:${Math.min(precipitation_prob,100)}%;background:${precipitation_prob >= 70 ? 'var(--accent2)' : precipitation_prob >= 30 ? 'var(--accent)' : 'var(--accent3)'}"></div>
        </div>
        <div class="jacket-rain-msg">${lluviaMsj}</div>
      </div>

    </div>

    <!-- Nueva consulta -->
    <button class="jacket-reset-btn" onclick="jacketReset()">↩ Nueva consulta</button>
  `;

  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function jacketToggleRain(el) {
  const detail = document.getElementById('jacketRainDetail');
  const chevron = el.querySelector('.jacket-rain-chevron');
  const open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : 'block';
  chevron.style.transform = open ? '' : 'rotate(180deg)';
}

// ── UI HELPERS ─────────────────────────────────────────────────────────────────

function jacketSetLoading(on) {
  const btn = document.getElementById('jacketSubmitBtn');
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? 'Consultando...' : 'Ver recomendación';
}

function jacketShowError(msg) {
  const resultEl = document.getElementById('jacketResult');
  if (!resultEl) return;
  resultEl.style.display = 'block';
  resultEl.innerHTML = `
    <div class="jacket-error-card">
      <span>⚠️</span> ${msg}
    </div>`;
}

function jacketReset() {
  const resultEl = document.getElementById('jacketResult');
  if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
  document.getElementById('jacketCoordsInput').value = '';
  document.getElementById('jacketCoordsHint').textContent = '';
  document.querySelectorAll('.jacket-shortcut').forEach(b => b.classList.remove('active'));
  JACKET_STATE.lastResult = null;
}

// ── INIT ───────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  renderJacket();
  // El modo por defecto es "Ahora" (lead 0)
  JACKET_STATE.step = 'ask_coords';
  JACKET_STATE.hoursAhead = 0;
});
