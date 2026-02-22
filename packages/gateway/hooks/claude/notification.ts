#!/usr/bin/env bun
/**
 * Claude Code Notification hook.
 *
 * Fire-and-forget: posts the notification event to the gateway and
 * always exits 0. Does not block.
 */

import { runHook } from "../shared/connect.ts";

await runHook("/hook/claude/Notification", /* blocking */ false);
