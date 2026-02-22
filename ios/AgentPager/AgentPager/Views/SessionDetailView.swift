import SwiftUI

struct SessionDetailView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String

    @State private var showStopConfirm = false

    private var session: ClientSession? {
        appState.sessions[sessionId]
    }

    private var projectName: String {
        guard let session else { return "Session" }
        if session.cwd.isEmpty { return session.agent.capitalized }
        let last = session.cwd.split(separator: "/").last.map(String.init) ?? session.cwd
        return last.isEmpty ? session.agent.capitalized : last
    }

    var body: some View {
        Group {
            if let session {
                sessionContent(session)
            } else {
                ContentUnavailableView(
                    "Session Not Found",
                    systemImage: "questionmark.circle",
                    description: Text("This session may have ended.")
                )
            }
        }
        .navigationTitle(projectName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let session, session.status == .running || session.status == .waiting {
                    sessionMenu
                }
            }
        }
        .onAppear { appState.selectedSessionId = sessionId }
        .onDisappear {
            if appState.selectedSessionId == sessionId {
                appState.selectedSessionId = nil
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func sessionContent(_ session: ClientSession) -> some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                List {
                    // Status
                    Section {
                        HStack(spacing: 8) {
                            Circle()
                                .fill(session.status.color)
                                .frame(width: 8, height: 8)
                            Text(session.status.label)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(session.status.color)
                            Spacer()
                            ConnectionStatusView()
                        }

                        if !session.cwd.isEmpty {
                            Label(session.cwd, systemImage: "folder")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    // Pending approvals
                    if !session.sortedPendingApprovals.isEmpty {
                        Section {
                            ForEach(session.sortedPendingApprovals) { request in
                                PermissionCardView(
                                    request: request,
                                    sessionId: sessionId
                                )
                                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                                .listRowBackground(Color.clear)
                            }
                        } header: {
                            HStack {
                                Text("Pending")
                                Spacer()
                                Text("\(session.sortedPendingApprovals.count)")
                                    .monospacedDigit()
                                    .foregroundStyle(.orange)
                            }
                        }
                    }

                    // Activity
                    if !session.recentEvents.isEmpty {
                        Section("Activity") {
                            ForEach(session.recentEvents) { event in
                                EventRowView(event: event)
                                    .id("event-\(event.id)")
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .onChange(of: session.events.count) { _, _ in
                    if let last = session.recentEvents.last {
                        withAnimation {
                            proxy.scrollTo("event-\(last.id)", anchor: .bottom)
                        }
                    }
                }
            }

            // Input bar
            if session.status == .running || session.status == .waiting {
                InputBarView(sessionId: sessionId)
            }
        }
    }

    // MARK: - Menu

    private var sessionMenu: some View {
        Menu {
            Button(role: .destructive) {
                showStopConfirm = true
            } label: {
                Label("Stop", systemImage: "stop.circle")
            }
            Button(role: .destructive) {
                appState.stopSession(sessionId, force: true)
            } label: {
                Label("Force Kill", systemImage: "xmark.octagon")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .confirmationDialog("Stop this session?", isPresented: $showStopConfirm) {
            Button("Stop (sends /exit)", role: .destructive) {
                appState.stopSession(sessionId)
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

// MARK: - Event Row

struct EventRowView: View {
    let event: SessionEvent

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            eventIcon
                .frame(width: 20)

            eventContent
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(event.timestamp, style: .time)
                .font(.caption2)
                .foregroundStyle(.quaternary)
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private var eventIcon: some View {
        switch event.data {
        case .toolComplete(let p):
            Image(systemName: p.success ? "checkmark.circle" : "xmark.circle")
                .font(.footnote)
                .foregroundStyle(p.success ? .green : .red)

        case .message:
            Image(systemName: "text.bubble")
                .font(.footnote)
                .foregroundStyle(.blue)

        case .error:
            Image(systemName: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)

        case .progress:
            Image(systemName: "arrow.clockwise")
                .font(.footnote)
                .foregroundStyle(.secondary)

        case .permissionResolved(_, let res, _):
            Image(systemName: res == .approved ? "checkmark.shield" : "xmark.shield")
                .font(.footnote)
                .foregroundStyle(res == .approved ? .green : .red)

        case .userQuestion:
            Image(systemName: "questionmark.bubble")
                .font(.footnote)
                .foregroundStyle(.blue)

        case .userInput:
            Image(systemName: "arrow.up.circle")
                .font(.footnote)
                .foregroundStyle(.blue)
        }
    }

    @ViewBuilder
    private var eventContent: some View {
        switch event.data {
        case .toolComplete(let p):
            HStack(spacing: 4) {
                Text(p.toolName)
                    .font(.footnote.weight(.medium))
                Text("completed")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if p.safeDuration > 0 {
                    Text(formatDuration(p.safeDuration))
                        .font(.caption2)
                        .foregroundStyle(.quaternary)
                }
            }

        case .message(let p):
            Text(p.text)
                .font(.footnote)
                .foregroundStyle(p.safeIsThinking ? .secondary : .primary)
                .lineLimit(4)

        case .error(let p):
            Text(p.message)
                .font(.footnote)
                .foregroundStyle(.red)
                .lineLimit(2)

        case .progress(let p):
            Text(p.step ?? p.currentFile ?? "")
                .font(.footnote)
                .foregroundStyle(.secondary)

        case .permissionResolved(let rid, let res, let tool):
            PermissionResolvedRow(requestId: rid, resolution: res, toolName: tool)

        case .userQuestion(let p):
            QuestionCardView(payload: p)

        case .userInput(let text):
            Text(text)
                .font(.footnote)
                .foregroundStyle(.blue)
                .lineLimit(3)
        }
    }

    private func formatDuration(_ ms: Double) -> String {
        if ms < 1000 { return "\(Int(ms))ms" }
        return String(format: "%.1fs", ms / 1000)
    }
}

// MARK: - Permission Resolved Row

struct PermissionResolvedRow: View {
    @Environment(AppState.self) private var appState
    let requestId: String
    let resolution: PermissionResolution
    let toolName: String

    @State private var showDetail = false

    private var request: PermissionRequest? {
        for session in appState.sessions.values {
            if let req = session.pendingApprovals[requestId] {
                return req
            }
        }
        return nil
    }

    var body: some View {
        Button {
            showDetail = true
        } label: {
            HStack(spacing: 4) {
                Text(resolution == .approved ? "Approved" : "Denied")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(resolution == .approved ? .green : .red)
                Text("—")
                    .foregroundStyle(.quaternary)
                Text(toolName)
                    .foregroundStyle(.primary)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.quaternary)
            }
            .font(.footnote)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showDetail) {
            if let request {
                PermissionDetailSheet(request: request, resolution: resolution)
            }
        }
    }
}

// MARK: - Permission Detail Sheet

struct PermissionDetailSheet: View {
    let request: PermissionRequest
    let resolution: PermissionResolution
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Image(systemName: resolution == .approved ? "checkmark.shield.fill" : "xmark.shield.fill")
                        Text(resolution == .approved ? "Approved" : "Denied")
                            .font(.headline)
                    }
                    .foregroundStyle(resolution == .approved ? .green : .red)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
                }

                Section("Tool") {
                    LabeledContent("Name", value: request.toolName)
                    LabeledContent("Risk", value: request.riskLevel.label)
                    if !request.target.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Target")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Text(request.target)
                                .font(.footnote.monospaced())
                        }
                    }
                }

                Section("Summary") {
                    Text(request.summary)
                        .font(.subheadline)
                }

                if !request.toolInput.isEmpty {
                    Section("Input") {
                        Text(formatInput(request.toolInput))
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                }

                if let diff = request.diff {
                    Section("Diff") {
                        DiffView(diff: diff)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(request.toolName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func formatInput(_ input: [String: JSONValue]) -> String {
        guard let data = try? JSONEncoder().encode(input),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: .prettyPrinted),
              let str = String(data: pretty, encoding: .utf8)
        else { return "{}" }
        return str
    }
}

// MARK: - Previews

#if DEBUG
#Preview("With Events & Pending") {
    PreviewWrapper(appState: PreviewData.detailAppState) {
        NavigationStack {
            SessionDetailView(sessionId: "sess-004")
        }
    }
}

#Preview("Running Session") {
    let state = PreviewData.makeAppState(
        sessions: ["sess-001": PreviewData.runningSession],
        connectionStatus: .connected
    )
    return PreviewWrapper(appState: state) {
        NavigationStack {
            SessionDetailView(sessionId: "sess-001")
        }
    }
}

#Preview("Session Not Found") {
    PreviewWrapper(appState: PreviewData.emptyAppState) {
        NavigationStack {
            SessionDetailView(sessionId: "nonexistent")
        }
    }
}

#Preview("Event Row - Tool Complete") {
    PreviewWrapper {
        EventRowView(event: SessionEvent(
            seq: 1,
            type: .toolComplete,
            timestamp: Date(),
            data: .toolComplete(ToolCompletePayload(
                toolName: "Bash",
                toolInput: nil,
                toolOutput: "Success",
                success: true,
                duration: 1500
            ))
        ))
        .padding()
    }
}

#Preview("Event Row - Message") {
    PreviewWrapper {
        EventRowView(event: SessionEvent(
            seq: 2,
            type: .message,
            timestamp: Date(),
            data: .message(MessagePayload(
                role: .agent,
                text: "I've finished implementing the feature. Let me run the tests now.",
                isThinking: false
            ))
        ))
        .padding()
    }
}

#Preview("Permission Detail") {
    PermissionDetailSheet(
        request: PreviewData.writeRequest,
        resolution: .approved
    )
}
#endif
