import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var appState
    @State private var showSettings = false
    @State private var showPairing = false

    var body: some View {
        @Bindable var state = appState

        NavigationStack {
            SessionListView()
                .navigationTitle("Sessions")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        HStack(spacing: 12) {
                            Button {
                                showSettings = true
                            } label: {
                                Image(systemName: "gear")
                            }

                            Button {
                                showPairing = true
                            } label: {
                                Image(systemName: "qrcode.viewfinder")
                            }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        ConnectionDot()
                    }
                }
                .navigationDestination(for: String.self) { sessionId in
                    SessionDetailView(sessionId: sessionId)
                }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(isPresented: $showPairing) {
            PairingView()
        }
        .onChange(of: appState.navigateToSessionId) { _, sessionId in
            if let sessionId {
                appState.selectedSessionId = sessionId
                appState.navigateToSessionId = nil
            }
        }
    }
}

// MARK: - Connection Dot

struct ConnectionDot: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        HStack(spacing: 4) {
            if appState.gateway.useRelay {
                Image(systemName: "cloud.fill")
                    .font(.caption2)
                    .foregroundStyle(dotColor)
            }
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
        }
    }

    private var dotColor: Color {
        switch appState.connectionStatus {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .red
        }
    }
}

// MARK: - Settings View

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var host: String = ""
    @State private var port: String = ""
    @State private var relayUrl: String = ""
    @State private var roomId: String = ""
    @State private var roomSecret: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(statusColor)
                                .frame(width: 8, height: 8)
                            Text(appState.connectionStatus.rawValue.capitalized)
                                .foregroundStyle(.secondary)
                        }
                    }

                    LabeledContent("Mode") {
                        Text(appState.gateway.useRelay ? "Cloud" : "LAN")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Cloud Relay") {
                    TextField("Relay URL", text: $relayUrl)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Room ID", text: $roomId)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    SecureField("Room Secret", text: $roomSecret)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    Button("Connect via Relay") {
                        appState.gateway.relayUrl = relayUrl.isEmpty ? nil : relayUrl
                        appState.gateway.roomId = roomId.isEmpty ? nil : roomId
                        appState.gateway.roomSecret = roomSecret.isEmpty ? nil : roomSecret
                        appState.gateway.disconnect()
                        appState.gateway.connect()
                    }
                    .disabled(relayUrl.isEmpty || roomId.isEmpty || roomSecret.isEmpty)
                }

                Section("LAN (Fallback)") {
                    TextField("Host", text: $host)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Port", text: $port)
                        .keyboardType(.numberPad)

                    Button("Connect via LAN") {
                        // Clear relay to force LAN
                        appState.gateway.relayUrl = nil
                        appState.gateway.roomId = nil
                        appState.gateway.roomSecret = nil
                        appState.gateway.host = host
                        if let p = Int(port), p > 0 {
                            appState.gateway.port = p
                        }
                        appState.gateway.disconnect()
                        appState.gateway.connect()
                    }
                }

                Section("Limits") {
                    Stepper("Max sessions: \(appState.settings.maxSessions)",
                            value: Bindable(appState.settings).maxSessions,
                            in: 5...100, step: 5)

                    Stepper("Events per session: \(appState.settings.maxEventsPerSession)",
                            value: Bindable(appState.settings).maxEventsPerSession,
                            in: 20...500, step: 10)
                }

                Section("Debug") {
                    LabeledContent("Sessions", value: "\(appState.sessions.count)")
                    LabeledContent("Last Seq", value: "\(appState.lastSeq)")
                }

                Section {
                    VStack(spacing: 8) {
                        Image("Logo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 48, height: 48)
                            .clipShape(RoundedRectangle(cornerRadius: 10))

                        Text("AgentPager")
                            .font(.footnote.weight(.semibold))
                        Text("v0.1.0")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .onAppear {
                host = appState.gateway.host
                port = "\(appState.gateway.port)"
                relayUrl = appState.gateway.relayUrl ?? ProtocolConstants.defaultRelayUrl
                roomId = appState.gateway.roomId ?? ""
                roomSecret = appState.gateway.roomSecret ?? ""
            }
        }
    }

    private var statusColor: Color {
        switch appState.connectionStatus {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .red
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Main View") {
    PreviewWrapper(appState: PreviewData.connectedAppState) {
        ContentView()
    }
}

#Preview("Empty State") {
    PreviewWrapper(appState: PreviewData.emptyAppState) {
        ContentView()
    }
}

#Preview("Settings") {
    PreviewWrapper(appState: PreviewData.connectedAppState) {
        SettingsView()
    }
}

#Preview("Connection Dot - Connected") {
    PreviewWrapper(appState: PreviewData.connectedAppState) {
        ConnectionDot()
    }
}

#Preview("Connection Dot - Disconnected") {
    PreviewWrapper(appState: PreviewData.disconnectedAppState) {
        ConnectionDot()
    }
}
#endif
