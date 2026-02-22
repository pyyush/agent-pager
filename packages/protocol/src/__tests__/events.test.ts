import { describe, it, expect } from "vitest";
import {
  RiskLevelSchema,
  SessionStatusSchema,
  PermissionRequestPayloadSchema,
  DiffPayloadSchema,
  ToolCompletePayloadSchema,
  SessionStartPayloadSchema,
  SessionEndPayloadSchema,
  MessagePayloadSchema,
  ErrorPayloadSchema,
} from "../events.js";

// ── RiskLevelSchema ────────────────────────────────────────────────────

describe("RiskLevelSchema", () => {
  it("accepts 'safe'", () => {
    expect(RiskLevelSchema.parse("safe")).toBe("safe");
  });

  it("accepts 'moderate'", () => {
    expect(RiskLevelSchema.parse("moderate")).toBe("moderate");
  });

  it("accepts 'dangerous'", () => {
    expect(RiskLevelSchema.parse("dangerous")).toBe("dangerous");
  });

  it("rejects invalid values", () => {
    expect(() => RiskLevelSchema.parse("critical")).toThrow();
    expect(() => RiskLevelSchema.parse("low")).toThrow();
    expect(() => RiskLevelSchema.parse("")).toThrow();
    expect(() => RiskLevelSchema.parse(123)).toThrow();
    expect(() => RiskLevelSchema.parse(null)).toThrow();
  });
});

// ── SessionStatusSchema ────────────────────────────────────────────────

describe("SessionStatusSchema", () => {
  const validStatuses = ["created", "running", "waiting", "error", "stopped", "done"];

  for (const status of validStatuses) {
    it(`accepts '${status}'`, () => {
      expect(SessionStatusSchema.parse(status)).toBe(status);
    });
  }

  it("rejects invalid statuses", () => {
    expect(() => SessionStatusSchema.parse("paused")).toThrow();
    expect(() => SessionStatusSchema.parse("active")).toThrow();
    expect(() => SessionStatusSchema.parse("")).toThrow();
    expect(() => SessionStatusSchema.parse(0)).toThrow();
  });
});

// ── PermissionRequestPayloadSchema ─────────────────────────────────────

describe("PermissionRequestPayloadSchema", () => {
  const validPayload = {
    requestId: "req-abc-123",
    toolName: "Bash",
    toolCategory: "execute",
    toolInput: { command: "ls -la" },
    riskLevel: "safe" as const,
    summary: "ls -la",
  };

  it("parses a valid payload", () => {
    const result = PermissionRequestPayloadSchema.parse(validPayload);
    expect(result.requestId).toBe("req-abc-123");
    expect(result.toolName).toBe("Bash");
    expect(result.toolCategory).toBe("execute");
    expect(result.toolInput).toEqual({ command: "ls -la" });
    expect(result.riskLevel).toBe("safe");
    expect(result.summary).toBe("ls -la");
  });

  it("applies default for toolCategory", () => {
    const { toolCategory, ...rest } = validPayload;
    const result = PermissionRequestPayloadSchema.parse(rest);
    expect(result.toolCategory).toBe("unknown");
  });

  it("applies default for target", () => {
    const result = PermissionRequestPayloadSchema.parse(validPayload);
    expect(result.target).toBe("");
  });

  it("includes optional diff when provided", () => {
    const withDiff = {
      ...validPayload,
      diff: {
        filePath: "/src/main.ts",
        hunks: [],
        additions: 5,
        deletions: 2,
      },
    };
    const result = PermissionRequestPayloadSchema.parse(withDiff);
    expect(result.diff).toBeDefined();
    expect(result.diff!.filePath).toBe("/src/main.ts");
  });

  it("rejects missing requestId", () => {
    const { requestId, ...rest } = validPayload;
    expect(() => PermissionRequestPayloadSchema.parse(rest)).toThrow();
  });

  it("rejects missing toolName", () => {
    const { toolName, ...rest } = validPayload;
    expect(() => PermissionRequestPayloadSchema.parse(rest)).toThrow();
  });

  it("rejects missing toolInput", () => {
    const { toolInput, ...rest } = validPayload;
    expect(() => PermissionRequestPayloadSchema.parse(rest)).toThrow();
  });

  it("rejects invalid riskLevel", () => {
    expect(() =>
      PermissionRequestPayloadSchema.parse({ ...validPayload, riskLevel: "critical" })
    ).toThrow();
  });

  it("rejects missing summary", () => {
    const { summary, ...rest } = validPayload;
    expect(() => PermissionRequestPayloadSchema.parse(rest)).toThrow();
  });
});

// ── DiffPayloadSchema ──────────────────────────────────────────────────

describe("DiffPayloadSchema", () => {
  it("parses a valid diff payload", () => {
    const payload = {
      filePath: "/src/index.ts",
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 5,
          lines: [" import foo", "-const a = 1", "+const a = 2", "+const b = 3", " export { a }"],
        },
      ],
      additions: 2,
      deletions: 1,
    };
    const result = DiffPayloadSchema.parse(payload);
    expect(result.filePath).toBe("/src/index.ts");
    expect(result.hunks).toHaveLength(1);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
  });

  it("defaults isBinary to false", () => {
    const result = DiffPayloadSchema.parse({
      filePath: "test.ts",
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    expect(result.isBinary).toBe(false);
  });

  it("defaults isTruncated to false", () => {
    const result = DiffPayloadSchema.parse({
      filePath: "test.ts",
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    expect(result.isTruncated).toBe(false);
  });

  it("respects explicit isBinary = true", () => {
    const result = DiffPayloadSchema.parse({
      filePath: "image.png",
      hunks: [],
      additions: 0,
      deletions: 0,
      isBinary: true,
    });
    expect(result.isBinary).toBe(true);
  });

  it("respects explicit isTruncated = true", () => {
    const result = DiffPayloadSchema.parse({
      filePath: "huge.ts",
      hunks: [],
      additions: 0,
      deletions: 0,
      isTruncated: true,
    });
    expect(result.isTruncated).toBe(true);
  });

  it("rejects missing filePath", () => {
    expect(() =>
      DiffPayloadSchema.parse({ hunks: [], additions: 0, deletions: 0 })
    ).toThrow();
  });
});

// ── ToolCompletePayloadSchema ──────────────────────────────────────────

describe("ToolCompletePayloadSchema", () => {
  it("parses a valid tool_complete payload", () => {
    const result = ToolCompletePayloadSchema.parse({
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolOutput: "file1.ts\nfile2.ts",
      success: true,
      duration: 150,
    });
    expect(result.toolName).toBe("Bash");
    expect(result.success).toBe(true);
    expect(result.duration).toBe(150);
  });

  it("applies defaults for optional fields", () => {
    const result = ToolCompletePayloadSchema.parse({
      toolName: "Read",
      success: true,
    });
    expect(result.toolInput).toEqual({});
    expect(result.toolOutput).toBe("");
    expect(result.duration).toBe(0);
  });

  it("rejects missing toolName", () => {
    expect(() => ToolCompletePayloadSchema.parse({ success: true })).toThrow();
  });

  it("rejects missing success", () => {
    expect(() => ToolCompletePayloadSchema.parse({ toolName: "Bash" })).toThrow();
  });
});

// ── SessionStartPayloadSchema ──────────────────────────────────────────

describe("SessionStartPayloadSchema", () => {
  it("parses a valid payload", () => {
    const result = SessionStartPayloadSchema.parse({
      agent: "claude",
      agentVersion: "1.0.12",
      task: "Fix the bug in auth module",
      cwd: "/home/user/project",
      tmuxSession: "ap-cc-abc123",
    });
    expect(result.agent).toBe("claude");
    expect(result.tmuxSession).toBe("ap-cc-abc123");
  });

  it("applies defaults", () => {
    const result = SessionStartPayloadSchema.parse({ agent: "claude" });
    expect(result.agentVersion).toBe("");
    expect(result.task).toBe("");
    expect(result.cwd).toBe("");
    expect(result.tmuxSession).toBeUndefined();
  });

  it("rejects missing agent", () => {
    expect(() => SessionStartPayloadSchema.parse({})).toThrow();
  });
});

// ── SessionEndPayloadSchema ────────────────────────────────────────────

describe("SessionEndPayloadSchema", () => {
  it("parses with defaults", () => {
    const result = SessionEndPayloadSchema.parse({ status: "done" });
    expect(result.status).toBe("done");
    expect(result.summary).toBe("");
    expect(result.filesChanged).toEqual([]);
    expect(result.duration).toBe(0);
  });

  it("rejects invalid status", () => {
    expect(() => SessionEndPayloadSchema.parse({ status: "finished" })).toThrow();
  });
});

// ── MessagePayloadSchema ───────────────────────────────────────────────

describe("MessagePayloadSchema", () => {
  it("accepts valid roles", () => {
    for (const role of ["agent", "user", "system"] as const) {
      const result = MessagePayloadSchema.parse({ role, text: "hello" });
      expect(result.role).toBe(role);
    }
  });

  it("defaults isThinking to false", () => {
    const result = MessagePayloadSchema.parse({ role: "agent", text: "thinking..." });
    expect(result.isThinking).toBe(false);
  });

  it("rejects invalid role", () => {
    expect(() => MessagePayloadSchema.parse({ role: "assistant", text: "hi" })).toThrow();
  });
});

// ── ErrorPayloadSchema ─────────────────────────────────────────────────

describe("ErrorPayloadSchema", () => {
  it("parses with defaults", () => {
    const result = ErrorPayloadSchema.parse({ message: "Something went wrong" });
    expect(result.message).toBe("Something went wrong");
    expect(result.code).toBe("UNKNOWN");
    expect(result.recoverable).toBe(true);
  });

  it("respects explicit values", () => {
    const result = ErrorPayloadSchema.parse({
      message: "Auth failed",
      code: "AUTH_ERROR",
      recoverable: false,
    });
    expect(result.code).toBe("AUTH_ERROR");
    expect(result.recoverable).toBe(false);
  });
});
