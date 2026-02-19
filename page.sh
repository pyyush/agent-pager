# Agent Pager — tmux wrapper
# Source this file in your shell rc (e.g. ~/.zshrc):
#   source /path/to/agent-pager/page.sh

# Start a new agent session inside tmux
# Usage: page <task>            (uses default agent)
#        page codex <task>      (uses codex)
#        page claude <task>     (uses claude)
page() {
  local agent="${PAGER_DEFAULT_AGENT:-claude}"
  local binary=""
  local prefix=""
  local launch_args=""

  # Check if first arg is an agent name
  case "$1" in
    claude)
      agent="claude"; shift ;;
    codex)
      agent="codex"; shift ;;
  esac

  # Resolve agent to binary, prefix, and default launch flags
  case "$agent" in
    claude)
      binary="claude"; prefix="cc"; launch_args="" ;;
    codex)
      binary="codex"; prefix="cx"; launch_args="--full-auto" ;;
    *)
      echo "Unknown agent: $agent"
      echo "Supported: claude, codex"
      return 1 ;;
  esac

  local name="${prefix}-$(date +%s | cut -c6-10)"

  # Use -- to pass args directly to the binary (no sh -c interpretation)
  if [ $# -eq 0 ]; then
    # Interactive — no task argument
    if [ -n "$launch_args" ]; then
      tmux new-session -d -s "$name" -- "$binary" $launch_args
    else
      tmux new-session -d -s "$name" -- "$binary"
    fi
  else
    # Task provided — pass as a single positional argument
    if [ -n "$launch_args" ]; then
      tmux new-session -d -s "$name" -- "$binary" $launch_args "$*"
    else
      tmux new-session -d -s "$name" -- "$binary" "$*"
    fi
  fi

  echo "Session: $name ($agent)"
  tmux attach -t "$name"
}

# Attach to an existing agent tmux session
# Usage: pagea           (pick from all agents)
#        pagea codex     (pick from codex sessions only)
pagea() {
  local filter=""
  case "$1" in
    claude) filter="^cc-" ;;
    codex)  filter="^cx-" ;;
    *)      filter="^(cc|cx)-" ;;
  esac

  local sessions
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E "$filter" || true)

  if [ -z "$sessions" ]; then
    echo "No active agent sessions."
    return 1
  fi

  local count
  count=$(echo "$sessions" | wc -l | tr -d ' ')

  if [ "$count" -eq 1 ]; then
    tmux attach -t "$sessions"
  else
    echo "Active sessions:"
    echo "$sessions" | nl -ba
    echo -n "Attach to (number): "
    read -r num
    local target
    target=$(echo "$sessions" | sed -n "${num}p")
    if [ -n "$target" ]; then
      tmux attach -t "$target"
    else
      echo "Invalid selection."
    fi
  fi
}

# List active agent sessions
pagel() {
  local sessions
  sessions=$(tmux list-sessions -F '#{session_name}: #{session_windows} windows (#{session_activity})' 2>/dev/null | grep -E '^(cc|cx)-' || true)

  if [ -z "$sessions" ]; then
    echo "No active agent sessions."
  else
    echo "Active agent sessions:"
    echo "$sessions"
  fi
}

# Check bridge health
pageb() {
  local port="${BRIDGE_PORT:-7890}"
  local result
  result=$(curl -s "http://127.0.0.1:${port}/health" 2>/dev/null) || { echo "Agent Pager not running on port $port"; return 1; }
  # Pretty-print via node (already a required dependency)
  node -e "console.log(JSON.stringify(JSON.parse(process.argv[1]),null,2))" "$result" 2>/dev/null || echo "$result"
}
