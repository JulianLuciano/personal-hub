// ── RECIPES MODULE ─────────────────────────────────────────────────────────────
// Responsabilidad: datos de recetas, renderizado, timers de cocción
// Para iterar: pasá solo recipes.js

const RECIPES_DATA = [
  { emoji: '🍝', title: 'Spaghetti alla Carbonara', time: '25 min', portions: '2 porciones', fav: true,  tags: ['Pasta', 'Italiana'],     key: 'Carbonara' },
  { emoji: '🍚', title: 'Risotto ai Funghi',         time: '35 min', portions: '4 porciones', fav: false, tags: ['Arroz', 'Italiana'],      key: 'Risotto'   },
  { emoji: '🐟', title: 'Salmón a la Plancha',       time: '30 min', portions: '2 porciones', fav: false, tags: ['Pescado', 'Saludable'],   key: 'Salmón'    },
];

const TIMER_DATA = {
  'Carbonara': [
    { icon: '🍝', name: 'Hervir pasta al dente',    time: '10 min', mins: 10 },
    { icon: '🥓', name: 'Dorar guanciale',          time: '5 min',  mins: 5  },
    { icon: '🥚', name: 'Mezclar huevo + pecorino', time: '2 min',  mins: 2  },
  ],
  'Risotto': [
    { icon: '🧅', name: 'Sofrito de cebolla',       time: '8 min',  mins: 8  },
    { icon: '🍚', name: 'Tostar el arroz',          time: '3 min',  mins: 3  },
    { icon: '🫗', name: 'Agregar caldo de a poco',  time: '18 min', mins: 18 },
  ],
  'Salmón': [
    { icon: '🧂', name: 'Marinar el salmón',        time: '15 min', mins: 15 },
    { icon: '🔥', name: 'Sellar en sartén',         time: '4 min',  mins: 4  },
    { icon: '🫕', name: 'Terminar en horno',        time: '8 min',  mins: 8  },
  ],
};

function renderRecipes() {
  const grid = document.getElementById('recipeList');
  if (!grid) return;
  grid.innerHTML = RECIPES_DATA.map(r => `
    <div class="recipe-card">
      <div class="recipe-img">${r.emoji}</div>
      <div class="recipe-body">
        <div class="recipe-title">${r.title}</div>
        <div class="recipe-meta">
          <span>⏱ ${r.time}</span><span>👤 ${r.portions}</span>${r.fav ? '<span>⭐ Fav</span>' : ''}
        </div>
        <div class="recipe-tags">${r.tags.map(t => `<span class="recipe-tag">${t}</span>`).join('')}</div>
        <button class="recipe-timer-btn" onclick="openTimer('${r.key}')">⏱ Iniciar timers de cocción</button>
      </div>
    </div>`).join('') + `
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:16px;background:var(--surface);border:1.5px dashed var(--border);border-radius:16px;cursor:pointer;color:var(--muted);font-size:14px">
      <span style="font-size:20px">+</span> Agregar receta
    </div>`;
}

const _activeTimers = {};

function openTimer(recipe) {
  const steps = TIMER_DATA[recipe] || [];
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
    </div>`).join('');
  document.getElementById('timerModal').classList.add('open');
}

function closeTimer() {
  document.getElementById('timerModal').classList.remove('open');
}

function startTimer(idx, mins) {
  if (_activeTimers[idx]) return;
  let secs = mins * 60;
  const btn = document.querySelector('#titem' + idx + ' .timer-btn');
  btn.textContent = '⏸';
  _activeTimers[idx] = setInterval(() => {
    secs--;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    document.getElementById('ttime' + idx).textContent = m + ':' + s.toString().padStart(2, '0') + ' restante';
    if (secs <= 0) {
      clearInterval(_activeTimers[idx]);
      delete _activeTimers[idx];
      document.getElementById('ttime' + idx).textContent = '✅ Listo!';
      btn.textContent = '✓';
      btn.style.background = 'var(--accent3)';
    }
  }, 1000);
}

document.addEventListener('DOMContentLoaded', renderRecipes);
