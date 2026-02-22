import { describe, it, expect } from "vitest";
import { classifyRisk, summarizeTool, extractTarget } from "../risk.js";

// ── classifyRisk ───────────────────────────────────────────────────────

describe("classifyRisk", () => {
  describe("read-only tools -> safe", () => {
    const readOnlyTools = [
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Task",
      "TaskList",
      "TaskGet",
      "AskUserQuestion",
    ];

    for (const tool of readOnlyTools) {
      it(`${tool} is always safe`, () => {
        expect(classifyRisk(tool, {})).toBe("safe");
        expect(classifyRisk(tool, { anything: "whatever" })).toBe("safe");
      });
    }
  });

  describe("Bash -> destructive commands -> dangerous", () => {
    const destructive = [
      "rm -rf /",
      "rm -rf --no-preserve-root /",
      "rm -f important.db",
      "rmdir /some/dir",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sda1",
      "git push --force origin main",
      "git push -f origin main",
      "git reset --hard HEAD~5",
      "git clean -df",  // regex requires 'f' at end of flag group: -[^\s]*f
      "DROP TABLE users",
      "drop database production",
      "TRUNCATE TABLE events",
      "shutdown -h now",
      "reboot",
      "kill -9 1234",
      "pkill -9 node",
      "chmod 777 /etc/passwd",
      "chown root /etc/shadow",
      "format C:",
    ];

    for (const cmd of destructive) {
      it(`"${cmd}" is dangerous`, () => {
        expect(classifyRisk("Bash", { command: cmd })).toBe("dangerous");
      });
    }
  });

  describe("Bash -> install commands -> moderate", () => {
    const installCmds = [
      "npm install express",
      "npm i lodash",
      "pnpm add zod",
      "pnpm install",
      "yarn add react",
      "pip install requests",
      "pip3 install flask",
      "brew install jq",
      "apt install curl",
      "apt-get install build-essential",
      "cargo install ripgrep",
      "go install golang.org/x/tools/gopls@latest",
    ];

    for (const cmd of installCmds) {
      it(`"${cmd}" is moderate`, () => {
        expect(classifyRisk("Bash", { command: cmd })).toBe("moderate");
      });
    }
  });

  describe("Bash -> network commands -> moderate", () => {
    const networkCmds = [
      "curl https://example.com",
      "wget https://example.com/file.tar.gz",
      "ssh user@host",
      "scp file.txt user@host:/tmp/",
      "docker pull nginx:latest",
      "docker push myimage:latest",
      "nc localhost 8080",
    ];

    for (const cmd of networkCmds) {
      it(`"${cmd}" is moderate`, () => {
        expect(classifyRisk("Bash", { command: cmd })).toBe("moderate");
      });
    }
  });

  describe("Bash -> safe commands -> safe", () => {
    const safeCmds = [
      "echo hello",
      "ls -la",
      "cat file.txt",
      "pwd",
      "whoami",
      "date",
      "node -e 'console.log(1)'",
      "tsc --noEmit",
      "vitest run",
      "git status",
      "git log --oneline -5",
      "git diff HEAD",
    ];

    for (const cmd of safeCmds) {
      it(`"${cmd}" is safe`, () => {
        expect(classifyRisk("Bash", { command: cmd })).toBe("safe");
      });
    }
  });

  it("Bash with empty command is safe", () => {
    expect(classifyRisk("Bash", {})).toBe("safe");
    expect(classifyRisk("Bash", { command: "" })).toBe("safe");
  });

  describe("Write -> path analysis", () => {
    it("normal path is safe", () => {
      expect(classifyRisk("Write", { file_path: "/home/user/project/file.ts" })).toBe("safe");
      expect(classifyRisk("Write", { file_path: "./src/index.ts" })).toBe("safe");
    });

    it("system path is dangerous", () => {
      expect(classifyRisk("Write", { file_path: "/etc/passwd" })).toBe("dangerous");
      expect(classifyRisk("Write", { file_path: "/usr/local/bin/my-tool" })).toBe("dangerous");
      expect(classifyRisk("Write", { file_path: "/var/log/syslog" })).toBe("dangerous");
      expect(classifyRisk("Write", { file_path: "/boot/grub/grub.cfg" })).toBe("dangerous");
      expect(classifyRisk("Write", { file_path: "/sys/class/net" })).toBe("dangerous");
      expect(classifyRisk("Write", { file_path: "/proc/self/status" })).toBe("dangerous");
    });

    it("credential file is moderate", () => {
      expect(classifyRisk("Write", { file_path: "/home/user/.env" })).toBe("moderate");
      expect(classifyRisk("Write", { file_path: "./server.pem" })).toBe("moderate");
      expect(classifyRisk("Write", { file_path: "/app/secrets/key.key" })).toBe("moderate");
      expect(classifyRisk("Write", { file_path: "cert.crt" })).toBe("moderate");
      expect(classifyRisk("Write", { file_path: "store.p12" })).toBe("moderate");
      expect(classifyRisk("Write", { file_path: "my.pfx" })).toBe("moderate");
      expect(classifyRisk("Write", { file_path: "keystore.jks" })).toBe("moderate");
      expect(classifyRisk("Write", { file_path: "app.keystore" })).toBe("moderate");
    });

    it("empty path is safe", () => {
      expect(classifyRisk("Write", {})).toBe("safe");
      expect(classifyRisk("Write", { file_path: "" })).toBe("safe");
    });
  });

  describe("Edit -> same rules as Write", () => {
    it("normal path is safe", () => {
      expect(classifyRisk("Edit", { file_path: "./src/main.ts" })).toBe("safe");
    });

    it("system path is dangerous", () => {
      expect(classifyRisk("Edit", { file_path: "/etc/hosts" })).toBe("dangerous");
    });

    it("credential file is moderate", () => {
      expect(classifyRisk("Edit", { file_path: ".env" })).toBe("moderate");
    });
  });

  describe("NotebookEdit -> same rules as Write", () => {
    it("normal path is safe", () => {
      expect(classifyRisk("NotebookEdit", { notebook_path: "./notebook.ipynb" })).toBe("safe");
    });

    it("system path is dangerous", () => {
      expect(classifyRisk("NotebookEdit", { notebook_path: "/etc/jupyter/config.ipynb" })).toBe(
        "dangerous"
      );
    });

    it("credential file is moderate", () => {
      expect(classifyRisk("NotebookEdit", { notebook_path: "secrets.env" })).toBe("moderate");
    });

    it("empty notebook_path is safe", () => {
      expect(classifyRisk("NotebookEdit", {})).toBe("safe");
    });
  });

  describe("unknown/MCP tools -> moderate", () => {
    it("unknown tool is moderate", () => {
      expect(classifyRisk("SomeCustomTool", {})).toBe("moderate");
    });

    it("MCP tool is moderate", () => {
      expect(classifyRisk("mcp__github__create_pr", { repo: "test" })).toBe("moderate");
    });

    it("subagent tool is moderate", () => {
      expect(classifyRisk("Skill", { name: "review-pr" })).toBe("moderate");
    });
  });
});

// ── summarizeTool ──────────────────────────────────────────────────────

describe("summarizeTool", () => {
  it("Bash returns the command", () => {
    expect(summarizeTool("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("Bash truncates long commands at 120 chars", () => {
    const longCmd = "a".repeat(200);
    const result = summarizeTool("Bash", { command: longCmd });
    expect(result.length).toBe(120);
    expect(result.endsWith("...")).toBe(true);
  });

  it("Bash with empty command returns empty string", () => {
    expect(summarizeTool("Bash", {})).toBe("");
  });

  it("Write returns file path", () => {
    expect(summarizeTool("Write", { file_path: "/src/index.ts" })).toBe(
      "Write to /src/index.ts"
    );
  });

  it("Write with missing file_path falls back", () => {
    expect(summarizeTool("Write", {})).toBe("Write to unknown file");
  });

  it("Edit returns file path", () => {
    expect(summarizeTool("Edit", { file_path: "main.ts" })).toBe("Edit main.ts");
  });

  it("Read returns file path", () => {
    expect(summarizeTool("Read", { file_path: "/etc/hosts" })).toBe("Read /etc/hosts");
  });

  it("Glob returns the pattern", () => {
    expect(summarizeTool("Glob", { pattern: "**/*.ts" })).toBe("Search for files: **/*.ts");
  });

  it("Grep returns the pattern", () => {
    expect(summarizeTool("Grep", { pattern: "TODO" })).toBe("Search content: TODO");
  });

  it("NotebookEdit returns notebook path", () => {
    expect(summarizeTool("NotebookEdit", { notebook_path: "analysis.ipynb" })).toBe(
      "Edit notebook analysis.ipynb"
    );
  });

  it("unknown tool returns tool name", () => {
    expect(summarizeTool("mcp__custom__action", { data: 123 })).toBe("mcp__custom__action");
  });
});

// ── extractTarget ──────────────────────────────────────────────────────

describe("extractTarget", () => {
  it("Bash returns the command string", () => {
    expect(extractTarget("Bash", { command: "npm test" })).toBe("npm test");
  });

  it("Bash with missing command returns empty string", () => {
    expect(extractTarget("Bash", {})).toBe("");
  });

  it("Write returns file_path", () => {
    expect(extractTarget("Write", { file_path: "/app/config.ts" })).toBe("/app/config.ts");
  });

  it("Edit returns file_path", () => {
    expect(extractTarget("Edit", { file_path: "src/lib.ts" })).toBe("src/lib.ts");
  });

  it("Read returns file_path", () => {
    expect(extractTarget("Read", { file_path: "/tmp/log" })).toBe("/tmp/log");
  });

  it("NotebookEdit returns notebook_path", () => {
    expect(extractTarget("NotebookEdit", { notebook_path: "nb.ipynb" })).toBe("nb.ipynb");
  });

  it("Glob returns pattern", () => {
    expect(extractTarget("Glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  });

  it("Grep returns pattern", () => {
    expect(extractTarget("Grep", { pattern: "classifyRisk" })).toBe("classifyRisk");
  });

  it("unknown tool returns JSON-stringified input (truncated to 200)", () => {
    const input = { key: "value", nested: { a: 1 } };
    const result = extractTarget("CustomTool", input);
    expect(result).toBe(JSON.stringify(input).slice(0, 200));
  });

  it("unknown tool with large input truncates at 200 chars", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      input[`key_${i}`] = "x".repeat(20);
    }
    const result = extractTarget("CustomTool", input);
    expect(result.length).toBe(200);
  });
});
