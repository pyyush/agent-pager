#!/usr/bin/env bun
/**
 * Codex CLI BeforeTool hook.
 *
 * Called by Codex CLI before executing a tool. Reads the hook event from
 * stdin (JSON with thread_id, tool_call.name, tool_call.arguments), posts
 * it to the gateway, and blocks until the user approves or denies.
 *
 * Exit 0 = approved, exit 2 = blocked.
 */

import { runHook } from "../shared/connect.ts";

await runHook("/hook/codex/BeforeTool", /* blocking */ true);
