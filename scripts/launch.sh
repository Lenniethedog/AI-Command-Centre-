#!/bin/bash
# Starts the AI Command Centre and opens it in the browser.
#
# Idempotent: if something is already running it is reused rather than
# restarted, so double-clicking the icon twice does not spawn duplicates.
# Lives in the repo (version-controlled); the .app bundle is a thin shim.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT" || exit 1

API_PORT=8787
WEB_PORT=5173
SEARX_PORT=8888
SEARX_HOME="$HOME/.local/share/searxng"
LOG_DIR="$PROJECT_ROOT/data/logs"
mkdir -p "$LOG_DIR"

notify() { osascript -e "display notification \"$1\" with title \"AI Command Centre\"" 2>/dev/null || true; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_for_port() {
  local port=$1 tries=${2:-60}
  for _ in $(seq 1 "$tries"); do
    listening "$port" && return 0
    sleep 0.5
  done
  return 1
}

fail() {
  notify "$1"
  osascript -e "display dialog \"$1\" with title \"AI Command Centre\" buttons {\"OK\"} default button 1 with icon caution" 2>/dev/null
  exit 1
}

# --- 1. local model runtime -------------------------------------------------
if ! curl -fsS --max-time 3 "http://127.0.0.1:11434/api/version" >/dev/null 2>&1; then
  notify "Starting the local model runtime…"
  if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q '^ollama'; then
    brew services start ollama >/dev/null 2>&1
  else
    command -v ollama >/dev/null 2>&1 || fail "Ollama is not installed. Install it with: brew install ollama"
    nohup ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
  fi
  sleep 3
  curl -fsS --max-time 5 "http://127.0.0.1:11434/api/version" >/dev/null 2>&1 ||
    fail "Could not start the local model runtime. Try: brew services start ollama"
fi

# --- 2. dependencies --------------------------------------------------------
if [ ! -d node_modules ]; then
  notify "Installing dependencies (first run only)…"
  npm install >"$LOG_DIR/install.log" 2>&1 || fail "npm install failed. See data/logs/install.log"
fi

# --- 3. web search ----------------------------------------------------------
# Optional by design. SearXNG missing means the web.search tool is not
# registered and the Command Centre runs on Wikipedia alone — degraded, but
# working. It must never become a precondition for starting.
if [ -x "$SEARX_HOME/.venv/bin/python" ] && ! listening "$SEARX_PORT"; then
  notify "Starting local web search…"
  (
    cd "$SEARX_HOME" &&
    SEARXNG_SETTINGS_PATH="$SEARX_HOME/settings.yml" \
      nohup ./.venv/bin/python -m searx.webapp >"$LOG_DIR/searxng.log" 2>&1 &
  )
  # Engine initialisation is slow — roughly 40s on a cold start — so this waits
  # longer than the other services, and carries on regardless if it times out.
  wait_for_port "$SEARX_PORT" 120 ||
    notify "Web search did not start; continuing with Wikipedia only."
fi

# --- 4. API -----------------------------------------------------------------
if ! listening "$API_PORT"; then
  nohup npx tsx src/index.ts >"$LOG_DIR/api.log" 2>&1 &
  wait_for_port "$API_PORT" || fail "The API did not start. See data/logs/api.log"
fi

# --- 5. interface -----------------------------------------------------------
if ! listening "$WEB_PORT"; then
  nohup npx vite >"$LOG_DIR/web.log" 2>&1 &
  wait_for_port "$WEB_PORT" || fail "The interface did not start. See data/logs/web.log"
fi

# --- 6. open ----------------------------------------------------------------
open "http://127.0.0.1:$WEB_PORT"
notify "Ready — running locally at £0"
