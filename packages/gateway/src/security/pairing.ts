import { TOTP } from "otpauth";
import { randomBytes } from "node:crypto";
import type { KeyPair } from "./keys.js";
import { fingerprint } from "./keys.js";
import { TOTP_MAX_ATTEMPTS, TOTP_WINDOW_MS } from "@agentpager/protocol";

export interface PairingInfo {
  gatewayId: string;
  publicKey: string;
  totpSecret: string;
  host: string;
  port: number;
}

export interface RelayPairingInfo {
  relayUrl: string;
  roomId: string;
  roomSecret: string;
  gatewayPublicKey: string;
}

export interface PairingAttempt {
  count: number;
  windowStart: number;
}

/**
 * Device pairing manager — handles QR code generation and TOTP verification.
 */
export class PairingManager {
  private totpSecret: string;
  private totp: TOTP;
  private attempts = new Map<string, PairingAttempt>();

  constructor(
    private gatewayKeys: KeyPair,
    private gatewayId: string
  ) {
    this.totpSecret = randomBytes(20).toString("hex");
    this.totp = new TOTP({
      secret: this.totpSecret,
      period: 30,
      digits: 6,
      algorithm: "SHA1",
    });
  }

  /**
   * Generate the QR code payload for device pairing.
   */
  async getPairingInfo(host: string, port: number): Promise<PairingInfo> {
    return {
      gatewayId: this.gatewayId,
      publicKey: Buffer.from(this.gatewayKeys.publicKey).toString("base64url"),
      totpSecret: this.totpSecret,
      host,
      port,
    };
  }

  /**
   * Verify a TOTP code from a pairing attempt.
   * Rate-limited to prevent brute force.
   */
  verifyCode(code: string, sourceIp: string): boolean {
    // Rate limiting
    const now = Date.now();
    const attempt = this.attempts.get(sourceIp) || {
      count: 0,
      windowStart: now,
    };

    if (now - attempt.windowStart > TOTP_WINDOW_MS) {
      attempt.count = 0;
      attempt.windowStart = now;
    }

    if (attempt.count >= TOTP_MAX_ATTEMPTS) {
      console.warn(`[pairing] Rate limited: ${sourceIp}`);
      return false;
    }

    attempt.count++;
    this.attempts.set(sourceIp, attempt);

    // Verify TOTP (allow ±1 window for clock skew)
    const delta = this.totp.validate({ token: code, window: 1 });
    return delta !== null;
  }

  /**
   * Generate relay pairing info for QR code.
   */
  getRelayPairingInfo(
    relayUrl: string,
    roomId: string,
    roomSecret: string
  ): RelayPairingInfo {
    return {
      relayUrl,
      roomId,
      roomSecret,
      gatewayPublicKey: Buffer.from(this.gatewayKeys.publicKey).toString(
        "base64url"
      ),
    };
  }

  /**
   * Regenerate the TOTP secret (invalidates existing QR codes).
   */
  regenerateSecret(): void {
    this.totpSecret = randomBytes(20).toString("hex");
    this.totp = new TOTP({
      secret: this.totpSecret,
      period: 30,
      digits: 6,
      algorithm: "SHA1",
    });
    this.attempts.clear();
  }
}
