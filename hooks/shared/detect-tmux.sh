#!/usr/bin/env bash
# Detect which tmux session this process is running inside.
# Walks up the process tree until it finds a PID that matches a tmux pane.
# Prints the session name to stdout, or empty string if not in tmux.

detect_tmux_session() {
  # Method 1: $TMUX env var is set (fastest)
  if [ -n "${TMUX:-}" ]; then
    tmux display-message -p '#S' 2>/dev/null && return
  fi

  # Method 2: Walk PID tree up to find a tmux pane ancestor
  local pane_map
  pane_map=$(tmux list-panes -a -F '#{pane_pid} #{session_name}' 2>/dev/null) || return

  local pid=$$
  local max_depth=20
  while [ "$pid" -gt 1 ] && [ "$max_depth" -gt 0 ]; do
    local match
    match=$(echo "$pane_map" | awk -v p="$pid" '$1 == p { print $2 }')
    if [ -n "$match" ]; then
      echo "$match"
      return
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    max_depth=$((max_depth - 1))
  done

}

detect_tmux_session
