import { AgentPagerDB } from "../db/database.js";
import { SessionManager } from "../sessions/manager.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { listTmuxSessions, isTmuxSessionAlive } from "../sessions/tmux.js";

/**
 * Startup recovery — reconciles DB state with running tmux sessions.
 *
 * On gateway crash/restart:
 * 1. Find all DB sessions marked as active (created/running/waiting)
 * 2. Check if their tmux sessions are still alive
 * 3. If alive: restore the session handle
 * 4. If dead: mark as stopped in DB
 */
export async function recoverSessions(
  db: AgentPagerDB,
  sessions: SessionManager,
  adapters: AdapterRegistry
): Promise<{ restored: number; cleaned: number }> {
  let restored = 0;
  let cleaned = 0;

  // Get active sessions from DB
  const activeSessions = db.listSessions(true);
  if (activeSessions.length === 0) {
    console.log("[recovery] No active sessions to recover");
    return { restored, cleaned };
  }

  console.log(
    `[recovery] Found ${activeSessions.length} active sessions in DB`
  );

  // Get running tmux sessions
  const tmuxSessions = await listTmuxSessions("ap-");
  const tmuxNames = new Set(tmuxSessions.map((s) => s.name));

  // Also check old Agent Pager prefix
  const oldTmuxSessions = await listTmuxSessions("cc-");
  for (const s of oldTmuxSessions) {
    tmuxNames.add(s.name);
  }

  for (const dbSession of activeSessions) {
    const tmuxName = dbSession.tmux_session;

    if (tmuxName && tmuxNames.has(tmuxName)) {
      // tmux session is alive — restore it
      const adapter = adapters.findByPrefix(tmuxName);
      if (adapter) {
        sessions.restore(adapter, dbSession);
        restored++;
        console.log(
          `[recovery] Restored session ${dbSession.id} (tmux: ${tmuxName})`
        );
      } else {
        // Unknown prefix — check if still alive
        const alive = await isTmuxSessionAlive(tmuxName);
        if (alive) {
          // Use default adapter
          const defaultAdapter = adapters.get("claude");
          if (defaultAdapter) {
            sessions.restore(defaultAdapter, dbSession);
            restored++;
            console.log(
              `[recovery] Restored session ${dbSession.id} with default adapter (tmux: ${tmuxName})`
            );
          }
        } else {
          db.updateSessionStatus(dbSession.id, "stopped");
          cleaned++;
        }
      }
    } else {
      // tmux session is dead — mark as stopped
      db.updateSessionStatus(dbSession.id, "stopped");
      cleaned++;
      console.log(
        `[recovery] Cleaned stale session ${dbSession.id} (tmux: ${tmuxName})`
      );
    }
  }

  return { restored, cleaned };
}
