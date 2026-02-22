import Foundation
import AuthenticationServices
import os

private let logger = Logger(subsystem: "com.agentpager.ios", category: "AuthService")

// MARK: - Auth Service

@Observable
@MainActor
final class AuthService: NSObject {
    var isAuthenticated = false
    var userId: String?
    var token: String?
    var displayName: String?

    private static let tokenKey = "agentpager_jwt"
    private static let userIdKey = "agentpager_user_id"
    private static let displayNameKey = "agentpager_display_name"

    override init() {
        super.init()
        restoreFromKeychain()
    }

    // MARK: - Apple Sign In

    func signInWithApple(presenting window: UIWindow?) {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    func signOut() {
        KeychainHelper.delete(key: Self.tokenKey)
        KeychainHelper.delete(key: Self.userIdKey)
        KeychainHelper.delete(key: Self.displayNameKey)
        isAuthenticated = false
        userId = nil
        token = nil
        displayName = nil
        logger.info("Signed out")
    }

    // MARK: - Token Management

    private func restoreFromKeychain() {
        if let savedToken = KeychainHelper.loadString(key: Self.tokenKey),
           let savedUserId = KeychainHelper.loadString(key: Self.userIdKey) {
            self.token = savedToken
            self.userId = savedUserId
            self.displayName = KeychainHelper.loadString(key: Self.displayNameKey)
            self.isAuthenticated = true
            logger.info("Restored auth from Keychain (user: \(savedUserId.prefix(8)))")
        }
    }

    private func saveToKeychain(token: String, userId: String, displayName: String?) {
        _ = KeychainHelper.save(key: Self.tokenKey, string: token)
        _ = KeychainHelper.save(key: Self.userIdKey, string: userId)
        if let displayName {
            _ = KeychainHelper.save(key: Self.displayNameKey, string: displayName)
        }
    }

    /// Exchange Apple identity token with the relay for a AgentPager JWT.
    func exchangeAppleToken(identityToken: String, displayName: String?, relayUrl: String) async -> Bool {
        guard let url = URL(string: "\(relayUrl)/api/auth/apple") else { return false }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "identityToken": identityToken,
            "displayName": displayName ?? "",
        ]

        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return false }
        request.httpBody = bodyData

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                logger.error("Apple auth exchange failed: \(String(data: data, encoding: .utf8) ?? "unknown")")
                return false
            }

            let result = try JSONDecoder().decode(AppleAuthResponse.self, from: data)
            self.token = result.token
            self.userId = result.userId
            self.displayName = displayName
            self.isAuthenticated = true

            saveToKeychain(token: result.token, userId: result.userId, displayName: displayName)
            logger.info("Apple auth success (user: \(result.userId.prefix(8)), new: \(result.isNewUser))")
            return true
        } catch {
            logger.error("Apple auth exchange error: \(error.localizedDescription)")
            return false
        }
    }
}

// MARK: - ASAuthorizationControllerDelegate

extension AuthService: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityTokenData = credential.identityToken,
              let identityToken = String(data: identityTokenData, encoding: .utf8) else {
            return
        }

        let name: String?
        if let fullName = credential.fullName {
            let components = [fullName.givenName, fullName.familyName].compactMap { $0 }
            name = components.isEmpty ? nil : components.joined(separator: " ")
        } else {
            name = nil
        }

        Task { @MainActor in
            let relayUrl = UserDefaults.standard.string(forKey: "relay_url") ?? ProtocolConstants.defaultRelayUrl
            let success = await exchangeAppleToken(
                identityToken: identityToken,
                displayName: name,
                relayUrl: relayUrl
            )
            if !success {
                logger.error("Failed to exchange Apple token")
            }
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        logger.error("Apple Sign In failed: \(error.localizedDescription)")
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding

extension AuthService: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // Return the first window scene's key window
        let scenes = UIApplication.shared.connectedScenes
        let windowScene = scenes.first as? UIWindowScene
        return windowScene?.windows.first ?? UIWindow()
    }
}

// MARK: - API Response Types

private struct AppleAuthResponse: Codable {
    let token: String
    let userId: String
    let isNewUser: Bool
}
