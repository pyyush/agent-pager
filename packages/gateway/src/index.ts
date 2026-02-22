#!/usr/bin/env bun

import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";

async function main() {
  console.log("AgentPager Gateway v0.1.0");
  console.log("─".repeat(40));

  const config = await loadConfig();
  const gateway = new Gateway(config);

  // Handle graceful shutdown
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();

  console.log("─".repeat(40));
  console.log(
    `Hook HTTP:  http://127.0.0.1:${config.hookHttpPort}`
  );
  console.log(`WebSocket:  ws://0.0.0.0:${config.wsPort}/ws`);
  console.log(`Client:     http://localhost:${config.wsPort}`);
  if (config.relayEnabled) {
    console.log(`Relay:      ${config.relayUrl} (room: ${config.relayRoomId.slice(0, 8)}…)`);
  }
  console.log(`Data dir:   ${config.dataDir}`);
  console.log("─".repeat(40));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
