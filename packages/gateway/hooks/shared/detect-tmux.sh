#!/usr/bin/env bash
# detect-tmux.sh — Detect if running inside tmux and output session info.
#
# Used by hook scripts to tag events with tmux session context.
# Outputs JSON to stdout. Exits 0 regardless of whether tmux is found.
#
# Output format:
#   { "in_tmux": true, "session": "ap-cc-abc123", "pane": "%4" }
#   { "in_tmux": false }

set -euo pipefail

if [ -n "${TMUX:-}" ]; then
  SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || echo "")
  PANE_ID=$(tmux display-message -p '#{pane_id}' 2>/dev/null || echo "")
  WINDOW_INDEX=$(tmux display-message -p '#{window_index}' 2>/dev/null || echo "")

  if [ -n "$SESSION_NAME" ]; then
    printf '{"in_tmux":true,"session":"%s","pane":"%s","window":"%s"}\n' \
      "$SESSION_NAME" "$PANE_ID" "$WINDOW_INDEX"
    exit 0
  fi
fi

printf '{"in_tmux":false}\n'
exit 0
