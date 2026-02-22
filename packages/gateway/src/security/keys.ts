import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// Configure noble to use sha512
ed.etc.sha512Sync = (...m) =>
  sha512(ed.etc.concatBytes(...m));

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Generate a new Ed25519 key pair.
 */
export function generateKeyPair(): KeyPair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Sign a message with a private key.
 */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed.sign(message, privateKey);
}

/**
 * Verify a signature.
 */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Compute a fingerprint for a public key (first 16 hex chars of SHA-256).
 */
export async function fingerprint(publicKey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(publicKey));
  return Array.from(new Uint8Array(hash).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Load or generate the gateway key pair.
 * Stored in ~/.agentpager/keys/ (fallback — production uses OS keychain).
 */
export function loadOrCreateKeys(dataDir: string): KeyPair {
  const keysDir = join(dataDir, "keys");
  const privPath = join(keysDir, "gateway.key");
  const pubPath = join(keysDir, "gateway.pub");

  if (existsSync(privPath) && existsSync(pubPath)) {
    return {
      privateKey: new Uint8Array(readFileSync(privPath)),
      publicKey: new Uint8Array(readFileSync(pubPath)),
    };
  }

  // Generate new key pair
  const keys = generateKeyPair();

  if (!existsSync(keysDir)) {
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(privPath, keys.privateKey, { mode: 0o600 });
  writeFileSync(pubPath, keys.publicKey, { mode: 0o644 });

  console.log(`[keys] Generated new Ed25519 key pair → ${keysDir}`);
  return keys;
}
