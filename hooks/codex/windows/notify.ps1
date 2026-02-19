# Codex CLI hook: Notification -> Bridge (Windows/PowerShell)
# Codex delivers JSON via argv[1]
$env:AGENT_PAYLOAD = $args[0]
$env:AGENT_NAME = "codex"
. (Join-Path $PSScriptRoot "..\..\shared\post-to-bridge.ps1")
Post-ToBridge "/notification"
