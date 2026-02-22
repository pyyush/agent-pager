#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook.
 *
 * Fire-and-forget: posts tool completion to the gateway.
 * Always exits 0. Does not block.
 */

import { runHook } from "../shared/connect.ts";

await runHook("/hook/claude/PostToolUse", /* blocking */ false);
