/**
 * tmux session management — create, attach, list, kill sessions.
 * tmux provides persistence (survives gateway restarts).
 */

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
}

/**
 * Check if tmux is available.
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * List all tmux sessions matching a prefix.
 */
export async function listTmuxSessions(
  prefix = "ap-"
): Promise<TmuxSession[]> {
  try {
    const proc = Bun.spawn(
      ["tmux", "list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) return [];

    return text
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, windows, attached, created] = line.split("\t");
        return {
          name,
          windows: parseInt(windows, 10),
          attached: attached === "1",
          created: parseInt(created, 10) * 1000,
        };
      })
      .filter((s) => s.name.startsWith(prefix));
  } catch {
    return [];
  }
}

/**
 * Create a new tmux session and run a command in it.
 */
export async function createTmuxSession(
  sessionName: string,
  command: string[],
  cwd?: string
): Promise<boolean> {
  try {
    const args = [
      "tmux",
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      "200",
      "-y",
      "50",
    ];

    if (cwd) {
      args.push("-c", cwd);
    }

    // The command to run
    args.push(command.join(" "));

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch (err) {
    console.error(`[tmux] Failed to create session ${sessionName}:`, err);
    return false;
  }
}

/**
 * Send keys (input) to a tmux session.
 * Uses -l for literal text, then sends Enter separately.
 */
export async function sendToTmux(
  sessionName: string,
  input: string
): Promise<boolean> {
  try {
    // Send the text literally (preserves spaces, special chars)
    const textProc = Bun.spawn(
      ["tmux", "send-keys", "-t", sessionName, "-l", input],
      { stdout: "pipe", stderr: "pipe" }
    );
    await textProc.exited;
    if (textProc.exitCode !== 0) return false;

    // Send Enter as a key name (not literal)
    const enterProc = Bun.spawn(
      ["tmux", "send-keys", "-t", sessionName, "Enter"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await enterProc.exited;
    return enterProc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Send raw keys (no Enter) to a tmux session.
 */
export async function sendRawToTmux(
  sessionName: string,
  keys: string
): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "send-keys", "-t", sessionName, "-l", keys], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Send Ctrl+C to a tmux session (pause/interrupt).
 */
export async function interruptTmux(sessionName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "send-keys", "-t", sessionName, "C-c"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux session.
 */
export async function killTmuxSession(sessionName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session exists and is alive.
 */
export async function isTmuxSessionAlive(
  sessionName: string
): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "has-session", "-t", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Capture the current tmux pane content (for terminal snapshots).
 */
export async function captureTmuxPane(
  sessionName: string,
  lines = 500
): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["tmux", "capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}
