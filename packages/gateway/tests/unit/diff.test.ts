import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateDiff } from "../../src/diff/generator.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TMP_DIR = join("/tmp", "agentpager-diff-test-" + process.pid);

describe("generateDiff", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  describe("Write tool", () => {
    it("new file (no existing) generates create diff", () => {
      const filePath = join(TMP_DIR, "new-file.ts");
      const result = generateDiff("Write", {
        file_path: filePath,
        content: "const a = 1;\nconst b = 2;\n",
      });

      expect(result).not.toBeNull();
      expect(result!.filePath).toBe(filePath);
      expect(result!.additions).toBeGreaterThan(0);
      expect(result!.deletions).toBe(0);
      expect(result!.isBinary).toBe(false);
      expect(result!.hunks.length).toBeGreaterThan(0);
    });

    it("existing file generates modification diff", () => {
      const filePath = join(TMP_DIR, "existing.ts");
      writeFileSync(filePath, "const a = 1;\nconst b = 2;\n");

      const result = generateDiff("Write", {
        file_path: filePath,
        content: "const a = 1;\nconst b = 3;\nconst c = 4;\n",
      });

      expect(result).not.toBeNull();
      expect(result!.filePath).toBe(filePath);
      expect(result!.additions).toBeGreaterThan(0);
      expect(result!.deletions).toBeGreaterThan(0);
      expect(result!.isBinary).toBe(false);
    });

    it("no change produces empty hunks", () => {
      const filePath = join(TMP_DIR, "no-change.ts");
      const content = "const x = 42;\n";
      writeFileSync(filePath, content);

      const result = generateDiff("Write", {
        file_path: filePath,
        content,
      });

      expect(result).not.toBeNull();
      expect(result!.hunks).toHaveLength(0);
      expect(result!.additions).toBe(0);
      expect(result!.deletions).toBe(0);
    });

    it("returns null when file_path is missing", () => {
      const result = generateDiff("Write", { content: "hello" });
      expect(result).toBeNull();
    });

    it("returns null when content is missing", () => {
      const result = generateDiff("Write", { file_path: "/tmp/test.txt" });
      expect(result).toBeNull();
    });
  });

  describe("Edit tool", () => {
    it("old_string/new_string generates correct diff", () => {
      const filePath = join(TMP_DIR, "edit-target.ts");
      writeFileSync(filePath, 'const greeting = "hello";\nconsole.log(greeting);\n');

      const result = generateDiff("Edit", {
        file_path: filePath,
        old_string: '"hello"',
        new_string: '"world"',
      });

      expect(result).not.toBeNull();
      expect(result!.filePath).toBe(filePath);
      expect(result!.additions).toBeGreaterThan(0);
      expect(result!.deletions).toBeGreaterThan(0);
    });

    it("replace_all flag replaces all occurrences", () => {
      const filePath = join(TMP_DIR, "replace-all.ts");
      writeFileSync(filePath, "foo bar foo baz foo\n");

      const result = generateDiff("Edit", {
        file_path: filePath,
        old_string: "foo",
        new_string: "qux",
        replace_all: true,
      });

      expect(result).not.toBeNull();
      // The diff should show the replacement
      expect(result!.additions).toBeGreaterThan(0);
      expect(result!.deletions).toBeGreaterThan(0);
    });

    it("non-existent file returns null", () => {
      const result = generateDiff("Edit", {
        file_path: join(TMP_DIR, "does-not-exist.ts"),
        old_string: "a",
        new_string: "b",
      });
      expect(result).toBeNull();
    });

    it("old_string not found in file returns null", () => {
      const filePath = join(TMP_DIR, "no-match.ts");
      writeFileSync(filePath, "const x = 1;\n");

      const result = generateDiff("Edit", {
        file_path: filePath,
        old_string: "nonexistent string",
        new_string: "replacement",
      });
      expect(result).toBeNull();
    });

    it("returns null when old_string is missing", () => {
      const filePath = join(TMP_DIR, "test.ts");
      writeFileSync(filePath, "content");

      const result = generateDiff("Edit", {
        file_path: filePath,
        new_string: "replacement",
      });
      expect(result).toBeNull();
    });
  });

  describe("binary file detection", () => {
    // Note: Binary detection uses Bun.file() which is only available in the Bun runtime.
    // When running under Vitest (Node.js), the Bun.file() call throws, the catch returns
    // false, and the file is treated as non-binary. These tests verify the fallback behavior
    // under Node.js and the expected behavior under Bun.
    const isBun = typeof globalThis.Bun !== "undefined";

    it("binary file extension: returns isBinary under Bun, falls back under Node", () => {
      const filePath = join(TMP_DIR, "image.png");
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = generateDiff("Write", {
        file_path: filePath,
        content: "new content",
      });

      expect(result).not.toBeNull();
      if (isBun) {
        expect(result!.isBinary).toBe(true);
        expect(result!.hunks).toHaveLength(0);
      } else {
        // Under Node.js, Bun.file() is unavailable so binary detection returns false
        expect(result!.isBinary).toBe(false);
      }
    });

    it("new text file without existing file is not detected as binary", () => {
      const filePath = join(TMP_DIR, "new-text-file.ts");
      const result = generateDiff("Write", {
        file_path: filePath,
        content: "const x = 1;",
      });
      expect(result).not.toBeNull();
      expect(result!.isBinary).toBe(false);
    });
  });

  describe("diff truncation for large files", () => {
    it("large diff is truncated", () => {
      const filePath = join(TMP_DIR, "large.ts");
      writeFileSync(filePath, "");

      // Generate content larger than a small maxBytes limit
      const largeContent = Array.from({ length: 500 }, (_, i) => `const line${i} = ${i};`).join(
        "\n"
      );

      const result = generateDiff(
        "Write",
        { file_path: filePath, content: largeContent },
        256 // very small maxBytes to force truncation
      );

      expect(result).not.toBeNull();
      expect(result!.isTruncated).toBe(true);
    });
  });

  describe("unsupported tool names", () => {
    it("returns null for non-Write/Edit tools", () => {
      expect(generateDiff("Bash", { command: "ls" })).toBeNull();
      expect(generateDiff("Read", { file_path: "/tmp/test" })).toBeNull();
      expect(generateDiff("Grep", { pattern: "foo" })).toBeNull();
    });
  });
});
