import { SCROLLBACK_LINES } from "@agentpager/protocol";

/**
 * Ring buffer for terminal output.
 * Stores lines with backpressure support.
 */
export class TerminalBuffer {
  private lines: string[] = [];
  private maxLines: number;
  private totalBytes = 0;

  constructor(maxLines = SCROLLBACK_LINES) {
    this.maxLines = maxLines;
  }

  /**
   * Append data to the buffer. Splits by newline.
   */
  append(data: string): void {
    const newLines = data.split("\n");
    this.lines.push(...newLines);
    this.totalBytes += data.length;

    // Trim if over capacity
    while (this.lines.length > this.maxLines) {
      const removed = this.lines.shift();
      if (removed) this.totalBytes -= removed.length + 1;
    }
  }

  /**
   * Get all buffered lines.
   */
  getAll(): string[] {
    return this.lines;
  }

  /**
   * Get the last N lines.
   */
  getLast(n: number): string[] {
    return this.lines.slice(-n);
  }

  /**
   * Get total byte size.
   */
  size(): number {
    return this.totalBytes;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.lines = [];
    this.totalBytes = 0;
  }
}
