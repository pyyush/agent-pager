import { satisfies } from "semver";
import type { AgentAdapter } from "./base.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GeminiAdapter } from "./gemini.js";

/**
 * Adapter registry — auto-discovers built-in and custom adapters.
 * Detects installed agent versions and validates compatibility.
 */
export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private versions = new Map<string, string>();

  constructor() {
    // Register built-in adapters
    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter());
    this.register(new GeminiAdapter());
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Detect installed agents and check version compatibility.
   * Logs warnings for version mismatches but never prevents startup.
   */
  async detectAll(): Promise<
    Array<{
      adapter: AgentAdapter;
      version: string | null;
      compatible: boolean;
    }>
  > {
    const results: Array<{
      adapter: AgentAdapter;
      version: string | null;
      compatible: boolean;
    }> = [];

    for (const adapter of this.adapters.values()) {
      const version = await adapter.detectVersion();
      let compatible = true;

      if (version) {
        this.versions.set(adapter.name, version);
        compatible = satisfies(version, adapter.compatibility);
        if (!compatible) {
          console.warn(
            `[adapters] ${adapter.displayName} v${version} outside supported range ${adapter.compatibility}`
          );
        }
      }

      results.push({ adapter, version, compatible });
    }

    return results;
  }

  getVersion(name: string): string | undefined {
    return this.versions.get(name);
  }

  /**
   * Find adapter by tmux session prefix.
   * Used during recovery to map tmux sessions back to adapters.
   */
  findByPrefix(prefix: string): AgentAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (prefix.startsWith(adapter.sessionPrefix)) {
        return adapter;
      }
    }
    return undefined;
  }

  /**
   * Find adapter by binary name (for auto-detection from hook payloads).
   */
  findByBinary(binary: string): AgentAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.binary === binary) {
        return adapter;
      }
    }
    return undefined;
  }
}
