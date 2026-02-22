import type { RiskLevel, PermissionRequestPayload } from "@agentpager/protocol";

/**
 * Capabilities an adapter may expose.
 */
export type AdapterCapability =
  | "structured_permissions"
  | "native_session_id"
  | "stop_event"
  | "headless_mode"
  | "session_resume"
  | "hook_blocking";

/**
 * Normalized event from an agent hook, regardless of agent type.
 */
export interface NormalizedHookEvent {
  type:
    | "permission_request"
    | "tool_complete"
    | "notification"
    | "stop"
    | "error"
    | "progress";
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  message?: string;
  /** Original, unmodified payload — preserved for forward compat */
  rawPayload: unknown;
  /** tmux session name (if the agent is running inside tmux) */
  tmuxSession?: string;
  /** Agent's working directory (from the hook process) */
  cwd?: string;
}

/**
 * Agent adapter interface. Each supported agent gets an adapter that
 * normalizes its hook payloads and translates protocol actions.
 */
export interface AgentAdapter {
  /** Machine name (e.g., 'claude', 'codex', 'gemini') */
  name: string;
  /** Human-friendly display name */
  displayName: string;
  /** CLI binary name */
  binary: string;
  /** tmux session prefix */
  sessionPrefix: string;
  /** Semver range of supported agent versions */
  compatibility: string;
  /** Hook endpoints this adapter listens on */
  supportedHooks: string[];
  /** Capabilities matrix */
  capabilities: AdapterCapability[];

  /** Detect installed version (null = not installed) */
  detectVersion(): Promise<string | null>;

  /** Normalize a raw hook payload into a unified event */
  normalizeHookPayload(
    raw: unknown,
    endpoint: string
  ): NormalizedHookEvent | null;

  /** Extract a permission request from a raw hook payload */
  extractPermission(raw: unknown): PermissionRequestPayload | null;

  /** Classify risk level for a tool invocation */
  classifyRisk(tool: string, input: Record<string, unknown>): RiskLevel;

  /** Build the command to launch this agent in tmux */
  buildLaunchCommand(task: string, flags?: string[]): string[];
}
