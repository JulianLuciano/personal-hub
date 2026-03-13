// ── HABITS MODULE ──────────────────────────────────────────────────────────────
// Responsabilidad: datos de hábitos, renderizado, toggle, progress ring, heatmap
// Para iterar: pasá solo habits.js

const HABITS_DATA = [
  { icon: '🏃', name: 'Running',        streak: 12, color: 'rgba(108,99,255,0.15)', done: true  },
  { icon: '📚', name: 'Reading',         streak: 7,  color: 'rgba(67,233,123,0.15)', done: true  },
  { icon: '💧', name: 'Drink 2L water',  streak: 4,  color: 'rgba(247,183,49,0.15)', done: true  },
  { icon: '🧘', name: 'Meditation',      streak: 2,  color: 'rgba(79,195,247,0.15)', done: false },
  { icon: '✍️', name: 'Journaling',      streak: 1,  color: 'rgba(255,101,132,0.15)',done: false },
];

function renderHabits() {
  const list    = document.getElementById('habitList');
  const allList = document.getElementById('allHabitsList');
  if (!list) return;
  const makeItem = (h, idx) => `
    <div class="habit-item ${h.done ? 'done' : ''}" onclick="toggleHabit(this)" data-idx="${idx}">
      <div class="habit-icon" style="background:${h.color}">${h.icon}</div>
      <div class="habit-info">
        <div class="habit-name">${h.name}</div>
        <div class="habit-streak">${h.streak > 1 ? '🔥 ' + h.streak + ' day streak' : h.streak + ' day streak'}</div>
      </div>
      <div class="habit-check">${h.done ? '✓' : ''}</div>
    </div>`;
  list.innerHTML = HABITS_DATA.map((h, i) => makeItem(h, i)).join('');
  if (allList) allList.innerHTML = HABITS_DATA.map((h, i) => makeItem(h, i)).join('');
  updateProgress();
}

function toggleHabit(el) {
  el.classList.toggle('done');
  el.classList.add('just-done');
  setTimeout(() => el.classList.remove('just-done'), 300);
  const check = el.querySelector('.habit-check');
  check.textContent = el.classList.contains('done') ? '✓' : '';
  const idx = parseInt(el.dataset.idx);
  if (!isNaN(idx)) HABITS_DATA[idx].done = el.classList.contains('done');
  updateProgress();
}

function updateProgress() {
  const items = document.querySelectorAll('#habitList .habit-item');
  const done  = document.querySelectorAll('#habitList .habit-item.done').length;
  const total = items.length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const pctLabel  = document.getElementById('pctLabel');
  const doneCount = document.getElementById('doneCount');
  const circle    = document.getElementById('progressCircle');
  if (pctLabel)  pctLabel.textContent  = pct + '%';
  if (doneCount) doneCount.textContent = done + ' de ' + total + ' hábitos hechos';
  if (circle) {
    const circumference = 201;
    circle.style.strokeDashoffset = circumference - (circumference * pct / 100);
  }
}

function renderHeatmap() {
  const hm = document.getElementById('heatmap');
  if (!hm) return;
  hm.innerHTML = '';
  for (let i = 0; i < 91; i++) {
    const cell = document.createElement('div');
    const r = Math.random();
    cell.className = 'hm-cell ' + (r < 0.2 ? '' : r < 0.4 ? 'l1' : r < 0.65 ? 'l2' : r < 0.85 ? 'l3' : 'l4');
    hm.appendChild(cell);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderHeatmap();
  renderHabits();
});
