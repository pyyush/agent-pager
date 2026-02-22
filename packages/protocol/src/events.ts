import { z } from "zod";
import { RISK_LEVELS, SESSION_STATUSES } from "./constants.js";

// ── Shared sub-schemas ──────────────────────────────────────────────

export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const DiffHunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffPayloadSchema = z.object({
  filePath: z.string(),
  oldContent: z.string().optional(),
  newContent: z.string().optional(),
  hunks: z.array(DiffHunkSchema),
  additions: z.number(),
  deletions: z.number(),
  isBinary: z.boolean().default(false),
  isTruncated: z.boolean().default(false),
});
export type DiffPayload = z.infer<typeof DiffPayloadSchema>;

// ── Event payloads (Gateway → Client) ───────────────────────────────

export const SessionStartPayloadSchema = z.object({
  agent: z.string(),
  agentVersion: z.string().default(""),
  task: z.string().default(""),
  cwd: z.string().default(""),
  tmuxSession: z.string().optional(),
});
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

export const SessionEndPayloadSchema = z.object({
  status: SessionStatusSchema,
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  duration: z.number().default(0),
});
export type SessionEndPayload = z.infer<typeof SessionEndPayloadSchema>;

export const SessionUpdatePayloadSchema = z.object({
  status: SessionStatusSchema,
  currentFile: z.string().optional(),
  step: z.string().optional(),
});
export type SessionUpdatePayload = z.infer<typeof SessionUpdatePayloadSchema>;

export const PermissionRequestPayloadSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  toolCategory: z.string().default("unknown"),
  toolInput: z.record(z.unknown()),
  riskLevel: RiskLevelSchema,
  summary: z.string(),
  diff: DiffPayloadSchema.optional(),
  target: z.string().default(""),
  rawPayload: z.unknown().optional(),
});
export type PermissionRequestPayload = z.infer<
  typeof PermissionRequestPayloadSchema
>;

export const ToolCompletePayloadSchema = z.object({
  toolName: z.string(),
  toolInput: z.record(z.unknown()).default({}),
  toolOutput: z.string().default(""),
  success: z.boolean(),
  duration: z.number().default(0),
});
export type ToolCompletePayload = z.infer<typeof ToolCompletePayloadSchema>;

export const MessagePayloadSchema = z.object({
  role: z.enum(["agent", "user", "system"]),
  text: z.string(),
  isThinking: z.boolean().default(false),
});
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

export const ProgressPayloadSchema = z.object({
  currentFile: z.string().optional(),
  step: z.string().optional(),
  tokenUsage: z
    .object({
      input: z.number().default(0),
      output: z.number().default(0),
    })
    .optional(),
});
export type ProgressPayload = z.infer<typeof ProgressPayloadSchema>;

export const ErrorPayloadSchema = z.object({
  message: z.string(),
  code: z.string().default("UNKNOWN"),
  recoverable: z.boolean().default(true),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const HeartbeatPayloadSchema = z.object({
  serverTime: z.string().datetime({ offset: true }),
  activeSessions: z.number(),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

export const SessionInfoSchema = z.object({
  id: z.string(),
  agent: z.string(),
  agentVersion: z.string().default(""),
  task: z.string().default(""),
  cwd: z.string().default(""),
  status: SessionStatusSchema,
  tmuxSession: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  pendingApprovals: z.number().default(0),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionListPayloadSchema = z.object({
  sessions: z.array(SessionInfoSchema),
});
export type SessionListPayload = z.infer<typeof SessionListPayloadSchema>;

export const SessionSnapshotPayloadSchema = z.object({
  session: SessionInfoSchema,
  recentEvents: z.array(z.unknown()),
  pendingApprovals: z.array(PermissionRequestPayloadSchema),
});
export type SessionSnapshotPayload = z.infer<
  typeof SessionSnapshotPayloadSchema
>;

export const AuthRequiredPayloadSchema = z.object({
  reason: z.string().default("authentication_required"),
});
export type AuthRequiredPayload = z.infer<typeof AuthRequiredPayloadSchema>;

// ── Event type union ────────────────────────────────────────────────

export const EVENT_TYPES = [
  "session_start",
  "session_end",
  "session_update",
  "permission_request",
  "tool_complete",
  "message",
  "progress",
  "error",
  "heartbeat",
  "session_list",
  "session_snapshot",
  "auth_required",
  "auth_ok",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Map event type → payload schema for runtime validation */
export const EVENT_PAYLOAD_SCHEMAS: Record<EventType, z.ZodTypeAny> = {
  session_start: SessionStartPayloadSchema,
  session_end: SessionEndPayloadSchema,
  session_update: SessionUpdatePayloadSchema,
  permission_request: PermissionRequestPayloadSchema,
  tool_complete: ToolCompletePayloadSchema,
  message: MessagePayloadSchema,
  progress: ProgressPayloadSchema,
  error: ErrorPayloadSchema,
  heartbeat: HeartbeatPayloadSchema,
  session_list: SessionListPayloadSchema,
  session_snapshot: SessionSnapshotPayloadSchema,
  auth_required: AuthRequiredPayloadSchema,
  auth_ok: z.object({ clientId: z.string() }),
};
