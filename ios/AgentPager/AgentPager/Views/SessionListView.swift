import SwiftUI

struct SessionListView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            if appState.sortedSessions.isEmpty {
                emptyState
            } else {
                sessionList
            }
        }
    }

    private var sessionList: some View {
        List {
            ForEach(appState.sortedSessions) { session in
                NavigationLink(value: session.id) {
                    SessionRowView(session: session)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) {
                        appState.removeSession(session.id)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            appState.gateway.disconnect()
            try? await Task.sleep(for: .milliseconds(500))
            appState.gateway.connect()
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            VStack(spacing: 12) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 14))

                Text("No Sessions")
            }
        } description: {
            if appState.connectionStatus == .connected {
                Text("Start a coding agent in a project with AgentPager hooks to see sessions here.")
            } else {
                Text("Not connected to gateway.")
            }
        } actions: {
            if appState.connectionStatus != .connected {
                Button("Reconnect") {
                    appState.gateway.connect()
                }
                .buttonStyle(.bordered)
            }
        }
    }
}

// MARK: - Session Row

struct SessionRowView: View {
    let session: ClientSession

    var body: some View {
        HStack(spacing: 12) {
            // Status indicator
            Circle()
                .fill(session.status.color)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 2) {
                Text(projectName)
                    .font(.body.weight(.medium))

                HStack(spacing: 4) {
                    Text(session.status.label)
                        .foregroundStyle(session.status.color)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(session.updatedAt, style: .relative)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }

            Spacer()

            if session.pendingCount > 0 {
                Text("\(session.pendingCount)")
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(.orange, in: Capsule())
            }
        }
        .padding(.vertical, 2)
    }

    private var projectName: String {
        if session.cwd.isEmpty { return session.agent.capitalized }
        let last = session.cwd.split(separator: "/").last.map(String.init) ?? session.cwd
        return last.isEmpty ? session.agent.capitalized : last
    }
}

// MARK: - Previews

#if DEBUG
#Preview("With Sessions") {
    PreviewWrapper(appState: PreviewData.connectedAppState) {
        NavigationStack {
            SessionListView()
                .navigationTitle("Sessions")
        }
    }
}

#Preview("Empty - Connected") {
    PreviewWrapper(appState: PreviewData.emptyAppState) {
        NavigationStack {
            SessionListView()
                .navigationTitle("Sessions")
        }
    }
}

#Preview("Empty - Disconnected") {
    PreviewWrapper(appState: PreviewData.disconnectedAppState) {
        NavigationStack {
            SessionListView()
                .navigationTitle("Sessions")
        }
    }
}

#Preview("Session Row") {
    SessionRowView(session: PreviewData.waitingSession)
        .padding()
}
#endif
