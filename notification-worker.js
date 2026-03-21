// notification-worker.js
// ─────────────────────────────────────────────────────────────────────────────
// Proceso independiente que corre junto a server.js en Railway.
// Maneja dos tipos de notificaciones:
//   1. Hábitos diarios  — una vez a las 22:30, solo si no completaste todo
//   2. Agua             — cada ~90 min entre 09:40 y 22:40, con lógica adaptativa
//
// Variables de entorno necesarias (agregar en Railway):
//   SUPABASE_URL, SUPABASE_SECRET_KEY  (ya las tenés)
//   VAPID_PUBLIC_KEY                   (generá con: node -e "require('web-push').generateVAPIDKeys()")
//   VAPID_PRIVATE_KEY                  (ídem)
//   VAPID_CONTACT                      (mailto:tu@email.com)
//
// Para correrlo en Railway como proceso paralelo, en package.json:
//   "scripts": {
//     "start": "node server.js",
//     "start:worker": "node notification-worker.js"
//   }
// Y en Railway, agrega un segundo service que corra: node notification-worker.js
// ─────────────────────────────────────────────────────────────────────────────

const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL        || '';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';

// ── VAPID setup ───────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  process.env.VAPID_CONTACT    || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Accept':        'application/json',
    },
  });
  if (!res.ok) throw new Error(`sbGet ${path}: ${res.status}`);
  return res.json();
}

async function sbPost(path, body, prefer = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      ...(prefer ? { 'Prefer': prefer } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`sbPost ${path}: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function nowHHMM() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes(); // minutes since midnight
}

function hhmm(h, m) { return h * 60 + m; }

// ── Push sender ───────────────────────────────────────────────────────────────
async function sendPushToAll(payload) {
  let subs;
  try {
    subs = await sbGet('push_subscriptions?select=*');
  } catch (e) {
    console.error('[worker] fetch subs failed:', e.message);
    return;
  }
  if (!Array.isArray(subs) || subs.length === 0) {
    console.log('[worker] no subscriptions registered');
    return;
  }

  const payloadStr = JSON.stringify(payload);
  let sent = 0, failed = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payloadStr
      );
      sent++;
    } catch (e) {
      failed++;
      // 410 = subscription expired/unsubscribed — remove it
      if (e.statusCode === 410) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
            method: 'DELETE',
            headers: {
              'apikey':        SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
          });
          console.log('[worker] removed expired sub:', sub.endpoint.slice(-20));
        } catch (_) {}
      } else {
        console.warn('[worker] push failed:', e.message);
      }
    }
  }
  console.log(`[worker] push sent=${sent} failed=${failed} payload=${payload.type}`);
}

// ── HÁBITOS — lógica inteligente ──────────────────────────────────────────────
// Manda notif a las 22:30 solo si no completaste TODOS los hábitos del día.
// "Completado" = trained, piano, deepwork, food, water todos true/>=objetivo.

const HABIT_NOTIF_HOUR   = 22;
const HABIT_NOTIF_MINUTE = 30;

async function checkAndSendHabitNotif() {
  const today = todayStr();
  let log;
  try {
    const rows = await sbGet(`habit_daily_logs?log_date=eq.${today}&limit=1`);
    log = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (e) {
    console.error('[worker] habit log fetch failed:', e.message);
    return;
  }

  // Water: fetch today's total
  let waterMl = 0;
  try {
    const wrows = await sbGet(`water_logs?log_date=eq.${today}&select=amount_ml`);
    if (Array.isArray(wrows)) {
      waterMl = wrows.reduce((s, r) => s + (r.amount_ml || 0), 0);
    }
  } catch (_) {}

  const trainedDone  = log?.trained  === true;
  const pianoDone    = log?.piano    === true;
  const deepworkDone = log?.deepwork === true;
  const foodDone     = log?.food     !== null && log?.food !== undefined;

  // Water goal: 2500ml if trained today, 2000ml otherwise
  const waterGoal = trainedDone ? 2500 : 2000;
  const waterDone = waterMl >= waterGoal;

  const allDone = trainedDone && pianoDone && deepworkDone && foodDone && waterDone;

  if (allDone) {
    console.log('[worker] all habits done, skipping habit notif');
    return;
  }

  // Build a useful body listing what's pending
  const pending = [];
  if (!trainedDone)  pending.push('entrenamiento');
  if (!pianoDone)    pending.push('piano');
  if (!deepworkDone) pending.push('deep work');
  if (!foodDone)     pending.push('comida');
  if (!waterDone)    pending.push(`agua (${Math.round(waterMl / 1000 * 10) / 10}L / ${waterGoal / 1000}L)`);

  await sendPushToAll({
    type:    'HABITS_REMINDER',
    title:   'Personal Hub',
    body:    `Te falta: ${pending.join(', ')}`,
    tag:     'habits-daily',
    actions: [{ action: 'open', title: 'Ver hábitos' }],
  });
}

// ── AGUA — lógica adaptativa ──────────────────────────────────────────────────
// Horario base: cada 90 min entre 09:40 y 22:40
// Reglas de adaptación:
//   - Si ya cumpliste el objetivo del día → no más notifs
//   - Si en las últimas 2 notifs dijiste "no tomé" → acorta a 60 min
//   - Si en las últimas 3 dijiste "sí tomé" consecutivas → alarga a 120 min

const WATER_START  = hhmm(9, 40);
const WATER_END    = hhmm(22, 40);
const WATER_BASE_INTERVAL_MIN = 90;

// State persisted in Supabase (water_notif_state table)
// For simplicity we use a single-row table with columns:
//   last_sent_at timestamptz, interval_minutes int, consecutive_yes int, consecutive_no int

async function getWaterNotifState() {
  try {
    const rows = await sbGet('water_notif_state?limit=1');
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (_) { return null; }
}

async function updateWaterNotifState(patch) {
  try {
    // Use upsert — there's always exactly one row (id=1)
    await sbPost('water_notif_state', { id: 1, ...patch }, 'resolution=merge-duplicates');
  } catch (e) {
    console.warn('[worker] water state update failed:', e.message);
  }
}

async function checkAndSendWaterNotif() {
  const now    = nowHHMM();
  const today  = todayStr();

  // Outside window — do nothing
  if (now < WATER_START || now > WATER_END) return;

  // Fetch today's total water
  let waterMl = 0;
  let trainedToday = false;
  try {
    const wrows = await sbGet(`water_logs?log_date=eq.${today}&select=amount_ml`);
    if (Array.isArray(wrows)) waterMl = wrows.reduce((s, r) => s + (r.amount_ml || 0), 0);
    const hrows = await sbGet(`habit_daily_logs?log_date=eq.${today}&select=trained&limit=1`);
    if (Array.isArray(hrows) && hrows.length > 0) trainedToday = hrows[0].trained === true;
  } catch (_) {}

  const waterGoal = trainedToday ? 2500 : 2000;

  // Already hit goal — no more water notifs today
  if (waterMl >= waterGoal) {
    console.log(`[worker] water goal reached (${waterMl}ml), skipping`);
    return;
  }

  // Get notif state
  const state = await getWaterNotifState();
  const lastSentAt     = state?.last_sent_at ? new Date(state.last_sent_at) : null;
  const intervalMin    = state?.interval_minutes || WATER_BASE_INTERVAL_MIN;
  const consecutiveYes = state?.consecutive_yes  || 0;
  const consecutiveNo  = state?.consecutive_no   || 0;

  // Check if enough time has passed since last notification
  if (lastSentAt) {
    const msSinceLast = Date.now() - lastSentAt.getTime();
    const minSinceLast = msSinceLast / 60000;
    if (minSinceLast < intervalMin) {
      console.log(`[worker] water: ${Math.round(minSinceLast)}min since last, need ${intervalMin}min`);
      return;
    }
  }

  // Calculate next interval based on behavior
  let nextInterval = WATER_BASE_INTERVAL_MIN;
  if (consecutiveNo >= 2)  nextInterval = 60;   // faltan 2 seguidas → más frecuente
  if (consecutiveYes >= 3) nextInterval = 120;  // cumplió 3 seguidas → más espaciado

  // Remaining water
  const remaining = waterGoal - waterMl;
  const remainingL = (remaining / 1000).toFixed(1);

  // Smart body text
  const takenL = (waterMl / 1000).toFixed(1);
  const body = `Tomaste ${takenL}L de ${waterGoal / 1000}L. ¿Tomaste agua en la última hora?`;

  await sendPushToAll({
    type:    'WATER_CHECK',
    title:   'Personal Hub · Agua 💧',
    body,
    tag:     'water-reminder',
    actions: [
      { action: 'water_yes', title: '✓ Sí tomé (500ml)' },
      { action: 'water_no',  title: '✗ No tomé' },
    ],
    data: { waterMl, waterGoal },
  });

  // Update state
  await updateWaterNotifState({
    last_sent_at:    new Date().toISOString(),
    interval_minutes: nextInterval,
    consecutive_yes: consecutiveYes, // updated when user responds, not here
    consecutive_no:  consecutiveNo,
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────
// Runs every minute, checks if any notification should fire.

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

let habitNotifSentToday = '';  // date string, reset each day

async function tick() {
  const today = todayStr();
  const now   = nowHHMM();

  // Reset daily habit notif flag at midnight
  if (habitNotifSentToday !== today) {
    habitNotifSentToday = '';
  }

  // Habit notif — once at 22:30
  if (
    now >= hhmm(HABIT_NOTIF_HOUR, HABIT_NOTIF_MINUTE) &&
    now <  hhmm(HABIT_NOTIF_HOUR, HABIT_NOTIF_MINUTE + 2) && // 2-min window
    habitNotifSentToday !== today
  ) {
    habitNotifSentToday = today;
    await checkAndSendHabitNotif();
  }

  // Water notif — check every tick, sendWater() decides internally
  await checkAndSendWaterNotif();
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[worker] SUPABASE_URL or SUPABASE_SECRET_KEY not set, exiting');
    process.exit(1);
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.error('[worker] VAPID keys not set — generate with: node -e "require(\'web-push\').generateVAPIDKeys()"');
    process.exit(1);
  }

  console.log('[worker] started — checking every 60s');
  await tick(); // run immediately on start
  setInterval(tick, CHECK_INTERVAL_MS);
}

main().catch(e => {
  console.error('[worker] fatal:', e);
  process.exit(1);
});
