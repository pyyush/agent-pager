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
 * Codex CLI adapter.
 *
 * Hook events:
 *   - BeforeTool: stdin = { thread_id, tool_call: { name, arguments } }
 *   - AfterTool: stdin = { thread_id, tool_call: { name, arguments, output } }
 *   - NotifyAgentTurnComplete: stdin = { thread_id }
 */
export class CodexAdapter implements AgentAdapter {
  name = "codex";
  displayName = "Codex CLI";
  binary = "codex";
  sessionPrefix = "ap-cx";
  compatibility = ">=0.1.0";
  supportedHooks = ["BeforeTool", "AfterTool", "NotifyAgentTurnComplete"];
  capabilities: AdapterCapability[] = [
    "structured_permissions",
    "native_session_id",
    "hook_blocking",
  ];

  async detectVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(["codex", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
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

    if (endpoint === "BeforeTool" || endpoint === "before-tool") {
      const toolCall = data.tool_call as Record<string, unknown> | undefined;
      if (!toolCall) return null;

      // Codex uses `arguments` (a JSON string) instead of `tool_input`
      let toolInput: Record<string, unknown> = {};
      try {
        const args = toolCall.arguments;
        toolInput =
          typeof args === "string" ? JSON.parse(args) : (args as Record<string, unknown>) || {};
      } catch {
        toolInput = {};
      }

      return {
        type: "permission_request",
        sessionId: data.thread_id as string | undefined,
        toolName: (toolCall.name as string) || "Unknown",
        toolInput,
        rawPayload: raw,
      };
    }

    if (endpoint === "AfterTool" || endpoint === "after-tool") {
      const toolCall = data.tool_call as Record<string, unknown> | undefined;
      if (!toolCall) return null;

      let toolInput: Record<string, unknown> = {};
      try {
        const args = toolCall.arguments;
        toolInput =
          typeof args === "string" ? JSON.parse(args) : (args as Record<string, unknown>) || {};
      } catch {
        toolInput = {};
      }

      return {
        type: "tool_complete",
        sessionId: data.thread_id as string | undefined,
        toolName: (toolCall.name as string) || "Unknown",
        toolInput,
        toolOutput: toolCall.output as string,
        rawPayload: raw,
      };
    }

    if (
      endpoint === "NotifyAgentTurnComplete" ||
      endpoint === "notify-agent-turn-complete"
    ) {
      return {
        type: "stop",
        sessionId: data.thread_id as string | undefined,
        rawPayload: raw,
      };
    }

    return null;
  }

  extractPermission(raw: unknown): PermissionRequestPayload | null {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    const toolCall = data.tool_call as Record<string, unknown> | undefined;
    if (!toolCall) return null;

    const toolName = (toolCall.name as string) || "Unknown";
    let toolInput: Record<string, unknown> = {};
    try {
      const args = toolCall.arguments;
      toolInput =
        typeof args === "string" ? JSON.parse(args) : (args as Record<string, unknown>) || {};
    } catch {
      toolInput = {};
    }

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
    return ["codex", "exec", task, ...flags];
  }
}
