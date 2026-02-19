#!/usr/bin/env bash
# Agent Pager — Setup Script
# Run: bash setup.sh

set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="${BRIDGE_DIR}/hooks"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
CODEX_CONFIG="${HOME}/.codex/config.toml"

# ─── Platform detection ──────────────────────────────────────────────────────────

PLATFORM="unknown"
IS_WSL=false
PKG_MGR="manual"

case "$(uname -s)" in
  Darwin) PLATFORM="macos"; PKG_MGR="brew" ;;
  Linux)
    PLATFORM="linux"
    if grep -qi microsoft /proc/version 2>/dev/null; then
      IS_WSL=true
    fi
    if command -v apt-get &>/dev/null; then
      PKG_MGR="apt"
    elif command -v dnf &>/dev/null; then
      PKG_MGR="dnf"
    elif command -v pacman &>/dev/null; then
      PKG_MGR="pacman"
    fi
    ;;
esac

# Shell RC file
if [ -f "${HOME}/.zshrc" ]; then
  SHELL_RC="${HOME}/.zshrc"
elif [ -f "${HOME}/.bashrc" ]; then
  SHELL_RC="${HOME}/.bashrc"
else
  SHELL_RC=""
fi

echo "╔══════════════════════════════════════════════════════╗"
echo "║   Agent Pager — Setup                               ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

if [ "$IS_WSL" = true ]; then
  echo "  Platform: Linux (WSL)"
else
  echo "  Platform: ${PLATFORM}"
fi
echo ""

# ─── Step 0: Check dependencies ────────────────────────────────────────────────

echo "━━━ Step 0: Check dependencies ━━━"
echo ""

check_deps() {
  local missing=()
  local install_cmds=()

  if ! command -v node &>/dev/null; then
    case "$PKG_MGR" in
      brew) missing+=("node"); install_cmds+=("brew install node") ;;
      apt)  missing+=("node"); install_cmds+=("curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs") ;;
      *)    missing+=("node (https://nodejs.org)") ;;
    esac
  fi

  if ! command -v tmux &>/dev/null; then
    case "$PKG_MGR" in
      brew) missing+=("tmux"); install_cmds+=("brew install tmux") ;;
      apt)  missing+=("tmux"); install_cmds+=("sudo apt-get install -y tmux") ;;
      dnf)  missing+=("tmux"); install_cmds+=("sudo dnf install -y tmux") ;;
      pacman) missing+=("tmux"); install_cmds+=("sudo pacman -S --noconfirm tmux") ;;
      *)    missing+=("tmux") ;;
    esac
  fi

  if ! command -v freeze &>/dev/null; then
    case "$PKG_MGR" in
      brew) missing+=("freeze"); install_cmds+=("brew install charmbracelet/tap/freeze") ;;
      *)    missing+=("freeze (go install github.com/charmbracelet/freeze@latest)") ;;
    esac
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    echo "  Missing dependencies:"
    for dep in "${missing[@]}"; do echo "    • $dep"; done
    echo ""

    if [ ${#install_cmds[@]} -gt 0 ]; then
      read -rp "  Install automatically? (Y/n) " do_install
      if [ "$do_install" != "n" ] && [ "$do_install" != "N" ]; then
        for cmd in "${install_cmds[@]}"; do
          echo "  Running: $cmd"
          eval "$cmd"
        done
        echo "  ✓ Dependencies installed"
      else
        echo "  Continuing without installing (some features may not work)"
      fi
    else
      echo "  Install these manually and re-run setup."
    fi
  else
    echo "  ✓ All dependencies found (node, tmux, freeze)"
  fi
}

check_deps
echo ""

# ─── Step 1: Agent selection ─────────────────────────────────────────────────────

echo "━━━ Step 1: Select agents ━━━"
echo ""
echo "  Which agents do you want to use?"
echo "    1) Claude Code only"
echo "    2) Codex CLI only"
echo "    3) Both"
echo ""
read -rp "  Choice (1/2/3): " agent_choice

SETUP_CLAUDE=false
SETUP_CODEX=false

case "$agent_choice" in
  1) SETUP_CLAUDE=true ;;
  2) SETUP_CODEX=true ;;
  3) SETUP_CLAUDE=true; SETUP_CODEX=true ;;
  *) echo "  Invalid choice, defaulting to Claude Code only"; SETUP_CLAUDE=true ;;
esac

echo ""

# ─── Step 2: Create Slack App ────────────────────────────────────────────────────

echo "━━━ Step 2: Create a Slack App ━━━"
echo ""
echo "  Option A — Use the app manifest (recommended):"
echo "    1. Go to: https://api.slack.com/apps"
echo "    2. Click 'Create New App' → 'From an app manifest'"
echo "    3. Select your workspace"
echo "    4. Choose YAML, paste the contents of:"
echo "       ${BRIDGE_DIR}/slack-app-manifest.yml"
echo "    5. Click 'Create'"
echo ""
echo "  Option B — Manual setup:"
echo "    1. Go to: https://api.slack.com/apps"
echo "    2. Click 'Create New App' → 'From scratch'"
echo "    3. Name: 'Agent Pager', pick your workspace"
echo ""
echo "  Then for both options:"
echo "    1. Enable Socket Mode:"
echo "       Settings → Socket Mode → Toggle ON"
echo "       Generate an App-Level Token:"
echo "         Name: 'pager-socket'"
echo "         Scope: connections:write"
echo "         → Copy the xapp-... token"
echo ""
echo "    2. Install App to Workspace:"
echo "       OAuth & Permissions → Install to Workspace"
echo "       → Copy the xoxb-... Bot Token"
echo ""
echo "    3. Get your Slack User ID (for DM mode):"
echo "       Click your profile in Slack → '...' → 'Copy member ID'"
echo ""

read -rp "Press Enter when you've completed the Slack app setup..."
echo ""

# ─── Step 3: Configure .env ─────────────────────────────────────────────────────

echo "━━━ Step 3: Configure tokens ━━━"
echo ""

ENV_FILE="${BRIDGE_DIR}/.env"

if [ -f "$ENV_FILE" ]; then
  echo "  .env already exists. Overwrite? (y/N)"
  read -r overwrite
  if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
    echo "  Keeping existing .env"
    echo ""
  else
    rm "$ENV_FILE"
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  read -rp "  Bot Token (xoxb-...): " BOT_TOKEN
  read -rp "  App Token (xapp-...): " APP_TOKEN
  echo ""
  read -rp "  Your Slack User ID (click profile → '...' → Copy member ID): " USER_ID

  # Generate BRIDGE_SECRET
  BRIDGE_SECRET=$(openssl rand -hex 32)

  # Determine default agent
  DEFAULT_AGENT="claude"
  if [ "$SETUP_CODEX" = true ] && [ "$SETUP_CLAUDE" = false ]; then
    DEFAULT_AGENT="codex"
  fi

  cat > "$ENV_FILE" <<EOF
SLACK_BOT_TOKEN=${BOT_TOKEN}
SLACK_APP_TOKEN=${APP_TOKEN}
SLACK_USER_ID=${USER_ID}
BRIDGE_PORT=7890
BRIDGE_SECRET=${BRIDGE_SECRET}
PAGER_DEFAULT_AGENT=${DEFAULT_AGENT}
LOG_LEVEL=info
EOF

  echo "  ✓ .env created (BRIDGE_SECRET auto-generated)"
  echo ""
fi

# ─── Step 4: Install dependencies ───────────────────────────────────────────────

echo "━━━ Step 4: Install dependencies ━━━"
echo ""

cd "$BRIDGE_DIR"
if [ -d "node_modules" ]; then
  echo "  node_modules exists, skipping install."
else
  echo "  Running npm install..."
  npm install --production
fi
echo ""

# ─── Step 5: Configure agent hooks ───────────────────────────────────────────────

echo "━━━ Step 5: Configure agent hooks ━━━"
echo ""

# --- Claude Code hooks ---
if [ "$SETUP_CLAUDE" = true ]; then
  echo "  ── Claude Code ──"
  echo ""

  # Ensure ~/.claude directory exists
  mkdir -p "$(dirname "$CLAUDE_SETTINGS")"

  # Build the hooks config
  HOOKS_JSON=$(cat <<HEOF
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${HOOKS_DIR}/claude/notify.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${HOOKS_DIR}/claude/stop.sh"
          }
        ]
      }
    ]
  }
}
HEOF
)

  if [ -f "$CLAUDE_SETTINGS" ]; then
    echo "  Claude settings file exists: $CLAUDE_SETTINGS"
    echo ""
    echo "  Current hooks config (if any):"
    SETTINGS_PATH="$CLAUDE_SETTINGS" node -e "
      const s = JSON.parse(require('fs').readFileSync(process.env.SETTINGS_PATH, 'utf8'));
      console.log(JSON.stringify(s.hooks || {}, null, 2));
    " 2>/dev/null || echo "  (could not read)"
    echo ""
    echo "  The bridge needs these hooks added to your settings."
    echo "  Merge automatically? (Y/n)"
    read -r merge
    if [ "$merge" = "n" ] || [ "$merge" = "N" ]; then
      echo ""
      echo "  Add this to $CLAUDE_SETTINGS manually:"
      echo "$HOOKS_JSON"
      echo ""
    else
      # Merge hooks into existing settings (paths passed via env vars, not interpolated into JS)
      SETTINGS_PATH="$CLAUDE_SETTINGS" NEW_HOOKS="$HOOKS_JSON" node -e "
        const fs = require('fs');
        const settings = JSON.parse(fs.readFileSync(process.env.SETTINGS_PATH, 'utf8'));
        const newHooks = JSON.parse(process.env.NEW_HOOKS);

        // Merge: append to existing arrays or create new ones
        if (!settings.hooks) settings.hooks = {};
        for (const [event, rules] of Object.entries(newHooks.hooks)) {
          if (!settings.hooks[event]) settings.hooks[event] = [];
          // Avoid duplicates by checking command path
          for (const rule of rules) {
            const exists = settings.hooks[event].some(existing =>
              existing.hooks?.some(h => rule.hooks?.some(rh => h.command === rh.command))
            );
            if (!exists) settings.hooks[event].push(rule);
          }
        }

        // Remove stale old-style hooks (flat hooks/ directory)
        for (const event of ['Notification', 'Stop']) {
          if (settings.hooks[event]) {
            settings.hooks[event] = settings.hooks[event].filter(rule =>
              !rule.hooks?.some(h => {
                const cmd = h.command || '';
                return (cmd.endsWith('/hooks/notify.sh') || cmd.endsWith('/hooks/stop.sh'))
                  && !cmd.includes('/hooks/claude/');
              })
            );
          }
        }

        // Remove stale tool-use.sh hooks if present
        if (settings.hooks.PreToolUse) {
          settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(rule =>
            !rule.hooks?.some(h => h.command?.includes('tool-use.sh'))
          );
          if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
        }

        fs.writeFileSync(process.env.SETTINGS_PATH, JSON.stringify(settings, null, 2));
        console.log('  ✓ Claude Code hooks merged into settings');
      " 2>/dev/null || {
        echo "  ✗ Failed to merge. Add hooks manually."
        echo "$HOOKS_JSON"
      }
    fi
  else
    echo "  Creating $CLAUDE_SETTINGS with hooks..."
    echo "$HOOKS_JSON" > "$CLAUDE_SETTINGS"
    echo "  ✓ Settings created"
  fi
  echo ""
fi

# --- Codex CLI hooks ---
if [ "$SETUP_CODEX" = true ]; then
  echo "  ── Codex CLI ──"
  echo ""

  mkdir -p "$(dirname "$CODEX_CONFIG")"

  CODEX_HOOK_LINE="notify = [\"${HOOKS_DIR}/codex/notify.sh\"]"

  if [ -f "$CODEX_CONFIG" ]; then
    if grep -q "codex/notify.sh" "$CODEX_CONFIG" 2>/dev/null; then
      echo "  ✓ Codex hook already configured in $CODEX_CONFIG"
    elif grep -q '^notify\s*=' "$CODEX_CONFIG" 2>/dev/null; then
      # Existing notify key — replace it (TOML doesn't allow duplicates)
      echo "  Found existing notify config — replacing with Agent Pager hook"
      perl -i -pe "s|^notify\s*=.*|${CODEX_HOOK_LINE}|" "$CODEX_CONFIG"
      echo "  ✓ Codex notify hook replaced"
    else
      echo "  Adding notify hook to $CODEX_CONFIG"
      echo "" >> "$CODEX_CONFIG"
      echo "# Agent Pager notification hook" >> "$CODEX_CONFIG"
      echo "$CODEX_HOOK_LINE" >> "$CODEX_CONFIG"
      echo "  ✓ Codex hook added"
    fi
  else
    echo "  Creating $CODEX_CONFIG with notify hook..."
    cat > "$CODEX_CONFIG" <<CEOF
# Codex CLI configuration
# Agent Pager notification hook
${CODEX_HOOK_LINE}
CEOF
    echo "  ✓ Codex config created"
  fi
  echo ""
fi

# ─── Step 6: Shell integration ───────────────────────────────────────────────────

echo "━━━ Step 6: Shell integration ━━━"
echo ""
echo "  This gives you:"
echo "    page <task>          — Start agent in tmux"
echo "    page codex <task>   — Start Codex CLI in tmux"
echo "    page claude <task>  — Start Claude Code in tmux"
echo "    pagea               — Attach to a running session"
echo "    pagel               — List active sessions"
echo "    pageb               — Check bridge health"
echo ""

if [ -n "$SHELL_RC" ]; then
  # Remove old cc.sh source line if present
  if grep -q "claude-slack-bridge/cc.sh" "$SHELL_RC" 2>/dev/null; then
    echo "  Found old cc.sh source line — replacing with page.sh"
    perl -i -pe 's|.*claude-slack-bridge/cc\.sh.*|# Agent Pager\nsource '"${BRIDGE_DIR}"'/page.sh|' "$SHELL_RC"
    echo "  ✓ Updated in $SHELL_RC"
  elif grep -q "agent-pager/page.sh\|claude-slack-bridge/page.sh" "$SHELL_RC" 2>/dev/null; then
    echo "  ✓ Already sourced in $SHELL_RC"
  else
    echo "  Add to $SHELL_RC automatically? (Y/n)"
    read -r add_shell
    if [ "$add_shell" != "n" ] && [ "$add_shell" != "N" ]; then
      echo "" >> "$SHELL_RC"
      echo "# Agent Pager" >> "$SHELL_RC"
      echo "source \"${BRIDGE_DIR}/page.sh\"" >> "$SHELL_RC"
      echo "  ✓ Added to $SHELL_RC"
    fi
  fi
else
  echo "  No ~/.zshrc or ~/.bashrc found."
  echo "  Add this to your shell config manually:"
  echo "    source ${BRIDGE_DIR}/page.sh"
fi
echo ""

# ─── Step 7: Auto-start (platform-aware) ────────────────────────────────────────

echo "━━━ Step 7: Auto-start ━━━"
echo ""

if [ "$PLATFORM" = "macos" ]; then
  # ── macOS: launchd ──
  PLIST_LABEL="com.agent-pager"
  PLIST_DST="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
  OLD_PLIST="${HOME}/Library/LaunchAgents/com.claude-slack-bridge.plist"

  echo "  Install launchd agent to keep the bridge running? (Y/n)"
  read -r install_service

  if [ "$install_service" != "n" ] && [ "$install_service" != "N" ]; then
    # Unload old plist if it exists
    if [ -f "$OLD_PLIST" ]; then
      launchctl unload "$OLD_PLIST" 2>/dev/null || true
      rm -f "$OLD_PLIST"
      echo "  Removed old com.claude-slack-bridge plist"
    fi

    launchctl unload "$PLIST_DST" 2>/dev/null || true

    NODE_PATH=$(which node)
    mkdir -p "$(dirname "$PLIST_DST")"

    cat > "$PLIST_DST" <<PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${BRIDGE_DIR}/bridge.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${BRIDGE_DIR}</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/agent-pager.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/agent-pager.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
PEOF

    launchctl load "$PLIST_DST"
    echo "  ✓ launchd agent installed and started"
    echo "  Logs: ~/.agent-pager/pager.log (app) + /tmp/agent-pager.log (launchd)"
  else
    echo "  Skipped. Start manually with: npm start"
  fi

elif [ "$PLATFORM" = "linux" ]; then
  # ── Linux / WSL: systemd ──
  if command -v systemctl &>/dev/null; then
    echo "  Install systemd user service to keep the bridge running? (Y/n)"
    read -r install_service

    if [ "$install_service" != "n" ] && [ "$install_service" != "N" ]; then
      NODE_PATH=$(which node)
      mkdir -p "${HOME}/.config/systemd/user"

      cat > "${HOME}/.config/systemd/user/agent-pager.service" <<SEOF
[Unit]
Description=Agent Pager
After=network.target

[Service]
WorkingDirectory=${BRIDGE_DIR}
ExecStart=${NODE_PATH} ${BRIDGE_DIR}/bridge.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
SEOF

      systemctl --user daemon-reload
      systemctl --user enable --now agent-pager
      echo "  ✓ systemd user service installed and started"
      echo "  Logs: journalctl --user -u agent-pager -f"
    else
      echo "  Skipped. Start manually with: npm start"
    fi
  else
    echo "  systemd not found. Start the bridge manually:"
    echo "    node ${BRIDGE_DIR}/bridge.js"
    echo ""
    echo "  Or run in a background tmux session:"
    echo "    tmux new-session -d -s pager 'node ${BRIDGE_DIR}/bridge.js'"
  fi
fi
echo ""

# ─── Step 8: Smoke test ──────────────────────────────────────────────────────────

echo "━━━ Step 8: Smoke test ━━━"
echo ""
echo "  Run a quick smoke test to verify everything works? (Y/n)"
read -r run_smoke

if [ "$run_smoke" != "n" ] && [ "$run_smoke" != "N" ]; then
  echo "  Starting bridge..."

  # Load BRIDGE_SECRET from .env
  BRIDGE_SECRET=$(grep '^BRIDGE_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)

  node "$BRIDGE_DIR/bridge.js" &
  BRIDGE_PID=$!
  sleep 4

  # Check if bridge is running
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "  ✗ Bridge failed to start — check logs"
  else
    echo "  ✓ Bridge running (PID $BRIDGE_PID)"

    # Create test tmux session (only if tmux is available)
    SMOKE_TMUX=""
    if command -v tmux &>/dev/null; then
      tmux new-session -d -s cc-smoke-test "echo 'Agent Pager smoke test'; sleep 30" 2>/dev/null && SMOKE_TMUX="cc-smoke-test"
      sleep 2
    fi

    # Fire test notification
    AUTH_HEADER=""
    if [ -n "${BRIDGE_SECRET:-}" ]; then
      AUTH_HEADER="-H X-Bridge-Token:${BRIDGE_SECRET}"
    fi

    SMOKE_PAYLOAD="{\"session_id\":\"smoke-test\",\"notification_type\":\"test\",\"_agent\":\"claude\""
    if [ -n "$SMOKE_TMUX" ]; then
      SMOKE_PAYLOAD="${SMOKE_PAYLOAD},\"tmux_session\":\"${SMOKE_TMUX}\""
    fi
    SMOKE_PAYLOAD="${SMOKE_PAYLOAD}}"

    SMOKE_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:7890/notification" \
      -H "Content-Type: application/json" \
      ${AUTH_HEADER} \
      -d "$SMOKE_PAYLOAD" \
      --connect-timeout 5 \
      --max-time 10 2>/dev/null || echo "000")

    if [ "$SMOKE_RESULT" = "200" ]; then
      echo "  ✓ Notification sent (HTTP $SMOKE_RESULT)"
      if [ -n "$SMOKE_TMUX" ]; then
        echo "  Check Slack — you should see a test screenshot!"
      else
        echo "  Check Slack — you should see a test message!"
      fi
    else
      echo "  ✗ Notification failed (HTTP $SMOKE_RESULT)"
    fi

    sleep 3
    [ -n "$SMOKE_TMUX" ] && tmux kill-session -t cc-smoke-test 2>/dev/null || true
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
    echo "  ✓ Smoke test cleanup done"
  fi
fi
echo ""

# ─── Done ────────────────────────────────────────────────────────────────────────

echo "━━━ Setup Complete ━━━"
echo ""
echo "  Quick test:"
echo "    1. Check bridge: pageb"
echo "    2. Start a session: page 'hello world'"
echo "    3. Check Slack for the notification"
echo ""
echo "  Useful commands:"
echo "    page <task>          Start agent in tmux"
echo "    page codex <task>   Start Codex CLI in tmux"
echo "    pagea               Attach to running session"
echo "    pagel               List sessions"
echo "    pageb               Bridge health check"
echo "    /pager <task>       Start from Slack"
echo "    /pager list         Dashboard in Slack"
echo "    /pager health       Bridge diagnostics"
echo ""

if [ "$PLATFORM" = "macos" ]; then
  echo "  Bridge management:"
  echo "    Logs:    tail -f ~/.agent-pager/pager.log"
  echo "    Restart: launchctl kickstart -k gui/\$(id -u)/com.agent-pager"
  echo "    Stop:    launchctl unload ~/Library/LaunchAgents/com.agent-pager.plist"
elif [ "$PLATFORM" = "linux" ] && command -v systemctl &>/dev/null; then
  echo "  Bridge management:"
  echo "    Logs:    journalctl --user -u agent-pager -f"
  echo "    Restart: systemctl --user restart agent-pager"
  echo "    Stop:    systemctl --user stop agent-pager"
fi
echo ""
