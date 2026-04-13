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
  let   consecutiveYes = state?.consecutive_yes  || 0;
  let   consecutiveNo  = state?.consecutive_no   || 0;
  const lastResetDate  = state?.last_reset_date  || '';

  // Reset consecutive counters at midnight — so yesterday's streak doesn't
  // carry over and distort the interval at the start of a new day
  if (lastResetDate !== today) {
    consecutiveYes = 0;
    consecutiveNo  = 0;
    await updateWaterNotifState({
      consecutive_yes: 0,
      consecutive_no:  0,
      interval_minutes: WATER_BASE_INTERVAL_MIN,
      last_reset_date: today,
    });
    console.log('[worker] water: consecutive counters reset for new day');
  }

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
    title:   'Agua 💧',
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


// ── BRIEFING DIARIO — cierre NYSE ─────────────────────────────────────────────
// NYSE cierra a las 16:00 ET. ET usa DST propio (cambia en mar y nov).
// Calculamos el offset ET↔UTC dinámicamente en cada tick para que el horario
// sea siempre correcto sin importar si es verano/invierno en UK o en EEUU.
// El briefing se manda 5 minutos después del cierre, lunes a viernes.

function getNYSECloseUTC() {
  // Computa a qué minuto UTC corresponde las 16:00 ET de hoy.
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const etH = parseInt(etParts.find(p => p.type === 'hour').value, 10);
  const etM = parseInt(etParts.find(p => p.type === 'minute').value, 10);
  const etMinutes  = etH * 60 + etM;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // offset = UTC - ET (e.g. 300 en invierno, 240 en verano)
  const offsetMin = ((utcMinutes - etMinutes) + 1440) % 1440;
  // NYSE cierra a las 16:00 ET → 16*60 + offset UTC
  return (16 * 60 + offsetMin) % 1440;
}

const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY  || '';
const SERVER_INTERNAL_URL  = process.env.SERVER_INTERNAL_URL || 'http://localhost:3000';

async function generateAndSendBriefing() {
  if (!ANTHROPIC_KEY) {
    console.warn('[briefing] ANTHROPIC_API_KEY not set, skipping');
    return;
  }
  console.log('[briefing] generating daily briefing...');

  // Obtener el prompt completo desde el server principal
  let systemPrompt = '';
  try {
    const ctxRes = await fetch(SERVER_INTERNAL_URL + '/api/briefing-context');
    if (ctxRes.ok) {
      const d = await ctxRes.json();
      systemPrompt = d.systemPrompt || '';
      console.log('[briefing] context loaded, prompt length:', systemPrompt.length);
    } else {
      console.warn('[briefing] briefing-context fetch failed:', ctxRes.status);
    }
  } catch (e) {
    console.warn('[briefing] briefing-context fetch error:', e.message);
  }

  if (!systemPrompt) {
    console.warn('[briefing] empty system prompt, aborting');
    return;
  }

  let briefingText = '';
  try {
    const https    = require('https');
    const bodyStr  = JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1200,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: 'Genera el briefing del dia.' }],
    });

    briefingText = await new Promise(function(resolve, reject) {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':        'application/json',
          'Content-Length':      Buffer.byteLength(bodyStr),
          'x-api-key':           ANTHROPIC_KEY,
          'anthropic-version':   '2023-06-01',
        },
      }, function(res) {
        let data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() {
          try {
            const parsed = JSON.parse(data);
            const text = (parsed.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
            resolve(text);
          } catch (err) { reject(err); }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, function() { req.destroy(); reject(new Error('Timeout 30s')); });
      req.write(bodyStr);
      req.end();
    });
  } catch (e) {
    console.error('[briefing] Claude API error:', e.message);
    briefingText = 'Briefing no disponible: ' + e.message.slice(0, 60);
  }

  if (!briefingText) return;

  // Guardar en daily_briefings (upsert por fecha — reemplaza si ya existe del día)
  const todayDate = new Date().toISOString().slice(0, 10);
  try {
    await fetch(SUPABASE_URL + '/rest/v1/daily_briefings', {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify({ date: todayDate, content: briefingText, prompt: systemPrompt }),
    });
    console.log('[briefing] saved to DB for', todayDate);
  } catch (e) {
    console.warn('[briefing] DB save failed:', e.message);
  }

  const shortBody = briefingText.slice(0, 110) + (briefingText.length > 110 ? '\u2026' : '');

  await sendPushToAll({
    type:    'DAILY_BRIEFING',
    title:   '📊 Briefing financiero del día',
    body:    shortBody,
    tag:     'daily-briefing',
    data:    { fullText: briefingText, date: todayDate },
    actions: [{ action: 'open', title: 'Ver análisis' }],
  });

  console.log('[briefing] sent, chars:', briefingText.length);
}

// ── Test server — para disparar el briefing sin esperar al cierre NYSE ────────
// Uso: curl -X POST http://localhost:3001/test-briefing
(function startTestServer() {
  const http = require('http');
  const port = parseInt(process.env.WORKER_TEST_PORT || '3001', 10);
  const srv  = http.createServer(function(req, res) {
    if (req.method === 'POST' && req.url === '/test-briefing') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      generateAndSendBriefing().catch(function(e) {
        console.error('[briefing-test] error:', e.message);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  srv.listen(port, function() {
    console.log('[briefing-test] test server on :' + port + ' — POST /test-briefing to trigger');
  });
  srv.on('error', function(e) {
    console.warn('[briefing-test] server error:', e.message);
  });
})();


// ── Main loop ─────────────────────────────────────────────────────────────────
// Runs every minute, checks if any notification should fire.

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

let habitNotifSentToday = '';  // date string, reset each day

let briefingSentToday = '';

async function tick() {
  const today = todayStr();
  const now   = nowHHMM();

  // Reset daily flags at midnight
  if (habitNotifSentToday !== today) {
    habitNotifSentToday = '';
  }
  if (briefingSentToday !== today) {
    briefingSentToday = '';
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

  // Daily briefing — 5 min after NYSE close (Mon–Fri only)
  // NYSE closes at 16:00 ET. We compute the UTC equivalent dynamically.
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && briefingSentToday !== today) {
    const nyseCloseUTC = getNYSECloseUTC(); // minutes from midnight UTC
    const briefingTime = (nyseCloseUTC + 5) % 1440; // +5 min
    if (now >= briefingTime && now < briefingTime + 2) { // 2-min window
      briefingSentToday = today;
      await generateAndSendBriefing();
    }
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
