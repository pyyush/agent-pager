import Foundation

// MARK: - Client Session

struct ClientSession: Identifiable {
    let id: String
    var agent: String
    var agentVersion: String
    var task: String
    var cwd: String
    var status: SessionStatus
    var tmuxSession: String?
    var createdAt: Date
    var updatedAt: Date
    var pendingApprovals: [String: PermissionRequest] = [:]
    var events: [SessionEvent] = []

    var pendingCount: Int {
        pendingApprovals.values.filter { $0.resolution == .pending }.count
    }

    var sortedPendingApprovals: [PermissionRequest] {
        pendingApprovals.values
            .filter { $0.resolution == .pending }
            .sorted { $0.receivedAt < $1.receivedAt }
    }

    var recentEvents: [SessionEvent] {
        Array(events.suffix(100))
    }

    /// Sort priority: waiting > running > created > done/stopped > error
    var sortOrder: Int {
        switch status {
        case .waiting: return 0
        case .running: return 1
        case .created: return 2
        case .done: return 3
        case .stopped: return 4
        case .error: return 5
        }
    }

    init(from info: SessionInfo) {
        self.id = info.id
        self.agent = info.agent
        self.agentVersion = info.safeAgentVersion
        self.task = info.safeTask
        self.cwd = info.safeCwd
        self.status = info.status
        self.tmuxSession = info.tmuxSession
        self.createdAt = Date(timeIntervalSince1970: info.createdAt / 1000)
        self.updatedAt = Date(timeIntervalSince1970: info.updatedAt / 1000)
    }

    init(from payload: SessionStartPayload, sessionId: String) {
        self.id = sessionId
        self.agent = payload.agent
        self.agentVersion = payload.safeAgentVersion
        self.task = payload.safeTask
        self.cwd = payload.safeCwd
        self.status = .running
        self.createdAt = Date()
        self.updatedAt = Date()
    }
}

// MARK: - Session Event

struct SessionEvent: Identifiable {
    let id = UUID()
    let seq: Int
    let type: EventType
    let timestamp: Date
    let data: SessionEventData
}

enum SessionEventData {
    case toolComplete(ToolCompletePayload)
    case message(MessagePayload)
    case error(ErrorPayload)
    case progress(ProgressPayload)
    case permissionResolved(requestId: String, resolution: PermissionResolution, toolName: String)
    case userQuestion(UserQuestionPayload)
    case userInput(text: String)
}
