import { edwardsToMontgomeryPriv, edwardsToMontgomeryPub } from "@noble/curves/ed25519";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

/**
 * E2E Encryption — X25519 ECDH + AES-256-GCM.
 *
 * Converts existing Ed25519 keys to X25519 for key agreement,
 * derives a shared AES-256-GCM key via HKDF-SHA256,
 * then encrypts/decrypts message envelopes.
 *
 * The relay only sees: { e2e: true, nonce, ciphertext, hint? }
 */
export class E2EEncryption {
  private sharedKey: Uint8Array | null = null;
  private nonceCounter = 0;

  /**
   * Derive a shared AES-256-GCM key from our Ed25519 private key
   * and the peer's Ed25519 public key.
   */
  async deriveSharedKey(
    ourEd25519Private: Uint8Array,
    theirEd25519Public: Uint8Array
  ): Promise<void> {
    // Convert Ed25519 → X25519 (Curve25519)
    const ourX25519Private = edwardsToMontgomeryPriv(ourEd25519Private);
    const theirX25519Public = edwardsToMontgomeryPub(theirEd25519Public);

    // X25519 ECDH → raw shared secret
    const rawSharedSecret = x25519.getSharedSecret(ourX25519Private, theirX25519Public);

    // HKDF-SHA256 → 32-byte AES key
    const info = new TextEncoder().encode("agentpager-e2e-v1");
    this.sharedKey = hkdf(sha256, rawSharedSecret, undefined, info, 32);

    // Reset nonce counter for new session
    this.nonceCounter = 0;
  }

  get isReady(): boolean {
    return this.sharedKey !== null;
  }

  /**
   * Encrypt a plaintext string.
   * Returns { ciphertext, nonce } as base64url-encoded strings.
   */
  async encrypt(plaintext: string): Promise<{ ciphertext: string; nonce: string }> {
    if (!this.sharedKey) throw new Error("E2E not initialized");

    // 12-byte nonce: 4 bytes counter + 8 bytes random
    const nonce = this.generateNonce();

    // Import key for WebCrypto — cast to ArrayBuffer for Bun types
    const keyBuffer = new Uint8Array(this.sharedKey).buffer as ArrayBuffer;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      "AES-GCM",
      false,
      ["encrypt"]
    );

    const encoded = new TextEncoder().encode(plaintext);
    const nonceBuffer = new Uint8Array(nonce).buffer as ArrayBuffer;
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonceBuffer },
      key,
      encoded
    );

    return {
      ciphertext: bufferToBase64Url(encrypted),
      nonce: bufferToBase64Url(nonce),
    };
  }

  /**
   * Decrypt a ciphertext + nonce (both base64url-encoded).
   * Returns the plaintext string.
   */
  async decrypt(ciphertextB64: string, nonceB64: string): Promise<string> {
    if (!this.sharedKey) throw new Error("E2E not initialized");

    const ciphertext = base64UrlToBuffer(ciphertextB64);
    const nonce = base64UrlToBuffer(nonceB64);

    const keyBuffer = new Uint8Array(this.sharedKey).buffer as ArrayBuffer;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      "AES-GCM",
      false,
      ["decrypt"]
    );

    const nonceBuffer = new Uint8Array(nonce).buffer as ArrayBuffer;
    const ciphertextBuffer = new Uint8Array(ciphertext).buffer as ArrayBuffer;
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonceBuffer },
      key,
      ciphertextBuffer
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Generate a 12-byte nonce: 4-byte counter + 8-byte random.
   */
  private generateNonce(): Uint8Array {
    const nonce = new Uint8Array(12);
    // First 4 bytes: counter (monotonic)
    const counter = this.nonceCounter++;
    nonce[0] = (counter >> 24) & 0xff;
    nonce[1] = (counter >> 16) & 0xff;
    nonce[2] = (counter >> 8) & 0xff;
    nonce[3] = counter & 0xff;
    // Last 8 bytes: random
    crypto.getRandomValues(nonce.subarray(4));
    return nonce;
  }
}

// ── E2E wire format helpers ──────────────────────────────────────────

export interface E2EWireMessage {
  e2e: true;
  nonce: string;
  ciphertext: string;
  hint?: {
    type: string;
    toolName?: string;
    risk?: string;
  };
}

export function isE2EMessage(data: unknown): data is E2EWireMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as any).e2e === true &&
    typeof (data as any).nonce === "string" &&
    typeof (data as any).ciphertext === "string"
  );
}

// ── Base64url helpers ────────────────────────────────────────────────

function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuffer(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
