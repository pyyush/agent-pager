import SwiftUI

struct ConnectionStatusView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            Text(statusLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var statusColor: Color {
        switch appState.connectionStatus {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .red
        }
    }

    private var statusLabel: String {
        switch appState.connectionStatus {
        case .connected: return "Connected"
        case .connecting: return "Connecting"
        case .disconnected: return "Offline"
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Connected") {
    PreviewWrapper(appState: PreviewData.connectedAppState) {
        ConnectionStatusView()
    }
}

#Preview("Disconnected") {
    PreviewWrapper(appState: PreviewData.disconnectedAppState) {
        ConnectionStatusView()
    }
}
#endif
