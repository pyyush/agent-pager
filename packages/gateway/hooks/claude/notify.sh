#!/usr/bin/env bash
# notify.sh — Backward-compatible Claude Code notification hook.
#
# Uses curl to POST to the HTTP endpoint. Works without Bun installed.
# Reads auth token from AGENTPAGER_TOKEN or BRIDGE_SECRET env vars.
# Always exits 0 (fire-and-forget).

set -euo pipefail

AGENTPAGER_PORT="${AGENTPAGER_PORT:-${BRIDGE_PORT:-7890}}"
AGENTPAGER_HOST="http://127.0.0.1:${AGENTPAGER_PORT}"
TOKEN="${AGENTPAGER_TOKEN:-${BRIDGE_SECRET:-}}"

# Read stdin (the hook event JSON)
PAYLOAD=$(cat)

# Build auth header
AUTH_HEADER=""
if [ -n "$TOKEN" ]; then
  AUTH_HEADER="-H X-AgentPager-Token: ${TOKEN}"
fi

# POST to gateway — fail silently (hooks should never block the agent)
# shellcheck disable=SC2086
curl -s -X POST \
  "${AGENTPAGER_HOST}/hook/claude/Notification" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER} \
  -d "$PAYLOAD" \
  --max-time 5 \
  -o /dev/null \
  2>/dev/null || true

exit 0
