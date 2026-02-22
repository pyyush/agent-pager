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
 * Gemini CLI adapter.
 *
 * Hook events:
 *   - BeforeTool: stdin = { tool_name, tool_input, session_id }
 *   - AfterAgent: stdin = { session_id }
 */
export class GeminiAdapter implements AgentAdapter {
  name = "gemini";
  displayName = "Gemini CLI";
  binary = "gemini";
  sessionPrefix = "ap-gm";
  compatibility = ">=0.1.0";
  supportedHooks = ["BeforeTool", "AfterAgent"];
  capabilities: AdapterCapability[] = [
    "structured_permissions",
    "native_session_id",
    "stop_event",
    "hook_blocking",
  ];

  async detectVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(["gemini", "--version"], {
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
      return {
        type: "permission_request",
        sessionId: data.session_id as string | undefined,
        toolName: (data.tool_name as string) || "Unknown",
        toolInput: (data.tool_input as Record<string, unknown>) || {},
        rawPayload: raw,
      };
    }

    if (endpoint === "AfterAgent" || endpoint === "after-agent") {
      return {
        type: "stop",
        sessionId: data.session_id as string | undefined,
        rawPayload: raw,
      };
    }

    return null;
  }

  extractPermission(raw: unknown): PermissionRequestPayload | null {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;

    const toolName = (data.tool_name as string) || "Unknown";
    const toolInput = (data.tool_input as Record<string, unknown>) || {};

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
    return ["gemini", task, ...flags];
  }
}
