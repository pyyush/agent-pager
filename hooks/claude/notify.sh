#!/usr/bin/env bash
# Claude Code hook: Notification -> Bridge
# Claude delivers JSON via stdin
set -euo pipefail
export AGENT_PAYLOAD=$(cat)
export AGENT_NAME="claude"
source "$(cd "$(dirname "$0")" && pwd)/../shared/post-to-bridge.sh"
post_to_bridge "/notification"
