import { statSync } from "node:fs";
import type { GatewayConfig } from "../config.js";
import { dbPath } from "../config.js";
import { MAX_DB_SIZE_BYTES } from "../limits.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  dbSizeBytes: number;
  dbSizeWarning: boolean;
  activeClients: number;
  activeSessions: number;
  pendingApprovals: number;
}

const startTime = Date.now();

/**
 * Perform a health check on the gateway.
 */
export function checkHealth(
  config: GatewayConfig,
  activeClients: number,
  activeSessions: number,
  pendingApprovals: number
): HealthStatus {
  let dbSizeBytes = 0;
  let dbSizeWarning = false;

  try {
    const stat = statSync(dbPath(config));
    dbSizeBytes = stat.size;
    dbSizeWarning = dbSizeBytes > MAX_DB_SIZE_BYTES;
  } catch {
    // DB might not exist yet
  }

  let status: HealthStatus["status"] = "healthy";
  if (dbSizeWarning) status = "degraded";

  return {
    status,
    uptime: Date.now() - startTime,
    dbSizeBytes,
    dbSizeWarning,
    activeClients,
    activeSessions,
    pendingApprovals,
  };
}
