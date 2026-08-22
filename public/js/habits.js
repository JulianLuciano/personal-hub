// ── HABITS MODULE ──────────────────────────────────────────────────────────────
// Responsabilidad: tab Hábitos completo — checks diarios, one-shots, año, config
// Para iterar: pasá solo habits.js + DOCS.md
//
// Estado actual: datos MOCK — para conectar a DB, reemplazar las funciones
// loadDailyFromDB(), saveDailyToDB(), loadOneshotsFromDB(), saveOneshotsToDB()
// con calls a sbFetch() (definida en core.js).
// ──────────────────────────────────────────────────────────────────────────────

// ── CONFIG ─────────────────────────────────────────────────────────────────────

// hasDetail: true = tapping opens a detail drawer inline
// isWater: true = special water tracker UI instead of checkbox
const HABITS_LIST = [
  { id: 'trained',  icon: '🏋️', name: 'Entrenaste hoy',   color: 'rgba(108,99,255,0.15)', streak: 3, hasDetail: true  },
  { id: 'piano',    icon: '🎹', name: 'Practicaste piano', color: 'rgba(79,195,247,0.15)',  streak: 0, hasDetail: true  },
  { id: 'water',    icon: '💧', name: 'Agua',              color: 'rgba(79,195,247,0.10)',  streak: 0, hasDetail: false, isWater: true },
];

// Keep legacy refs for compatibility
const HABITS_BODY = HABITS_LIST;
const HABITS_WORK = [];

const ONESHOTS = [
  { id: 'presentations',  icon: '🎤', name: 'Presentaciones',          sub: 'Objetivo: ≥6',      goal: 6  },
  { id: 'feedbacks',      icon: '📝', name: 'Feedbacks post-pres.',     sub: 'Objetivo: ≥2',      goal: 2  },
  { id: 'recordings',     icon: '🎬', name: 'Grabaciones presentando',  sub: '1 por trimestre',   goal: 4  },
  { id: 'pianoLessons',   icon: '🎵', name: 'Clases de piano',          sub: 'Objetivo: ≥15',     goal: 15 },
  { id: 'trips',          icon: '✈️', name: 'Viajes',                   sub: '3 este año',        goal: 3  },
  { id: 'devTalks',       icon: '💬', name: 'Charlas de desarrollo',    sub: 'Objetivo: ≥2',      goal: 2  },
  { id: 'pscReviews',     icon: '⭐', name: 'PSC reviews',              sub: '≥2 Meet exp.',      goal: 2  },
  { id: 'groupPlans',     icon: '👥', name: 'Planes grupales',          sub: '≥1 por mes',        goal: 12 },
  { id: 'dates2nd',       icon: '❤️', name: 'Segundas citas',           sub: '≥50% de citas',     goal: null },
];

const YEAR_GOALS = [
  { id: 'training',      icon: '🏋️', name: 'Semanas con ≥3 días',  target: '≥80% del año (≥42 sem)', current: 7,  goal: 42,  unit: 'sem'  },
  { id: 'piano_days',    icon: '🎹', name: 'Días de piano',          target: '≥40 días en el año',     current: 8,  goal: 40,  unit: 'días' },
  { id: 'piano_class',   icon: '🎵', name: 'Clases de piano',        target: '≥15 clases',             current: 3,  goal: 15,  unit: ''     },
  { id: 'groupplans',    icon: '👥', name: 'Planes grupales',        target: '≥1 por mes',             current: 2,  goal: 12,  unit: ''     },
  { id: 'presentations', icon: '🎤', name: 'Presentaciones',         target: '≥6 en el año',           current: 1,  goal: 6,   unit: ''     },
  { id: 'trips',         icon: '✈️', name: 'Viajes',                 target: '3 este año',             current: 0,  goal: 3,   unit: ''     },
];

// Semana actual del año (se actualiza en init)
let CURRENT_WEEK = 10;

// ── STATE ──────────────────────────────────────────────────────────────────────

let habitDayOffset   = 0;          // 0 = hoy, -1 = ayer
let habitDayState    = {};         // { trained, piano }
let habitMealsState  = { slots: {}, caprichos: [] }; // cargado desde tabla real `meals`, no es mock
let habitOneshotState = {};        // { presentations: 1, pianoLessons: 3, ... }
let habitNotifState  = { daily: true, weight: true };
let habitSaveTimeout = null;       // debounce timer para auto-save
let habitPendingSave  = null;      // { dateStr, state } — snapshot tomado al programar el save,
                                    // no al dispararse (evita guardar en el día/estado equivocado
                                    // si navegás a otro día antes de que venza el debounce)
let habitWaterMl     = 0;           // ml de agua de hoy (cargado desde DB)
let habitWaterGoal   = 2000;        // meta del día (2500 si entrenó)

// ── MOCK DATA (one-shots todavía no tienen tabla propia) ───────────────────────

const MOCK_ONESHOTS = {
  presentations: 1, feedbacks: 0, recordings: 0,
  pianoLessons: 3, trips: 0, devTalks: 1,
  pscReviews: 0, groupPlans: 2, dates2nd: 1,
};

// ── DB INTEGRATION ──────────────────────────────────────────────────────────────
// trained/piano ya pegan contra /api/habits/daily (tabla habit_daily_logs, real).
// Antes esto devolvía datos hardcodeados (bug: "ayer" siempre marcado, cualquier
// otro día en blanco) porque nunca se conectó al endpoint que ya existía en
// server.js. one-shots siguen en mock, todavía no tienen tabla.

async function loadDailyFromDB(dateStr) {
  try {
    const res = await fetch('/api/habits/daily/' + dateStr);
    if (res.status === 204) return null; // no hay registro guardado ese día
    if (!res.ok) throw new Error((await res.text()).slice(0, 150));
    return await res.json();
  } catch (e) {
    console.error('[habits] Error cargando daily:', e);
    return null;
  }
}

async function saveDailyToDB(dateStr, state) {
  try {
    const res = await fetch('/api/habits/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        log_date: dateStr,
        trained: state.trained ?? null,
        piano:   state.piano ?? null,
      }),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 150));
  } catch (e) {
    console.error('[habits] Error guardando daily:', e);
  }
}

async function loadOneshotsFromDB() {
  // TODO: return await sbFetch('habit_oneshots?limit=1').then(r => r[0] || {});
  return { ...MOCK_ONESHOTS };
}

async function saveOneshotsToDB(state) {
  // TODO:
  // return await fetch('/api/habits/oneshots', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify(state)
  // });
  console.log('[habits] save oneshots mock:', state);
}

// ── DATE HELPERS ───────────────────────────────────────────────────────────────

const H_DAYS   = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const H_MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function habitGetDate(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
}

function habitFormatDate(d) {
  return `${H_DAYS[d.getDay()]} ${d.getDate()} ${H_MONTHS[d.getMonth()]}`;
}

// Fecha LOCAL en formato YYYY-MM-DD. NO usar toISOString().slice(0,10) para
// esto: convierte a UTC, y cerca de medianoche en horario de verano de
// Londres (BST, UTC+1) puede devolver el día equivocado.
function habitLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function habitDateStr(offset) {
  return habitLocalDateStr(habitGetDate(offset));
}

function habitWeekOfYear() {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
}

// ── INIT ───────────────────────────────────────────────────────────────────────

async function initHabits() {
  CURRENT_WEEK = habitWeekOfYear();
  // Restore saved notification time from localStorage
  const savedTime = localStorage.getItem('habitNotifTime');
  const timeInput = document.getElementById('habitNotifTimeDaily');
  if (savedTime && timeInput) timeInput.value = savedTime;
  // Wire time input: 'change' fires after user confirms (OK button), not while scrolling
  if (timeInput) timeInput.addEventListener('change', habitSaveNotifTime);
  // Set topbar title on first load (switchNav only runs on tab changes)
  const h1 = document.querySelector('.topbar-left h1');
  const sub = document.querySelector('.topbar-left p');
  if (h1) h1.textContent = 'Hábitos';
  if (sub) sub.textContent = '';
  habitOneshotState = await loadOneshotsFromDB();
  habitUpdateDateUI();
  habitInitDatePicker();
  await habitLoadDay();
  habitRenderOneshots();
  habitRenderYear();
  habitRenderConfig();
  habitRenderAnalytics();
  habitInitNotifications();
  habitCheckWaterPrompt();
  loadWaterNotifSetting();
}

// ── WATER PROMPT (iOS fallback) ───────────────────────────────────────────────
// When user taps the water push notification on iOS (no action buttons),
// the app opens with ?water_prompt=1. We show a banner asking yes/no.

function habitCheckWaterPrompt() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('water_prompt')) return;
  // Clean the URL without reloading
  window.history.replaceState({}, '', window.location.pathname);
  // Show the banner after a short delay so the app renders first
  setTimeout(waterPromptShow, 600);
}

function waterPromptShow() {
  const banner = document.getElementById('waterPromptBanner');
  if (banner) {
    banner.style.display = 'block';
    // Auto-dismiss after 30s if no response
    banner._timer = setTimeout(waterPromptDismiss, 30000);
  }
}

function waterPromptDismiss() {
  const banner = document.getElementById('waterPromptBanner');
  if (!banner) return;
  clearTimeout(banner._timer);
  banner.style.display = 'none';
}

function waterPromptRespond(tookWater) {
  waterPromptDismiss();
  if (tookWater) {
    // Same as tapping action button: log 500ml
    fetch('/api/water/log', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ amount_ml: 500, source: 'notification', response: 'yes' }),
    }).then(() => {
      habitWaterMl += 500;
      habitWaterRender();
      localStorage.setItem('habitLastActivity', habitLocalDateStr(new Date()));
    }).catch(console.warn);
  } else {
    fetch('/api/water/respond', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ response: 'no', water_ml_at_time: habitWaterMl }),
    }).catch(console.warn);
  }
}

// ── DATE NAV ───────────────────────────────────────────────────────────────────

// Mínimo permitido: 1 de enero del año en curso
function habitMinOffset() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const jan1  = new Date(today.getFullYear(), 0, 1);
  return Math.round((jan1 - today) / 86400000); // negativo
}

function habitUpdateDateUI() {
  const d = habitGetDate(habitDayOffset);
  const topDate = document.getElementById('habitsTopbarDate');
  if (topDate) topDate.textContent = habitFormatDate(d);

  const pill    = document.getElementById('habitDayPill');
  const banner  = document.getElementById('habitPastBanner');
  const nextBtn = document.getElementById('habitNextDayBtn');
  const prevBtn = document.getElementById('habitPrevDayBtn');

  if (!pill) return;

  const pillText = document.getElementById('habitDayPillText');
  if (habitDayOffset === 0) {
    if (pillText) pillText.textContent = 'Hoy';
    pill.classList.remove('past');
    if (banner)  banner.style.display = 'none';
    if (nextBtn) nextBtn.classList.add('disabled');
  } else {
    if (pillText) pillText.textContent = d.getDate() + ' ' + H_MONTHS[d.getMonth()];
    pill.classList.add('past');
    if (banner)  banner.style.display = 'flex';
    if (nextBtn) nextBtn.classList.remove('disabled');
  }

  if (prevBtn) prevBtn.classList.toggle('disabled', habitDayOffset <= habitMinOffset());

  // Botón Hoy: solo visible cuando estás en fecha pasada
  const todayBtn = document.getElementById('habitTodayBtn');
  if (todayBtn) todayBtn.style.display = habitDayOffset < 0 ? 'inline-flex' : 'none';

  // Mantener el value del picker sincronizado
  const picker = document.getElementById('habitDatePicker');
  if (picker) picker.value = habitDateStr(habitDayOffset);
}

function habitGoToday() {
  if (habitDayOffset === 0) return;
  habitFlushSave();
  habitDayOffset = 0;
  habitUpdateDateUI();
  habitLoadDay();
}

function habitShiftDay(delta) {
  const next = habitDayOffset + delta;
  if (next > 0 || next < habitMinOffset()) return;
  habitFlushSave();
  habitDayOffset = next;
  habitUpdateDateUI();
  habitLoadDay();
}

function habitOpenDatePicker() {
  // No-op: el input está embebido dentro de la pastilla en el HTML,
  // el browser lo abre directamente con el click del usuario.
}

function habitInitDatePicker() {
  const picker = document.getElementById('habitDatePicker');
  if (!picker) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const jan1  = new Date(today.getFullYear(), 0, 1);
  picker.max   = habitLocalDateStr(today);
  picker.min   = habitLocalDateStr(jan1);
  picker.value = habitDateStr(0); // hoy
}

function habitPickDate(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const jan1   = new Date(today.getFullYear(), 0, 1);
  const picked = new Date(dateStr + 'T00:00:00');
  if (picked > today || picked < jan1) return;
  const diffMs   = picked - today;
  const diffDays = Math.round(diffMs / 86400000);
  habitFlushSave();
  habitDayOffset = diffDays;
  habitUpdateDateUI();
  habitLoadDay();
}

// ── DAILY STATE ────────────────────────────────────────────────────────────────

async function habitLoadDay() {
  const dateStr = habitDateStr(habitDayOffset);
  const [data] = await Promise.all([
    loadDailyFromDB(dateStr),
    habitDayOffset === 0 ? habitLoadWater() : Promise.resolve(),
    habitLoadMeals(dateStr),
  ]);
  habitDayState = data ? { ...data } : {};
  await habitLoadTrainingDetail(dateStr); // tipo/duración/notas del entrenamiento (vive en habit_logs, no en habit_daily_logs)
  habitWaterGoal = habitDayState.trained ? 2500 : 2000;
  habitOpenDrawers.clear(); // resetear drawers al cambiar de día
  habitRenderHabits();
  habitRenderMeals();
  habitRenderDrawers();
}

// El checkbox "entrenaste hoy" (booleano) vive en habit_daily_logs, pero la
// categoría/duración/notas del entrenamiento NUNCA se guardaban ahí — solo
// existían en memoria mientras tenías el drawer abierto, y se perdían al
// recargar el día. La única persistencia real de esos datos es habit_logs,
// que se llena con el botón "Registrar". Esta función trae esa fila (si
// existe para el día) y reconstruye trainType/trainTypeOther/trainDur para
// que el drawer se vea igual que como quedó guardado.
//
// Caveat: si hubiera más de un entrenamiento registrado el mismo día,
// habit_logs no tiene columna de hora para desempatar cuál mostrar acá — se
// toma el último de la respuesta. Para un solo registro diario (el caso
// normal) esto no es un problema.
async function habitLoadTrainingDetail(dateStr) {
  let rows = [];
  try {
    rows = await sbFetch(`/rest/v1/habit_logs?habit_date=eq.${dateStr}&habit=eq.Workout`);
  } catch (e) {
    console.error('[habits] Error cargando detalle de entrenamiento:', e);
    return;
  }
  const entry = rows && rows.length ? rows[rows.length - 1] : null;
  if (!entry) return;

  const dbType = (entry.type && entry.type[0]) || null;
  if (dbType) {
    const knownChips = ['Rugby','Gym','Crossfit','Paddle','Fútbol','Correr','Bici'];
    const uiType = Object.keys(HABIT_TRAIN_TYPE_DB_MAP).find(k => HABIT_TRAIN_TYPE_DB_MAP[k] === dbType);
    if (uiType || knownChips.includes(dbType)) {
      habitDayState.trainType = uiType || dbType;
      habitDayState.trainTypeOther = null;
    } else {
      // No matchea ninguna pastilla conocida → va como "Otro" con el texto real
      habitDayState.trainType = 'Otro';
      habitDayState.trainTypeOther = dbType;
    }
  }
  habitDayState.trainDur = entry.duration_min || null;
  habitDayState.trainNotes = entry.notes || '';
}

// Carga las comidas del día desde la tabla real `meals` (vía sbFetch → /api/db/meals)
// y arma el borrador en base a lo que ya está guardado.
async function habitLoadMeals(dateStr) {
  try {
    const rows = await sbFetch(`/rest/v1/meals?meal_date=eq.${dateStr}`);
    const slots = {};
    const caprichos = [];
    (rows || []).forEach(r => {
      if (r.meal_type === 'capricho') caprichos.push(r);
      else slots[r.meal_type] = r;
    });
    habitMealsState = { slots, caprichos };
  } catch (e) {
    console.error('[habits] Error cargando meals:', e);
    habitMealsState = { slots: {}, caprichos: [] };
  }
  habitMealsDraftFromState();
}

async function habitLoadWater() {
  try {
    const res = await fetch('/api/water/today');
    if (!res.ok) return;
    const data = await res.json();
    habitWaterMl = data.total_ml || 0;
  } catch (_) { habitWaterMl = 0; }
}

function habitScheduleSave() {
  // Debounce: espera 1.5s sin cambios antes de guardar.
  // El snapshot se toma ACÁ (fecha + estado actuales), no cuando dispara el
  // timeout — si no, navegar a otro día antes de que venza el debounce hacía
  // que el guardado se disparara con la fecha y el estado del día nuevo, no
  // del que realmente se había editado.
  clearTimeout(habitSaveTimeout);
  habitPendingSave = { dateStr: habitDateStr(habitDayOffset), state: { ...habitDayState } };
  habitSaveTimeout = setTimeout(habitFlushSave, 1500);
}

// Fuerza el guardado pendiente ya (sin esperar el debounce). Se llama antes
// de navegar a otro día, para no depender de que el timer siga vivo en
// background si el usuario cierra la app o sigue navegando rápido.
function habitFlushSave() {
  clearTimeout(habitSaveTimeout);
  if (!habitPendingSave) return;
  const { dateStr, state } = habitPendingSave;
  habitPendingSave = null;
  saveDailyToDB(dateStr, state);
}

// ── RENDER: HABITS ─────────────────────────────────────────────────────────────

function habitDrawerHTML(id) {
  var q = '"', sq = "'";
  if (id === 'trained') {
    var typeChips = ['Rugby','Gym','Crossfit','Paddle','Fútbol','Correr','Bici','Otro'].map(function(t) {
      return '<button class=' + q + 'h-scroll-chip' + q + ' onclick=' + q + 'habitSelectTrainType(' + sq + t + sq + ')' + q + '>' + t + '</button>';
    }).join('');
    var durChips = [30,45,60,90].map(function(n) {
      return '<button class=' + q + 'h-scroll-chip' + q + ' onclick=' + q + 'habitSelectTrainDur(' + n + ')' + q + '>' + n + '</button>';
    }).join('') + '<button class=' + q + 'h-scroll-chip' + q + ' onclick=' + q + 'habitSelectTrainDur(' + sq + 'custom' + sq + ')' + q + '>Otro</button>';
    return '<div class=' + q + 'h-detail-drawer' + q + ' id=' + q + 'h-drawer-trained' + q + '>' +
      '<div class=' + q + 'h-drawer-label' + q + '>Tipo de entrenamiento</div>' +
      '<div class=' + q + 'h-scroll-chips' + q + ' id=' + q + 'h-chips-trained-type' + q + '>' + typeChips + '</div>' +
      '<input class=' + q + 'h-drawer-other-input' + q + ' id=' + q + 'h-train-other' + q + ' placeholder=' + q + '¿Cuál?' + q + ' style=' + q + 'display:none' + q + ' oninput=' + q + 'habitTrainOtherChange(this.value)' + q + '>' +
      '<div class=' + q + 'h-drawer-label' + q + ' style=' + q + 'margin-top:12px' + q + '>Duración (min)</div>' +
      '<div class=' + q + 'h-scroll-chips' + q + ' id=' + q + 'h-chips-trained-dur' + q + '>' + durChips + '</div>' +
      '<input class=' + q + 'h-drawer-other-input' + q + ' id=' + q + 'h-train-dur-custom' + q + ' type=' + q + 'text' + q + ' inputmode=' + q + 'numeric' + q + ' pattern=' + q + '[0-9]*' + q + ' placeholder=' + q + 'min' + q + ' style=' + q + 'display:none' + q + ' oninput=' + q + 'habitTrainDurCustomChange(this.value)' + q + '>' +
      '<div class=' + q + 'h-drawer-label' + q + ' style=' + q + 'margin-top:12px' + q + '>Comentario o notas</div>' +
      '<div style=' + q + 'display:flex;gap:8px;margin-top:6px;align-items:center' + q + '>' +
        '<input class=' + q + 'h-drawer-other-input' + q + ' id=' + q + 'h-train-notes' + q + ' placeholder=' + q + 'Opcional...' + q + ' style=' + q + 'display:block;flex:1;margin:0' + q + '>' +
        '<button id=' + q + 'h-train-register-btn' + q + ' onclick=' + q + 'habitRegisterTrainLog()' + q + ' style=' + q + 'padding:0 14px;height:38px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0' + q + '>Registrar</button>' +
      '</div>' +
    '</div>';
  }
  if (id === 'piano') {
    var typeChips = ['Escalas','Arpegios','Canciones','Ejercicios','Clase','Inversiones'].map(function(t) {
      return '<button class=' + q + 'h-scroll-chip' + q + ' onclick=' + q + 'habitTogglePianoType(' + sq + t + sq + ')' + q + '>' + t + '</button>';
    }).join('');
    var durChips = [15,30,45,60,90,120].map(function(n) {
      return '<button class=' + q + 'h-scroll-chip' + q + ' onclick=' + q + 'habitSelectPianoDur(' + n + ')' + q + '>' + n + '</button>';
    }).join('') + '<button class=' + q + 'h-scroll-chip' + q + ' onclick=' + q + 'habitSelectPianoDur(' + sq + 'custom' + sq + ')' + q + '>Otro</button>';
    return '<div class=' + q + 'h-detail-drawer' + q + ' id=' + q + 'h-drawer-piano' + q + '>' +
      '<div class=' + q + 'h-drawer-label' + q + '>Qué practicaste</div>' +
      '<div class=' + q + 'h-scroll-chips' + q + ' id=' + q + 'h-chips-piano-type' + q + '>' + typeChips + '</div>' +
      '<div class=' + q + 'h-drawer-label' + q + ' style=' + q + 'margin-top:12px' + q + '>Duración (min)</div>' +
      '<div class=' + q + 'h-scroll-chips' + q + ' id=' + q + 'h-chips-piano-dur' + q + '>' + durChips + '</div>' +
      '<input class=' + q + 'h-drawer-other-input' + q + ' id=' + q + 'h-piano-dur-custom' + q + ' type=' + q + 'text' + q + ' inputmode=' + q + 'numeric' + q + ' pattern=' + q + '[0-9]*' + q + ' placeholder=' + q + 'min' + q + ' style=' + q + 'display:none' + q + ' oninput=' + q + 'habitPianoDurCustomChange(this.value)' + q + '>' +
    '</div>';
  }
  return '';
}

function habitWaterItemHTML() {
  // Bar fills to 3000ml max; turns green at goal (2000 or 2500)
  const pct      = Math.min(100, Math.round((habitWaterMl / 3000) * 100));
  const goalPct  = Math.round((habitWaterGoal / 3000) * 100);
  const done     = habitWaterMl >= habitWaterGoal;
  const barColor = done ? 'var(--accent3)' : 'var(--accent5)';
  const takenL   = (habitWaterMl / 1000).toFixed(2);
  const goalL    = (habitWaterGoal / 1000).toFixed(1);
  const label    = takenL + ' / ' + goalL + 'L';
  const minusDisabled = habitWaterMl <= 0 ? ' disabled' : '';
  return (
    '<div class="habit-item h-water-item" data-id="water">' +
      '<div class="habit-icon" style="background:rgba(79,195,247,0.10)">&#x1F4A7;</div>' +
      '<div class="habit-info" style="flex:1">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div class="habit-name">Agua</div>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            (done ? '<div class="h-water-tick">&#10003;</div>' : '') +
            '<div class="h-water-label" style="color:' + (done ? 'var(--accent3)' : 'var(--accent5)') + '">' + label + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="h-water-bar-track">' +
          '<div class="h-water-bar-fill" style="width:' + pct + '%;background:' + barColor + '"></div>' +
          '<div class="h-water-goal-mark" style="left:' + goalPct + '%"></div>' +
        '</div>' +
        '<div class="h-water-btns">' +
          '<button class="h-water-btn minus"' + minusDisabled + ' onclick="habitAddWater(-100);event.stopPropagation()">&#8722;100</button>' +
          '<button class="h-water-btn" onclick="habitAddWater(250);event.stopPropagation()">+250</button>' +
          '<button class="h-water-btn plus" onclick="habitAddWater(500);event.stopPropagation()">+500</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function habitRenderHabits() {
  const el = document.getElementById('habitList');
  if (!el) return;
  el.innerHTML = HABITS_LIST.map(h => {
    if (h.isWater) return habitWaterItemHTML();
    const done = !!habitDayState[h.id];
    // click en la fila: abre drawer o cierra con validación
    // click en el círculo verde: desmarcar sin validación
    const rowClick = "habitToggle(\'" + h.id + "\', false)";
    const itemHTML = (
      '<div class="habit-item ' + (done ? 'done' : '') + '" onclick="' + rowClick + '" data-id="' + h.id + '">' +
        '<div class="habit-icon" style="background:' + h.color + '">' + h.icon + '</div>' +
        '<div class="habit-info">' +
          '<div class="habit-name">' + h.name + '</div>' +
          '<div class="habit-streak">' + (h.streak > 0 ? '🔥 ' + h.streak + ' días seguidos' : 'Sin racha activa') + '</div>' +
        '</div>' +
        '<div class="habit-check" data-checkid="' + h.id + '">' + (done ? '✓' : '') + '</div>' +
        (h.hasDetail ? '<span class="h-habit-chevron">›</span>' : '') +
      '</div>'
    );
    const drawerOpen = habitOpenDrawers.has(h.id);
    const drawerHTML = h.hasDetail ? habitDrawerHTML(h.id).replace(
      'class="h-detail-drawer"',
      'class="h-detail-drawer' + (drawerOpen ? ' open' : '') + '"'
    ) : '';
    return itemHTML + drawerHTML;
  }).join('');
  habitRestoreDrawerSelections();

  // Bindear los círculos verdes con capture para interceptar ANTES del burbujeo
  document.querySelectorAll('[data-checkid]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();
      var id = btn.getAttribute('data-checkid');
      habitCheckClick(id);
    }, true); // capture=true: intercepta antes que el onclick del padre
  });
}

// Valida si los campos obligatorios del drawer están completos
function habitDetailComplete(id) {
  if (id === 'trained') {
    return !!(habitDayState.trainType && habitDayState.trainDur);
  }
  if (id === 'piano') {
    return !!(habitDayState.pianoTypes && habitDayState.pianoTypes.length > 0 && habitDayState.pianoDur);
  }
  return true;
}

// Flash rojo en los chip-containers faltantes
function habitFlashMissing(id) {
  if (id === 'trained') {
    if (!habitDayState.trainType) habitFlashChips('h-chips-trained-type');
    if (!habitDayState.trainDur)  habitFlashChips('h-chips-trained-dur');
  }
  if (id === 'piano') {
    if (!habitDayState.pianoTypes || !habitDayState.pianoTypes.length) habitFlashChips('h-chips-piano-type');
    if (!habitDayState.pianoDur)  habitFlashChips('h-chips-piano-dur');
  }
}

function habitFlashChips(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  // Flashear cada chip individualmente para forzar reflow limpio
  container.querySelectorAll('.h-scroll-chip').forEach(chip => {
    chip.classList.remove('h-chip-flash');
    void chip.offsetWidth;
    chip.classList.add('h-chip-flash');
    setTimeout(() => chip.classList.remove('h-chip-flash'), 700);
  });
}

// Estado de drawers abiertos — independiente del estado done
const habitOpenDrawers = new Set();

// Click en el círculo verde — stopPropagation ya manejado por el listener con capture
function habitCheckClick(id) {
  // Limpiar estado del drawer al desmarcar
  if (id === 'trained') {
    habitDayState.trainType = null;
    habitDayState.trainDur  = null;
  }
  if (id === 'piano') {
    habitDayState.pianoTypes = [];
    habitDayState.pianoDur   = null;
  }
  habitToggle(id, true);
}

// fromCheck=true  → click en el círculo verde:
//   · desmarca siempre (done=false) y cierra el drawer
// fromCheck=false → click en la fila:
//   · si done=false → marca (done=true) y abre el drawer
//   · si done=true y drawer abierto → intenta cerrar drawer (validar primero);
//     si faltan campos flashea y no cierra. Estado done NO cambia.
//   · si done=true y drawer cerrado → abre el drawer (sin cambiar done)
function habitToggle(id, fromCheck) {
  const h      = HABITS_LIST.find(h => h.id === id);
  const done   = !!habitDayState[id];
  const isOpen = habitOpenDrawers.has(id);

  if (fromCheck) {
    // Círculo verde: desmarcar + cerrar drawer
    habitDayState[id] = false;
    habitOpenDrawers.delete(id);
    habitRenderHabits();
    habitScheduleSave();
    return;
  }

  // Clic en la fila
  if (!done) {
    // Marcar y abrir drawer
    habitDayState[id] = true;
    if (h && h.hasDetail) habitOpenDrawers.add(id);
    localStorage.setItem('habitLastActivity', habitLocalDateStr(new Date()));
    habitRenderHabits();
    habitScheduleSave();
    return;
  }

  // done=true
  if (h && h.hasDetail) {
    // Con drawer: toggle del drawer (validando al cerrar)
    if (isOpen) {
      if (!habitDetailComplete(id)) {
        habitFlashMissing(id);
        return;
      }
      habitOpenDrawers.delete(id); // cierra drawer, done sigue true
    } else {
      habitOpenDrawers.add(id); // abre drawer, done sigue true
    }
    habitRenderHabits();
  } else {
    // Sin drawer: desmarcar directamente
    habitDayState[id] = false;
    habitRenderHabits();
    habitScheduleSave();
  }
}


function habitRestoreDrawerSelections() {
  // Trained type
  if (habitDayState.trainType) {
    document.querySelectorAll('#h-chips-trained-type .h-scroll-chip').forEach(c => {
      c.classList.toggle('selected', c.textContent.trim() === habitDayState.trainType);
    });
    const inp = document.getElementById('h-train-other');
    if (inp) {
      inp.style.display = habitDayState.trainType === 'Otro' ? 'block' : 'none';
      if (habitDayState.trainType === 'Otro' && habitDayState.trainTypeOther) {
        inp.value = habitDayState.trainTypeOther;
      }
    }
  }
  // Trained duration
  if (habitDayState.trainDur) {
    document.querySelectorAll('#h-chips-trained-dur .h-scroll-chip').forEach(c => {
      const n = parseInt(c.textContent);
      c.classList.toggle('selected', n === habitDayState.trainDur);
    });
  }
  // Trained notes
  const notesInp = document.getElementById('h-train-notes');
  if (notesInp && habitDayState.trainNotes) notesInp.value = habitDayState.trainNotes;
  // Piano types (multi)
  if (habitDayState.pianoTypes && habitDayState.pianoTypes.length) {
    document.querySelectorAll('#h-chips-piano-type .h-scroll-chip').forEach(c => {
      c.classList.toggle('selected', habitDayState.pianoTypes.includes(c.textContent.trim()));
    });
  }
  // Piano duration
  if (habitDayState.pianoDur) {
    document.querySelectorAll('#h-chips-piano-dur .h-scroll-chip').forEach(c => {
      const n = parseInt(c.textContent);
      c.classList.toggle('selected', n === habitDayState.pianoDur);
    });
  }
}

// ── WATER TRACKER ────────────────────────────────────────────────────────────
// Queue de transacciones: cada tap encola su delta, el flush manda todas juntas.
// No reconcilia con la DB post-save — el estado local ya es correcto
// (suma de todos los deltas encolados + base cargada al inicio del día).

let waterQueue   = [];   // deltas pendientes de persistir
let waterFlushTimer = null;

function habitWaterRender() {
  const waterEl = document.querySelector('[data-id="water"]');
  if (!waterEl) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = habitWaterItemHTML();
  waterEl.replaceWith(tmp.firstChild);
}

async function habitWaterFlush() {
  if (waterQueue.length === 0) return;
  const toSend = waterQueue.slice(); // snapshot
  waterQueue = [];                   // vaciar antes del await
  try {
    await Promise.all(toSend.map(deltaMl =>
      fetch('/api/water/log', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ amount_ml: deltaMl, source: 'manual' }),
      })
    ));
    localStorage.setItem('habitLastActivity', habitLocalDateStr(new Date()));
  } catch (e) {
    // Si falla, reencolar para reintentar en el próximo flush
    console.warn('[water] flush failed, re-queuing:', e.message);
    waterQueue = [...toSend, ...waterQueue];
  }
}

function habitWaterScheduleFlush() {
  clearTimeout(waterFlushTimer);
  waterFlushTimer = setTimeout(habitWaterFlush, 0);
}

function habitAddWater(deltaMl) {
  // Guard: no bajar de 0 ni superar 3000
  if (deltaMl < 0 && habitWaterMl <= 0) return;
  if (deltaMl > 0 && habitWaterMl >= 3000) return;

  // Actualización local inmediata
  habitWaterMl = Math.max(0, Math.min(3000, habitWaterMl + deltaMl));
  habitWaterRender();

  // Encolar delta y programar flush (debounced 800ms)
  waterQueue.push(deltaMl);
  habitWaterScheduleFlush();
}

// Flush inmediato si el usuario cierra/navega fuera de la app
window.addEventListener('beforeunload', () => {
  if (waterQueue.length === 0) return;
  // sendBeacon es el único fetch garantizado durante beforeunload
  waterQueue.forEach(deltaMl => {
    navigator.sendBeacon('/api/water/log',
      new Blob(
        [JSON.stringify({ amount_ml: deltaMl, source: 'manual' })],
        { type: 'application/json' }
      )
    );
  });
  waterQueue = [];
});

// ── RENDER: MEALS ──────────────────────────────────────────────────────────────
// Reemplaza la grilla de Excel. 4 slots fijos (desayuno/almuerzo/merienda/cena)
// + caprichos por día. Guardado en tabla `meals` vía proxy genérico /api/db/meals
// (mismo patrón que habitRegisterTrainLog), pero NO se guarda tap por tap: los
// botones/texto solo arman un borrador en memoria, y un único "Guardar" persiste
// todo junto.
//
// UX de cada slot:
//   👍/👎 → togglean el estado en el borrador (tildado visualmente). Tocar el
//           mismo botón ya seleccionado lo deselecciona.
//   texto → aparece SOLO cuando el estado del slot es 👎, se esconde si se
//           deselecciona.
// Capricho: "+ Capricho" es un toggle igual — al tocarlo aparece el campo de
// texto (+ kcal opcional); tocarlo de nuevo lo esconde y descarta lo tipeado.
// Nada de esto pega contra la DB hasta tocar "Guardar comidas".

const MEAL_SLOTS = [
  { id: 'desayuno', label: 'Desayuno' },
  { id: 'almuerzo', label: 'Almuerzo' },
  { id: 'merienda', label: 'Merienda' },
  { id: 'cena',     label: 'Cena'     },
];
const MEAL_TYPE_LABELS = { desayuno: 'Desayuno', almuerzo: 'Almuerzo', merienda: 'Merienda', cena: 'Cena', capricho: 'Capricho' };
const MEAL_SKIP_TEXT = '(nada)'; // texto fijo para "no comí esta comida"

// habitMealsState: lo que YA está guardado en DB (fuente de verdad al cargar).
// habitMealsDraft: lo que se está por guardar, arranca como espejo de lo guardado.
let habitMealsDraft = { slots: {}, capricho: { open: false, description: '', kcal: '' } };

function habitEscapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function habitMealsDraftFromState() {
  const slots = {};
  MEAL_SLOTS.forEach(s => {
    const saved = habitMealsState.slots[s.id];
    if (!saved) {
      slots[s.id] = { status: null, description: '' };
    } else if (saved.is_indulgent) {
      slots[s.id] = { status: 'bad', description: saved.description || '' };
    } else if (saved.description === MEAL_SKIP_TEXT) {
      slots[s.id] = { status: 'skip', description: '' };
    } else {
      slots[s.id] = { status: 'good', description: '' };
    }
  });
  habitMealsDraft = { slots, capricho: { open: false, description: '', kcal: '' } };
}

function habitRenderMeals() {
  const container = document.getElementById('habitMealSlots');
  if (!container) return;

  const slotsHTML = MEAL_SLOTS.map(s => {
    const d = habitMealsDraft.slots[s.id] || { status: null, description: '' };
    const goodSel = d.status === 'good' ? ' selected' : '';
    const skipSel = d.status === 'skip' ? ' selected' : '';
    const badSel  = d.status === 'bad'  ? ' selected' : '';
    const textHTML = d.status === 'bad'
      ? '<input class="h-meal-slot-input" data-flash="' + s.id + '" placeholder="&#191;Qu&#233; pas&#243;? (delivery, exceso, etc.)" ' +
          'value="' + habitEscapeHtml(d.description) + '" oninput="habitMealDraftSetText(' + "'" + s.id + "'" + ', this.value)">'
      : '';
    return (
      '<div class="h-meal-slot-row">' +
        '<div class="h-meal-slot-top">' +
          '<span class="h-meal-slot-label">' + s.label + '</span>' +
          '<div class="h-meal-slot-btns">' +
            '<button class="h-meal-mark-btn good' + goodSel + '" title="Bien" onclick="habitMealDraftToggle(' + "'" + s.id + "'" + ', ' + "'good'" + ')">&#128077;</button>' +
            '<button class="h-meal-mark-btn skip' + skipSel + '" title="No comí" onclick="habitMealDraftToggle(' + "'" + s.id + "'" + ', ' + "'skip'" + ')">&#128683;</button>' +
            '<button class="h-meal-mark-btn bad' + badSel + '" title="Mal" onclick="habitMealDraftToggle(' + "'" + s.id + "'" + ', ' + "'bad'" + ')">&#128078;</button>' +
          '</div>' +
        '</div>' +
        textHTML +
      '</div>'
    );
  }).join('');

  const savedCaprichosHTML = habitMealsState.caprichos.map(c => (
    '<div class="h-meal-capricho-chip">' +
      '<span>' + habitEscapeHtml(c.description) + (c.kcal_estimate ? ' · ' + c.kcal_estimate + 'kcal' : '') + '</span>' +
      '<span class="h-meal-capricho-remove" onclick="habitDeleteCapricho(' + "'" + c.id + "'" + ', event)">&times;</span>' +
    '</div>'
  )).join('');

  const cap = habitMealsDraft.capricho;
  const capDraftHTML = cap.open
    ? '<div class="h-meal-capricho-draft">' +
        '<input class="h-meal-slot-input" data-flash="capricho" placeholder="&#191;Qu&#233; te diste de gusto?" ' +
          'value="' + habitEscapeHtml(cap.description) + '" oninput="habitCapDraftSetText(this.value)">' +
        '<input class="h-meal-slot-input" type="number" inputmode="numeric" placeholder="Kcal aprox. (opcional)" ' +
          'value="' + habitEscapeHtml(cap.kcal) + '" oninput="habitCapDraftSetKcal(this.value)">' +
      '</div>'
    : '';

  container.innerHTML =
    '<div class="h-meal-slots-list">' + slotsHTML + '</div>' +
    '<div class="h-meal-caprichos-row">' +
      savedCaprichosHTML +
      '<button class="h-meal-capricho-add' + (cap.open ? ' selected' : '') + '" onclick="habitCapDraftToggleOpen()">+ Capricho</button>' +
    '</div>' +
    capDraftHTML +
    '<button class="h-meal-save-all-btn" id="habitMealsSaveAllBtn" onclick="habitSaveAllMeals()">Guardar comidas</button>';
}

// Toggle visual — no pega contra la DB. Tocar el mismo botón ya seleccionado
// deselecciona (y esconde el texto si era 'bad').
function habitMealDraftToggle(mealType, status) {
  const d = habitMealsDraft.slots[mealType];
  if (d.status === status) {
    d.status = null;
    d.description = '';
  } else {
    d.status = status;
    if (status === 'good' || status === 'skip') d.description = '';
  }
  habitRenderMeals();
}

// Solo actualiza el borrador en memoria — sin re-render, para no perder foco/cursor.
function habitMealDraftSetText(mealType, value) {
  habitMealsDraft.slots[mealType].description = value;
}

function habitCapDraftToggleOpen() {
  const cap = habitMealsDraft.capricho;
  cap.open = !cap.open;
  if (!cap.open) { cap.description = ''; cap.kcal = ''; }
  habitRenderMeals();
}

function habitCapDraftSetText(value) { habitMealsDraft.capricho.description = value; }
function habitCapDraftSetKcal(value) { habitMealsDraft.capricho.kcal = value; }

function habitFlashMealField(key) {
  const el = document.querySelector('[data-flash="' + key + '"]');
  if (!el) return;
  el.classList.remove('h-chip-flash');
  void el.offsetWidth;
  el.classList.add('h-chip-flash');
  setTimeout(() => el.classList.remove('h-chip-flash'), 700);
}

// Guarda todo junto: los 4 slots (según su estado en el borrador) + el
// capricho pendiente si hay uno abierto con texto. Un solo tap, un solo lote.
async function habitSaveAllMeals() {
  // Validar: todo lo marcado "mal" necesita texto antes de guardar nada
  const missing = MEAL_SLOTS.filter(s => {
    const d = habitMealsDraft.slots[s.id];
    return d.status === 'bad' && !d.description.trim();
  });
  if (missing.length) {
    missing.forEach(s => habitFlashMealField(s.id));
    return;
  }
  if (habitMealsDraft.capricho.open && !habitMealsDraft.capricho.description.trim()) {
    habitFlashMealField('capricho');
    return;
  }

  const btn = document.getElementById('habitMealsSaveAllBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    for (const s of MEAL_SLOTS) {
      const d     = habitMealsDraft.slots[s.id];
      const saved = habitMealsState.slots[s.id];

      if (d.status === null) {
        // Estaba guardado y se deseleccionó → borrar
        if (saved) {
          const delRes = await fetch('/api/db/meals?id=eq.' + saved.id, { method: 'DELETE' });
          if (!delRes.ok) throw new Error((await delRes.text()).slice(0, 150));
          delete habitMealsState.slots[s.id];
        }
        continue;
      }

      const payload = {
        meal_date:     habitDateStr(habitDayOffset),
        meal_type:     s.id,
        description:   d.status === 'bad' ? d.description.trim() : (d.status === 'skip' ? MEAL_SKIP_TEXT : null),
        is_indulgent:  d.status === 'bad',
        kcal_estimate: null,
      };
      const res = await fetch('/api/db/meals?on_conflict=meal_date,slot_key', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.text()).slice(0, 150));
      const rows = await res.json();
      habitMealsState.slots[s.id] = Array.isArray(rows) ? rows[0] : rows;
    }

    if (habitMealsDraft.capricho.open && habitMealsDraft.capricho.description.trim()) {
      const cap = habitMealsDraft.capricho;
      const payload = {
        meal_date:     habitDateStr(habitDayOffset),
        meal_type:     'capricho',
        description:   cap.description.trim(),
        is_indulgent:  true,
        kcal_estimate: cap.kcal ? parseInt(cap.kcal, 10) : null,
      };
      const res = await fetch('/api/db/meals', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.text()).slice(0, 150));
      const rows  = await res.json();
      const saved = Array.isArray(rows) ? rows[0] : rows;
      habitMealsState.caprichos = [...habitMealsState.caprichos, saved];
    }

    habitMealsDraftFromState(); // resincroniza el borrador con lo recién guardado
    if (btn) btn.textContent = 'Guardado ✓';
    habitRenderMeals();
    setTimeout(() => {
      const b = document.getElementById('habitMealsSaveAllBtn');
      if (b) { b.disabled = false; b.textContent = 'Guardar comidas'; }
    }, 1500);
  } catch (e) {
    console.error('[habits] Error guardando comidas:', e);
    alert('No se pudo guardar: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar comidas'; }
  }
}

// Los caprichos ya guardados se borran al toque (no forman parte del borrador
// pendiente, es una acción puntual sobre algo que ya está en DB).
async function habitDeleteCapricho(id, event) {
  if (event) event.stopPropagation();
  if (!confirm('¿Borrar este capricho?')) return;
  try {
    const res = await fetch('/api/db/meals?id=eq.' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    habitMealsState.caprichos = habitMealsState.caprichos.filter(c => c.id !== id);
    habitRenderMeals();
  } catch (e) {
    console.error('[habits] Error borrando capricho:', e);
  }
}


// ── RENDER: DETAIL DRAWERS ─────────────────────────────────────────────────────

function habitSelectTrainType(type) {
  habitDayState.trainType = type;
  // Update chips UI — single select
  document.querySelectorAll('#h-chips-trained-type .h-scroll-chip').forEach(c => {
    c.classList.toggle('selected', c.textContent.includes(type));
  });
  // Show/hide "Otro" text input
  const inp = document.getElementById('h-train-other');
  if (inp) inp.style.display = type === 'Otro' ? 'block' : 'none';
  habitScheduleSave();
}

function habitTrainOtherChange(val) {
  habitDayState.trainTypeOther = val;
  habitScheduleSave();
}

function habitSelectTrainDur(val) {
  const isCustom = val === 'custom';
  habitDayState.trainDur = isCustom ? null : val;
  document.querySelectorAll('#h-chips-trained-dur .h-scroll-chip').forEach(c => {
    const chipVal = c.textContent === 'Otro' ? 'custom' : parseInt(c.textContent);
    c.classList.toggle('selected', isCustom ? c.textContent === 'Otro' : chipVal === val);
  });
  const inp = document.getElementById('h-train-dur-custom');
  if (inp) inp.style.display = isCustom ? 'block' : 'none';
  habitScheduleSave();
}

function habitTrainDurCustomChange(val) {
  habitDayState.trainDur = parseInt(val) || null;
  habitScheduleSave();
}

// Mapeo entre el label que se muestra en la UI y el valor que se guarda en DB.
// Los tipos no listados acá se guardan tal cual (ej. 'Gym' -> 'Gym').
const HABIT_TRAIN_TYPE_DB_MAP = { Rugby: 'Touch Rugby' };

function habitResolveTrainType() {
  const t = habitDayState.trainType;
  if (!t) return null;
  const raw = t === 'Otro' ? (habitDayState.trainTypeOther || '').trim() : t;
  if (!raw) return null;
  return HABIT_TRAIN_TYPE_DB_MAP[raw] || raw;
}

// Inserta un registro de entrenamiento en habit_logs (independiente del check
// diario / habitScheduleSave, que todavía es mock). Usa el mismo proxy
// genérico /api/db/:table que transactions.js usa para POST.
async function habitRegisterTrainLog() {
  const dbType = habitResolveTrainType();
  const dur    = habitDayState.trainDur;

  if (!dbType || !dur) {
    habitFlashMissing('trained');
    return;
  }

  const btn      = document.getElementById('h-train-register-btn');
  const notesInp = document.getElementById('h-train-notes');
  const notes    = notesInp && notesInp.value.trim() ? notesInp.value.trim() : null;

  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const res = await fetch('/api/db/habit_logs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        habit_date:   habitDateStr(habitDayOffset),
        habit:        'Workout',
        type:         [dbType],
        duration_min: dur,
        notes,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err.slice(0, 120));
    }

    if (notesInp) notesInp.value = '';
    if (btn) btn.textContent = '✓';
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Registrar'; } }, 2000);

    // Si el historial de Analytics está abierto, refrescarlo con el nuevo registro
    if (document.getElementById('habitHistoryBody')?.classList.contains('open')) loadHabitHistory();

  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Registrar'; }
    alert('Error al registrar: ' + e.message);
  }
}

function habitTogglePianoType(type) {
  if (!habitDayState.pianoTypes) habitDayState.pianoTypes = [];
  const idx = habitDayState.pianoTypes.indexOf(type);
  if (idx === -1) habitDayState.pianoTypes.push(type);
  else            habitDayState.pianoTypes.splice(idx, 1);
  document.querySelectorAll('#h-chips-piano-type .h-scroll-chip').forEach(c => {
    c.classList.toggle('selected', habitDayState.pianoTypes.includes(c.textContent));
  });
  habitScheduleSave();
}

function habitSelectPianoDur(val) {
  const isCustom = val === 'custom';
  habitDayState.pianoDur = isCustom ? null : val;
  document.querySelectorAll('#h-chips-piano-dur .h-scroll-chip').forEach(c => {
    const chipVal = c.textContent === 'Otro' ? 'custom' : parseInt(c.textContent);
    c.classList.toggle('selected', isCustom ? c.textContent === 'Otro' : chipVal === val);
  });
  const inp = document.getElementById('h-piano-dur-custom');
  if (inp) inp.style.display = isCustom ? 'block' : 'none';
  habitScheduleSave();
}

function habitPianoDurCustomChange(val) {
  habitDayState.pianoDur = parseInt(val) || null;
  habitScheduleSave();
}

// Drawer state is restored by habitRestoreDrawerSelections() called from habitRenderHabits
function habitRenderDrawers() { /* no-op: inline drawers handle this */ }

// ── RENDER: ONE-SHOTS ──────────────────────────────────────────────────────────

function habitRenderOneshots() {
  const container = document.getElementById('habitOneshotGroup');
  if (!container) return;

  container.innerHTML = ONESHOTS.map(os => {
    const val = habitOneshotState[os.id] || 0;
    const pct = os.goal ? Math.min(100, Math.round((val / os.goal) * 100)) : null;
    const fillColor = !os.goal      ? 'var(--accent)' :
                      val >= os.goal ? 'var(--accent3)' :
                      val >= os.goal * 0.5 ? 'var(--accent4)' : 'var(--accent)';

    const barHtml = os.goal
      ? `<div class="h-stepper-track">
           <div class="h-stepper-fill" id="h-osbar-${os.id}" style="width:${pct}%;background:${fillColor}"></div>
         </div>`
      : `<div style="flex:1;font-size:11px;color:var(--muted)">contador</div>`;

    return `
      <div class="h-oneshot-card">
        <div class="h-oneshot-header">
          <div class="h-oneshot-icon">${os.icon}</div>
          <div class="h-oneshot-info">
            <div class="h-oneshot-name">${os.name}</div>
            <div class="h-oneshot-sub">${os.sub}</div>
          </div>
          <div class="h-oneshot-val" id="h-osval-${os.id}" style="color:${fillColor}">${val}</div>
        </div>
        <div class="h-oneshot-controls">
          <button class="h-stepper-btn" onclick="habitStepOneshot('${os.id}', -1)">−</button>
          ${barHtml}
          <button class="h-stepper-btn" onclick="habitStepOneshot('${os.id}', 1)">+</button>
        </div>
      </div>`;
  }).join('');
}

function habitStepOneshot(id, delta) {
  habitOneshotState[id] = Math.max(0, (habitOneshotState[id] || 0) + delta);
  const os  = ONESHOTS.find(o => o.id === id);
  const val = habitOneshotState[id];
  const fillColor = !os.goal      ? 'var(--accent)' :
                    val >= os.goal ? 'var(--accent3)' :
                    val >= os.goal * 0.5 ? 'var(--accent4)' : 'var(--accent)';

  const valEl = document.getElementById('h-osval-' + id);
  const barEl = document.getElementById('h-osbar-' + id);
  if (valEl) { valEl.textContent = val; valEl.style.color = fillColor; }
  if (barEl && os.goal) {
    barEl.style.width      = Math.min(100, Math.round((val / os.goal) * 100)) + '%';
    barEl.style.background = fillColor;
  }

  // Debounce save
  clearTimeout(habitSaveTimeout);
  habitSaveTimeout = setTimeout(() => saveOneshotsToDB(habitOneshotState), 1500);
}

// ── RENDER: WEIGHT ─────────────────────────────────────────────────────────────

function habitSaveWeight() {
  const input  = document.getElementById('habitWeightInput');
  const btn    = document.getElementById('habitWeightSaveBtn');
  const val    = parseFloat(input?.value);
  if (!input || isNaN(val)) return;

  // TODO: POST to /api/habits/weight
  console.log('[habits] save weight mock:', habitDateStr(0), val);

  if (btn) {
    btn.textContent = 'Guardado ✓';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'Guardar peso'; btn.classList.remove('saved'); }, 2000);
  }

  habitUpdateMilestones(val);
}

function habitUpdateMilestones(kg) {
  const apr = document.getElementById('h-ms-apr');
  const aug = document.getElementById('h-ms-aug');
  const dec = document.getElementById('h-ms-dec');
  if (apr) apr.className = 'h-milestone ' + (kg <= 98 ? 'achieved' : 'next');
  if (aug) aug.className = 'h-milestone ' + (kg <= 94 ? 'achieved' : kg <= 98 ? 'next' : 'future');
  if (dec) dec.className = 'h-milestone ' + (kg <= 90 ? 'achieved' : 'future');
}

// ── RENDER: YEAR ───────────────────────────────────────────────────────────────

function habitRenderYear() {
  const container = document.getElementById('habitYearCards');
  if (!container) return;

  container.innerHTML = YEAR_GOALS.map(g => {
    const expected = Math.round((CURRENT_WEEK / 52) * g.goal);
    const status   = g.current >= g.goal           ? 'ok' :
                     g.current >= expected          ? 'ok' :
                     g.current >= expected * 0.65   ? 'warn' : 'bad';
    const pct      = Math.min(100, Math.round((g.current / g.goal) * 100));
    const valLabel = g.unit ? g.current + ' ' + g.unit : String(g.current);
    const sub      = g.current >= g.goal
      ? 'Objetivo alcanzado 🎉'
      : `Esperado a esta semana: ${expected}`;

    return `
      <div class="h-year-card">
        <div class="h-year-card-top">
          <div class="h-year-card-left">
            <div class="h-year-card-icon">${g.icon}</div>
            <div>
              <div class="h-year-card-name">${g.name}</div>
              <div class="h-year-card-target">${g.target}</div>
            </div>
          </div>
          <div class="h-year-card-val ${status}">${valLabel}</div>
        </div>
        <div class="h-bar-track">
          <div class="h-bar-fill ${status}" style="width:${pct}%"></div>
        </div>
        <div class="h-year-card-sub">${sub}</div>
      </div>`;
  }).join('');

  // Week label
  const weekLabel = document.getElementById('habitYearWeekLabel');
  if (weekLabel) weekLabel.textContent = `Semana ${CURRENT_WEEK} / 52`;
}

// ── RENDER: CONFIG ─────────────────────────────────────────────────────────────

function habitRenderConfig() {
  // no-op — panel Config reemplazado por Analytics
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
// Muestra 3 gráficos de seguimiento: entrenamiento (% días + min/semana),
// tipos de entrenamiento (stacked bar), y piano (% días + min/semana).
// Los datos vienen de loadAnalyticsFromDB() — stub por ahora, reemplazar
// cuando esté la tabla habit_analytics en Supabase.

let chartTraining  = null;
let chartTrainTypes = null;
let chartPiano     = null;

// ── Carga y agrupa logs de habit_logs por semana ─────────────────────────────
// Retorna array de { weekLabel, weekStart, trainDays, trainMins, pianoDays,
//                    pianoMins, trainTypes: { Gym: N, ... } }
async function loadAnalyticsFromDB(weeks) {
  // Calcular fecha de inicio: lunes de la semana más antigua a mostrar
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Ir al lunes de esta semana
  const dayOfWeek = (today.getDay() + 6) % 7; // lunes = 0
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - dayOfWeek);

  // Fecha de inicio = thisMonday - (weeks-1) semanas
  const fromDate = new Date(thisMonday);
  fromDate.setDate(thisMonday.getDate() - (weeks - 1) * 7);
  const fromStr = habitLocalDateStr(fromDate);

  // Query a Supabase via proxy
  let rows = [];
  try {
    rows = await sbFetch(`/rest/v1/habit_logs?habit_date=gte.${fromStr}&order=habit_date.asc`);
  } catch(e) {
    console.error('[analytics] Error cargando habit_logs:', e);
    rows = [];
  }

  // Construir array de semanas (lunes → domingo)
  const result = [];
  for (let i = 0; i < weeks; i++) {
    const weekStart = new Date(fromDate);
    weekStart.setDate(fromDate.getDate() + i * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const weekNum = Math.ceil(((weekStart - new Date(weekStart.getFullYear(), 0, 1)) / 86400000 + 1) / 7);

    // Filtrar rows de esta semana
    const weekRows = rows.filter(r => {
      const d = new Date(r.habit_date + 'T00:00:00');
      return d >= weekStart && d <= weekEnd;
    });

    // Workout
    const workoutRows = weekRows.filter(r => r.habit === 'Workout');
    const trainDays   = new Set(workoutRows.map(r => r.habit_date)).size;
    const trainMins   = workoutRows.reduce((s, r) => s + (r.duration_min || 0), 0);

    // Tipos de entrenamiento — aplanar arrays y contar
    const trainTypes  = { Gym: 0, Crossfit: 0, Paddle: 0, Fútbol: 0, Correr: 0, Bici: 0, 'Touch Rugby': 0, Otro: 0 };
    workoutRows.forEach(r => {
      (r.type || []).forEach(t => {
        if (t in trainTypes) trainTypes[t] += r.duration_min || 0;
        else trainTypes['Otro'] += r.duration_min || 0;
      });
    });

    // Piano
    const pianoRows = weekRows.filter(r => r.habit === 'piano');
    const pianoDays = new Set(pianoRows.map(r => r.habit_date)).size;
    const pianoMins = pianoRows.reduce((s, r) => s + (r.duration_min || 0), 0);

    result.push({
      weekLabel:  'S' + weekNum,
      weekStart:  habitLocalDateStr(weekStart),
      trainDays,
      trainMins,
      pianoDays,
      pianoMins,
      trainTypes,
    });
  }

  return result;
}

let analyticsRange = 8; // semanas visibles por default

// Colores por tipo — usados en gráfico 2
const TYPE_COLORS_MAP = {
  'Touch Rugby': 'rgba(108,99,255,0.85)',
  Gym:           'rgba(67,233,123,0.85)',
  Crossfit:      'rgba(247,183,49,0.85)',
  Paddle:        'rgba(79,195,247,0.85)',
  Fútbol:        'rgba(255,107,107,0.85)',
  Correr:        'rgba(255,167,38,0.85)',
  Bici:          'rgba(0,230,118,0.85)',
  Otro:          'rgba(150,150,150,0.85)',
};

// Helper: formato de fecha DD/MM para el label de semana
function fmtWeekLabel(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return d.getDate() + '/' + (d.getMonth() + 1);
}

// Escala X compartida
const AXIS_X = {
  grid: { color: 'rgba(255,255,255,0.05)' },
  ticks: { color: 'rgba(255,255,255,0.45)', font: { size: 11 } },
};

async function habitRenderAnalytics() {
  const panel = document.getElementById('h-panel-analytics');
  if (!panel) return;

  const data = await loadAnalyticsFromDB(analyticsRange === 999 ? 999 : analyticsRange);

  // Labels: fecha de inicio de semana (DD/MM)
  const labels = data.map(d => fmtWeekLabel(d.weekStart));

  // Objetivo semanal: 3/7 días = 42.857% → redondeado a 43
  const TRAIN_TARGET_PCT = Math.round((3 / 7) * 100); // 43

  // ── Gráfico 1: Entrenamiento — dos líneas + objetivo punteado ────────────
  const ctx1 = document.getElementById('chartTraining');
  if (ctx1) {
    if (chartTraining) chartTraining.destroy();
    chartTraining = new Chart(ctx1, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Días entrenados (%)',
            data: data.map(d => Math.round((d.trainDays / 7) * 100)),
            borderColor:     'rgba(108,99,255,0.9)',
            backgroundColor: 'rgba(108,99,255,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            fill: true,
            tension: 0.3,
            yAxisID: 'yPct',
            order: 1,
          },
          {
            label: 'Min/semana',
            data: data.map(d => d.trainMins),
            borderColor:     'rgba(67,233,123,0.9)',
            backgroundColor: 'rgba(67,233,123,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            fill: true,
            tension: 0.3,
            yAxisID: 'yMins',
            order: 2,
          },
          {
            // Línea objetivo punteada — misma altura en todos los puntos
            label: 'Objetivo (3/7 días)',
            data: labels.map(() => TRAIN_TARGET_PCT),
            borderColor:     'rgba(247,183,49,0.7)',
            borderWidth: 1.5,
            borderDash: [5, 4],
            pointRadius: 0,
            fill: false,
            tension: 0,
            yAxisID: 'yPct',
            order: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: AXIS_X,
          yPct: {
            type: 'linear', position: 'left',
            min: 0, max: 100,
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(108,99,255,0.8)', font: { size: 10 }, callback: v => v + '%' },
          },
          yMins: {
            type: 'linear', position: 'right',
            min: 0,
            grid: { drawOnChartArea: false },
            ticks: { color: 'rgba(67,233,123,0.8)', font: { size: 10 }, callback: v => v + 'm' },
          },
        },
        plugins: {
          legend: { display: true, labels: { color: 'rgba(255,255,255,0.6)', font: { size: 11 }, boxWidth: 12 } },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                if (ctx.dataset.label === 'Días entrenados (%)') return 'Días entrenados: ' + v + '%';
                if (ctx.dataset.label === 'Objetivo (3/7 días)') return null; // no mostrar en tooltip
                return 'Min/semana: ' + v;
              },
            },
            filter: item => item.dataset.label !== 'Objetivo (3/7 días)',
          },
        },
      },
    });
  }

  // ── Gráfico 2: Tipos de entrenamiento — stacked 100% con % por segmento ──
  const ctx2 = document.getElementById('chartTrainTypes');
  if (ctx2) {
    if (chartTrainTypes) chartTrainTypes.destroy();

    // Tipos distintos que aparecen en el rango actual (punto 7)
    const activeTypes = [...new Set(
      data.flatMap(d => Object.entries(d.trainTypes)
        .filter(([, v]) => v > 0)
        .map(([k]) => k)
      )
    )];

    // Normalizar a 100% por semana para stacked base-100
    const pctByType = activeTypes.map(t => ({
      label: t,
      backgroundColor: TYPE_COLORS_MAP[t] || 'rgba(150,150,150,0.85)',
      data: data.map(d => {
        const total = Object.values(d.trainTypes).reduce((s, v) => s + v, 0);
        if (!total) return 0;
        return Math.round(((d.trainTypes[t] || 0) / total) * 100);
      }),
      stack: 'types',
    }));

    // Guardar los valores raw de minutos para el tooltip
    const rawMins = activeTypes.map(t => data.map(d => d.trainTypes[t] || 0));

    // Plugin inline: dibuja el % centrado en cada segmento de barra
    const stackedLabelsPlugin = {
      id: 'stackedLabels',
      afterDatasetsDraw(chart) {
        const ctx2d = chart.ctx;
        chart.data.datasets.forEach((dataset, datasetIdx) => {
          const meta = chart.getDatasetMeta(datasetIdx);
          if (meta.hidden) return;
          meta.data.forEach((bar, idx) => {
            const pct = dataset.data[idx];
            if (!pct || pct < 8) return; // no dibujar si el segmento es demasiado chico
            const { x, y, width, height } = bar.getProps(['x', 'y', 'width', 'height'], true);
            ctx2d.save();
            ctx2d.fillStyle = 'rgba(255,255,255,0.92)';
            ctx2d.font = 'bold 10px DM Sans, sans-serif';
            ctx2d.textAlign = 'center';
            ctx2d.textBaseline = 'middle';
            ctx2d.fillText(pct + '%', x, y + height / 2);
            ctx2d.restore();
          });
        });
      },
    };

    chartTrainTypes = new Chart(ctx2, {
      type: 'bar',
      data: { labels, datasets: pctByType },
      plugins: [stackedLabelsPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ...AXIS_X, stacked: true },
          y: {
            stacked: true,
            min: 0, max: 100,
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.45)', font: { size: 10 }, callback: v => v + '%' },
          },
        },
        plugins: {
          legend: {
            display: true,
            labels: { color: 'rgba(255,255,255,0.6)', font: { size: 10 }, boxWidth: 10 },
          },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: {
              label: ctx => {
                const pct = ctx.parsed.y;
                if (!pct) return null;
                return ctx.dataset.label + ': ' + pct + '%';
              },
            },
            filter: item => item.parsed.y > 0,
          },
        },
      },
    });
  }

  // ── Gráfico 3: Piano — dos líneas: % días + min/semana ────────────────────
  const ctx3 = document.getElementById('chartPiano');
  if (ctx3) {
    if (chartPiano) chartPiano.destroy();
    chartPiano = new Chart(ctx3, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Días de piano (%)',
            data: data.map(d => Math.round((d.pianoDays / 7) * 100)),
            borderColor:     'rgba(79,195,247,0.9)',
            backgroundColor: 'rgba(79,195,247,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            fill: true,
            tension: 0.3,
            yAxisID: 'yPct',
            order: 1,
          },
          {
            label: 'Min/semana',
            data: data.map(d => d.pianoMins),
            borderColor:     'rgba(247,183,49,0.9)',
            backgroundColor: 'rgba(247,183,49,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            fill: true,
            tension: 0.3,
            yAxisID: 'yMins',
            order: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: AXIS_X,
          yPct: {
            type: 'linear', position: 'left',
            min: 0, max: 100,
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(79,195,247,0.8)', font: { size: 10 }, callback: v => v + '%' },
          },
          yMins: {
            type: 'linear', position: 'right',
            min: 0,
            grid: { drawOnChartArea: false },
            ticks: { color: 'rgba(247,183,49,0.8)', font: { size: 10 }, callback: v => v + 'm' },
          },
        },
        plugins: {
          legend: { display: true, labels: { color: 'rgba(255,255,255,0.6)', font: { size: 11 }, boxWidth: 12 } },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                if (ctx.dataset.label === 'Días de piano (%)') return 'Días de piano: ' + v + '%';
                return 'Min/semana: ' + v;
              },
            },
          },
        },
      },
    });
  }

  // Grilla de comidas — independiente del rango 8sem/YTD de los charts de arriba,
  // tiene su propia navegación semana a semana.
  loadMealsGrid();
}

// ── COMIDAS: GRILLA SEMANAL (Analytics) ─────────────────────────────────────
// Recrea la vieja grilla de Excel: filas = comida, columnas = día,
// coloreado según is_indulgent. Datos reales de la tabla `meals`.

let mealsWeekOffset = 0; // 0 = semana actual, negativo = semanas atrás

const MEAL_GRID_ROWS   = ['desayuno', 'almuerzo', 'merienda', 'cena', 'capricho'];
const MEAL_GRID_DAYS   = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

function mealsWeekRange(offset) {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // lunes = 0
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: habitLocalDateStr(monday), to: habitLocalDateStr(sunday), monday };
}

async function loadMealsGrid() {
  const { from, to, monday } = mealsWeekRange(mealsWeekOffset);

  const label = document.getElementById('habitMealsWeekLabel');
  if (label) {
    label.textContent = mealsWeekOffset === 0
      ? 'Esta semana'
      : fmtWeekLabel(from) + ' – ' + fmtWeekLabel(to);
  }
  const nextBtn = document.getElementById('habitMealsWeekNextBtn');
  if (nextBtn) nextBtn.classList.toggle('disabled', mealsWeekOffset >= 0);

  let rows = [];
  try {
    rows = await sbFetch(`/rest/v1/meals?meal_date=gte.${from}&meal_date=lte.${to}&order=meal_date.asc`);
  } catch (e) {
    console.error('[analytics] Error cargando meals:', e);
    rows = [];
  }

  renderMealsGrid(rows, monday);
  renderMealsStats(rows);
  habitMealsGridAutoScroll();
}

// Deja el scroll horizontal de la grilla arrancando en el día de hoy (o el
// lunes, si estás viendo una semana pasada). Ej: si es jueves, la grilla
// abre con jueves como primera columna visible, scrolleable para ambos lados.
function habitMealsGridAutoScroll() {
  const wrap = document.querySelector('.h-meal-grid-wrap');
  if (!wrap) return;
  if (mealsWeekOffset !== 0) { wrap.scrollLeft = 0; return; }
  const todayIdx = (new Date().getDay() + 6) % 7; // lunes = 0
  const headers  = document.querySelectorAll('#habitMealsGrid .h-meal-grid-daylabel');
  const target   = headers[todayIdx];
  if (target) target.scrollIntoView({ inline: 'start', block: 'nearest' });
  else wrap.scrollLeft = 0;
}

function renderMealsGrid(rows, monday) {
  const container = document.getElementById('habitMealsGrid');
  if (!container) return;

  const byDate = {};
  rows.forEach(r => {
    byDate[r.meal_date] = byDate[r.meal_date] || {};
    if (r.meal_type === 'capricho') {
      byDate[r.meal_date].capricho = byDate[r.meal_date].capricho || [];
      byDate[r.meal_date].capricho.push(r);
    } else {
      byDate[r.meal_date][r.meal_type] = r;
    }
  });

  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return habitLocalDateStr(d);
  });

  let html = '<div class="h-meal-grid-header-row"><div class="h-meal-grid-corner"></div>';
  dates.forEach((d, i) => {
    html += '<div class="h-meal-grid-daylabel">' + MEAL_GRID_DAYS[i] + '<br><span>' + d.slice(8,10) + '/' + d.slice(5,7) + '</span></div>';
  });
  html += '</div>';

  MEAL_GRID_ROWS.forEach(rowType => {
    html += '<div class="h-meal-grid-row"><div class="h-meal-grid-rowlabel">' + (MEAL_TYPE_LABELS[rowType] || rowType) + '</div>';
    dates.forEach(d => {
      const dayData = byDate[d] || {};
      if (rowType === 'capricho') {
        const items = dayData.capricho || [];
        const text  = items.map(c => habitEscapeHtml(c.description)).join(', ');
        html += '<div class="h-meal-grid-cell ' + (items.length ? 'indulgent' : '') + '">' + text + '</div>';
      } else {
        const cell = dayData[rowType];
        const cls  = cell ? (cell.is_indulgent ? 'indulgent' : 'filled') : '';
        const text = cell ? (cell.is_indulgent || cell.description === MEAL_SKIP_TEXT ? habitEscapeHtml(cell.description) : '&#10003;') : '';
        html += '<div class="h-meal-grid-cell ' + cls + '">' + text + '</div>';
      }
    });
    html += '</div>';
  });

  container.innerHTML = html;
}

function renderMealsStats(rows) {
  const container = document.getElementById('habitMealsStats');
  if (!container) return;

  const slotRows   = rows.filter(r => r.meal_type !== 'capricho');
  const indulgent  = slotRows.filter(r => r.is_indulgent).length;
  const pct        = slotRows.length ? Math.round((indulgent / slotRows.length) * 100) : 0;
  const caprichoKcal = rows
    .filter(r => r.meal_type === 'capricho' && r.kcal_estimate)
    .reduce((s, r) => s + r.kcal_estimate, 0);

  container.innerHTML =
    '<div class="h-meal-stat-chip">' + pct + '% comidas indulgentes</div>' +
    '<div class="h-meal-stat-chip">' + caprichoKcal + ' kcal en caprichos</div>';
}

function habitMealsShiftWeek(delta) {
  const next = mealsWeekOffset + delta;
  if (next > 0) return; // no ir al futuro
  mealsWeekOffset = next;
  loadMealsGrid();
}

// ── HISTORIAL DE HÁBITOS (Analytics) ────────────────────────────────────────
// Mismo patrón que toggleTxHistory/loadTxHistory en transactions.js.

let _habitHistRows   = [];
let _habitHistFilter = 'all';

const HABIT_HIST_LABEL = { Workout: 'Entrenamiento', piano: 'Piano' };

function toggleHabitHistory() {
  const toggle = document.getElementById('habitHistToggle');
  const body   = document.getElementById('habitHistoryBody');
  const isOpen = body.classList.contains('open');
  toggle.classList.toggle('open', !isOpen);
  body.classList.toggle('open', !isOpen);
  if (!isOpen) loadHabitHistory();
}

async function loadHabitHistory() {
  const container = document.getElementById('habitHistoryContent');
  container.innerHTML = '<span style="color:var(--muted)">Cargando...</span>';
  try {
    const rows = await sbFetch('/rest/v1/habit_logs?order=habit_date.desc&limit=100');
    _habitHistRows = rows || [];
    renderHabitHistory();
  } catch(e) {
    container.innerHTML = '<span style="color:var(--accent2)">Error al cargar historial</span>';
  }
}

// Abre un overlay simple con el texto completo de una nota truncada
function habitShowFullNote(text) {
  const existing = document.getElementById('habitNoteOverlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'habitNoteOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:24px';
  overlay.onclick = () => overlay.remove();
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface2,#1e1e2a);border-radius:12px;padding:16px;max-width:340px;max-height:70vh;overflow-y:auto;color:var(--text);font-size:13px;line-height:1.5;white-space:pre-wrap';
  box.textContent = text;
  box.onclick = e => e.stopPropagation();
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function renderHabitHistory() {
  const container = document.getElementById('habitHistoryContent');
  if (!_habitHistRows.length) {
    container.innerHTML = '<span style="color:var(--muted);font-size:13px">Sin registros</span>';
    return;
  }

  // Leer el filtro elegido (si el <select> ya existe de un render previo)
  const filterSel = document.getElementById('habitHistFilter');
  if (filterSel) _habitHistFilter = filterSel.value;

  const distinctHabits = [...new Set(_habitHistRows.map(r => r.habit))];
  const filtered = _habitHistFilter === 'all'
    ? _habitHistRows
    : _habitHistRows.filter(r => r.habit === _habitHistFilter);

  const fmtDate = d => d ? d.slice(5).replace('-', '/') : '—';
  const fmtType = r => (r.type && r.type.length) ? r.type.join(', ') : '—';

  const optionsHtml = ['<option value="all">Todos</option>']
    .concat(distinctHabits.map(h =>
      `<option value="${h}" ${h === _habitHistFilter ? 'selected' : ''}>${HABIT_HIST_LABEL[h] || h}</option>`
    )).join('');

  // table-layout fijo + colgroup con % => nunca se pasa del ancho de pantalla,
  // así que no hace falta scroll horizontal. El clamp de 2 líneas va en un
  // <div> interno (no directo en el <td>: -webkit-box en una celda de tabla
  // rompe el cálculo de alto de fila en algunos navegadores y superpone filas).
  container.innerHTML = `
    <div style="margin-bottom:10px;text-align:right">
      <select id="habitHistFilter" onchange="renderHabitHistory()"
        style="font-size:12px;padding:5px 8px;border-radius:8px;border:1.5px solid var(--border);background:var(--bg);color:var(--text)">
        ${optionsHtml}
      </select>
    </div>
    <table class="tx-hist-table" style="width:100%;table-layout:fixed;font-size:11.5px">
      <colgroup>
        <col style="width:15%"><col style="width:22%"><col style="width:22%"><col style="width:13%"><col style="width:28%">
      </colgroup>
      <thead><tr>
        <th>Fecha</th><th>Hábito</th><th>Tipo</th><th>Tiempo</th><th>Comentario</th>
      </tr></thead>
      <tbody>
        ${filtered.map(r => `<tr>
          <td style="vertical-align:top;padding:6px 4px">${fmtDate(r.habit_date)}</td>
          <td style="vertical-align:top;padding:6px 4px;font-weight:700;word-break:break-word">${HABIT_HIST_LABEL[r.habit] || r.habit}</td>
          <td style="vertical-align:top;padding:6px 4px;color:var(--muted);word-break:break-word">${fmtType(r)}</td>
          <td style="vertical-align:top;padding:6px 4px">${r.duration_min != null ? r.duration_min + 'm' : '—'}</td>
          <td style="vertical-align:top;padding:6px 4px">
            <div class="habit-note-cell" data-full-note="${(r.notes || '').replace(/"/g, '&quot;')}"
              style="color:var(--muted);word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${r.notes ? r.notes : '—'}</div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  // Segunda pasada: solo las notas que realmente se cortaron (scrollHeight >
  // clientHeight) se marcan como clickeables para ver el texto completo.
  container.querySelectorAll('.habit-note-cell').forEach(cell => {
    if (cell.dataset.fullNote && cell.scrollHeight > cell.clientHeight + 1) {
      cell.style.cursor = 'pointer';
      cell.title = 'Tocar para ver completo';
      cell.onclick = () => habitShowFullNote(cell.dataset.fullNote);
    }
  });
}

function habitAnalyticsSetRange(weeks, btn) {
  analyticsRange = weeks;
  document.querySelectorAll('.h-analytics-range-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  habitRenderAnalytics();
}

function habitToggleNotif(key) {
  habitNotifState[key] = !habitNotifState[key];
  const el = document.getElementById('h-tgl-' + key);
  if (el) el.classList.toggle('on', habitNotifState[key]);
  if (key === 'daily') habitSaveNotifTime();
}

function habitSaveNotifTime() {
  const input = document.getElementById('habitNotifTimeDaily');
  if (!input || !input.value) return;
  // Persist to localStorage — preference is per-device, not per-account
  localStorage.setItem('habitNotifTime', input.value);
  habitScheduleNotification();
  // Visual feedback
  const btn = document.getElementById('habitNotifSaveBtn');
  if (btn) {
    btn.textContent = 'Guardado ✓';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'Guardar hora'; btn.classList.remove('saved'); }, 2000);
  }
}

// ── SUB-TAB SWITCH ─────────────────────────────────────────────────────────────

function habitSwitchSubTab(id, el) {
  document.querySelectorAll('.h-sub-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.h-panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('h-panel-' + id);
  if (target) target.classList.add('active');
  if (id === 'analytics') habitRenderAnalytics();
}


// ── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────────
// Solicita permiso y registra un Service Worker que programa la alarma diaria.
// La hora por defecto es 22:30 — configurable desde el tab Config.

const HABIT_NOTIF_DEFAULT_HOUR   = 22;
const HABIT_NOTIF_DEFAULT_MINUTE = 30;

// ── WEB PUSH REAL (VAPID) ────────────────────────────────────────────────────
// El servidor (notification-worker.js) decide cuándo mandar cada push.
// El frontend solo necesita: registrar el SW + suscribirse + guardar la sub en DB.

async function habitInitNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;

  // Register SW
  let reg;
  try {
    reg = await navigator.serviceWorker.register('/sw-habits.js');
    await navigator.serviceWorker.ready;
  } catch(e) {
    console.warn('[habits] SW register failed:', e.message);
    return;
  }

  // Request permission
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  if (Notification.permission !== 'granted') {
    console.log('[habits] notification permission denied');
    return;
  }

  // Get VAPID public key from server
  let vapidKey;
  try {
    const r = await fetch('/api/push/vapid-public-key');
    if (!r.ok) throw new Error('no vapid key');
    const d = await r.json();
    vapidKey = d.publicKey;
  } catch(e) {
    console.warn('[habits] could not get VAPID key:', e.message);
    return;
  }

  // Subscribe or reuse existing subscription
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch(e) {
      console.warn('[habits] push subscribe failed:', e.message);
      return;
    }
  }

  // Save subscription to server
  try {
    await fetch('/api/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(sub.toJSON()),
    });
    console.log('[habits] push subscription saved');
  } catch(e) {
    console.warn('[habits] could not save subscription:', e.message);
  }
}

// urlBase64ToUint8Array — needed to convert VAPID key for pushManager.subscribe
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// habitSaveNotifTime — now just persists preference; actual scheduling done server-side
function habitScheduleNotification() {
  console.log('[habits] scheduling done server-side via notification-worker.js');
}

// ─── Notificaciones de agua (Settings → Hábitos) ───
// Estado guardado en Supabase (water_notif_state, misma fila id=1 que usa
// el worker para el intervalo adaptativo), así el notification-worker
// (proceso separado, corre 24/7) puede leer la preferencia sin depender del browser.

async function loadWaterNotifSetting() {
  const el = document.getElementById('waterNotifToggle');
  if (!el) return;
  try {
    const { enabled } = await fetch('/api/water/notif-settings').then(r => r.json());
    el.classList.toggle('on', enabled !== false);
  } catch (e) {
    console.warn('[water] no se pudo cargar el estado de notificaciones:', e.message);
  }
}

async function toggleWaterNotif() {
  const el = document.getElementById('waterNotifToggle');
  if (!el) return;
  const nextEnabled = !el.classList.contains('on');
  el.classList.toggle('on', nextEnabled); // optimistic UI

  try {
    const res = await fetch('/api/water/notif-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    if (!res.ok) throw new Error('save failed');
  } catch (e) {
    el.classList.toggle('on', !nextEnabled); // revert on failure
    console.warn('[water] no se pudo guardar la preferencia:', e.message);
  }
}

// ── BOOT ───────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initHabits);
