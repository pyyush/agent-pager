#if DEBUG
import SwiftUI

// MARK: - Mock Payloads

enum PreviewData {

    // MARK: Permission Requests

    static let bashPermissionPayload = PermissionRequestPayload(
        requestId: "req-001",
        toolName: "Bash",
        toolCategory: "execute",
        toolInput: ["command": .string("rm -rf node_modules && npm install")],
        riskLevel: .moderate,
        summary: "Execute shell command",
        diff: nil,
        target: "rm -rf node_modules && npm install",
        rawPayload: nil
    )

    static let writePermissionPayload = PermissionRequestPayload(
        requestId: "req-002",
        toolName: "Write",
        toolCategory: "file",
        toolInput: [
            "file_path": .string("/Users/dev/project/src/index.ts"),
            "content": .string("export function hello() {\n  return 'world';\n}\n"),
        ],
        riskLevel: .safe,
        summary: "Write to src/index.ts",
        diff: PreviewData.sampleDiff,
        target: "/Users/dev/project/src/index.ts",
        rawPayload: nil
    )

    static let dangerousPermissionPayload = PermissionRequestPayload(
        requestId: "req-003",
        toolName: "Bash",
        toolCategory: "execute",
        toolInput: ["command": .string("rm -rf /tmp/build && sudo chmod -R 777 /var/data")],
        riskLevel: .dangerous,
        summary: "Destructive shell command",
        diff: nil,
        target: "rm -rf /tmp/build && sudo chmod -R 777 /var/data",
        rawPayload: nil
    )

    static let bashRequest = PermissionRequest(from: bashPermissionPayload)
    static let writeRequest = PermissionRequest(from: writePermissionPayload)
    static let dangerousRequest = PermissionRequest(from: dangerousPermissionPayload)

    // MARK: Diff

    static let sampleDiff = DiffPayload(
        filePath: "src/index.ts",
        oldContent: nil,
        newContent: nil,
        hunks: [
            DiffHunk(
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 5,
                lines: [
                    " import { serve } from 'bun';",
                    "-const PORT = 3000;",
                    "+const PORT = process.env.PORT ?? 3000;",
                    "+const HOST = '0.0.0.0';",
                    " ",
                    "-serve({ port: PORT });",
                    "+serve({ port: PORT, hostname: HOST });",
                ]
            ),
        ],
        additions: 3,
        deletions: 2,
        isBinary: false,
        isTruncated: false
    )

    static let largeDiff = DiffPayload(
        filePath: "packages/gateway/src/transport/websocket.ts",
        oldContent: nil,
        newContent: nil,
        hunks: [
            DiffHunk(
                oldStart: 10,
                oldLines: 4,
                newStart: 10,
                newLines: 8,
                lines: [
                    " export class WebSocketTransport {",
                    "-  private ws: WebSocket | null = null;",
                    "+  private ws: WebSocket | null = null;",
                    "+  private reconnectTimer: Timer | null = null;",
                    "+  private reconnectAttempt = 0;",
                    " ",
                    "   constructor(private config: TransportConfig) {}",
                    " ",
                    "+  get isConnected(): boolean {",
                    "+    return this.ws?.readyState === WebSocket.OPEN;",
                    "+  }",
                    "+",
                    "   async start(): Promise<void> {",
                    "-    this.connect();",
                    "+    this.closed = false;",
                    "+    this.connect();",
                    "   }",
                ]
            ),
        ],
        additions: 8,
        deletions: 2,
        isBinary: false,
        isTruncated: false
    )

    // MARK: Sessions

    static func makeSession(
        id: String = "sess-001",
        agent: String = "claude",
        cwd: String = "/Users/dev/my-project",
        status: SessionStatus = .running,
        pendingApprovals: [String: PermissionRequest] = [:],
        events: [SessionEvent] = []
    ) -> ClientSession {
        let info = SessionInfo(
            id: id,
            agent: agent,
            agentVersion: "1.0.0",
            task: "Implement feature",
            cwd: cwd,
            status: status,
            tmuxSession: "ap-cc-\(id)",
            createdAt: Date().timeIntervalSince1970 * 1000,
            updatedAt: Date().timeIntervalSince1970 * 1000,
            pendingApprovals: pendingApprovals.count
        )
        var session = ClientSession(from: info)
        session.pendingApprovals = pendingApprovals
        session.events = events
        return session
    }

    static let runningSession = makeSession()

    static let waitingSession = makeSession(
        id: "sess-002",
        agent: "claude",
        cwd: "/Users/dev/another-project",
        status: .waiting,
        pendingApprovals: [
            "req-001": bashRequest,
            "req-002": writeRequest,
        ]
    )

    static let doneSession = makeSession(
        id: "sess-003",
        agent: "codex",
        cwd: "/Users/dev/finished-project",
        status: .done
    )

    static let sessionWithEvents: ClientSession = {
        var session = makeSession(
            id: "sess-004",
            cwd: "/Users/dev/active-project",
            status: .waiting,
            pendingApprovals: ["req-001": bashRequest]
        )
        session.events = [
            SessionEvent(
                seq: 1,
                type: .toolComplete,
                timestamp: Date().addingTimeInterval(-120),
                data: .toolComplete(ToolCompletePayload(
                    toolName: "Read",
                    toolInput: ["file_path": .string("src/index.ts")],
                    toolOutput: "file contents...",
                    success: true,
                    duration: 45
                ))
            ),
            SessionEvent(
                seq: 2,
                type: .message,
                timestamp: Date().addingTimeInterval(-90),
                data: .message(MessagePayload(
                    role: .agent,
                    text: "I've read the file. Let me make the changes you requested.",
                    isThinking: false
                ))
            ),
            SessionEvent(
                seq: 3,
                type: .toolComplete,
                timestamp: Date().addingTimeInterval(-60),
                data: .toolComplete(ToolCompletePayload(
                    toolName: "Edit",
                    toolInput: ["file_path": .string("src/index.ts")],
                    toolOutput: nil,
                    success: true,
                    duration: 120
                ))
            ),
            SessionEvent(
                seq: 4,
                type: .permissionRequest,
                timestamp: Date().addingTimeInterval(-30),
                data: .permissionResolved(
                    requestId: "req-old",
                    resolution: .approved,
                    toolName: "Write"
                )
            ),
            SessionEvent(
                seq: 5,
                type: .error,
                timestamp: Date().addingTimeInterval(-15),
                data: .error(ErrorPayload(
                    message: "File not found: config.json",
                    code: "ENOENT",
                    recoverable: true
                ))
            ),
        ]
        return session
    }()

    // MARK: User Questions

    static let sampleQuestion = UserQuestionPayload(
        sessionId: "sess-001",
        questions: [
            UserQuestion(
                question: "Which testing framework should we use?",
                header: "Framework",
                multiSelect: false,
                options: [
                    UserQuestionOption(label: "Vitest (Recommended)", description: "Fast, Vite-native, compatible with Jest API"),
                    UserQuestionOption(label: "Jest", description: "Mature ecosystem, widely used"),
                    UserQuestionOption(label: "Mocha + Chai", description: "Flexible, highly configurable"),
                ]
            ),
        ]
    )

    // MARK: App State

    @MainActor
    static func makeAppState(
        sessions: [String: ClientSession] = [:],
        connectionStatus: ConnectionStatus = .connected
    ) -> AppState {
        let state = AppState()
        state.sessions = sessions
        state.connectionStatus = connectionStatus
        return state
    }

    @MainActor
    static let connectedAppState: AppState = {
        makeAppState(
            sessions: [
                "sess-001": runningSession,
                "sess-002": waitingSession,
                "sess-003": doneSession,
            ],
            connectionStatus: .connected
        )
    }()

    @MainActor
    static let emptyAppState: AppState = {
        makeAppState(connectionStatus: .connected)
    }()

    @MainActor
    static let disconnectedAppState: AppState = {
        makeAppState(connectionStatus: .disconnected)
    }()

    @MainActor
    static let detailAppState: AppState = {
        makeAppState(
            sessions: ["sess-004": sessionWithEvents],
            connectionStatus: .connected
        )
    }()
}

// MARK: - Preview Wrapper

/// Wraps a view with the required AppState environment for previews.
struct PreviewWrapper<Content: View>: View {
    let appState: AppState
    @ViewBuilder let content: () -> Content

    init(
        appState: AppState = PreviewData.connectedAppState,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.appState = appState
        self.content = content
    }

    var body: some View {
        content()
            .environment(appState)
    }
}
#endif
