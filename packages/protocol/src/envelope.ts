import { z } from "zod";
import { PROTOCOL_VERSION } from "./constants.js";

/**
 * Base message envelope — wraps all protocol messages.
 * Discriminated by `type` field.
 */
export const MessageEnvelopeSchema = z.object({
  /** Protocol version (semver — major = breaking) */
  v: z.string().default(PROTOCOL_VERSION),
  /** Monotonic sequence number per connection direction */
  seq: z.number().int().nonnegative(),
  /** Discriminated union tag */
  type: z.string(),
  /** ISO-8601 timestamp */
  ts: z.string().datetime({ offset: true }),
  /** Session ID (null for system-level messages) */
  sessionId: z.string().nullable(),
  /** Type-specific payload */
  payload: z.unknown(),
});

export type MessageEnvelope<T extends string = string, P = unknown> = {
  v: string;
  seq: number;
  type: T;
  ts: string;
  sessionId: string | null;
  payload: P;
};

/** Create a new message envelope */
export function createEnvelope<T extends string, P>(
  type: T,
  payload: P,
  sessionId: string | null,
  seq: number
): MessageEnvelope<T, P> {
  return {
    v: PROTOCOL_VERSION,
    seq,
    type,
    ts: new Date().toISOString(),
    sessionId,
    payload,
  };
}
