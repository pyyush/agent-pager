#!/usr/bin/env bun
/**
 * Claude Code Stop hook.
 *
 * Fire-and-forget: notifies the gateway that the Claude Code session
 * has stopped. Always exits 0.
 */

import { runHook } from "../shared/connect.ts";

await runHook("/hook/claude/Stop", /* blocking */ false);
