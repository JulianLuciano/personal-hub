// ── HABITS MODULE ──────────────────────────────────────────────────────────────
// Responsabilidad: tab Hábitos completo — checks diarios, one-shots, año, config
// Para iterar: pasá solo habits.js + DOCS.md
//
// Estado actual: datos MOCK — para conectar a DB, reemplazar las funciones
// loadDailyFromDB(), saveDailyToDB(), loadOneshotsFromDB(), saveOneshotsToDB()
// con calls a sbFetch() (definida en core.js).
// ──────────────────────────────────────────────────────────────────────────────

// ── CONFIG ─────────────────────────────────────────────────────────────────────

const HABITS_BODY = [
  { id: 'trained',  icon: '🏋️', name: 'Entrenaste hoy',      color: 'rgba(108,99,255,0.15)', streak: 3 },
  { id: 'piano',    icon: '🎹', name: 'Practicaste piano',    color: 'rgba(79,195,247,0.15)',  streak: 0 },
];

const HABITS_WORK = [
  { id: 'deepwork', icon: '🧠', name: 'Deep work 60 min',    color: 'rgba(67,233,123,0.15)',  streak: 5 },
];

// Todos los hábitos para el progress ring (food se agrega manualmente)
const ALL_HABIT_IDS = ['trained', 'piano', 'deepwork', 'food'];

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
  { id: 'deepwork',      icon: '🧠', name: 'Días con deep work',     target: '≥70% días laborables',   current: 18, goal: 40,  unit: 'días' },
  { id: 'groupplans',    icon: '👥', name: 'Planes grupales',        target: '≥1 por mes',             current: 2,  goal: 12,  unit: ''     },
  { id: 'presentations', icon: '🎤', name: 'Presentaciones',         target: '≥6 en el año',           current: 1,  goal: 6,   unit: ''     },
  { id: 'trips',         icon: '✈️', name: 'Viajes',                 target: '3 este año',             current: 0,  goal: 3,   unit: ''     },
];

// Semana actual del año (se actualiza en init)
let CURRENT_WEEK = 10;

// ── STATE ──────────────────────────────────────────────────────────────────────

let habitDayOffset   = 0;          // 0 = hoy, -1 = ayer
let habitDayState    = {};         // { trained, piano, deepwork, food, foodBad[], foodIssue }
let habitOneshotState = {};        // { presentations: 1, pianoLessons: 3, ... }
let habitNotifState  = { daily: true, weight: true };
let habitSaveTimeout = null;       // debounce timer para auto-save

// ── MOCK DATA (reemplazar con sbFetch cuando haya DB) ──────────────────────────

const MOCK_DAILY = {
  0:   { trained: false, piano: false, deepwork: false, food: null, foodBad: [], foodIssue: null },
  '-1':{ trained: true,  piano: false, deepwork: true,  food: false, foodBad: ['dinner'], foodIssue: 'quality' },
};

const MOCK_ONESHOTS = {
  presentations: 1, feedbacks: 0, recordings: 0,
  pianoLessons: 3, trips: 0, devTalks: 1,
  pscReviews: 0, groupPlans: 2, dates2nd: 1,
};

// ── DB INTEGRATION STUBS ───────────────────────────────────────────────────────
// Cuando tengas las tablas en Supabase, reemplazá estas funciones.
// sbFetch está definida en core.js.

async function loadDailyFromDB(dateStr) {
  // TODO: return await sbFetch(`habit_daily_logs?log_date=eq.${dateStr}&limit=1`).then(r => r[0] || null);
  const offset = habitDayOffset;
  return MOCK_DAILY[String(offset)] || null;
}

async function saveDailyToDB(dateStr, state) {
  // TODO:
  // return await fetch('/api/habits/daily', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ log_date: dateStr, ...state })
  // });
  console.log('[habits] save daily mock:', dateStr, state);
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

function habitDateStr(offset) {
  // YYYY-MM-DD para la DB
  const d = habitGetDate(offset);
  return d.toISOString().slice(0, 10);
}

function habitWeekOfYear() {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
}

// ── INIT ───────────────────────────────────────────────────────────────────────

async function initHabits() {
  CURRENT_WEEK = habitWeekOfYear();
  habitOneshotState = await loadOneshotsFromDB();
  habitUpdateDateUI();
  await habitLoadDay();
  habitRenderOneshots();
  habitRenderYear();
  habitRenderConfig();
  habitInitNotifications();
}

// ── DATE NAV ───────────────────────────────────────────────────────────────────

function habitUpdateDateUI() {
  const d = habitGetDate(habitDayOffset);
  const topDate = document.getElementById('habitsTopbarDate');
  if (topDate) topDate.textContent = habitFormatDate(d);

  const pill   = document.getElementById('habitDayPill');
  const banner = document.getElementById('habitPastBanner');
  const nextBtn = document.getElementById('habitNextDayBtn');
  const prevBtn = document.getElementById('habitPrevDayBtn');

  if (!pill) return;

  if (habitDayOffset === 0) {
    pill.textContent = 'Hoy';
    pill.classList.remove('past');
    if (banner)  banner.style.display = 'none';
    if (nextBtn) nextBtn.classList.add('disabled');
  } else {
    pill.textContent = d.getDate() + ' ' + H_MONTHS[d.getMonth()];
    pill.classList.add('past');
    if (banner)  banner.style.display = 'flex';
    if (nextBtn) nextBtn.classList.remove('disabled');
  }

  if (prevBtn) prevBtn.classList.toggle('disabled', habitDayOffset <= -1);
}

function habitShiftDay(delta) {
  const next = habitDayOffset + delta;
  if (next > 0 || next < -1) return;   // máximo 1 día atrás
  habitDayOffset = next;
  habitUpdateDateUI();
  habitLoadDay();
}

// ── DAILY STATE ────────────────────────────────────────────────────────────────

async function habitLoadDay() {
  const dateStr = habitDateStr(habitDayOffset);
  const data    = await loadDailyFromDB(dateStr);
  habitDayState = data ? { ...data } : {};
  habitRenderHabits();
  habitRenderFood();
}

function habitScheduleSave() {
  // Debounce: espera 1.5s sin cambios antes de guardar
  clearTimeout(habitSaveTimeout);
  habitSaveTimeout = setTimeout(() => {
    saveDailyToDB(habitDateStr(habitDayOffset), habitDayState);
  }, 1500);
}

// ── RENDER: HABITS ─────────────────────────────────────────────────────────────

function habitRenderHabits() {
  habitRenderGroup('habitListBody', HABITS_BODY);
  habitRenderGroup('habitListWork', HABITS_WORK);
}

function habitRenderGroup(containerId, habits) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = habits.map(h => {
    const done = !!habitDayState[h.id];
    return `
      <div class="habit-item ${done ? 'done' : ''}" onclick="habitToggle('${h.id}', this)">
        <div class="habit-icon" style="background:${h.color}">${h.icon}</div>
        <div class="habit-info">
          <div class="habit-name">${h.name}</div>
          <div class="habit-streak">${h.streak > 0 ? '🔥 ' + h.streak + ' días seguidos' : 'Sin racha activa'}</div>
        </div>
        <div class="habit-check">${done ? '✓' : ''}</div>
      </div>`;
  }).join('');
}

function habitToggle(id, el) {
  el.classList.add('just-done');
  setTimeout(() => el.classList.remove('just-done'), 180);
  habitDayState[id] = !habitDayState[id];
  const done = habitDayState[id];
  el.classList.toggle('done', done);
  el.querySelector('.habit-check').textContent = done ? '✓' : '';
  habitScheduleSave();
}

// ── RENDER: FOOD ───────────────────────────────────────────────────────────────
// food: null = sin marcar, true = comí bien, false = comí mal
// foodBad: [] multiselect de comidas (breakfast/lunch/dinner/other)
// foodIssue: null | 'quantity' | 'quality' | 'both'

const FOOD_MEALS = [
  { id: 'breakfast', label: 'Desayuno' },
  { id: 'lunch',     label: 'Almuerzo' },
  { id: 'dinner',    label: 'Cena'     },
  { id: 'other',     label: 'Otros'    },
];

function habitRenderFood() {
  const block  = document.getElementById('habitFoodBlock');
  if (!block) return;
  const food   = habitDayState.food;   // null | true | false
  const bad    = habitDayState.foodBad   || [];
  const issue  = habitDayState.foodIssue || null;

  // Option buttons state
  ['opt-good','opt-bad'].forEach(id => {
    const el = document.getElementById('h-food-' + id);
    if (el) el.classList.remove('selected');
  });
  if (food === true)  { const el = document.getElementById('h-food-opt-good'); if(el) el.classList.add('selected'); }
  if (food === false) { const el = document.getElementById('h-food-opt-bad');  if(el) el.classList.add('selected'); }

  // Dropdown visibility
  const drop = document.getElementById('habitFoodDrop');
  if (drop) drop.classList.toggle('open', food === false);

  // Meal chips
  FOOD_MEALS.forEach(m => {
    const chip = document.getElementById('h-meal-' + m.id);
    if (chip) chip.classList.toggle('selected', bad.includes(m.id));
  });

  // Issue buttons
  ['quantity','quality','both'].forEach(v => {
    const el = document.getElementById('h-issue-' + v);
    if (el) el.classList.toggle('selected', issue === v);
  });
}

function habitSelectFood(val) {
  // val: true = bien, false = mal — toggle si ya estaba seleccionado
  if (habitDayState.food === val) {
    habitDayState.food = null;
  } else {
    habitDayState.food = val;
    if (val === true) {
      habitDayState.foodBad   = [];
      habitDayState.foodIssue = null;
    }
  }
  habitRenderFood();
  habitScheduleSave();
}

function habitToggleMeal(mealId) {
  if (!habitDayState.foodBad) habitDayState.foodBad = [];
  const idx = habitDayState.foodBad.indexOf(mealId);
  if (idx === -1) habitDayState.foodBad.push(mealId);
  else            habitDayState.foodBad.splice(idx, 1);
  habitRenderFood();
  habitScheduleSave();
}

function habitSelectIssue(val) {
  habitDayState.foodIssue = habitDayState.foodIssue === val ? null : val;
  habitRenderFood();
  habitScheduleSave();
}

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
  const list = document.getElementById('habitConfigList');
  if (!list) return;

  const allHabits = [
    ...HABITS_BODY,
    ...HABITS_WORK,
    { id: 'food', icon: '🥗', name: 'Comí bien', color: 'rgba(247,183,49,0.15)' },
  ];

  list.innerHTML = allHabits.map(h => `
    <div class="h-config-row">
      <div class="habit-icon" style="background:${h.color || 'rgba(108,99,255,0.12)'};flex-shrink:0">${h.icon}</div>
      <div class="h-config-label">${h.name}</div>
      <div class="toggle on"><div class="toggle-knob"></div></div>
    </div>`).join('');
}

function habitToggleNotif(key) {
  habitNotifState[key] = !habitNotifState[key];
  const el = document.getElementById('h-tgl-' + key);
  if (el) el.classList.toggle('on', habitNotifState[key]);
}

// ── SUB-TAB SWITCH ─────────────────────────────────────────────────────────────

function habitSwitchSubTab(id, el) {
  document.querySelectorAll('.h-sub-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.h-panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('h-panel-' + id);
  if (target) target.classList.add('active');
}


// ── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────────
// Solicita permiso y registra un Service Worker que programa la alarma diaria.
// La hora por defecto es 22:30 — configurable desde el tab Config.

const HABIT_NOTIF_DEFAULT_HOUR   = 22;
const HABIT_NOTIF_DEFAULT_MINUTE = 30;

async function habitInitNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;

  // Registrar SW si no está registrado
  try {
    await navigator.serviceWorker.register('/sw-habits.js');
  } catch(e) {
    console.warn('[habits] SW register failed:', e.message);
    return;
  }

  // Pedir permiso solo si es 'default' (no volver a pedir si ya denegó)
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission !== 'granted') return;

  habitScheduleNotification();
}

function habitScheduleNotification() {
  const timeInput = document.getElementById('habitNotifTimeDaily');
  let hour   = HABIT_NOTIF_DEFAULT_HOUR;
  let minute = HABIT_NOTIF_DEFAULT_MINUTE;

  if (timeInput && timeInput.value) {
    const parts = timeInput.value.split(':');
    hour   = parseInt(parts[0], 10);
    minute = parseInt(parts[1], 10);
  }

  // Calcular ms hasta la próxima alarma
  const now    = new Date();
  const target = new Date();
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1); // si ya pasó, mañana

  const msUntil = target - now;

  // Enviar la hora al SW para que maneje el scheduling persistente
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type:   'SCHEDULE_HABIT_NOTIF',
      hour,
      minute,
      msUntil,
    });
  }

  console.log(`[habits] notif programada para ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} (en ${Math.round(msUntil/60000)} min)`);
}

// ── BOOT ───────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initHabits);
