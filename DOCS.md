# Personal Hub — Documentación de Arquitectura

## ¿Qué es este proyecto?

Una app web móvil personal que corre en Railway, usa Express como servidor y Supabase como base de datos. Se accede desde el browser del celular como si fuera una app nativa.

---

## Estructura de archivos

```
/personal-hub
├── server.js                  ← Servidor Express (API, proxy Supabase, OCR, push, water)
├── worker.js                  ← Worker de precios (corre cada 15 min, Yahoo Finance)
├── notification-worker.js     ← Worker de notificaciones push (hábitos + agua + briefing diario, corre 24/7 en Railway)
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
| Bug en Analytics (Health Score, Monte Carlo, Correlación) | `analytics.js` |
| Bug en correlación (valores raros, no carga, períodos) | `analytics.js` + `worker.js` |
| Bug en contexto de correlación del agente (siempre null, datos viejos) | `server.js` → `/api/ai-correlation-context` |
| Anthropic devuelve 429/529 y el chat falla | `server.js` → `callAnthropic()` (retry automático) |
| Bug en nueva transacción o en OCR | `transactions.js` |
| Bug en el chat AI / cambiar modelo / contexto | `ai.js` |
| Bug en logging de conversaciones / historial de chats | `ai.js` + `server.js` |
| Bug en swipe-to-delete del historial / confirm popup | `ai.js` + `styles.css` |
| Bug en mensajes favoritos (star, starred view) | `ai.js` + `server.js` + `styles.css` |
| Bug en briefing diario (push, contenido, modal) | `notification-worker.js` + `server.js` + `ai.js` |
| Bug en modal de briefing (UI, historial, render) | `ai.js` + `index.html` + `styles.css` |
| Bug en tool calls del agente (query_db, run_montecarlo) | `server.js` (ejecutores de tools) |
| Bug en loop agentic / iteraciones / tool_use | `server.js` (endpoint `/api/ai-chat`) |
| Bug en widget de tools usadas en el chat | `ai.js` (`aiRenderToolLog`) + `styles.css` |
| Tool calls no se guardan en historial | `ai.js` (`aiLogMessage`) + `server.js` (POST `/api/ai-messages`) |
| Tool calls no aparecen al reabrir conversación vieja | `ai.js` (`aiOpenConversation`) |
| Bug en Monte Carlo del agente (valores, parámetros) | `server.js` (`executeRunMontecarlo`) |
| Simulación Monte Carlo ignora capital especificado por el usuario | `server.js` (`executeRunMontecarlo` → parámetro `initial_capital_gbp`) |
| Bug en Monte Carlo del frontend (UI, parámetros, gráfico) | `analytics.js` |
| `annualFlow` del Health Score incorrecto (flujo anual RSU) | `analytics.js` → `computeHealthData()` + `calcRsuDefault()` |
| FABs (AI bubble / + transacción) aparecen en tab equivocada | `core.js` → `switchNav` |
| Bug en servidor (endpoints, proxy Supabase) | `server.js` |
| Bug en precios / worker no actualiza | `worker.js` |
| Bug en notificaciones push (hábitos o agua) | `notification-worker.js` + `sw-habits.js` |
| Bug en tracker de agua (UI, botones, barra) | `habits.js` |
| Bug en endpoints de agua o push | `server.js` |
| Bug en recálculo de posiciones | `recalculator.js` |
| Feature nueva que toca varias tabs | `core.js` + módulos relevantes |
| Cambiar/recortar el system prompt del agente | `ai.js` → `aiSendMsg()` (funciones `build*Context`, `_cachedSystemPrompt`) |
| Cambiar descripciones/parámetros de tools del agente | `server.js` → `AI_TOOLS` |
| El prompt caching no funciona / cache_read siempre 0 | `server.js` → `callAnthropic()` (header `anthropic-beta` + formato `system` como array) |
| Chat falla con 429 o 529 y no reintenta | `server.js` → `callAnthropic()` / `_callAnthropicOnce()` (retry automático) |

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
| `analytics.js` | Health Score engine + Monte Carlo engine + Correlation Heatmap + sus UIs. |
| `transactions.js` | Formulario de transacción, validaciones, submit a DB, OCR via Claude Vision. |
| `ai.js` | Chat con Claude: builders de contexto, loop agentic con tool calls, widget de tools usadas, logging de conversaciones a Supabase, rendering de respuestas, historial con swipe-to-delete, mensajes favoritos (★), modal de briefing diario. |
| `server.js` | Express: proxy Supabase, loop agentic (`/api/ai-chat`), ejecutores de tools (`query_db`, `run_montecarlo`), endpoint OCR, proxy `/api/abrigo`, servir archivos estáticos, endpoints de chat history, contexto de transacciones, contexto de correlaciones, contexto completo para briefing. |
| `worker.js` | Proceso separado: fetch Yahoo Finance cada 15 min, guarda snapshots + calcula matriz de correlación diaria. |
| `recalculator.js` | Recalcula qty/avg_cost de posiciones desde tabla transactions. |
| `sw-habits.js` | Service Worker en `/public`. Recibe Web Push real del servidor vía VAPID. Maneja action buttons de agua y redirección al abrir briefing (`/?briefing=1`). |
| `notification-worker.js` | Proceso Node.js separado en Railway (segundo service). Corre cada 60s. Manda push de hábitos a las 22:30, agua cada ~90 min con lógica adaptativa, y briefing financiero 5 min después del cierre NYSE (lun-vie). |

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
- `switchNav(el, name)` — cambia de tab principal. También controla visibilidad de los FABs (`#aiBubble` y `#txFab`): solo visibles en `portfolio` y `analytics`.
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
Motor de Health Score, Monte Carlo y Correlation Heatmap.

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

**Correlation Heatmap:**
- `corrAllRows` — caché en memoria de todos los rows de `correlation_matrix` (se carga una vez, cubre los 3 períodos).
- `corrActivePeriod` — período activo (90, 180 o 365). Default: 90.
- `loadCorrelation(period?)` — punto de entrada. Si es la primera carga, fetcha todos los períodos de una vez via `sbFetch`. Los cambios de período posteriores filtran el array en memoria (instantáneo). Actualiza las pills y llama `renderCorrelationHeatmap(rows)`.
- `renderCorrelationHeatmap(rows)` — construye la tabla NxN: calcula el tamaño de celda desde el `clientWidth` real del wrapper, aplica colores por valor absoluto con thresholds fijos (verde <0.3 / amarillo 0.3–0.6 / rojo >0.6), muestra el signo en el valor de la celda, y genera el insight de par más/menos correlacionado.

**Color coding (valor absoluto):**
- `|corr| < 0.3` → verde — baja correlación, buen diversificador
- `0.3 ≤ |corr| < 0.6` → amarillo — correlación media
- `|corr| ≥ 0.6` → rojo — alta correlación, poco beneficio de diversificación
- Dentro de cada banda la intensidad sube gradualmente (0.61 ≠ 0.95).
- El signo (+/-) se muestra en el número de la celda pero no afecta el color.

**Pills de período:**
- Tres botones `90d / 180d / 365d` en el HTML con clase `corr-period-pill`.
- El estado activo se maneja solo con `classList.toggle('active')` — CSS se encarga del estilo.
- No hay re-fetch al cambiar de período: filtrado en memoria sobre `corrAllRows`.
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
Chat con Claude integrado en la app. Maneja el chat UI, los builders de contexto para el system prompt, el logging de conversaciones a Supabase, el rendering de respuestas, los mensajes favoritos y el modal de briefing diario.

**Configuración:**
- `AI_CONTEXT_WINDOW = 10` — cuántos mensajes se pasan como contexto en cada turn (5 pares Q&A). **Cambiar este único valor** para ajustar el sliding window en toda la app.
- `AI_MODELS` — mapa `{ sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6' }`.
- `max_tokens: 3000` para ambos modelos.

**Contexto builders** (arman el system prompt con datos reales del portfolio):
- `buildPortfolioContext()` — posiciones con valores, P&L, pesos, cost basis, vest schedule RSU
- `buildHealthContext()` — sub-scores del Health Score actual (HHI, beta, PE, currency, concentración, income)
- `buildMacroContext()` — datos macro en TSV (VIX, US10Y, FX, índices) con cambios 7d/30d y tendencia
- `buildWatchlistBase()` — ~14 tickers de referencia fija (SPY, QQQ, BTC, NVDA, etc.) en TSV
- `buildWatchlistExtended()` — ~50 tickers adicionales por grupo temático; solo se incluye si el mensaje del usuario activa `needsExtendedWatchlist()`
- `buildMarketContext()` — fundamentals de posiciones del portfolio (beta, PE, 52w, MA, analyst targets)
- Transacciones recientes: fetcha `/api/ai-transactions-context` en cada turn (últimas 5 transacciones + total mes corriente y anterior en USD y GBP). Fire-and-forget con fallback graceful.

**Quick pills (chat):**
- Las 5 pills copian el texto al input en vez de enviarlo directamente, para que el usuario pueda editar antes de mandar.
- `aiCopyToInput(msg)` — copia al textarea, ajusta altura, hace focus y mueve el cursor al final.
- `aiQuick(msg)` — envía directamente (mantenido para uso programático).
- Pills actuales: Composición · Riesgo · Diversificación · P&L · 💰 Invertir (template con monto editable).

**Chat UI:**
- `openAIChat()` / `closeAIChat()` — abre y cierra el modal (close siempre vuelve a la vista de chat)
- `aiSendMsg()` — envía el mensaje, muestra typing indicator animado, llama a `/api/ai-chat`, filtra thinking blocks de Opus, loggea a Supabase. Construye el system prompt con cache (`_cachedSystemPrompt`, invalidado por `captured_at` del snapshot más reciente de `liveData`): el bloque pesado (portfolio, health, market) se reconstruye solo cuando `liveData` cambia; txSection, corrSection, wlExtended se concatenan siempre fresh porque varían por mensaje. El contexto de correlación se fetchea desde `/api/ai-correlation-context` (server-side), no desde `corrAllRows` del frontend.
- `setAiModel(m)` — cambia entre Sonnet y Opus con feedback visual. El modelo se lee en el momento del envío, así que puede cambiar mid-conversación — cada mensaje assistant loggea el modelo usado.
- `aiRenderMarkdown(text)` — parsea tablas, bold, italic, headers y listas para renderizar en HTML

**Historial de conversaciones:**
- `aiToggleHistory()` — alterna entre vista de chat y vista de historial dentro del mismo sheet
- `aiLoadHistory()` — fetcha las últimas 15 conversaciones de `/api/ai-conversations`. Lazy: solo carga la primera vez; se resetea con `aiHistoryLoaded = false` cada vez que se loggea un mensaje nuevo.
- `aiOpenConversation(id, targetMsgId?)` — carga todos los mensajes de una conversación, reconstruye `aiHistory` completo, y setea `aiConversationId` al ID original. Si se pasa `targetMsgId`, hace scroll hasta ese mensaje y aplica animación `ai-msg-highlight` (glow amarillo 1.8s). Los mensajes nuevos se agregan a la misma conversación con seq continuado.
- `aiNewConversation()` — resetea `aiHistory`, `aiConversationId` y `aiMessageSeq`. El próximo mensaje crea una conversación nueva. Disponible desde el botón "+ Nueva" en la vista de historial.

**Mensajes favoritos (★):**
- Cada mensaje del assistant tiene un botón `☆` en la esquina inferior derecha. Al tocar lo marca/desmarca en amarillo y hace PATCH a `/api/ai-messages/:id/star`.
- `_aiMsgMeta` — WeakMap que mapea elementos DOM a `{ dbId }`. Se inicializa en `aiAddMsg` con `dbId: null` y se actualiza cuando el log async devuelve el ID real.
- `aiToggleStar(el)` — lee `el.dataset.starred`, invierte, PATCH al server, actualiza icono y clase `.active`.
- `aiToggleStarred()` / `aiShowStarredView()` — botón ★ en el header del modal AI abre la vista de guardados.
- `aiLoadStarred()` — fetcha `/api/ai-messages/starred`, renderiza cards con preview + fecha + título de conversación. Al tocar una card llama `aiOpenConversation(conversationId, messageId)` para ir directo al mensaje.
- Estado inicial correcto al reabrir conversaciones: `aiOpenConversation` pasa `row.starred` a `aiAddMsg` para que el ★ se renderice en amarillo si el mensaje estaba guardado.

**Thinking blocks (Opus):**
- Las respuestas de Opus pueden incluir bloques `{type:'thinking'}` antes del texto. El cliente filtra con `.find(b => b.type === 'text')` para no mostrar ni loggear el razonamiento interno.

**Logging de conversaciones (fire-and-forget, no bloquea el chat):**
- `aiConversationId` — UUID de la conversación activa; `null` al cargar la página (cada reload = nueva conversación).
- `aiMessageSeq` — contador 0-based que se incrementa con cada mensaje loggeado.
- `aiEnsureConversation(model, firstMsg)` — crea la fila en `ai_conversations` en el primer mensaje del usuario; los primeros 80 chars del mensaje se usan como título.
- `aiLogMessage({role, content, model, input_tokens, output_tokens, context_start_seq, tool_calls})` — inserta una fila en `ai_messages`. `context_start_seq` es el seq del primer mensaje incluido en el contexto de ese turn. `tool_calls` es un array JSONB con los tool calls ejecutados (solo se pasa en mensajes assistant que usaron tools, null en el resto).

**Flujo de logging en cada turn:**
1. `aiEnsureConversation()` (solo si es el primer mensaje).
2. Se calcula `contextStartSeq`: índice en `aiHistory` del primer mensaje del slice que se enviará como contexto.
3. `aiLogMessage({ role: 'user', context_start_seq: contextStartSeq, ... })` → inserta el mensaje del usuario.
4. Se hace el API call con `contextSlice`.
5. Al recibir la respuesta: `aiLogMessage({ role: 'assistant', tool_calls: toolLog, ... })` → devuelve el `dbId` via `.then()`, que se guarda en `_aiMsgMeta` para habilitar el starring.

**Tool calls widget:**
- `aiRenderToolLog(toolLog, container)` — función standalone reutilizable que construye el elemento `.ai-tools-used` y lo agrega al container dado. Usada tanto en el live chat (después de recibir la respuesta) como en `aiOpenConversation` (al recargar mensajes históricos desde DB).
- El widget muestra un header colapsado con `🔧 N herramientas usadas`. Al tocar expande/colapsa el detalle.
- Cada fila del detalle muestra: icono, nombre de la tool, descripción del input (query_type + ticker/fechas para `query_db`, escenario + años para `run_montecarlo`), elapsed ms.
- El widget se inserta **antes** del mensaje del asistente en el DOM.
- Al reabrir una conversación, `aiOpenConversation` lee `row.tool_calls` de cada mensaje y llama `aiRenderToolLog` si no es null.

**Modal de briefing diario:**
- `openBriefingModal(content?)` — navega a la tab portfolio y abre el modal `#briefingModal`. Si no se pasa `content`, llama `briefingLoadLatest()`.
- `briefingLoadLatest()` — fetcha el último registro de `daily_briefings` via `/api/db/daily_briefings?order=date.desc&limit=1`, renderiza con `_briefingRender()`.
- `briefingToggleHistory()` — alterna entre la vista del último briefing y la lista histórica.
- `briefingLoadHistory()` — fetcha los últimos 30 briefings; cada card muestra fecha + preview y al tocar carga ese contenido.
- `_briefingRender(content)` — renderiza el contenido markdown con `aiRenderMarkdown()` en `#briefingContent`.
- Detección de `?briefing=1` al cargar la app (parámetro que pone el SW al tocar la notificación): limpia el param con `history.replaceState` y abre el modal tras 400ms.

---

### `server.js`
Servidor Express. Puntos clave:
- Sirve los archivos estáticos de `/public`
- `GET /api/db/:table` — proxy hacia Supabase con la secret key server-side
- `POST /api/transactions` — inserta en la tabla transactions y dispara recálculo
- `POST /api/ocr-transaction` — recibe imagen base64, llama a Claude Vision, devuelve JSON con datos de la transacción
- `GET /api/price/:ticker` — proxy hacia Yahoo Finance para obtener precio actual
- `GET /api/chart/:period` — downsampling server-side de portfolio_snapshots (1S/1M/3M/6M/1A → ~180 pts)

**Loop agentic — `/api/ai-chat`:**

El endpoint ya no es un relay tonto. Implementa un loop completo de tool use compatible con la API de Anthropic:

```
Frontend → POST /api/ai-chat → loop:
  1. Llamada a Anthropic con tools definidos
  2. Si stop_reason = "end_turn" → devuelve respuesta al frontend
  3. Si stop_reason = "tool_use" → ejecuta tools server-side → agrega tool_result → repite
  4. Techo duro: MAX_TOOL_ITERATIONS = 5
```

- La respuesta final tiene exactamente el mismo formato que antes (compatible con `ai.js` sin cambios en el frontend).
- Se agrega `_tool_calls_log` al response: array con `{ tool, input, elapsed_ms, row_count, error }` por cada tool ejecutada. Lo usa `ai.js` para renderizar el widget y para loggear en Supabase.
- **Logs en Railway** para debug: entrada (model, tamaño system prompt, user msg truncado), cada tool (nombre, input JSON, elapsed ms, preview del resultado), y salida (stop_reason, iteraciones, tokens in/out, reply truncado).

**Tool: `query_db`** — `executeQueryDb(input)`

Ejecuta queries read-only sobre Supabase. El modelo nunca ve SQL — elige un `query_type` de un enum y filtros opcionales; el servidor construye la query internamente.

| query_type | Tabla | Filtros disponibles |
|---|---|---|
| `transactions_by_ticker` | `transactions` | `ticker`, `limit` |
| `transactions_by_period` | `transactions` | `from_date`, `to_date`, `limit` |
| `transactions_all` | `transactions` | `limit` |
| `portfolio_history` | `portfolio_snapshots` | `from_date`, `to_date`, `limit` |
| `price_history` | `price_snapshots` | `ticker`, `from_date`, `limit` |
| `rsu_vests` | `rsu_vests` | `vested_only` (bool) |
| `positions_snapshot` | `positions` | — |
| `daily_returns` | `daily_returns` | `ticker`, `from_date`, `to_date`, `limit` |

Límite máximo: 200 filas. Default: 20.

**Tool: `run_montecarlo`** — `executeRunMontecarlo(input)` (async)

Corre 2000 simulaciones Monte Carlo sobre el portfolio real. Alineado con la lógica de `mcSimulate()` en `analytics.js`:
- **Valores iniciales:** fetcheados en tiempo real de Supabase (`positions` + último `portfolio_snapshots` para FX + últimos `price_snapshots`). `startInvested` = activos non-fiat en GBP. `startCash` = activos fiat en GBP. Fallback a 8000/4000 si falla el fetch.
- **Tasas separadas:** invested usa el escenario elegido; cash fijo 3% ret / 1% vol.
- **Escenarios** (alineados con `MC_SCEN` en `analytics.js`): `bear` (3% ret, 25% vol) / `neutral` (9% ret, 18% vol) / `bull` (16% ret, 22% vol).
- **Cash flows:** bonus en meses 3 y 9 (50% c/u), RSU en meses 1/4/7/10, aporte mensual continuo.
- **Output:** p10/p25/median/p75/p90 al final del horizonte + probabilidades para goals £30k@1yr, £100k@3yr, £200k@5yr (calculadas en el mismo loop, sin segunda simulación) + probabilidad de `target_gbp` si se especifica.

**Parámetros del tool `run_montecarlo`:**
- `years` (requerido, 1–40)
- `monthly_contribution_gbp` (default 950)
- `annual_bonus_gbp` (default 9500)
- `include_rsu` (default true)
- `target_gbp` (opcional)
- `scenario`: `neutral` | `bull` | `bear` (default `neutral`)
- `initial_capital_gbp` (opcional): `null` (default) = fetchea el portfolio real de Supabase. `0` o cualquier número = override directo, saltea el fetch. Útil para simular desde cero o desde un monto hipotético. La comparación es `!== null` así que `0` funciona correctamente.

**Endpoints de chat history:**
- `POST /api/ai-conversations` — crea fila en `ai_conversations`, devuelve `{ id }` (UUID)
- `POST /api/ai-messages` — inserta un mensaje con `{ conversation_id, seq, role, content, model?, input_tokens?, output_tokens?, context_start_seq?, tool_calls? }`. `tool_calls` es JSONB, solo presente en mensajes assistant que usaron tools.
- `GET /api/ai-conversations` — lista conversaciones ordenadas por fecha desc (param `limit`, default 30, max 100)
- `GET /api/ai-conversations/:id/messages` — todos los mensajes de una conversación ordenados por `seq` (incluye `tool_calls`)
- `DELETE /api/ai-conversations/:id` — elimina conversación + cascade mensajes
- `PATCH /api/ai-messages/:id/star` — togglea `starred` (boolean) en un mensaje. Body: `{ starred: true|false }`
- `GET /api/ai-messages/starred` — todos los mensajes starred con join a `ai_conversations` (title, started_at), ordenados por fecha desc

**Endpoints de contexto para el agente AI:**
- `GET /api/ai-transactions-context` — últimas 5 transacciones + total invertido en mes corriente y anterior en USD y GBP. Devuelve `{ tsv }`. Usado en el system prompt del chat en cada turn.
- `GET /api/ai-correlation-context` — correlaciones del portfolio a 90d en TSV compacto. Devuelve `{ tsv }` con: `vs_SPY` (correlación de cada posición vs SPY), `vs_portfolio` (aproximación ponderada corr(i, P) ≈ Σ_j w_j × corr(i,j)), `high_corr_pairs` (pares con |r| ≥ 0.7), matriz completa de pares. Replica la lógica de `buildCorrelationContext()` del frontend pero server-side — disponible siempre, independientemente de si el usuario abrió el tab Analytics.
- `GET /api/briefing-context` — arma el system prompt completo para el briefing diario. Fetcha posiciones, snapshots (day change, 7d, 30d), market fundamentals de las posiciones actuales via `fetchFundamentals()` directamente (no depende del cache del frontend), macro cache, y transacciones recientes. Devuelve `{ systemPrompt }`. Usado exclusivamente por `notification-worker.js`.

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
- **Una vez por día:** calcula la matriz de correlación de retornos para los 3 períodos (90d / 180d / 365d) y hace upsert en `correlation_matrix`

**Funciones de correlación:**
- `fetchDailyPriceMap(yahooTicker, range='400d')` — fetcha histórico de precios diarios desde Yahoo Finance. Retorna `{ 'YYYY-MM-DD': closePrice }`. El range 400d cubre los 3 períodos en un solo fetch.
- `buildAlignedReturns(mapA, mapB, fxMap, isGBP_A, isGBP_B, maxDays)` — hace inner join por fecha entre dos series de precios, aplica ajuste FX para tickers GBP, calcula log-returns. Descarta días donde cualquiera de los dos returns supera ±20% (outlier filter). Retorna `{ returnsA, returnsB, n }`.
- `pearsonCorrelation(a, b)` — correlación de Pearson estándar sobre dos arrays alineados.
- `runCorrelation(positions)` — orquesta todo: chequea si ya corrió hoy, fetcha GBPUSD una sola vez, fetcha price maps una vez por ticker, computa correlaciones para los 3 períodos reutilizando los mismos datos, hace upsert en `correlation_matrix`.

**Decisiones de diseño:**
- Los tickers GBP (`pricing_currency = 'GBP'`) se ajustan a USD antes de calcular returns, multiplicando cada close por el tipo de cambio GBPUSD del mismo día. Esto evita que el ruido FX contamine la correlación.
- El inner join por fecha (vs. alineación por posición) elimina el problema de días de mercado distintos entre UK y US.
- Los price maps se fetchean una sola vez por ticker con range=400d — los 3 períodos se calculan de esos mismos datos sin fetches adicionales.
- El chequeo de "ya corrió hoy" consulta `calculated_at` de la tabla. Para forzar recálculo manual: borrar filas de `correlation_matrix` en Supabase y reiniciar el worker.

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
- `DAILY_BRIEFING` handler: al tocar la notificación del briefing llama `focusOrOpenApp('/?briefing=1')`. La app detecta el parámetro al cargar, lo limpia con `history.replaceState` y abre el modal de briefing.

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

**Briefing diario (lunes a viernes, 5 min después del cierre NYSE):**
- `getNYSECloseUTC()` — calcula dinámicamente a qué minuto UTC corresponde las 16:00 ET usando `Intl.DateTimeFormat`. Maneja DST de EEUU y UK automáticamente sin offsets hardcodeados.
- `generateAndSendBriefing()` — fetcha el system prompt completo desde `GET /api/briefing-context` del service principal (incluye posiciones, P&L, day change, fundamentals actuales, macro, transacciones). Llama a `claude-sonnet-4-6` directamente desde el worker con `max_tokens: 600`. Guarda el resultado en `daily_briefings` (upsert por fecha, incluye el campo `prompt` con el system prompt completo para auditoría). Manda push con título "📊 Briefing financiero del día" con preview de 110 chars y texto completo en `data.fullText`.
- Variables de entorno adicionales requeridas: `ANTHROPIC_API_KEY`, `SERVER_INTERNAL_URL` (URL del service principal, ej: `https://personal-hub-julian.up.railway.app`).

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

---

## Arquitectura agentica del chat AI

### Concepto general

El asesor financiero tiene capacidades agénticas: puede consultar la base de datos y correr simulaciones de forma autónoma para responder preguntas que van más allá del contexto estático del system prompt. El modelo decide cuándo usar cada tool basándose en las descripciones y en el system prompt.

### Flujo de un request con tools

```
Frontend (ai.js)
  → POST /api/ai-chat { model, system, messages }

server.js — loop agentic
  → Llamada 1 a Anthropic (con AI_TOOLS)
      Si stop_reason = end_turn   → respuesta directa (0 tools, igual que antes)
      Si stop_reason = tool_use   → ejecutar tools server-side
          tool_use: query_db      → executeQueryDb() → Supabase REST
          tool_use: run_montecarlo → executeRunMontecarlo() → simulación Node.js
      → tool_result agregado al hilo
  → Llamada 2 a Anthropic (modelo procesa resultados)
      Si stop_reason = end_turn   → respuesta final
      Si stop_reason = tool_use   → más tools (hasta MAX_TOOL_ITERATIONS = 5)

Respuesta final al frontend:
  { content: [...], stop_reason, usage, _tool_calls_log: [...] }
```

### Cuándo usa cada tool

**`query_db`** — cuando la pregunta requiere datos históricos no presentes en el contexto:
- "¿Cuánto invertí en MELI en total?" → `transactions_by_ticker`
- "¿Cómo estuvo el portfolio en enero?" → `portfolio_history` con rango de fechas
- "¿Cuántos RSUs me quedan?" → `rsu_vests` con `vested_only: false`
- "¿Cuánto invertí en diciembre?" → `transactions_by_period`

**`run_montecarlo`** — cuando el usuario quiere proyecciones futuras:
- "¿Qué pasa si ahorro £600/mes los próximos 10 años?" → `years: 10, monthly_contribution_gbp: 600`
- "¿Cuándo llego a £100k?" → `target_gbp: 100000`
- "Simulación pesimista a 5 años" → `scenario: bear, years: 5`

**Sin tools** — responde directo si la info ya está en el contexto del system prompt:
- Composición actual del portfolio, P&L, health score, watchlist, macro

### Costos y control

- Cada iteración del loop = 1 llamada extra a la API de Anthropic
- Las llamadas intermedias usan el mismo `max_tokens` que el request original
- `MAX_TOOL_ITERATIONS = 5` como techo duro — si se supera, devuelve mensaje de error al usuario
- Los requests sin tools son idénticos en costo a antes (0 overhead)
- `_tool_calls_log` en la respuesta incluye `elapsed_ms` por tool para monitoreo

### Widget de tool calls en el chat (UI)

Componente: `aiRenderToolLog(toolLog, container)` en `ai.js`.

- Se muestra entre el thinking indicator y la respuesta del asistente
- Header colapsado: `🔧 N herramientas usadas` — tap para expandir
- Detalle expandido: una fila por tool con icono, nombre, descripción del input y tiempo de ejecución
- Se persiste en `ai_messages.tool_calls` (JSONB) y se re-renderiza al reabrir la conversación
- Clases CSS: `.ai-tools-used`, `.ai-tools-header`, `.ai-tools-summary`, `.ai-tools-chevron`, `.ai-tools-detail`, `.ai-tools-row`, `.ai-tools-row-{icon,name,desc,time}`

### Roadmap de tools (no implementadas aún)

- **`web_search`** (Tavily) — para noticias recientes, earnings, eventos de mercado. Pendiente de fase 4. No implementada por costo variable y riesgo de over-triggering.

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
| `correlation_matrix` | Matriz de correlación de retornos entre activos. Una fila por par ordenado (ticker_a, ticker_b) por período. PK: `(ticker_a, ticker_b, period_days)`. |
| `ai_conversations` | Una fila por sesión de chat. Campos: `id` (UUID), `started_at`, `model`, `title` (primeros 80 chars del primer mensaje), `message_count` (actualizado automáticamente por trigger). |
| `ai_messages` | Una fila por mensaje. Campos: `id`, `conversation_id`, `seq` (0-based global en la conversación), `role` (user/assistant), `content`, `model`, `input_tokens`, `output_tokens`, `context_start_seq` (seq del primer mensaje incluido como contexto en ese turn), `starred` (BOOLEAN DEFAULT false), `tool_calls` (JSONB — array de tool calls ejecutados, solo en mensajes assistant que usaron tools), `created_at`. |
| `daily_briefings` | Un registro por día con el briefing financiero generado por el worker. Campos: `id` (UUID), `date` (DATE UNIQUE), `content` (TEXT — markdown del briefing), `prompt` (TEXT — system prompt completo enviado a Claude, para auditoría), `generated_at` (TIMESTAMPTZ). |
| `daily_returns` | Retornos diarios por ticker calculados por el worker. Campos: `ticker`, `date`, `return_pct`, `close_usd`. Usado por el agente via `query_db` con `query_type: daily_returns` y como insumo para el Monte Carlo del servidor. |

### Schema de las tablas de chat history

```sql
CREATE TABLE ai_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  model         TEXT,
  title         TEXT,
  message_count INT DEFAULT 0  -- actualizado automáticamente por trigger
);

CREATE TABLE ai_messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    UUID REFERENCES ai_conversations(id) ON DELETE CASCADE,
  seq                INT NOT NULL,
  role               TEXT NOT NULL,
  content            TEXT NOT NULL,
  model              TEXT,
  input_tokens       INT,
  output_tokens      INT,
  context_start_seq  INT,     -- seq del primer msg incluido como contexto en este turn
  starred            BOOLEAN NOT NULL DEFAULT false,
  tool_calls         JSONB,   -- array de tool calls; solo en mensajes assistant, null en user
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_messages(conversation_id, seq);
CREATE INDEX ON ai_messages(starred) WHERE starred = true;

-- Trigger para mantener message_count actualizado automáticamente
CREATE OR REPLACE FUNCTION update_conversation_message_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ai_conversations
  SET message_count = (
    SELECT COUNT(*) FROM ai_messages
    WHERE conversation_id = NEW.conversation_id
  )
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_message_count
AFTER INSERT ON ai_messages
FOR EACH ROW EXECUTE FUNCTION update_conversation_message_count();

-- daily_briefings
CREATE TABLE daily_briefings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date         DATE NOT NULL UNIQUE,
  content      TEXT NOT NULL,
  prompt       TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Formato de `tool_calls` (JSONB):**
```json
[
  {
    "tool": "query_db",
    "input": { "query_type": "transactions_by_period", "filters": { "from_date": "2025-12-01", "to_date": "2025-12-31" } },
    "elapsed_ms": 146,
    "row_count": null,
    "error": null
  },
  {
    "tool": "run_montecarlo",
    "input": { "years": 10, "scenario": "neutral" },
    "elapsed_ms": 199,
    "row_count": null,
    "error": null
  }
]
```

### Schema de `correlation_matrix`

```sql
CREATE TABLE correlation_matrix (
  ticker_a      TEXT NOT NULL,
  ticker_b      TEXT NOT NULL,
  correlation   FLOAT NOT NULL,        -- Pearson, 3 decimales
  period_days   INT NOT NULL,          -- 90, 180 o 365
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker_a, ticker_b, period_days)
);
```

Cada par se guarda en ambas direcciones (A→B y B→A) para facilitar queries. La diagonal (ticker_a = ticker_b) siempre tiene `correlation = 1.0`.

**Para forzar recálculo manual:**
```sql
DELETE FROM correlation_matrix;
-- Luego reiniciar el worker o esperar el próximo tick (15 min)
```

---

### Cómo consultar el contexto de cualquier mensaje

Dado cualquier `seq` (user o assistant), devuelve ese mensaje y todo su contexto en orden:

```sql
SELECT seq, role, content
FROM ai_messages
WHERE conversation_id = '<uuid>'
  AND seq BETWEEN (
    SELECT context_start_seq FROM ai_messages
    WHERE conversation_id = '<uuid>' AND seq = 20
  ) AND 20
ORDER BY seq;
```

### Reglas importantes
- Las posiciones con `managed_by = 'transactions'` son calculadas automáticamente por `recalculator.js`. **No editarlas a mano en Supabase.**
- Las posiciones con `managed_by = 'manual'` (cash, rent deposit, etc.) se editan directo en Supabase.
- El worker siempre convierte precios a USD antes de guardar en `price_snapshots`.
- El campo `pricing_currency` en `positions` indica si el activo cotiza en GBP (ej: VWRP.L) o USD.
- `correlation_matrix` se calcula una vez por día. Los tickers con `pricing_currency = 'GBP'` se ajustan a USD antes de calcular correlaciones (se multiplica el precio por GBPUSD del mismo día). El inner join por fecha elimina la desalineación entre mercados UK y US.

---

## Arquitectura agentica del chat AI

### Concepto

El asesor financiero es un agente con capacidad de consultar datos reales y correr simulaciones. El frontend no cambia — manda el mismo request a `/api/ai-chat` y recibe la misma estructura de respuesta. Todo el loop ocurre server-side.

### Flujo completo

```
Usuario escribe mensaje
    ↓
ai.js construye system prompt:
  - bloque cacheado: portfolio, health, market (solo si liveData cambió)
  - secciones fresh: txContext, corrContext (server-side), macro, watchlist base/extended
    ↓
POST /api/ai-chat → server.js
    ↓
Loop agentic (max 5 iteraciones):
    → Llamada a Anthropic con AI_TOOLS definidos
    → stop_reason = "end_turn"  → devuelve respuesta final
    → stop_reason = "tool_use"  → ejecuta tool → agrega tool_result → repite
    ↓
Respuesta final + _tool_calls_log al frontend
    ↓
ai.js renderiza aiRenderToolLog() antes del mensaje
ai.js loggea tool_calls en ai_messages (Supabase)
```

### Tools disponibles

**`query_db`** — consulta datos históricos de Supabase. El modelo elige un `query_type` de un enum; el servidor construye el SQL internamente. El modelo nunca ve SQL raw. 8 query types: transacciones (by ticker / by period / all), portfolio history, price history, RSU vests, positions snapshot, daily returns.

**`run_montecarlo`** — simulación Monte Carlo server-side. Fetchea valores iniciales reales de Supabase (invested vs cash separados), corre 2000 simulaciones, devuelve percentiles y probabilidades para los goals de Julián.

### Cuándo usa tools el agente

El system prompt le instruye al modelo cuándo usar cada tool:
- Si la información ya está en el contexto (portfolio actual, posiciones, P&L) → responde directo, NO hace query.
- Si necesita datos históricos no incluidos en el contexto → `query_db`.
- Si el usuario pide proyecciones con parámetros específicos → `run_montecarlo`.

### Watchlist extendida — activación condicional

`needsExtendedWatchlist(userMsg)` decide si incluir `WATCHLIST_EXTENDED` (~50 tickers adicionales agrupados por tema) en el system prompt. Si no se activa, solo se incluye `WATCHLIST_BASE` (~14 tickers de referencia). Se activa por cualquiera de estas keywords (case-insensitive):

- **Intent:** `watchlist`, `comprar`, `agregar`, `comparar`, `busco`, `oportunidad`, `qué está barato`, `fundamentals`, `fwd pe`, `forward pe`, `compro`, `screener`, `qué comprarías`, `dónde metería`, `alternativa`, `diversificar`, `rotar`, `rotación`
- **Rioplatense / coloquial:** `pongo plata`, `vale la pena`, `conviene`, `qué conviene`, `fuera del portfolio`, `afuera del portfolio`, `por fuera`, `algo interesante`, `algo lindo`, `algo bueno`, `donde pongo`
- **Themes:** `latam`, `argentina`, `brasil`, `china`, `emergentes`, `bonos`, `bond`, `commodities`, `defensivo`, `dividendo`, `uk`, `cripto`, `crypto`, `india`
- **Tickers directos:** `aapl`, `amzn`, `tsm`, `ko`, `mcd`, `jnj`, `xom`, `vnq`, `xlk`, `xlf`, `xle`, `soxx`, `icln`, `vig`, `schd`, `inda`, `ewz`, `argt`, `ilf`, `fxi`, `kweb`, `baba`, `ief`, `hyg`, `iglt`, `vuke`, `slv`, `uso`, `pdbc`, `eth`, `sol`, `ypf`, `pbr`, `ggal`

### Widget de tools en el chat

`aiRenderToolLog(toolLog, container)` — función reutilizable en `ai.js`. Construye un elemento `.ai-tools-used` con:
- **Header colapsado** (siempre visible): `🔧 N herramientas usadas` con chevron `›`.
- **Detalle expandible** (tap para abrir): una fila por tool con icono, nombre, descripción del input y elapsed ms.
- Se inserta **antes** del mensaje del asistente en el DOM.
- Se usa tanto en el live chat (con `_tool_calls_log` de la respuesta) como al reabrir conversaciones históricas (con `tool_calls` de la DB).

### Persistencia

`tool_calls` (JSONB) en `ai_messages`: se guarda en cada mensaje del asistente que usó tools. `null` en mensajes que no usaron tools y en todos los mensajes del usuario. Esto permite reconstruir el widget exactamente igual al reabrir una conversación vieja.

### Logs en Railway

Cada request al agente genera:
```
[ai-chat] ← request | model: claude-sonnet-4-6 | system: 8880 chars | messages: 6
[ai-chat] ← user_msg: cuánto invertí en MELI en total?
[ai-chat] ← system_preview: You are Julián's personal financial advisor...
[ai-chat] iteración 1 — mensajes: 6
[ai-chat] ejecutando tool: query_db {"query_type":"transactions_by_ticker",...}
[ai-chat] tool query_db OK (243ms) | rows: 4 | preview: {...}
[ai-chat] iteración 2 — mensajes: 8
[ai-chat] → response | stop: end_turn | iterations: 2 | tokens in: 9841 out: 187 | cache_read: 5877
[ai-chat] → reply_preview: Invertiste un total de...
[ai-chat] tools usadas: query_db | iteraciones: 2
```

### Costo y límites

- Sin tools: 1 llamada a Anthropic por turno (igual que antes).
- Con tools: 1 llamada adicional por cada iteración del loop. Típicamente 2 llamadas (1 tool call) o 3 (2 tool calls encadenados).
- Las llamadas intermedias usan el mismo `max_tokens` configurado — se puede bajar para tool calls intermedias si el costo es un problema.
- Techo duro: `MAX_TOOL_ITERATIONS = 5`.

### Optimización de tokens (abril 2026)

**Baseline original:** ~7.460 tokens por request.  
**Estado actual:** ~6.200 tokens primer mensaje, ~390 tokens mensajes 2+ (con cache).

**Cambios realizados:**

1. **AI_TOOLS reescritas en inglés + descriptions recortadas** (`server.js`) — de 2.125 a 1.415 tokens (-710). Las descriptions verbosas en español tokenizaban muy mal (~1.94 chars/token vs ~3.5 en inglés plano).

2. **System prompt en inglés** (`ai.js`, función `aiSendMsg`) — header, PROFILE, CASHFLOW, RULES y fxLine traducidos al inglés. El idioma de respuesta se mantiene español via instrucción explícita `Reply in Spanish`.

3. **VEST_SCHEDULE_PENDING recortado** (`ai.js`, `buildPortfolioContext`) — de todos los vests (16 filas) a próximos 4 + resumen (`...+N vests (Xu gross $Y net $Z through date)`).

4. **buildHealthContext trimado** — notas verbosas eliminadas, labels compactados.

5. **buildMacroContext** — columna `label` (nombres en español) eliminada del TSV.

6. **buildMarketContext** — filas vacías (tickers fallback sin datos live) filtradas.

7. **Prompt caching activado** (`server.js`, `callAnthropic`) — header `anthropic-beta: prompt-caching-2024-07-31` + system prompt como array con `cache_control: { type: 'ephemeral' }`. El cache dura 5 min y se resetea con cada hit. Mensajes 2+ en una sesión activa pagan ~10% del costo del system prompt.

8. **System prompt cache en JS** (`ai.js`, `_cachedSystemPrompt`) — el bloque pesado del system prompt (portfolio, health, market) se reconstruye solo cuando cambia `liveData` (clave = `captured_at` del snapshot más reciente). En una conversación normal dentro de la misma sesión, `buildPortfolioContext()`, `buildHealthContext()` y `buildMarketContext()` se ejecutan una sola vez. Las secciones dinámicas (txSection, corrSection, wlExtended) se concatenan fresh en cada mensaje.

**Cómo medir el costo real:**
- La consola de Anthropic muestra `input_tokens` brutos (no refleja el descuento del cache).
- El log de Railway muestra `cache_read: N` cuando hay cache hit — esos N tokens cuestan 10x menos.
- `GET /api/token-diag` — endpoint de diagnóstico temporal (mide costo con/sin tools con system="x").

**Overhead fijo medido:**
- Sin nada (system="x", message="x"): 10 tokens
- AI_TOOLS solos: 1.415 tokens
- System prompt (~8.880 chars): ~4.780 tokens
- Total sin cache: ~6.200 tokens
- Total con cache (turn 2+): ~390 tokens input efectivo

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

| Variable adicional | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | Misma key que el service principal. Usada para generar el briefing. |
| `SERVER_INTERNAL_URL` | URL del service principal para fetchear el contexto del briefing. Ej: `https://personal-hub-julian.up.railway.app`. Intentar con URL privada (`http://personal-hub.railway.internal:3000`) si Private Networking está habilitado. |

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