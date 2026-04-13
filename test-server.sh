#!/usr/bin/env bash
# Corre con el server ya levantado: node server.js &
# Uso: bash test-server.sh [PORT]

BASE="http://localhost:${1:-3000}"
PASS=0; FAIL=0

check() {
  local label="$1" expected="$2"
  shift 2
  local body
  body=$(curl -sf "$@" 2>/dev/null)
  local status=$?
  if [ $status -ne 0 ]; then
    echo "❌ $label — curl failed (network/connection error)"
    FAIL=$((FAIL+1))
    return
  fi
  if echo "$body" | grep -q "$expected"; then
    echo "✅ $label"
    PASS=$((PASS+1))
  else
    echo "❌ $label — esperaba '$expected', got: ${body:0:120}"
    FAIL=$((FAIL+1))
  fi
}

echo "=== Personal Hub — smoke tests ==="
echo "Base: $BASE"
echo ""

# Config
check "GET /api/config — devuelve anthropicKey"         '"anthropicKey"'     "$BASE/api/config"

# Supabase proxy (solo verifica que el proxy forwarda, no que Supabase tenga datos)
check "GET /api/db/positions — proxy responde"          '\[' \
  "$BASE/api/db/positions?select=ticker&limit=1"

# Chart
check "GET /api/chart/1S — devuelve array"              '\[' \
  "$BASE/api/chart/1S"
check "GET /api/chart/INVALID — 400"                    '"error"' \
  "$BASE/api/chart/INVALID"

# Market data (puede fallar si Yahoo está caído, se acepta cualquier JSON)
check "GET /api/market-data sin tickers — {}"           '"data":{}' \
  "$BASE/api/market-data"
check "GET /api/market-data con ticker — devuelve data" '"data"' \
  "$BASE/api/market-data?tickers=SPY"

# Macro
check "GET /api/macro-data — devuelve data"             '"data"' \
  "$BASE/api/macro-data"

# Watchlist (puede tardar, tiene cache de 1h)
check "GET /api/watchlist-data — devuelve data"         '"data"' \
  "$BASE/api/watchlist-data"

# AI context helpers
check "GET /api/ai-transactions-context — devuelve tsv" '"tsv"' \
  "$BASE/api/ai-transactions-context"
check "GET /api/ai-correlation-context — devuelve tsv"  '"tsv"' \
  "$BASE/api/ai-correlation-context"
check "GET /api/briefing-context — devuelve systemPrompt" '"systemPrompt"' \
  "$BASE/api/briefing-context"

# AI conversations CRUD
CONV=$(curl -sf -X POST "$BASE/api/ai-conversations" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-6","title":"test"}' 2>/dev/null)
CONV_ID=$(echo "$CONV" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$CONV_ID" ]; then
  echo "✅ POST /api/ai-conversations — id: ${CONV_ID:0:8}..."
  PASS=$((PASS+1))

  check "GET /api/ai-conversations — lista conversaciones" '"id"' \
    "$BASE/api/ai-conversations"

  check "GET /api/ai-conversations/:id/messages — array" '\[' \
    "$BASE/api/ai-conversations/$CONV_ID/messages"

  # Cleanup
  curl -sf -X DELETE "$BASE/api/ai-conversations/$CONV_ID" > /dev/null 2>&1
  echo "   (conversación de test eliminada)"
else
  echo "❌ POST /api/ai-conversations — no devolvió id. Body: ${CONV:0:120}"
  FAIL=$((FAIL+1))
fi

# Water
check "GET /api/water/today — devuelve total_ml" '"total_ml"' \
  "$BASE/api/water/today"

# Habits
TODAY=$(date +%Y-%m-%d)
check "GET /api/habits/daily/:date — responde (204 o JSON)" '' \
  -w "%{http_code}" -o /dev/null "$BASE/api/habits/daily/$TODAY"

check "GET /api/habits/oneshots — responde (204 o JSON)"    '' \
  -w "%{http_code}" -o /dev/null "$BASE/api/habits/oneshots"

# Push
check "GET /api/push/vapid-public-key — responde"         '' \
  -w "%{http_code}" -o /dev/null "$BASE/api/push/vapid-public-key"

# SPA catch-all
check "GET /nonexistent — sirve index.html"               'html' \
  "$BASE/nonexistent-route-xyz"

echo ""
echo "=== Resultado: $PASS pasaron, $FAIL fallaron ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1