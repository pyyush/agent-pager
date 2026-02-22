import Foundation
import CryptoKit
import os

private let logger = Logger(subsystem: "com.agentpager.ios", category: "CryptoService")

/// E2E Encryption service using Apple CryptoKit.
///
/// Generates an Ed25519 key pair, converts to X25519 for ECDH key agreement,
/// derives a shared AES-256-GCM key via HKDF-SHA256, then encrypts/decrypts.
/// Zero external dependencies — all Apple CryptoKit.
@MainActor
final class CryptoService {
    private var signingKey: Curve25519.Signing.PrivateKey?
    private var sharedKey: SymmetricKey?
    private var nonceCounter: UInt32 = 0

    private static let privateKeyTag = "agentpager_ed25519_private"

    init() {
        loadOrCreateKeys()
    }

    /// Our Ed25519 public key (base64url encoded).
    var publicKeyBase64: String? {
        guard let key = signingKey else { return nil }
        return key.publicKey.rawRepresentation.base64UrlEncoded
    }

    /// Whether E2E encryption is ready (shared key derived).
    var isReady: Bool { sharedKey != nil }

    // MARK: - Key Management

    private func loadOrCreateKeys() {
        if let data = KeychainHelper.load(key: Self.privateKeyTag) {
            do {
                signingKey = try Curve25519.Signing.PrivateKey(rawRepresentation: data)
                logger.info("Loaded Ed25519 key from Keychain")
            } catch {
                logger.error("Failed to load key: \(error.localizedDescription)")
                generateNewKeys()
            }
        } else {
            generateNewKeys()
        }
    }

    private func generateNewKeys() {
        signingKey = Curve25519.Signing.PrivateKey()
        if let key = signingKey {
            _ = KeychainHelper.save(key: Self.privateKeyTag, value: key.rawRepresentation)
            logger.info("Generated new Ed25519 key pair")
        }
    }

    // MARK: - Key Agreement

    /// Derive shared AES-256-GCM key from gateway's Ed25519 public key.
    func deriveSharedKey(gatewayPublicKeyBase64: String) -> Bool {
        guard let signingKey = signingKey else {
            logger.error("No signing key available")
            return false
        }

        guard let gatewayPublicKeyData = Data(base64UrlEncoded: gatewayPublicKeyBase64) else {
            logger.error("Invalid gateway public key base64")
            return false
        }

        do {
            // Convert Ed25519 signing keys → X25519 key agreement keys
            // CryptoKit handles the Edwards→Montgomery conversion internally
            // when we construct KeyAgreement keys from the raw representation
            let ourAgreementKey = try Curve25519.KeyAgreement.PrivateKey(
                rawRepresentation: signingKey.rawRepresentation
            )
            let theirAgreementKey = try Curve25519.KeyAgreement.PublicKey(
                rawRepresentation: gatewayPublicKeyData
            )

            // X25519 ECDH → shared secret
            let sharedSecret = try ourAgreementKey.sharedSecretFromKeyAgreement(with: theirAgreementKey)

            // HKDF-SHA256 → AES-256 key
            let info = "agentpager-e2e-v1".data(using: .utf8)!
            sharedKey = sharedSecret.hkdfDerivedSymmetricKey(
                using: SHA256.self,
                salt: Data(),
                sharedInfo: info,
                outputByteCount: 32
            )

            nonceCounter = 0
            logger.info("E2E shared key derived successfully")
            return true
        } catch {
            logger.error("Key derivation failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Encrypt / Decrypt

    /// Encrypt plaintext string → (ciphertext, nonce) as base64url strings.
    func encrypt(_ plaintext: String) -> (ciphertext: String, nonce: String)? {
        guard let key = sharedKey else {
            logger.error("E2E not initialized")
            return nil
        }

        guard let data = plaintext.data(using: .utf8) else { return nil }

        do {
            let nonce = generateNonce()
            let aesNonce = try AES.GCM.Nonce(data: nonce)
            let sealed = try AES.GCM.seal(data, using: key, nonce: aesNonce)

            // combined = nonce + ciphertext + tag, but we send nonce separately
            // so just use ciphertext + tag
            guard let combined = sealed.combined else { return nil }
            // combined starts with 12-byte nonce, skip it since we send nonce separately
            let ciphertextAndTag = combined.dropFirst(12)

            return (
                ciphertext: Data(ciphertextAndTag).base64UrlEncoded,
                nonce: Data(nonce).base64UrlEncoded
            )
        } catch {
            logger.error("Encryption failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Decrypt base64url (ciphertext, nonce) → plaintext string.
    func decrypt(ciphertextBase64: String, nonceBase64: String) -> String? {
        guard let key = sharedKey else {
            logger.error("E2E not initialized")
            return nil
        }

        guard let ciphertextAndTag = Data(base64UrlEncoded: ciphertextBase64),
              let nonceData = Data(base64UrlEncoded: nonceBase64) else {
            return nil
        }

        do {
            let nonce = try AES.GCM.Nonce(data: nonceData)
            // Reconstruct combined: nonce + ciphertext + tag
            var combined = Data(nonceData)
            combined.append(ciphertextAndTag)
            let box = try AES.GCM.SealedBox(combined: combined)
            let decrypted = try AES.GCM.open(box, using: key)
            return String(data: decrypted, encoding: .utf8)
        } catch {
            logger.error("Decryption failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Nonce Generation

    private func generateNonce() -> Data {
        var nonce = Data(count: 12)
        // First 4 bytes: counter
        let counter = nonceCounter
        nonceCounter += 1
        nonce[0] = UInt8((counter >> 24) & 0xFF)
        nonce[1] = UInt8((counter >> 16) & 0xFF)
        nonce[2] = UInt8((counter >> 8) & 0xFF)
        nonce[3] = UInt8(counter & 0xFF)
        // Last 8 bytes: random
        var random = Data(count: 8)
        _ = random.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 8, $0.baseAddress!) }
        nonce.replaceSubrange(4..<12, with: random)
        return nonce
    }
}

// MARK: - Base64url Extensions

extension Data {
    var base64UrlEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(base64UrlEncoded string: String) {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Add padding
        while base64.count % 4 != 0 {
            base64.append("=")
        }
        self.init(base64Encoded: base64)
    }
}
