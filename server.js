'use strict';

const express = require('express');
const path    = require('path');
const { recalculatePositions } = require('./recalculator');

const { SUPABASE_URL, SUPABASE_KEY, isConfigured, headers, sb } = require('./lib/supabase-server');
const marketRouter = require('./routes/market-server');
const aiRouter     = require('./routes/ai-server');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    anthropicKey:      process.env.ANTHROPIC_API_KEY || '',
    aiProfileName:     process.env.AI_PROFILE_NAME       || '',
    aiMonthlyExpenses: process.env.AI_MONTHLY_EXPENSES   || '',
    aiSavingsRange:    process.env.AI_SAVINGS_RANGE       || '',
    aiBonusRange:      process.env.AI_BONUS_RANGE         || '',
    aiRsuRange:        process.env.AI_RSU_RANGE           || '',
    aiEmergencyFund:   process.env.AI_EMERGENCY_FUND      || '',
    aiGoals:           process.env.AI_GOALS               || '',
    aiSalaryRange:     process.env.AI_SALARY_RANGE        || '',
    aiAnnualInvestable: process.env.AI_ANNUAL_INVESTABLE  || '',
    mcMonthlySaving:   process.env.MC_MONTHLY_SAVING      || '',
    mcAnnualBonus:     process.env.MC_ANNUAL_BONUS        || '',
    mcRsuPerVest:      process.env.MC_RSU_PER_VEST        || '',
  });
});

// ── Supabase generic proxy ────────────────────────────────────────────────────

app.all('/api/db/*', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  const subPath = req.params[0];
  const qs      = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const supaUrl = `${SUPABASE_URL}/rest/v1/${subPath}${qs}`;

  try {
    const sbRes = await fetch(supaUrl, {
      method: req.method,
      headers: headers({ 'Content-Type': 'application/json' }),
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });
    const text = await sbRes.text();
    res.status(sbRes.status).send(text);
  } catch (e) {
    console.error('[db-proxy] fetch error:', e.message);
    res.status(502).json({ error: 'Supabase unreachable' });
  }
});

// ── Chart with server-side downsampling ───────────────────────────────────────
// Sampling strategy (keep last row per bucket):
//   1S → 1 pt/hour (~168 pts)   1M → 1 pt/4h (~180 pts)   3M → 2 pts/day (~180 pts)
//   6M → 1 pt/day (~180 pts)    1A → 1 pt/day (~365 pts)

app.get('/api/chart/:period', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  const period     = req.params.period;
  const periodDays = { '1S': 7, '1M': 30, '3M': 90, '6M': 180, '1A': 365 };
  const days       = periodDays[period];
  if (!days) return res.status(400).json({ error: 'Invalid period' });

  const since      = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const FETCH_LIMIT = 50000;
  const supaUrl    = `${SUPABASE_URL}/rest/v1/portfolio_snapshots?select=captured_at,total_usd,total_gbp,fx_rate,breakdown&order=captured_at.asc&captured_at=gte.${since}&limit=${FETCH_LIMIT}`;

  try {
    const sbRes = await fetch(supaUrl, { headers: headers() });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      console.error('[chart] supabase error:', err.slice(0, 300));
      return res.status(sbRes.status).json({ error: err.slice(0, 200) });
    }

    const rows = await sbRes.json();

    function getBucket(isoStr) {
      const h = new Date(isoStr).getUTCHours();
      if (period === '1S') return isoStr.slice(0, 13);
      if (period === '1M') { const block = Math.floor(h / 4) * 4; return `${isoStr.slice(0, 10)}T${String(block).padStart(2, '0')}`; }
      if (period === '3M') { const shiftedH = (h - 9 + 24) % 24; const anchor = shiftedH < 12 ? 9 : 21; return `${isoStr.slice(0, 10)}T${String(anchor).padStart(2, '0')}`; }
      return isoStr.slice(0, 10);
    }

    const bucketMap = new Map();
    for (const row of rows) bucketMap.set(getBucket(row.captured_at), row);

    const sampled = Array.from(bucketMap.values()).sort((a, b) => a.captured_at < b.captured_at ? -1 : 1);
    console.log(`[chart] period=${period} raw=${rows.length} sampled=${sampled.length}`);
    res.json(sampled);

  } catch (e) {
    console.error('[chart] fetch error:', e.message);
    res.status(502).json({ error: 'Supabase unreachable' });
  }
});

// ── Positions ─────────────────────────────────────────────────────────────────

app.post('/api/recalculate-positions', async (req, res) => {
  try {
    const result = await recalculatePositions();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[recalculate-positions] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/positions/manual', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  const { ticker, qty, avg_cost_usd, notes } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker requerido' });

  const updates = { updated_at: new Date().toISOString() };
  if (qty          !== undefined) updates.qty          = qty;
  if (avg_cost_usd !== undefined) {
    updates.avg_cost_usd   = avg_cost_usd;
    updates.fx_gbp_usd_avg = avg_cost_usd;
  }
  if (notes !== undefined) updates.notes = notes;
  if (updates.qty !== undefined && updates.avg_cost_usd !== undefined) {
    updates.initial_investment_usd = Math.round(updates.qty * updates.avg_cost_usd * 100) / 100;
    updates.initial_investment_gbp = updates.qty;
  }

  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/positions?ticker=eq.${encodeURIComponent(ticker)}&managed_by=eq.manual`;
    const sbRes = await fetch(supaUrl, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(updates),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    res.json({ ok: true, data: await sbRes.json() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Habits ────────────────────────────────────────────────────────────────────

app.get('/api/habits/daily/:date', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const data = await sb(`habit_daily_logs?log_date=eq.${date}&limit=1`);
    if (!Array.isArray(data) || data.length === 0) return res.status(204).end();
    res.json(data[0]);
  } catch (e) {
    console.error('[habits/daily GET]', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/habits/daily', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { log_date, trained, piano, deepwork, food, food_note } = req.body || {};
  if (!log_date) return res.status(400).json({ error: 'log_date requerido' });
  const payload = { log_date, trained: trained ?? null, piano: piano ?? null,
    deepwork: deepwork ?? null, food: food ?? null, food_note: food_note ?? null,
    updated_at: new Date().toISOString() };
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_daily_logs`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(payload),
    });
    const text = await sbRes.text();
    if (!sbRes.ok) { console.error('[habits/daily POST] supabase error:', text.slice(0, 300)); return res.status(sbRes.status).json({ error: text }); }
    res.json({ ok: true });
  } catch (e) {
    console.error('[habits/daily POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/habits/oneshots', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const data = await sb(`habit_oneshots?year=eq.${new Date().getFullYear()}&limit=1`);
    if (!Array.isArray(data) || data.length === 0) return res.status(204).end();
    res.json(data[0]);
  } catch (e) {
    console.error('[habits/oneshots GET]', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/habits/oneshots', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const year = req.body?.year ?? new Date().getFullYear();
  const allowed = ['presentations','feedbacks','recordings','piano_lessons','trips','dev_talks','psc_reviews','group_plans','dates_2nd'];
  const payload = { year, updated_at: new Date().toISOString() };
  allowed.forEach(k => {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (req.body[k]     !== undefined) payload[k] = req.body[k];
    if (req.body[camel] !== undefined) payload[k] = req.body[camel];
  });
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_oneshots`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(payload),
    });
    const text = await sbRes.text();
    if (!sbRes.ok) { console.error('[habits/oneshots POST] supabase error:', text.slice(0, 300)); return res.status(sbRes.status).json({ error: text }); }
    res.json({ ok: true });
  } catch (e) {
    console.error('[habits/oneshots POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/habits/weight', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { weight_kg, recorded_date } = req.body || {};
  if (!weight_kg || isNaN(parseFloat(weight_kg))) return res.status(400).json({ error: 'weight_kg requerido' });
  const payload = {
    weight_kg:     parseFloat(weight_kg),
    recorded_date: recorded_date || new Date().toISOString().slice(0, 10),
    created_at:    new Date().toISOString(),
  };
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/habit_weight_logs`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload),
    });
    const text = await sbRes.text();
    if (!sbRes.ok) { console.error('[habits/weight POST] supabase error:', text.slice(0, 300)); return res.status(sbRes.status).json({ error: text }); }
    res.json({ ok: true });
  } catch (e) {
    console.error('[habits/weight POST]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Push notifications ────────────────────────────────────────────────────────

const webpush = require('web-push');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

app.get('/api/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || '';
  if (!key) return res.status(500).json({ error: 'VAPID not configured' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'endpoint y keys requeridos' });
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/push_subscriptions`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth, updated_at: new Date().toISOString() }),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Water ─────────────────────────────────────────────────────────────────────

app.get('/api/water/today', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const today = new Date().toISOString().slice(0, 10);
  try {
    const rows = await sb(`water_logs?log_date=eq.${today}&select=amount_ml`);
    const total = Array.isArray(rows) ? rows.reduce((s, r) => s + (r.amount_ml || 0), 0) : 0;
    res.json({ total_ml: total, date: today });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/water/log', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { amount_ml, source = 'manual', response } = req.body || {};
  const amountInt = parseInt(amount_ml);
  if (amount_ml === undefined || amount_ml === null || isNaN(amountInt) || amountInt === 0) {
    return res.status(400).json({ error: 'amount_ml requerido (puede ser negativo)' });
  }
  const today = new Date().toISOString().slice(0, 10);
  try {
    const supaUrl = `${SUPABASE_URL}/rest/v1/water_logs`;
    const sbRes = await fetch(supaUrl, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ log_date: today, amount_ml: amountInt, source }),
    });
    if (!sbRes.ok) return res.status(sbRes.status).json({ error: await sbRes.text() });
    if (source === 'notification' && response === 'yes') await updateWaterNotifConsecutive('yes');
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/water/respond', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  const { response, water_ml_at_time = 0 } = req.body || {};
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/water_notif_responses`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ response, water_ml_at_time }),
    });
    if (response === 'no') await updateWaterNotifConsecutive('no');
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

async function updateWaterNotifConsecutive(response) {
  try {
    const rows = await sb('water_notif_state?id=eq.1');
    const state = Array.isArray(rows) && rows.length > 0 ? rows[0] : {};
    let patch = response === 'yes'
      ? { consecutive_yes: (state.consecutive_yes || 0) + 1, consecutive_no: 0 }
      : { consecutive_no:  (state.consecutive_no  || 0) + 1, consecutive_yes: 0 };
    patch.updated_at = new Date().toISOString();
    const base = 90;
    if      (patch.consecutive_no  >= 2) patch.interval_minutes = 60;
    else if (patch.consecutive_yes >= 3) patch.interval_minutes = 120;
    else                                 patch.interval_minutes = base;
    await fetch(`${SUPABASE_URL}/rest/v1/water_notif_state?id=eq.1`, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.warn('[water] consecutive update failed:', e.message);
  }
}

// ── Jacket proxy ──────────────────────────────────────────────────────────────

const JACKET_API_URL = process.env.JACKET_API_URL || 'https://api-service-production-b8b1.up.railway.app/predecir';

app.post('/api/abrigo', async (req, res) => {
  const { lat, lon, lead } = req.body;
  if (lat === undefined || lon === undefined || lead === undefined) {
    return res.status(400).json({ error: 'Faltan campos: lat, lon, lead' });
  }
  try {
    const upstream = await fetch(JACKET_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, lead }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[/api/abrigo] upstream error:', upstream.status, errText);
      return res.status(502).json({ error: 'Error en la API de predicción' });
    }
    res.json(await upstream.json());
  } catch (err) {
    console.error('[/api/abrigo]', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── Route modules ─────────────────────────────────────────────────────────────

app.use('/api', marketRouter.router);
app.use('/api', aiRouter);

// ── SPA catch-all ─────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Personal Hub corriendo en puerto ${PORT}`);
});

// ── Cache pre-warm (30s after startup) ───────────────────────────────────────

setTimeout(() => {
  console.log('[cache] pre-warming watchlist + macro...');
  Promise.all([
    fetch(`http://localhost:${PORT}/api/watchlist-data`),
    fetch(`http://localhost:${PORT}/api/macro-data`),
  ])
    .then(() => console.log('[cache] watchlist + macro ready'))
    .catch(e => console.warn('[cache] pre-warm failed:', e.message));
}, 30000);
