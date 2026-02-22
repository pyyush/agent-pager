import { describe, it, expect } from "vitest";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";

// ── Claude Adapter ─────────────────────────────────────────────────────

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter();

  describe("normalizeHookPayload", () => {
    it("PreToolUse -> permission_request", () => {
      const raw = {
        session_id: "sess-123",
        tool: {
          tool_name: "Bash",
          tool_input: { command: "ls -la" },
        },
      };
      const result = adapter.normalizeHookPayload(raw, "PreToolUse");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("permission_request");
      expect(result!.sessionId).toBe("sess-123");
      expect(result!.toolName).toBe("Bash");
      expect(result!.toolInput).toEqual({ command: "ls -la" });
      expect(result!.rawPayload).toBe(raw);
    });

    it("PreToolUse with kebab-case endpoint", () => {
      const raw = {
        session_id: "sess-123",
        tool: { tool_name: "Read", tool_input: { file_path: "/tmp/file" } },
      };
      const result = adapter.normalizeHookPayload(raw, "pre-tool-use");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("permission_request");
      expect(result!.toolName).toBe("Read");
    });

    it("PreToolUse without tool returns null", () => {
      const result = adapter.normalizeHookPayload({ session_id: "s1" }, "PreToolUse");
      expect(result).toBeNull();
    });

    it("PostToolUse -> tool_complete", () => {
      const raw = {
        session_id: "sess-456",
        tool: {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          tool_output: "hello\n",
        },
      };
      const result = adapter.normalizeHookPayload(raw, "PostToolUse");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("tool_complete");
      expect(result!.sessionId).toBe("sess-456");
      expect(result!.toolName).toBe("Bash");
      expect(result!.toolOutput).toBe("hello\n");
    });

    it("PostToolUse with kebab-case endpoint", () => {
      const raw = {
        session_id: "s1",
        tool: { tool_name: "Write", tool_input: {}, tool_output: "ok" },
      };
      const result = adapter.normalizeHookPayload(raw, "post-tool-use");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("tool_complete");
    });

    it("PostToolUse without tool returns null", () => {
      const result = adapter.normalizeHookPayload({ session_id: "s1" }, "PostToolUse");
      expect(result).toBeNull();
    });

    it("Notification -> notification", () => {
      const raw = { message: "Agent is thinking about the problem" };
      const result = adapter.normalizeHookPayload(raw, "Notification");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("notification");
      expect(result!.message).toBe("Agent is thinking about the problem");
    });

    it("Notification with kebab-case endpoint", () => {
      const raw = { message: "Progress update" };
      const result = adapter.normalizeHookPayload(raw, "notification");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("notification");
    });

    it("Notification without message falls back to JSON.stringify", () => {
      const raw = { type: "info", data: 42 };
      const result = adapter.normalizeHookPayload(raw, "Notification");
      expect(result).not.toBeNull();
      expect(result!.message).toBe(JSON.stringify(raw));
    });

    it("Stop -> stop", () => {
      const raw = { session_id: "sess-789", stop_hook_active: true };
      const result = adapter.normalizeHookPayload(raw, "Stop");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stop");
      expect(result!.sessionId).toBe("sess-789");
    });

    it("Stop with kebab-case endpoint", () => {
      const raw = { session_id: "s1" };
      const result = adapter.normalizeHookPayload(raw, "stop");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stop");
    });

    it("null input returns null", () => {
      expect(adapter.normalizeHookPayload(null, "PreToolUse")).toBeNull();
    });

    it("non-object input returns null", () => {
      expect(adapter.normalizeHookPayload("string", "PreToolUse")).toBeNull();
      expect(adapter.normalizeHookPayload(42, "PreToolUse")).toBeNull();
    });

    it("unknown endpoint returns null", () => {
      const result = adapter.normalizeHookPayload({ data: 1 }, "UnknownHook");
      expect(result).toBeNull();
    });
  });

  describe("extractPermission", () => {
    it("builds correct PermissionRequestPayload", () => {
      const raw = {
        session_id: "sess-1",
        tool: {
          tool_name: "Bash",
          tool_input: { command: "rm -rf /tmp/junk" },
        },
      };
      const result = adapter.extractPermission(raw);
      expect(result).not.toBeNull();
      expect(result!.requestId).toBeDefined();
      expect(result!.requestId.length).toBeGreaterThan(0);
      expect(result!.toolName).toBe("Bash");
      expect(result!.toolInput).toEqual({ command: "rm -rf /tmp/junk" });
      expect(result!.riskLevel).toBe("dangerous");
      expect(result!.summary).toBe("rm -rf /tmp/junk");
      expect(result!.target).toBe("rm -rf /tmp/junk");
      expect(result!.rawPayload).toBe(raw);
    });

    it("returns null for null input", () => {
      expect(adapter.extractPermission(null)).toBeNull();
    });

    it("returns null when tool is missing", () => {
      expect(adapter.extractPermission({ session_id: "s1" })).toBeNull();
    });

    it("classifies risk for Write tool", () => {
      const raw = {
        tool: {
          tool_name: "Write",
          tool_input: { file_path: "/etc/hosts", content: "malicious" },
        },
      };
      const result = adapter.extractPermission(raw);
      expect(result!.riskLevel).toBe("dangerous");
    });

    it("classifies safe tool correctly", () => {
      const raw = {
        tool: {
          tool_name: "Read",
          tool_input: { file_path: "/tmp/safe.txt" },
        },
      };
      const result = adapter.extractPermission(raw);
      expect(result!.riskLevel).toBe("safe");
    });
  });

  describe("classifyRisk", () => {
    it("delegates to protocol classifyRisk", () => {
      expect(adapter.classifyRisk("Bash", { command: "rm -rf /" })).toBe("dangerous");
      expect(adapter.classifyRisk("Read", { file_path: "/tmp" })).toBe("safe");
      expect(adapter.classifyRisk("Bash", { command: "curl example.com" })).toBe("moderate");
    });
  });
});

// ── Codex Adapter ──────────────────────────────────────────────────────

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  describe("normalizeHookPayload", () => {
    it("BeforeTool -> permission_request", () => {
      const raw = {
        thread_id: "thread-abc",
        tool_call: {
          name: "Bash",
          arguments: JSON.stringify({ command: "echo test" }),
        },
      };
      const result = adapter.normalizeHookPayload(raw, "BeforeTool");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("permission_request");
      expect(result!.sessionId).toBe("thread-abc");
      expect(result!.toolName).toBe("Bash");
      expect(result!.toolInput).toEqual({ command: "echo test" });
    });

    it("BeforeTool with kebab-case endpoint", () => {
      const raw = {
        thread_id: "t1",
        tool_call: { name: "Read", arguments: JSON.stringify({ file_path: "/tmp/x" }) },
      };
      const result = adapter.normalizeHookPayload(raw, "before-tool");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("permission_request");
    });

    it("correctly parses JSON string in arguments field", () => {
      const raw = {
        thread_id: "t1",
        tool_call: {
          name: "Write",
          arguments: '{"file_path":"/src/main.ts","content":"hello world"}',
        },
      };
      const result = adapter.normalizeHookPayload(raw, "BeforeTool");
      expect(result!.toolInput).toEqual({
        file_path: "/src/main.ts",
        content: "hello world",
      });
    });

    it("handles object arguments (non-string)", () => {
      const raw = {
        thread_id: "t1",
        tool_call: {
          name: "Bash",
          arguments: { command: "ls" },
        },
      };
      const result = adapter.normalizeHookPayload(raw, "BeforeTool");
      expect(result!.toolInput).toEqual({ command: "ls" });
    });

    it("handles invalid JSON in arguments gracefully", () => {
      const raw = {
        thread_id: "t1",
        tool_call: {
          name: "Bash",
          arguments: "not valid json {{{",
        },
      };
      const result = adapter.normalizeHookPayload(raw, "BeforeTool");
      expect(result).not.toBeNull();
      expect(result!.toolInput).toEqual({});
    });

    it("BeforeTool without tool_call returns null", () => {
      const result = adapter.normalizeHookPayload({ thread_id: "t1" }, "BeforeTool");
      expect(result).toBeNull();
    });

    it("AfterTool -> tool_complete", () => {
      const raw = {
        thread_id: "thread-xyz",
        tool_call: {
          name: "Bash",
          arguments: JSON.stringify({ command: "echo done" }),
          output: "done\n",
        },
      };
      const result = adapter.normalizeHookPayload(raw, "AfterTool");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("tool_complete");
      expect(result!.toolOutput).toBe("done\n");
      expect(result!.toolName).toBe("Bash");
    });

    it("AfterTool with kebab-case endpoint", () => {
      const raw = {
        thread_id: "t1",
        tool_call: { name: "Read", arguments: "{}", output: "contents" },
      };
      const result = adapter.normalizeHookPayload(raw, "after-tool");
      expect(result!.type).toBe("tool_complete");
    });

    it("NotifyAgentTurnComplete -> stop", () => {
      const raw = { thread_id: "thread-done" };
      const result = adapter.normalizeHookPayload(raw, "NotifyAgentTurnComplete");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stop");
      expect(result!.sessionId).toBe("thread-done");
    });

    it("null input returns null", () => {
      expect(adapter.normalizeHookPayload(null, "BeforeTool")).toBeNull();
    });

    it("unknown endpoint returns null", () => {
      const result = adapter.normalizeHookPayload({ data: 1 }, "UnknownHook");
      expect(result).toBeNull();
    });
  });
});

// ── Adapter Registry ───────────────────────────────────────────────────

describe("AdapterRegistry", () => {
  it("lists all 3 built-in adapters", () => {
    const registry = new AdapterRegistry();
    const adapters = registry.list();
    expect(adapters).toHaveLength(3);
    const names = adapters.map((a) => a.name);
    expect(names).toContain("claude");
    expect(names).toContain("codex");
    expect(names).toContain("gemini");
  });

  it('get("claude") returns Claude adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.get("claude");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("claude");
    expect(adapter!.displayName).toBe("Claude Code");
  });

  it('get("codex") returns Codex adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.get("codex");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("codex");
  });

  it('get("gemini") returns Gemini adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.get("gemini");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("gemini");
  });

  it("get with unknown name returns undefined", () => {
    const registry = new AdapterRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it('findByPrefix("ap-cc") returns Claude adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.findByPrefix("ap-cc");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("claude");
  });

  it('findByPrefix("ap-cc-abc123") returns Claude adapter (prefix match)', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.findByPrefix("ap-cc-abc123");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("claude");
  });

  it('findByPrefix("ap-cx") returns Codex adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.findByPrefix("ap-cx");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("codex");
  });

  it('findByPrefix("ap-gm") returns Gemini adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.findByPrefix("ap-gm");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("gemini");
  });

  it("findByPrefix with unknown prefix returns undefined", () => {
    const registry = new AdapterRegistry();
    expect(registry.findByPrefix("ap-xx")).toBeUndefined();
  });

  it('findByBinary("claude") returns Claude adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.findByBinary("claude");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("claude");
  });

  it('findByBinary("codex") returns Codex adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.findByBinary("codex");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("codex");
  });

  it('findByBinary("gemini") returns Gemini adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = registry.findByBinary("gemini");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("gemini");
  });

  it("findByBinary with unknown binary returns undefined", () => {
    const registry = new AdapterRegistry();
    expect(registry.findByBinary("unknown-agent")).toBeUndefined();
  });
});
