# Agent Pager — Windows Setup Script
# Run: powershell -ExecutionPolicy Bypass -File setup-windows.ps1

$ErrorActionPreference = "Stop"
$BridgeDir = $PSScriptRoot
$HooksDir = Join-Path $BridgeDir "hooks"
$ClaudeSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"

Write-Host ""
Write-Host "  Agent Pager — Windows Setup" -ForegroundColor Magenta
Write-Host "  ============================" -ForegroundColor Magenta
Write-Host ""

# ─── Step 0: Check dependencies ─────────────────────────────────────────────────

Write-Host "--- Step 0: Check dependencies ---" -ForegroundColor Cyan
Write-Host ""

$missing = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "node (https://nodejs.org)" }
if (-not (Get-Command freeze -ErrorAction SilentlyContinue)) { $missing += "freeze (go install github.com/charmbracelet/freeze@latest)" }

if ($missing.Count -gt 0) {
    Write-Host "  Missing:" -ForegroundColor Yellow
    foreach ($dep in $missing) { Write-Host "    - $dep" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "  Install these and re-run setup." -ForegroundColor Yellow
} else {
    Write-Host "  All dependencies found (node, freeze)" -ForegroundColor Green
}
Write-Host ""

# ─── Step 1: Agent selection ────────────────────────────────────────────────────

Write-Host "--- Step 1: Select agents ---" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Which agents do you want to use?"
Write-Host "    1) Claude Code only"
Write-Host "    2) Codex CLI only"
Write-Host "    3) Both"
Write-Host ""
$choice = Read-Host "  Choice (1/2/3)"

$setupClaude = $false
$setupCodex = $false

switch ($choice) {
    "1" { $setupClaude = $true }
    "2" { $setupCodex = $true }
    "3" { $setupClaude = $true; $setupCodex = $true }
    default { Write-Host "  Defaulting to Claude Code only"; $setupClaude = $true }
}
Write-Host ""

# ─── Step 2: Slack App ──────────────────────────────────────────────────────────

Write-Host "--- Step 2: Create a Slack App ---" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Go to: https://api.slack.com/apps"
Write-Host "  2. Create New App > From an app manifest"
Write-Host "  3. Paste the contents of: $BridgeDir\slack-app-manifest.yml"
Write-Host ""
Write-Host "  Then:"
Write-Host "    - Enable Socket Mode, create token (xapp-...)"
Write-Host "    - Install to Workspace, copy Bot Token (xoxb-...)"
Write-Host "    - Copy your Slack User ID from profile"
Write-Host ""
Read-Host "  Press Enter when done"
Write-Host ""

# ─── Step 3: Configure .env ─────────────────────────────────────────────────────

Write-Host "--- Step 3: Configure tokens ---" -ForegroundColor Cyan
Write-Host ""

$envFile = Join-Path $BridgeDir ".env"

if (Test-Path $envFile) {
    $overwrite = Read-Host "  .env exists. Overwrite? (y/N)"
    if ($overwrite -eq "y") { Remove-Item $envFile }
}

if (-not (Test-Path $envFile)) {
    $botToken = Read-Host "  Bot Token (xoxb-...)"
    $appToken = Read-Host "  App Token (xapp-...)"
    Write-Host ""
    $userId = Read-Host "  Slack User ID for DM mode (or Enter to skip)"
    $channelId = ""
    if (-not $userId) {
        $channelId = Read-Host "  Channel ID (C0...)"
    }

    # Generate secret
    $secret = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

    $defaultAgent = "claude"
    if ($setupCodex -and -not $setupClaude) { $defaultAgent = "codex" }

    @"
SLACK_BOT_TOKEN=$botToken
SLACK_APP_TOKEN=$appToken
SLACK_CHANNEL_ID=$channelId
SLACK_USER_ID=$userId
BRIDGE_PORT=7890
BRIDGE_SECRET=$secret
PAGER_DEFAULT_AGENT=$defaultAgent
LOG_LEVEL=info
"@ | Set-Content $envFile -Encoding UTF8

    Write-Host "  .env created" -ForegroundColor Green
}
Write-Host ""

# ─── Step 4: Install dependencies ───────────────────────────────────────────────

Write-Host "--- Step 4: Install dependencies ---" -ForegroundColor Cyan
Write-Host ""

if (Test-Path (Join-Path $BridgeDir "node_modules")) {
    Write-Host "  node_modules exists, skipping."
} else {
    Write-Host "  Running npm install..."
    Push-Location $BridgeDir
    npm install --production
    Pop-Location
}
Write-Host ""

# ─── Step 5: Configure agent hooks ──────────────────────────────────────────────

Write-Host "--- Step 5: Configure agent hooks ---" -ForegroundColor Cyan
Write-Host ""

# --- Claude Code ---
if ($setupClaude) {
    Write-Host "  -- Claude Code --" -ForegroundColor White

    $claudeDir = Split-Path $ClaudeSettings
    if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }

    $notifyPath = (Join-Path $HooksDir "claude\windows\notify.ps1") -replace '\\', '\\'
    $stopPath = (Join-Path $HooksDir "claude\windows\stop.ps1") -replace '\\', '\\'

    $hooksConfig = @{
        hooks = @{
            Notification = @(@{
                matcher = ""
                hooks = @(@{
                    type = "command"
                    command = "powershell -ExecutionPolicy Bypass -File `"$notifyPath`""
                })
            })
            Stop = @(@{
                matcher = ""
                hooks = @(@{
                    type = "command"
                    command = "powershell -ExecutionPolicy Bypass -File `"$stopPath`""
                })
            })
        }
    }

    if (Test-Path $ClaudeSettings) {
        $merge = Read-Host "  Merge hooks into existing settings? (Y/n)"
        if ($merge -ne "n") {
            node -e "
                const fs = require('fs');
                const settings = JSON.parse(fs.readFileSync('$($ClaudeSettings -replace '\\', '/')', 'utf8'));
                const newHooks = JSON.parse('$(($hooksConfig | ConvertTo-Json -Depth 10 -Compress) -replace "'", "\'")');
                if (!settings.hooks) settings.hooks = {};
                for (const [event, rules] of Object.entries(newHooks.hooks)) {
                    if (!settings.hooks[event]) settings.hooks[event] = [];
                    for (const rule of rules) {
                        const exists = settings.hooks[event].some(existing =>
                            existing.hooks?.some(h => rule.hooks?.some(rh => h.command === rh.command))
                        );
                        if (!exists) settings.hooks[event].push(rule);
                    }
                }
                fs.writeFileSync('$($ClaudeSettings -replace '\\', '/')', JSON.stringify(settings, null, 2));
                console.log('  Hooks merged');
            " 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Claude hooks configured" -ForegroundColor Green
            } else {
                Write-Host "  Failed to merge — configure manually" -ForegroundColor Red
            }
        }
    } else {
        $hooksConfig | ConvertTo-Json -Depth 10 | Set-Content $ClaudeSettings -Encoding UTF8
        Write-Host "  Claude settings created" -ForegroundColor Green
    }
    Write-Host ""
}

# --- Codex CLI ---
if ($setupCodex) {
    Write-Host "  -- Codex CLI --" -ForegroundColor White

    $codexDir = Split-Path $CodexConfig
    if (-not (Test-Path $codexDir)) { New-Item -ItemType Directory -Path $codexDir -Force | Out-Null }

    $codexNotifyPath = (Join-Path $HooksDir "codex\windows\notify.ps1") -replace '\\', '/'
    $codexHookLine = "notify = [`"powershell`", `"-ExecutionPolicy`", `"Bypass`", `"-File`", `"$codexNotifyPath`"]"

    if (Test-Path $CodexConfig) {
        $content = Get-Content $CodexConfig -Raw
        if ($content -match "codex[/\\]windows[/\\]notify\.ps1") {
            Write-Host "  Codex hook already configured" -ForegroundColor Green
        } elseif ($content -match "^notify\s*=") {
            # Replace existing notify line
            $content = $content -replace "^notify\s*=.*", $codexHookLine
            Set-Content $CodexConfig $content -Encoding UTF8
            Write-Host "  Codex notify hook replaced" -ForegroundColor Green
        } else {
            Add-Content $CodexConfig "`n# Agent Pager notification hook`n$codexHookLine"
            Write-Host "  Codex hook added" -ForegroundColor Green
        }
    } else {
        @"
# Codex CLI configuration
# Agent Pager notification hook
$codexHookLine
"@ | Set-Content $CodexConfig -Encoding UTF8
        Write-Host "  Codex config created" -ForegroundColor Green
    }
    Write-Host ""
}

# ─── Step 6: Done ───────────────────────────────────────────────────────────────

Write-Host "--- Setup Complete ---" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Start the bridge:"
Write-Host "    cd $BridgeDir"
Write-Host "    node bridge.js"
Write-Host ""
Write-Host "  Or run in the background:"
Write-Host "    Start-Process -NoNewWindow node -ArgumentList 'bridge.js' -WorkingDirectory '$BridgeDir'"
Write-Host ""
Write-Host "  Start an agent in a separate terminal:"
Write-Host "    claude 'fix the auth bug'"
Write-Host "    codex --full-auto 'fix the auth bug'"
Write-Host ""
Write-Host "  Windows limitations:" -ForegroundColor Yellow
Write-Host "    - Notifications work (agent -> Slack)" -ForegroundColor Yellow
Write-Host "    - Screenshots require freeze (text fallback if missing)" -ForegroundColor Yellow
Write-Host "    - Reply from Slack requires tmux (WSL only)" -ForegroundColor Yellow
Write-Host ""
Write-Host "  For full features (screenshots + reply routing), use WSL." -ForegroundColor Yellow
Write-Host ""
