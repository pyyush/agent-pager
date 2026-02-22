import { createTwoFilesPatch, structuredPatch } from "diff";
import type { DiffPayload, DiffHunk } from "@agentpager/protocol";
import { MAX_DIFF_BYTES } from "@agentpager/protocol";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Generate a unified diff for a file edit/write operation.
 *
 * For Write: compares current file (if exists) with new content.
 * For Edit: applies old_string → new_string on current file content.
 */
export function generateDiff(
  toolName: string,
  toolInput: Record<string, unknown>,
  maxBytes = MAX_DIFF_BYTES
): DiffPayload | null {
  try {
    if (toolName === "Write") {
      return generateWriteDiff(toolInput, maxBytes);
    }
    if (toolName === "Edit") {
      return generateEditDiff(toolInput, maxBytes);
    }
    return null;
  } catch (err) {
    console.warn(`[diff] Failed to generate diff:`, err);
    return null;
  }
}

function generateWriteDiff(
  toolInput: Record<string, unknown>,
  maxBytes: number
): DiffPayload | null {
  const filePath = toolInput.file_path as string;
  const newContent = toolInput.content as string;
  if (!filePath || typeof newContent !== "string") return null;

  // Check if it's a binary or too-large file
  if (isBinaryOrTooLarge(filePath, maxBytes)) {
    return {
      filePath,
      hunks: [],
      additions: 0,
      deletions: 0,
      isBinary: true,
      isTruncated: false,
    };
  }

  // Read existing file (empty string if new file)
  let oldContent = "";
  if (existsSync(filePath)) {
    oldContent = readFileSync(filePath, "utf-8");
  }

  return computeDiff(filePath, oldContent, newContent, maxBytes);
}

function generateEditDiff(
  toolInput: Record<string, unknown>,
  maxBytes: number
): DiffPayload | null {
  const filePath = toolInput.file_path as string;
  const oldString = toolInput.old_string as string;
  const newString = toolInput.new_string as string;
  if (!filePath || typeof oldString !== "string" || typeof newString !== "string")
    return null;

  if (!existsSync(filePath)) return null;

  const fileContent = readFileSync(filePath, "utf-8");

  // Simulate the edit
  let newContent: string;
  if (toolInput.replace_all) {
    newContent = fileContent.split(oldString).join(newString);
  } else {
    const idx = fileContent.indexOf(oldString);
    if (idx === -1) return null; // old_string not found
    newContent =
      fileContent.slice(0, idx) + newString + fileContent.slice(idx + oldString.length);
  }

  return computeDiff(filePath, fileContent, newContent, maxBytes);
}

function computeDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  maxBytes: number
): DiffPayload {
  const patch = structuredPatch("a/" + filePath, "b/" + filePath, oldContent, newContent);

  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunk[] = [];
  let totalSize = 0;
  let isTruncated = false;

  for (const hunk of patch.hunks) {
    const lines = hunk.lines.map((l) => {
      if (l.startsWith("+")) additions++;
      if (l.startsWith("-")) deletions++;
      return l;
    });

    totalSize += lines.join("\n").length;
    if (totalSize > maxBytes) {
      isTruncated = true;
      break;
    }

    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
    });
  }

  return {
    filePath,
    hunks,
    additions,
    deletions,
    isBinary: false,
    isTruncated,
  };
}

function isBinaryOrTooLarge(filePath: string, maxBytes: number): boolean {
  if (!existsSync(filePath)) return false;

  try {
    const stat = statSync(filePath);
    if (stat.size > maxBytes) return true;

    // Check for binary content (sample first 8KB)
    const fd = Bun.file(filePath);
    // Simple heuristic: if the file extension suggests binary, treat as binary
    const binaryExtensions = [
      ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp",
      ".mp3", ".mp4", ".wav", ".avi", ".mov",
      ".zip", ".tar", ".gz", ".bz2", ".7z",
      ".exe", ".dll", ".so", ".dylib",
      ".wasm", ".pdf", ".docx", ".xlsx",
    ];
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
    return binaryExtensions.includes(ext);
  } catch {
    return false;
  }
}
