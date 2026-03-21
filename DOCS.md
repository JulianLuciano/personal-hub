# Personal Hub — Documentación de Arquitectura

## ¿Qué es este proyecto?

Una app web móvil personal que corre en Railway, usa Express como servidor y Supabase como base de datos. Se accede desde el browser del celular como si fuera una app nativa.

---

## Estructura de archivos

```
/personal-hub
├── server.js                  ← Servidor Express (API, proxy Supabase, OCR, push, water)
├── worker.js                  ← Worker de precios (corre cada 15 min, Yahoo Finance)
├── notification-worker.js     ← Worker de notificaciones push (hábitos + agua, corre 24/7 en Railway)
├── recalculator.js            ← Motor de recálculo de posiciones desde transacciones
├── package.json
│
└── /public
    ├── index.html         ← Esqueleto HTML puro. Sin lógica, sin estilos inline.
    │
    ├── /css
    │   └── styles.css     ← TODO el CSS de la app (1255 líneas)
    │
    ├── /js
    │   ├── core.js            ← Base: estado global, fetch, nav, formatters, tools nav
    │   ├── habits.js          ← Tab Today + hábitos
    │   ├── recipes.js         ← Sub-tool Recetario + timers de cocción
    │   ├── jacket.js          ← Sub-tool Predictor de abrigo (replica bot Telegram)
    │   ├── portfolio.js       ← Tab Portfolio (la más compleja)
    │   ├── analytics.js       ← Tab Analytics: Health Score + Monte Carlo
    │   ├── transactions.js    ← Panel de nueva transacción + OCR
    │   └── ai.js              ← Chat con Claude
    │
    └── sw-habits.js           ← Service Worker: recibe Web Push real del servidor, maneja action buttons de agua
    │
    └── /logos
        └── *.png              ← Logos de activos (no tocar)
```

---

## Qué archivo pasarme según el problema

| Síntoma / Tarea | Archivos que necesito |
|---|---|
| Bug visual, color, layout, fuente | `styles.css` |
| La app no carga / error en consola al iniciar | `core.js` |
| Bug en tab Today (hábitos, progreso, heatmap) | `habits.js` |
| Bug en navigación Tools / menú de herramientas | `core.js` |
| Agregar/modificar receta o timer | `recipes.js` |
| Bug en predictor de abrigo (UI, shortcuts, resultado) | `jacket.js` |
| Cambiar URL de la API de predicción | `server.js` (env var `JACKET_API_URL`) |
| Bug en Portfolio (posiciones, gráfico, pie, RSU, P&L) | `portfolio.js` |
| Bug en Analytics (Health Score, Monte Carlo) | `analytics.js` |
| Bug en nueva transacción o en OCR | `transactions.js` |
| Bug en el chat AI / cambiar modelo / contexto | `ai.js` |
| Bug en servidor (endpoints, proxy Supabase) | `server.js` |
| Bug en precios / worker no actualiza | `worker.js` |
| Bug en notificaciones push (hábitos o agua) | `notification-worker.js` + `sw-habits.js` |
| Bug en tracker de agua (UI, botones, barra) | `habits.js` |
| Bug en endpoints de agua o push | `server.js` |
| Bug en recálculo de posiciones | `recalculator.js` |
| Feature nueva que toca varias tabs | `core.js` + módulos relevantes |

---

## Descripción breve de cada módulo

| Archivo | Qué hace en una línea |
|---|---|
| `index.html` | Esqueleto HTML. Solo estructura y referencias a CSS/JS. |
| `styles.css` | Todo el CSS: colores, layout, cards, animaciones. |
| `core.js` | Estado global, fetch a DB, navegación, formatters, pull-to-refresh, **tools nav**. |
| `habits.js` | Datos y lógica de hábitos, progress ring, heatmap. |
| `recipes.js` | Sub-tool: datos de recetas, render, timers de cocción. |
| `jacket.js` | Sub-tool: predictor de abrigo. Replica exactamente el bot de Telegram. |
| `portfolio.js` | Carga y renderiza Portfolio: posiciones, gráfico, pies, RSU modal, pos detail. |
| `analytics.js` | Health Score engine + Monte Carlo engine + sus UIs. |
| `transactions.js` | Formulario de transacción, validaciones, submit a DB, OCR via Claude Vision. |
| `ai.js` | Chat con Claude: builders de contexto, streaming, rendering de respuestas. |
| `server.js` | Express: proxy Supabase, endpoint OCR, proxy `/api/abrigo`, servir archivos estáticos. |
| `worker.js` | Proceso separado: fetch Yahoo Finance cada 15 min, guarda snapshots. |
| `recalculator.js` | Recalcula qty/avg_cost de posiciones desde tabla transactions. |
| `sw-habits.js` | Service Worker en `/public`. Recibe Web Push real del servidor vía VAPID. Muestra notificaciones con action buttons (agua: ✓ Sí tomé / ✗ No tomé). Responde clicks llamando a endpoints del server. |
| `notification-worker.js` | Proceso Node.js separado en Railway (segundo service). Corre cada 60s. Manda push de hábitos a las 22:30 (solo si no completaste todo) y push de agua cada ~90 min entre 09:40 y 22:40 con lógica adaptativa. |

---

## Descripción exhaustiva de cada módulo

### `index.html`
El punto de entrada de la app. Antes era un monolito de 7700 líneas; ahora tiene ~1300 líneas de HTML puro. Contiene:
- Los metadatos de la PWA (iconos, colores, viewport)
- Los imports de fuentes de Google Fonts
- El import del CSS (`css/styles.css`)
- Los imports de librerías externas (Chart.js, Hammer.js, chartjs-plugin-zoom)
- La estructura HTML de todos los paneles: Today, Habits Analytics, All Habits, Recipes, Portfolio, Analytics, Settings
- Los modals: Timer, RSU, Position Detail, AI Chat, Health Detail, Transaction Panel
- La bottom navigation bar y los botones flotantes (AI, +transacción)
- Los imports de todos los módulos JS al final del body (en orden: core → habits → recipes → portfolio → analytics → transactions → ai)

**Cuándo tocarlo:** solo para agregar campos HTML a un formulario, crear un panel nuevo, o modificar la estructura de un modal existente.

---

### `css/styles.css`
Todo el CSS de la aplicación (~1255 líneas). Organizado en secciones:
- Variables CSS (colores, fuentes, radios)
- Reset y base
- Phone frame y layout general
- Topbar y bottom nav
- Panels y tabs
- Cards y componentes comunes
- Portfolio: allocation bar, position items, mini-chart, equity pie
- Analytics: health score gauge, sub-scores, monte carlo cards
- Modals: overlay, sheet, handle, drag-to-close
- Transaction panel
- Hábitos: habit-item, progress ring, heatmap
- Recetas: recipe-card, timer-item
- AI chat: message bubbles, quick buttons
- Animaciones y transiciones
- Tema claro (overrides)

**Cuándo tocarlo:** cualquier cambio visual. Color de un botón, padding de una card, tamaño de fuente, nueva animación.

---

### `js/core.js`
El módulo base que todos los demás dependen. Se carga primero. Contiene:

**Estado global:**
- `liveData` — datos del portfolio en memoria (posiciones, precios, snapshots)
- `FX_RATE` — tipo de cambio GBP/USD actual
- `currentCurrency` — moneda activa ('GBP' o 'USD')
- `TICKER_META` — objeto con metadatos de cada activo (nombre, logo, categoría)
- `navTitles` — títulos del topbar por tab

**Data access:**
- `sbFetch(path)` — wrapper de fetch que transforma `/rest/v1/X` en `/api/db/X` (proxy Express). Todos los módulos usan esto para leer de Supabase.

**Navegación:**
- `switchNav(el, name)` — cambia de tab principal (portfolio, analytics, etc.)
- `switchTab(name, btn)` — cambia entre sub-tabs de Today (Today/Analytics/All)
- `toggleTheme()` — alterna modo oscuro/claro

**Formatters:**
- `fmtVal(usd, rate, sym)` — formatea un valor en USD a la moneda actual
- `fmtQty(qty, ticker)` — formatea cantidad según el tipo de activo

**UX gestures:**
- Pull-to-refresh — detecta el gesto de arrastrar hacia abajo y recarga la página
- `initDragClose(overlayId, closeFn)` — hace que los modals se cierren al arrastrarlos hacia abajo
- `initAllModals()` — inicializa drag-to-close en todos los modals

**Init:**
- `DOMContentLoaded` → llama `loadPortfolio()` y `loadRSUVests()`

---

### `js/habits.js`
Lógica completa del tab Hábitos. Incluye checks diarios, tracker de agua, one-shots anuales, estado de ánimo, drawers de detalle y sistema de notificaciones push real.

**Configuración:**
- `HABITS_LIST` — array de hábitos con `{id, icon, name, color, streak, hasDetail, isWater}`. Hábitos actuales: entrenamiento (con drawer de tipo + duración), piano (con drawer de tipos practicados + duración), deep work.
- `ONESHOTS` — contadores anuales: presentaciones, feedbacks, grabaciones, clases de piano, viajes, charlas de desarrollo, PSC reviews, planes grupales, segundas citas.
- `YEAR_GOALS` — objetivos anuales con valores actuales y metas para mostrar progreso.

**Estado:**
- `habitDayOffset` — 0 = hoy, negativo = días anteriores (hasta -7).
- `habitDayState` — estado del día: `{trained, piano, deepwork, food, foodBad[], foodIssue, trainType, trainDur, pianoTypes[], pianoDur, mood}`.
- `habitWaterMl` / `habitWaterGoal` — ml acumulados hoy y meta del día (2000ml base, 2500ml si entrenó).

**Funciones principales:**
- `initHabits()` — inicializa módulo, restaura hora de notif desde localStorage, carga datos, registra SW para push.
- `habitLoadDay()` — carga estado del día desde DB (mock) + agua desde `/api/water/today` en paralelo.
- `habitRenderHabits()` — genera HTML de ítems con drawers inline para hasDetail. Llama `habitRestoreDrawerSelections()`.
- `habitToggle(id)` — marca/desmarca hábito, re-renderiza lista completa (para que drawer aparezca en posición correcta).
- `habitWaterItemHTML()` — genera HTML del tracker de agua: barra hasta 3L, verde al llegar a la meta, tick inline a la izquierda del label, botones −100/+250/+500.
- `habitAddWater(deltaMl)` — actualiza local + persiste en DB (acepta negativos), reconcilia con `/api/water/today` post-save.
- `habitSelectFood(val)` / `habitToggleMeal(id)` / `habitSelectIssue(val)` — lógica del check de alimentación (bien/mal + detalle).
- `habitSelectMood(val)` — registra estado de ánimo (1-5).
- `habitInitNotifications()` — registra SW, solicita permiso, suscribe con VAPID, guarda suscripción en `/api/push/subscribe`.
- `habitSaveNotifTime()` — persiste hora configurada en localStorage y llama `/api/push/subscribe` para que el worker use la preferencia.

**Drawers de detalle (entrenamiento / piano):**
- `habitDrawerHTML(id)` — genera HTML del drawer inline (chips de tipo + duración).
- `habitSelectTrainType(type)` / `habitSelectTrainDur(val)` — selección única de tipo y duración de entrenamiento.
- `habitTogglePianoType(type)` / `habitSelectPianoDur(val)` — selección múltiple de tipos de piano, única de duración.
- `habitRestoreDrawerSelections()` — restaura estado visual de chips después de re-render.

---

### `js/recipes.js`
Lógica de la tab Recipes y el modal de timers. Actualmente con datos hardcodeados.

**Datos:**
- `RECIPES_DATA` — array de recetas `{emoji, title, time, portions, fav, tags, key}`
- `TIMER_DATA` — objeto con pasos de cocción por receta `{icon, name, time, mins}`

**Funciones:**
- `renderRecipes()` — genera las recipe-cards en `#recipeList`
- `openTimer(recipe)` — abre el modal timer y genera los ítems de pasos
- `closeTimer()` — cierra el modal
- `startTimer(idx, mins)` — arranca un countdown para un paso específico, actualiza el display cada segundo

---

### `js/portfolio.js`
El módulo más grande (~2745 líneas). Maneja toda la tab Portfolio.

**Carga de datos:**
- `loadPortfolio()` — fetcha positions, price_snapshots y portfolio_snapshots desde la DB. Puebla `liveData`. Llama a `renderPortfolio()`, `drawChart()`, `renderEquityPie()`, `renderHealthScore()`.

**Render principal:**
- `renderPortfolio()` — genera los ítems de posiciones en `#assetList`. Muestra precio actual, P&L, qty, valor. Incluye market status (open/closed/pre-market).
- `switchPosTab(el, cat)` — filtra las posiciones por categoría (acciones, cripto, rsu, fiat)

**Gráfico de evolución:**
- `loadChartData()` — carga portfolio_snapshots del rango seleccionado
- `drawChart()` — dibuja el gráfico de línea con Canvas API (sin Chart.js, custom)
- Period tabs (1S, 1M, 3M, 6M, 1A) — cambian el rango y redibujan

**Allocation pie (header):**
- `buildAllocSlices()` — calcula las porciones por categoría
- `drawPie()` — dibuja el pie chart en canvas con Canvas API
- `animateAllocPie()` / `focusAllocSlice()` — animaciones de focus al tocar una porción
- `hitTestAllocPie(e)` — detecta qué porción se tocó

**Equity pie (card derecha):**
- `renderEquityPie()` — dibuja el pie por ticker para acciones+RSU+cripto
- `toggleEquityCat(el)` — activa/desactiva categorías del equity pie
- `animateEquityPie()` / `focusEquitySlice()` / `hitTestEquityPie(e)` — ídem alloc pie

**P&L Attribution:**
- `renderPnlAttribution()` — barra horizontal de ganancia/pérdida por posición
- `setPnlAttrMode(mode)` — alterna entre % de retorno y valor absoluto
- `togglePnlCollapse()` — expande/colapsa la card

**Card ribbon (swipe):**
- IIFE con lógica de drag para swipe entre la card de Evolución y Equity Pie

**Hide values (privacy):**
- `toggleHideValues()` — enmascara todos los valores monetarios con `*****`
- `maskElement()`, `unmaskElement()`, `maskAllocItem()`, etc. — helpers de enmascarado

**Moneda:**
- `setCurrency(cur)` — cambia entre GBP y USD, re-renderiza todo

**Modal RSU:**
- `loadRSUVests()` — carga la tabla rsu_vests desde DB
- `openRSU()` — abre el modal con los datos del vest schedule
- `drawVestChart(...)` — dibuja el gráfico de barras de vests próximos
- `setRsuCurrency()`, `setRsuNet()`, `setQuarters()` — controles del modal
- `refreshRSU()` — recalcula y re-renderiza el modal con los parámetros actuales

**Modal Position Detail:**
- `openPosDetail(ticker)` — abre el modal con métricas de una posición específica
- `renderPosModalValues(ticker)` — calcula y muestra P&L, avg cost, rendimiento
- `drawPosChart(ticker, meta)` — gráfico de precio histórico de la posición
- `setPosModalCurrency(cur)` — cambia moneda dentro del modal

---

### `js/analytics.js`
Motor de Health Score y Motor de Monte Carlo (~986 líneas).

**Health Score Engine:**
- `computeHealthData()` — calcula el score de salud del portfolio (0-100) evaluando:
  - Concentración (HHI — Herfindahl-Hirschman Index)
  - Single Stock Risk
  - Exposición sectorial
  - Exposición a monedas
  - Beta del portfolio
  - Volatilidad estimada
  - Valuación (P/E forward ponderado)
  - Income momentum
  - Drawdown estimado
  Devuelve un objeto con el score total y sub-scores por dimensión.

- `renderHealthScore()` — actualiza el gauge SVG y las tarjetas de sub-scores en la UI
- `openHealthDetail(type)` — abre el modal de detalle para un sub-score específico
- `closeHealthDetail()` — cierra el modal
- `updateDrawdown()` — actualiza el slider de tolerancia a drawdown

**Monte Carlo Engine:**
- `mcSimulate({...})` — corre N simulaciones de trayectoria de portfolio con:
  - Aportes mensuales
  - Bonus semestral (meses 3 y 9)
  - RSU trimestral (meses 1, 4, 7, 10)
  - Retorno y volatilidad anualizados con distribución normal (Box-Muller)
  Devuelve array de arrays de valores mes a mes.

- `mcRun()` — lee los parámetros del formulario, corre la simulación, renderiza todos los resultados
- `mcRenderHist(sims, M, yr)` — dibuja el histograma de distribución final con Chart.js
- Ribbon de 3 cards con resultados clave (mediana, p10, p90, probabilidad de objetivo)
- `mcSwitchHistTab(el, tab)` — alterna entre vista de distribución y tabla de percentiles
- `toggleMcParams()` — expande/colapsa el formulario de parámetros
- `switchAnalyticsTab(tab, btn)` — alterna entre Health y Simulaciones

---

### `js/transactions.js`
Formulario para registrar transacciones manualmente (~522 líneas).

**Panel:**
- `openTxPanel()` / `closeTxPanel()` — abre/cierra el panel
- `setTxStatus(msg, type)` — muestra mensajes de éxito/error en el formulario

**Lógica de formulario:**
- `onTxTypeChange()` — adapta el formulario según el tipo (BUY/SELL/RSU_VEST/FX)
- `onTxBrokerChange()` — cambia defaults según el broker (Trading212, Kraken, Manual)
- `onTxTickerBlur()` — al salir del campo ticker, auto-completa name, asset_class, exchange desde `TX_TICKER_META`
- `setPricingCurrency(cur)` — cambia entre USD y GBP como moneda de precio
- `fetchTxPrice()` — fetcha el precio actual desde Yahoo Finance via `/api/price/:ticker`
- `recalcAmounts()` — recalcula amount_usd = qty × price_usd y amount_local = amount_usd × fx_rate
- `recalcDerivedPrice()` — recalcula precio desde amount_local si se edita ese campo
- `onTxPriceMainChange()`, `onTxFxChange()`, `onTxQtyChange()` — event handlers de recálculo

**Submit:**
- `submitTransaction()` — valida el formulario, hace POST a `/api/transactions`, llama a recalculador, recarga portfolio

**Historial:**
- `toggleTxHistory()` — muestra/oculta la sección de historial
- `loadTxHistory()` — fetcha las últimas transacciones y las renderiza en tabla

**OCR:**
- `handleTxImage(event)` — captura la imagen seleccionada, la comprime con Canvas y la envía a `/api/ocr-transaction`
- `compressImageToBase64(file, maxWidth, quality)` — reduce el tamaño de la imagen antes de enviar
- `fillFormFromOcr(tx)` — rellena los campos del formulario con los datos extraídos por Claude Vision

---

### `js/ai.js`
Chat con Claude integrado en la app (~493 líneas).

**Contexto builders** (arman el prompt de sistema con datos reales del portfolio):
- `buildPortfolioContext()` — lista de posiciones con valores, P&L, pesos en el portfolio
- `buildHealthContext()` — sub-scores del Health Score actual
- `buildMacroContext()` — datos macro (FX rate, índices si están disponibles)
- `buildWatchlistContext()` — activos en watchlist con precios
- `buildMarketContext()` — estado de mercados (abierto/cerrado, variaciones del día)

**Chat UI:**
- `openAIChat()` — abre el modal y configura los quick buttons contextuales
- `closeAIChat()` — cierra el modal
- `aiSendMsg()` — envía el mensaje, muestra el typing indicator, llama a la API
- `aiQuick(msg)` — envía un mensaje predefinido desde los quick buttons
- `setAiModel(m)` — cambia el modelo (Haiku / Sonnet / Opus)
- `getAnthropicKey()` — obtiene la API key desde el servidor via `/api/anthropic-key`

**Rendering:**
- Las respuestas se parsean para detectar tablas, listas y código, y se renderizan con HTML apropiado
- Soporte para streaming si está disponible

---

### `server.js`
Servidor Express. Puntos clave:
- Sirve los archivos estáticos de `/public`
- `GET /api/db/:table` — proxy hacia Supabase con la secret key server-side
- `POST /api/transactions` — inserta en la tabla transactions y dispara recálculo
- `POST /api/ocr-transaction` — recibe imagen base64, llama a Claude Vision, devuelve JSON con datos de la transacción
- `GET /api/price/:ticker` — proxy hacia Yahoo Finance para obtener precio actual
- `GET /api/anthropic-key` — devuelve la API key de Anthropic para el chat

**Endpoints de push (VAPID):**
- `GET /api/push/vapid-public-key` — devuelve la clave pública VAPID al frontend para la suscripción.
- `POST /api/push/subscribe` — guarda la suscripción del browser (`endpoint`, `p256dh`, `auth`) en la tabla `push_subscriptions`. Usa `merge-duplicates` para upsert.
- `POST /api/push/unsubscribe` — elimina la suscripción por endpoint.

**Endpoints de agua:**
- `GET /api/water/today` — suma todos los `amount_ml` de `water_logs` del día actual (incluye negativos).
- `POST /api/water/log` — inserta una transacción de agua. `amount_ml` puede ser positivo (+250, +500) o negativo (−100). `source`: `'manual'` | `'notification'`.
- `POST /api/water/respond` — registra respuesta "no tomé" en `water_notif_responses` y actualiza contadores consecutivos en `water_notif_state` para la lógica adaptativa del worker.

---

### `worker.js`
Proceso Node.js separado que corre en paralelo al servidor.
- Se ejecuta al arrancar y luego cada 15 minutos
- Lee todas las posiciones de Supabase
- Fetcha precios de Yahoo Finance para cada ticker no-fiat
- Convierte precios GBP → USD para los tickers con `pricing_currency = 'GBP'` (ej: VWRP.L)
- Fetcha el tipo de cambio GBPUSD=X
- Guarda los precios en `price_snapshots`
- Calcula el valor total del portfolio por categoría y guarda en `portfolio_snapshots`

---

### `recalculator.js`
Motor de recálculo de posiciones desde transacciones.
- Lee toda la tabla `transactions` ordenada cronológicamente
- Para cada ticker, aplica weighted average acumulativo:
  - BUY / RSU_VEST → acumula qty, amount_usd, amount_local, fees
  - SELL → descuenta qty y costo proporcional
  - qty == 0 → reset total (próxima compra arranca limpio)
- Regla especial: `ticker=META` + `type=RSU_VEST` → `positions.ticker = RSU_META`
- Compara con posiciones existentes; solo hace UPSERT si los valores cambiaron (no toca `updated_at` innecesariamente)
- Solo afecta posiciones con `managed_by = 'transactions'`; las `managed_by = 'manual'` no se tocan

---

### `js/jacket.js`
Sub-tool del tab Tools. Replica exactamente la lógica del bot de Telegram (`bot.py` + `utils.py`).

**Helpers (equivalentes a utils.py):**
- `jacketTemperaturaEmoji(apparent_temperature)` — mismo mapa de rangos que `temperatura_emoji()`
- `jacketAbrigo(clase)` — mismo mapa emoji que `abrigo_emoji()`
- `jacketLluviaMsj(prob, intensidad)` — misma lógica que `lluvia_msj()`

**Shortcuts de ubicación (equivalentes a `location_shortcuts` en bot.py):**
- Mapeo de nombres (`cordoba`, `cba`, `casa`, `caba`, `london`, etc.) a coordenadas
- `jacketNormalize(text)` — minúsculas, sin espacios, sin tildes (igual que el bot)

**Flujo (equivalente a `ConversationHandler` del bot):**
1. Selector de modo: Ahora / +2h / +3h / +4h / N hs (equivalente a `/abrigo`, `/abrigo_2h`, etc.)
2. En modo N hs, muestra input de horas con validación 1–48
3. Input de ubicación: shortcuts rápidos (London, Córdoba, Buenos Aires) + lat,lon manual + GPS
4. POST a `/api/abrigo` (proxy en `server.js` hacia la API de Railway)
5. Render de resultado: temperatura, métricas de clima, recomendación principal + barra de prob, segunda opción condicional (misma lógica que el bot: `prob_1st <= 0.6 and prob_2nd > 0.25 or diff < 0.10`), accordion de lluvia

**API:**
- `renderJacket()` — genera el HTML completo del predictor en `#jacketPanel`
- `jacketSelectMode(el, lead)` — equivalente a elegir `/abrigo` vs `/abrigo_nhs`
- `jacketSubmit()` — orquesta la validación y la llamada a la API
- `jacketRenderResult(data, label)` — equivalente a `process_coordinates()` en el bot
- `jacketReset()` — vuelve al estado inicial

---

### `public/sw-habits.js`
Service Worker registrado por `habits.js`. Gestiona notificaciones Web Push reales enviadas por `notification-worker.js` desde el servidor via protocolo VAPID. Ya **no** usa `setTimeout` local.

**Eventos:**
- `install` → `skipWaiting()` para activarse inmediatamente.
- `activate` → `clients.claim()` para tomar control de pestañas existentes.
- `push` → recibe el payload del servidor, muestra la notificación con opciones y action buttons. Para notificaciones de agua (`WATER_CHECK`), usa `requireInteraction: true` para que no desaparezca sola.
- `notificationclick` → maneja clicks en la notificación y en los action buttons:
  - `water_yes` → POST a `/api/water/log` con 500ml + abre la app.
  - `water_no` → POST a `/api/water/respond` con `response: 'no'` (para lógica adaptativa del worker).
  - Default → abre/enfoca la app.

**Ventaja sobre el sistema anterior:**
- Las notificaciones llegan aunque el browser esté cerrado (push real vía Apple/Google servers).
- No depende de que el usuario abra la app para reprogramar. El worker en Railway es quien decide cuándo mandar cada push.

### `notification-worker.js`
Proceso Node.js independiente que corre en Railway como segundo service (start command: `npm run start:worker`). Corre un tick cada 60 segundos.

**Variables de entorno requeridas:**
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` — para leer logs y suscripciones.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — claves VAPID generadas una sola vez con `web-push`.
- `VAPID_CONTACT` — debe ser `mailto:tu@email.com` (con prefijo `mailto:`).

**Notificaciones de hábitos (22:30):**
- Consulta `habit_daily_logs` y `water_logs` del día.
- Si todos los hábitos están completos (trained, piano, deepwork, food, agua ≥ objetivo) → silencio.
- Si falta algo → manda push listando exactamente qué falta.
- Objetivo de agua: 2000ml por defecto, 2500ml si `trained = true` ese día.

**Notificaciones de agua (09:40–22:40):**
- Consulta `water_notif_state` para saber cuándo fue el último push y cuál es el intervalo actual.
- Si ya se llegó al objetivo del día → no manda más.
- Intervalo adaptativo: base 90 min. Si respondiste "no tomé" 2 veces seguidas → acorta a 60 min. Si respondiste "sí tomé" 3 veces seguidas → alarga a 120 min.
- Actualiza `water_notif_state` después de cada envío.
- Registra respuestas en `water_notif_responses` para análisis futuro.

---

### `server.js` — endpoint `/api/abrigo`
Proxy hacia la API de predicción de abrigo (deployada en Railway por separado, con el modelo CatBoost).
- `POST /api/abrigo` — recibe `{ lat, lon, lead }`, los reenvía a `JACKET_API_URL` (env var), devuelve la respuesta JSON al cliente
- Si `JACKET_API_URL` no está definida en Railway, devuelve error 500
- El modelo y la inferencia Python siguen corriendo en su propio servicio; el hub solo actúa de proxy

---

### `core.js` — funciones de Tools nav
- `toolsOpenSub(name)` — muestra el sub-panel `tools-sub-{name}`, oculta el menú home, actualiza el topbar title
- `toolsBack()` — vuelve al menú home de Tools

---

## Cómo trabajamos a partir de ahora

### Flujo estándar para iterar
1. **Identificá el módulo** usando la tabla de arriba
2. **Adjuntá solo ese archivo** (+ `DOCS.md` si querés que tenga contexto)
3. Describí el bug o la feature
4. Yo te devuelvo el archivo modificado

### Para features que tocan múltiples módulos
Describí el objetivo. Yo te digo exactamente qué archivos necesito antes de empezar.

### Para bugs que no sabés en qué módulo están
Describí el síntoma y pegá el error de consola si hay. Con eso lo identifico.

### Reducción de tokens vs antes
- Antes: 7700 líneas de `index.html` en cada iteración = ~8000 tokens solo de contexto
- Ahora: el módulo más grande (`portfolio.js`) tiene 2745 líneas. El promedio es ~600 líneas.
- **Ahorro típico: 70-85% de tokens por sesión de iteración**

---

## Base de datos (Supabase)

### Tablas principales

| Tabla | Qué guarda |
|---|---|
| `positions` | Una fila por activo. Qty, avg_cost, initial_investment, managed_by. |
| `transactions` | Historial completo de compras/ventas/vests. |
| `price_snapshots` | Precio de cada ticker cada 15 min (lo escribe el worker). |
| `portfolio_snapshots` | Valor total del portfolio cada 15 min (lo escribe el worker). |
| `rsu_vests` | Schedule de vesting de RSUs META. |
| `habit_daily_logs` | Un registro por día con estado de cada hábito. UNIQUE(log_date). |
| `habit_oneshots` | Contadores anuales (presentaciones, viajes, clases de piano, etc.). UNIQUE(year). |
| `habit_weight_logs` | Historial de registros de peso quincenal. |
| `push_subscriptions` | Suscripciones Web Push de cada dispositivo/browser. UNIQUE(endpoint). |
| `water_logs` | Transacciones de agua del día. Acepta `amount_ml` negativos (correcciones). El total del día es la suma de todas las filas. |
| `water_notif_state` | Fila única (id=1). Guarda `last_sent_at`, `interval_minutes`, `consecutive_yes`, `consecutive_no` para la lógica adaptativa del worker de agua. |
| `water_notif_responses` | Historial de respuestas a notificaciones de agua (yes/no). Para análisis futuro de comportamiento. |

### Reglas importantes
- Las posiciones con `managed_by = 'transactions'` son calculadas automáticamente por `recalculator.js`. **No editarlas a mano en Supabase.**
- Las posiciones con `managed_by = 'manual'` (cash, rent deposit, etc.) se editan directo en Supabase.
- El worker siempre convierte precios a USD antes de guardar en `price_snapshots`.
- El campo `pricing_currency` en `positions` indica si el activo cotiza en GBP (ej: VWRP.L) o USD.

---


---

## Variables de entorno (Railway)

### Service principal (`server.js`)
| Variable | Descripción |
|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SECRET_KEY` | Service role key (nunca expuesta al frontend) |
| `ANTHROPIC_API_KEY` | API key de Anthropic para OCR y chat |
| `JACKET_API_URL` | URL de la API de predicción de abrigo |
| `VAPID_PUBLIC_KEY` | Clave pública VAPID para Web Push |
| `VAPID_PRIVATE_KEY` | Clave privada VAPID |
| `VAPID_CONTACT` | `mailto:tu@email.com` (con prefijo `mailto:`) |

### Service de notificaciones (`notification-worker.js`)
Requiere las mismas variables que el service principal, **más** las VAPID keys. Deben cargarse manualmente — Railway no comparte variables entre services automáticamente.

### Generar claves VAPID (una sola vez)
```bash
node -e "const wp=require('web-push'); console.log(wp.generateVAPIDKeys())"
```

## Claude Code — ¿Vale la pena?

**Respuesta corta: sí, pero después de que el código refactorizado esté funcionando.**

Claude Code es un agente que corre en tu terminal, puede leer/escribir archivos directamente, ejecutar comandos y hacer git. Para este proyecto tiene sentido cuando el código sea estable y la arquitectura esté clara (exactamente como queda después de esta refactorización).

**Roles que tendrían sentido:**
- **Agente de bugfixing** — le das el módulo y el error, él lee el archivo, lo arregla y hace el commit
- **Agente de features** — le describís lo que querés agregar, él identifica qué módulos tocar
- **Agente de DB** — manejo de migraciones de schema en Supabase

Para discutir esto en detalle, una vez que el código refactorizado esté en producción y funcionando bien.
EOF
echo "DOCS.md: $(wc -l < /home/claude/personal-hub/DOCS.md) lines"