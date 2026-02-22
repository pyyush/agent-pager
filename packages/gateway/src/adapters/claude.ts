import {
  classifyRisk,
  summarizeTool,
  extractTarget,
  type PermissionRequestPayload,
  type RiskLevel,
} from "@agentpager/protocol";
import type {
  AgentAdapter,
  AdapterCapability,
  NormalizedHookEvent,
} from "./base.js";

/**
 * Claude Code adapter.
 *
 * Hook events (flat format — tool_name/tool_input at root level):
 *   - PreToolUse: stdin = { session_id, tool_name, tool_input }
 *   - PostToolUse: stdin = { session_id, tool_name, tool_input, tool_output }
 *   - Notification: POST /notification { type, message }
 *   - Stop: stdin = { session_id, stop_hook_active }
 */
export class ClaudeAdapter implements AgentAdapter {
  name = "claude";
  displayName = "Claude Code";
  binary = "claude";
  sessionPrefix = "ap-cc";
  compatibility = ">=1.0.0";
  supportedHooks = ["PreToolUse", "PostToolUse", "Notification", "Stop"];
  capabilities: AdapterCapability[] = [
    "structured_permissions",
    "native_session_id",
    "stop_event",
    "headless_mode",
    "session_resume",
    "hook_blocking",
  ];

  async detectVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(["claude", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      // Claude Code outputs something like "claude 1.0.12"
      const match = text.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  normalizeHookPayload(
    raw: unknown,
    endpoint: string
  ): NormalizedHookEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;

    // PreToolUse hook — the critical path for permission cards
    // Claude Code sends FLAT format: { session_id, tool_name, tool_input }
    // (Not nested under a `tool` key)
    if (endpoint === "PreToolUse" || endpoint === "pre-tool-use") {
      const toolName = (data.tool_name as string)
        || (data.tool as Record<string, unknown>)?.tool_name as string;
      const toolInput = (data.tool_input as Record<string, unknown>)
        || (data.tool as Record<string, unknown>)?.tool_input as Record<string, unknown>;

      if (!toolName) return null;

      return {
        type: "permission_request",
        sessionId: (data.session_id as string) || undefined,
        toolName,
        toolInput: toolInput || {},
        rawPayload: raw,
        tmuxSession: (data._tmuxSession as string) || undefined,
        cwd: (data._cwd as string) || undefined,
      };
    }

    // PostToolUse hook — tool completion (also flat format)
    if (endpoint === "PostToolUse" || endpoint === "post-tool-use") {
      const toolName = (data.tool_name as string)
        || (data.tool as Record<string, unknown>)?.tool_name as string;
      const toolInput = (data.tool_input as Record<string, unknown>)
        || (data.tool as Record<string, unknown>)?.tool_input as Record<string, unknown>;
      const toolOutput = (data.tool_output as string)
        || (data.tool as Record<string, unknown>)?.tool_output as string;

      if (!toolName) return null;

      return {
        type: "tool_complete",
        sessionId: (data.session_id as string) || undefined,
        toolName,
        toolInput: toolInput || {},
        toolOutput,
        rawPayload: raw,
        tmuxSession: (data._tmuxSession as string) || undefined,
        cwd: (data._cwd as string) || undefined,
      };
    }

    // Notification hook
    if (endpoint === "Notification" || endpoint === "notification") {
      return {
        type: "notification",
        sessionId: (data.session_id as string) || undefined,
        message: (data.message as string) || JSON.stringify(data),
        rawPayload: raw,
        tmuxSession: (data._tmuxSession as string) || undefined,
        cwd: (data._cwd as string) || undefined,
      };
    }

    // Stop hook
    if (endpoint === "Stop" || endpoint === "stop") {
      return {
        type: "stop",
        sessionId: (data.session_id as string) || undefined,
        rawPayload: raw,
        tmuxSession: (data._tmuxSession as string) || undefined,
        cwd: (data._cwd as string) || undefined,
      };
    }

    return null;
  }

  extractPermission(raw: unknown): PermissionRequestPayload | null {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;

    // Flat format (Claude Code actual): { tool_name, tool_input }
    // Nested format (fallback): { tool: { tool_name, tool_input } }
    const toolName = (data.tool_name as string)
      || (data.tool as Record<string, unknown>)?.tool_name as string
      || "Unknown";
    const toolInput = (data.tool_input as Record<string, unknown>)
      || (data.tool as Record<string, unknown>)?.tool_input as Record<string, unknown>
      || {};

    if (toolName === "Unknown") return null;

    const requestId = crypto.randomUUID();
    const risk = this.classifyRisk(toolName, toolInput);

    return {
      requestId,
      toolName,
      toolCategory: "unknown",
      toolInput,
      riskLevel: risk,
      summary: summarizeTool(toolName, toolInput),
      target: extractTarget(toolName, toolInput),
      rawPayload: raw,
    };
  }

  classifyRisk(tool: string, input: Record<string, unknown>): RiskLevel {
    return classifyRisk(tool, input);
  }

  buildLaunchCommand(task: string, flags: string[] = []): string[] {
    return ["claude", "-p", task, "--verbose", ...flags];
  }
}
