import { z } from "zod";
import { APPROVAL_SCOPES, RISK_LEVELS } from "./constants.js";

// ── Action payloads (Client → Gateway) ──────────────────────────────

export const ApproveActionSchema = z.object({
  requestId: z.string(),
  scope: z.enum(APPROVAL_SCOPES).default("once"),
});
export type ApproveAction = z.infer<typeof ApproveActionSchema>;

export const DenyActionSchema = z.object({
  requestId: z.string(),
  reason: z.string().optional(),
});
export type DenyAction = z.infer<typeof DenyActionSchema>;

export const EditApproveActionSchema = z.object({
  requestId: z.string(),
  updatedInput: z.record(z.unknown()),
});
export type EditApproveAction = z.infer<typeof EditApproveActionSchema>;

export const TextInputActionSchema = z.object({
  text: z.string(),
});
export type TextInputAction = z.infer<typeof TextInputActionSchema>;

export const StopActionSchema = z.object({
  force: z.boolean().default(false),
});
export type StopAction = z.infer<typeof StopActionSchema>;

export const PauseActionSchema = z.object({});
export type PauseAction = z.infer<typeof PauseActionSchema>;

export const StartSessionActionSchema = z.object({
  agent: z.string(),
  task: z.string(),
  cwd: z.string().optional(),
  repo: z.string().optional(),
});
export type StartSessionAction = z.infer<typeof StartSessionActionSchema>;

export const TerminalInputActionSchema = z.object({
  /** Base64-encoded terminal input data */
  data: z.string(),
});
export type TerminalInputAction = z.infer<typeof TerminalInputActionSchema>;

export const BatchApproveActionSchema = z.object({
  requestIds: z.array(z.string()),
  scope: z.enum(APPROVAL_SCOPES).default("once"),
  maxRiskLevel: z.enum(RISK_LEVELS).optional(),
});
export type BatchApproveAction = z.infer<typeof BatchApproveActionSchema>;

export const ResumeFromSeqActionSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
});
export type ResumeFromSeqAction = z.infer<typeof ResumeFromSeqActionSchema>;

export const AuthActionSchema = z.object({
  token: z.string(),
});
export type AuthAction = z.infer<typeof AuthActionSchema>;

export const DevicePairActionSchema = z.object({
  roomId: z.string(),
  roomSecret: z.string(),
  gatewayPublicKey: z.string(),
  relayUrl: z.string().optional(),
});
export type DevicePairAction = z.infer<typeof DevicePairActionSchema>;

// ── Action type union ───────────────────────────────────────────────

export const ACTION_TYPES = [
  "approve",
  "deny",
  "edit_approve",
  "text_input",
  "stop",
  "pause",
  "start_session",
  "terminal_input",
  "batch_approve",
  "resume_from_seq",
  "auth",
  "device_pair",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** Map action type → payload schema for runtime validation */
export const ACTION_PAYLOAD_SCHEMAS: Record<ActionType, z.ZodTypeAny> = {
  approve: ApproveActionSchema,
  deny: DenyActionSchema,
  edit_approve: EditApproveActionSchema,
  text_input: TextInputActionSchema,
  stop: StopActionSchema,
  pause: PauseActionSchema,
  start_session: StartSessionActionSchema,
  terminal_input: TerminalInputActionSchema,
  batch_approve: BatchApproveActionSchema,
  resume_from_seq: ResumeFromSeqActionSchema,
  auth: AuthActionSchema,
  device_pair: DevicePairActionSchema,
};
