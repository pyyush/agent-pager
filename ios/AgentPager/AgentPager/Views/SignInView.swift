import SwiftUI
import AuthenticationServices

struct SignInView: View {
    @Environment(AppState.self) private var appState
    let authService: AuthService

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            VStack(spacing: 16) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 80, height: 80)
                    .clipShape(RoundedRectangle(cornerRadius: 18))

                Text("AgentPager")
                    .font(.largeTitle.weight(.bold))

                Text("Control plane for AI coding agents")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer()

            VStack(spacing: 16) {
                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = [.fullName, .email]
                } onCompletion: { result in
                    switch result {
                    case .success(let authorization):
                        handleAuthorization(authorization)
                    case .failure(let error):
                        print("Sign in failed: \(error.localizedDescription)")
                    }
                }
                .signInWithAppleButtonStyle(.whiteOutline)
                .frame(height: 50)
                .padding(.horizontal, 40)

                Text("Required for cloud connectivity")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Spacer()
                .frame(height: 40)
        }
    }

    private func handleAuthorization(_ authorization: ASAuthorization) {
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

        Task {
            let relayUrl = appState.gateway.relayUrl ?? ProtocolConstants.defaultRelayUrl
            await authService.exchangeAppleToken(
                identityToken: identityToken,
                displayName: name,
                relayUrl: relayUrl
            )
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview {
    PreviewWrapper {
        SignInView(authService: AuthService())
    }
}
#endif
