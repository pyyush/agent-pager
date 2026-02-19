#!/usr/bin/env bash
# Shared hook logic: detect tmux, inject metadata, POST to bridge.
# Expects AGENT_PAYLOAD env var to contain the JSON payload.
# Expects AGENT_NAME env var to identify the agent (claude, codex, etc.).
# Usage: source this file, then call post_to_bridge "/endpoint"
set -euo pipefail

SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SHARED_DIR/../.." && pwd)"
BRIDGE_PORT="${BRIDGE_PORT:-7890}"

# Load BRIDGE_SECRET from .env if not already set
if [ -z "${BRIDGE_SECRET:-}" ] && [ -f "$BRIDGE_DIR/.env" ]; then
  BRIDGE_SECRET=$(grep '^BRIDGE_SECRET=' "$BRIDGE_DIR/.env" | cut -d= -f2- || true)
  # Strip surrounding quotes (dotenv strips them; we must match)
  BRIDGE_SECRET="${BRIDGE_SECRET#\"}"
  BRIDGE_SECRET="${BRIDGE_SECRET%\"}"
  BRIDGE_SECRET="${BRIDGE_SECRET#\'}"
  BRIDGE_SECRET="${BRIDGE_SECRET%\'}"
fi

post_to_bridge() {
  local endpoint="$1"

  # Detect tmux session — exit silently if not in tmux
  local tmux_session
  tmux_session=$("$SHARED_DIR/detect-tmux.sh" 2>/dev/null || true)
  if [ -z "$tmux_session" ]; then
    return 0
  fi

  # Inject tmux_session and _agent into payload via node (no shell interpolation of JSON)
  local payload
  payload=$(TMUX_SESSION="$tmux_session" AGENT_NAME="${AGENT_NAME:-unknown}" node -e "
    const data = JSON.parse(process.env.AGENT_PAYLOAD);
    data.tmux_session = process.env.TMUX_SESSION;
    data._agent = process.env.AGENT_NAME;
    process.stdout.write(JSON.stringify(data));
  " 2>/dev/null) || return 0

  # Build auth header if BRIDGE_SECRET is set
  local auth_header=()
  if [ -n "${BRIDGE_SECRET:-}" ]; then
    auth_header=(-H "X-Bridge-Token: ${BRIDGE_SECRET}")
  fi

  # POST to bridge (fire-and-forget)
  curl -s -X POST "http://127.0.0.1:${BRIDGE_PORT}${endpoint}" \
    -H "Content-Type: application/json" \
    "${auth_header[@]}" \
    -d "$payload" \
    --connect-timeout 2 \
    --max-time 5 \
    &>/dev/null &
}
