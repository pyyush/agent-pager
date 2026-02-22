#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook.
 *
 * Called by Claude Code before executing a tool. Reads the hook event from
 * stdin (JSON with session_id, tool.tool_name, tool.tool_input), posts it
 * to the gateway, and blocks until the user approves or denies.
 *
 * Exit 0 = approved, exit 2 = blocked.
 */

import { runHook } from "../shared/connect.ts";

await runHook("/hook/claude/PreToolUse", /* blocking */ true);
