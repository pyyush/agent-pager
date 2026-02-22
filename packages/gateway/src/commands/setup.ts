import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import QRCode from "qrcode";
import { loadOrCreateKeys, fingerprint } from "../security/keys.js";
import { DEFAULT_RELAY_URL } from "@agentpager/protocol";

interface SetupConfig {
  relayUrl: string;
  roomId: string;
  roomSecret: string;
  gatewayPublicKey: string;
}

/**
 * Interactive `agentpager setup` command.
 *
 * 1. Creates a room on the relay
 * 2. Generates a QR code for device pairing
 * 3. Saves relay config to ~/.agentpager/config.toml
 */
export async function runSetup(options?: {
  relayUrl?: string;
}): Promise<void> {
  const dataDir = join(homedir(), ".agentpager");
  const relayUrl = options?.relayUrl || DEFAULT_RELAY_URL;

  console.log("AgentPager Setup");
  console.log("─".repeat(40));

  // Step 1: Load or create gateway keys
  console.log("\n1. Loading gateway keys...");
  const keys = loadOrCreateKeys(dataDir);
  const fp = await fingerprint(keys.publicKey);
  console.log(`   Gateway fingerprint: ${fp}`);

  // Step 2: Create room on relay
  console.log("\n2. Creating room on relay...");
  const httpUrl = relayUrl
    .replace("wss://", "https://")
    .replace("ws://", "http://");

  const response = await fetch(`${httpUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create room: ${response.status} ${body}`);
  }

  const { roomId, roomSecret } = (await response.json()) as {
    roomId: string;
    roomSecret: string;
  };
  console.log(`   Room ID: ${roomId}`);

  // Step 3: Save to config.toml
  console.log("\n3. Saving relay config...");
  const configPath = join(dataDir, "config.toml");
  let config = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  // Remove existing relay config lines
  config = config
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("relay_enabled") &&
        !line.startsWith("relay_url") &&
        !line.startsWith("relay_room_id") &&
        !line.startsWith("relay_room_secret")
    )
    .join("\n");

  // Append relay config
  config += `\n# Cloud Relay\nrelay_enabled = true\nrelay_url = "${relayUrl}"\nrelay_room_id = "${roomId}"\nrelay_room_secret = "${roomSecret}"\n`;

  writeFileSync(configPath, config);
  console.log(`   Saved to ${configPath}`);

  // Step 4: Generate QR code
  console.log("\n4. Scan this QR code with the AgentPager iOS app:\n");

  const publicKeyB64 = Buffer.from(keys.publicKey).toString("base64url");
  const qrPayload: SetupConfig = {
    relayUrl,
    roomId,
    roomSecret,
    gatewayPublicKey: publicKeyB64,
  };

  const qrString = await QRCode.toString(JSON.stringify(qrPayload), {
    type: "terminal",
    small: true,
  });
  console.log(qrString);

  console.log("─".repeat(40));
  console.log("Setup complete! Start the gateway with: agentpager start");
  console.log(
    "Or manually: pnpm --filter @agentpager/gateway dev"
  );
}

// CLI entry point
if (import.meta.main) {
  const relayUrl = process.argv[2] || undefined;
  runSetup({ relayUrl }).catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
}
