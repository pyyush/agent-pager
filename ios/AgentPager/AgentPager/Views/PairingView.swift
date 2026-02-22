import SwiftUI
import os

private let logger = Logger(subsystem: "com.agentpager.ios", category: "PairingView")

/// QR payload from `agentpager setup`.
struct PairingPayload: Codable {
    let relayUrl: String
    let roomId: String
    let roomSecret: String
    let gatewayPublicKey: String
}

struct PairingView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var showScanner = false
    @State private var pairingError: String?
    @State private var isPaired = false

    // Manual entry fallback
    @State private var manualRelayUrl = ProtocolConstants.defaultRelayUrl
    @State private var manualRoomId = ""
    @State private var manualRoomSecret = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 48))
                            .foregroundStyle(Color.accentColor)

                        Text("Pair with Gateway")
                            .font(.headline)

                        Text("Run `agentpager setup` on your Mac, then scan the QR code")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .listRowBackground(Color.clear)
                }

                Section {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan QR Code", systemImage: "camera")
                    }
                }

                Section("Manual Entry") {
                    TextField("Relay URL", text: $manualRelayUrl)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Room ID", text: $manualRoomId)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    SecureField("Room Secret", text: $manualRoomSecret)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    Button("Connect Manually") {
                        applyPairing(PairingPayload(
                            relayUrl: manualRelayUrl,
                            roomId: manualRoomId,
                            roomSecret: manualRoomSecret,
                            gatewayPublicKey: ""
                        ))
                    }
                    .disabled(manualRoomId.isEmpty || manualRoomSecret.isEmpty)
                }

                if let error = pairingError {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }

                if isPaired {
                    Section {
                        Label("Paired successfully!", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
            }
            .navigationTitle("Pair Device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .sheet(isPresented: $showScanner) {
                QRScannerSheet(onPayload: { payload in
                    showScanner = false
                    applyPairing(payload)
                })
            }
        }
    }

    private func applyPairing(_ payload: PairingPayload) {
        pairingError = nil

        // Store relay credentials
        appState.gateway.relayUrl = payload.relayUrl
        appState.gateway.roomId = payload.roomId
        appState.gateway.roomSecret = payload.roomSecret

        // Store credentials in Keychain
        _ = KeychainHelper.save(key: "relay_room_id", string: payload.roomId)
        _ = KeychainHelper.save(key: "relay_room_secret", string: payload.roomSecret)

        // Derive E2E shared key if gateway public key provided
        if !payload.gatewayPublicKey.isEmpty {
            let success = appState.cryptoService.deriveSharedKey(
                gatewayPublicKeyBase64: payload.gatewayPublicKey
            )
            if success {
                logger.info("E2E key derived from pairing")
            } else {
                logger.warning("E2E key derivation failed — continuing without encryption")
            }
        }

        // Reconnect with relay
        appState.gateway.disconnect()
        appState.gateway.connect()

        isPaired = true
        logger.info("Paired with gateway (room: \(payload.roomId.prefix(8)))")
    }
}

// MARK: - QR Scanner Sheet

private struct QRScannerSheet: View {
    let onPayload: (PairingPayload) -> Void
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                QRScannerView { code in
                    handleQRCode(code)
                }
                .ignoresSafeArea()

                if let error {
                    VStack {
                        Spacer()
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.white)
                            .padding()
                            .background(.red.opacity(0.8))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .padding()
                    }
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func handleQRCode(_ code: String) {
        guard let data = code.data(using: .utf8) else {
            error = "Invalid QR code"
            return
        }

        do {
            let payload = try JSONDecoder().decode(PairingPayload.self, from: data)
            onPayload(payload)
        } catch {
            self.error = "Invalid AgentPager QR code"
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview {
    PreviewWrapper {
        PairingView()
    }
}
#endif
