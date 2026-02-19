# Claude Code hook: Stop -> Bridge (Windows/PowerShell)
# Claude delivers JSON via stdin
$env:AGENT_PAYLOAD = $input | Out-String
$env:AGENT_NAME = "claude"
. (Join-Path $PSScriptRoot "..\..\shared\post-to-bridge.ps1")
Post-ToBridge "/stop"
