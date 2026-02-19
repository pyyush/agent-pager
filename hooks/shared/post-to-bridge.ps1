# Shared hook logic: inject agent metadata, POST to bridge.
# Expects $env:AGENT_PAYLOAD to contain the JSON payload.
# Expects $env:AGENT_NAME to identify the agent (claude, codex, etc.).
# Usage: . this file, then call Post-ToBridge "/notification"

$BridgeDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BridgePort = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { "7890" }

# Load BRIDGE_SECRET from .env if not already set
if (-not $env:BRIDGE_SECRET) {
    $envFile = Join-Path $BridgeDir ".env"
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match "^BRIDGE_SECRET=" }
        if ($line) {
            $env:BRIDGE_SECRET = ($line -split "=", 2)[1]
        }
    }
}

function Post-ToBridge {
    param([string]$Endpoint)

    try {
        # Parse payload JSON via node (safe, no shell interpolation)
        $agentName = if ($env:AGENT_NAME) { $env:AGENT_NAME } else { "unknown" }
        $injected = node -e "
            const data = JSON.parse(process.env.AGENT_PAYLOAD);
            data._agent = process.env.AGENT_NAME || 'unknown';
            process.stdout.write(JSON.stringify(data));
        " 2>$null

        if (-not $injected) { return }

        # Build headers
        $headers = @{ "Content-Type" = "application/json" }
        if ($env:BRIDGE_SECRET) {
            $headers["X-Bridge-Token"] = $env:BRIDGE_SECRET
        }

        # POST to bridge (fire-and-forget via job)
        $uri = "http://127.0.0.1:${BridgePort}${Endpoint}"
        Start-Job -ScriptBlock {
            param($u, $h, $b)
            try {
                Invoke-RestMethod -Uri $u -Method Post -Headers $h -Body $b -TimeoutSec 5 | Out-Null
            } catch {}
        } -ArgumentList $uri, $headers, $injected | Out-Null
    }
    catch {
        # Silent failure — don't break the agent
    }
}
