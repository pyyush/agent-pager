#!/usr/bin/env bash
# Codex CLI hook: Notification -> Bridge
# Codex delivers JSON via argv[1]
set -euo pipefail
export AGENT_PAYLOAD="$1"
export AGENT_NAME="codex"
source "$(cd "$(dirname "$0")" && pwd)/../shared/post-to-bridge.sh"
post_to_bridge "/notification"
