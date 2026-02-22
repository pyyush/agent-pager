import Foundation

// MARK: - Protocol Constants

enum ProtocolConstants {
    static let version = "1.0.0"
    static let defaultWSPort = 7891
    static let heartbeatIntervalMs = 15_000
    static let heartbeatTimeoutMs = 5_000
    static let maxMissedHeartbeats = 3
    static let reconnectBaseMs = 1_000
    static let reconnectMaxMs = 30_000
    static let approvalTimeoutMs = 300_000
    static let dangerousDelayMs = 2_000
    static let defaultEventBufferSize = 50
    static let defaultMaxSessions = 10
    static let maxDiffBytes = 256 * 1024

    // Relay
    static let defaultRelayUrl = "wss://relay.agentpager.dev"
    static let relayReconnectBaseMs = 2_000
    static let relayReconnectMaxMs = 60_000
}

// MARK: - Enums

enum RiskLevel: String, Codable, CaseIterable {
    case safe
    case moderate
    case dangerous
}

enum SessionStatus: String, Codable, CaseIterable {
    case created
    case running
    case waiting
    case error
    case stopped
    case done
}

enum ApprovalScope: String, Codable {
    case once
    case session
    case tool
}

enum MessageRole: String, Codable {
    case agent
    case user
    case system
}

// MARK: - Message Envelope

struct MessageEnvelope: Codable {
    let v: String
    let seq: Int
    let type: String
    let ts: String
    let sessionId: String?
    let payload: JSONValue
}

// MARK: - JSON Value (generic payload handling)

enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var intValue: Int? {
        if case .int(let i) = self { return i }
        return nil
    }

    var doubleValue: Double? {
        if case .double(let d) = self { return d }
        if case .int(let i) = self { return Double(i) }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    subscript(index: Int) -> JSONValue? {
        if case .array(let a) = self, index < a.count { return a[index] }
        return nil
    }
}

// MARK: - Event Payloads (Gateway → Client)

struct SessionStartPayload: Codable {
    let agent: String
    let agentVersion: String?
    let task: String?
    let cwd: String?
    let tmuxSession: String?

    var safeAgentVersion: String { agentVersion ?? "" }
    var safeTask: String { task ?? "" }
    var safeCwd: String { cwd ?? "" }
}

struct SessionEndPayload: Codable {
    let status: SessionStatus
    let summary: String?
    let filesChanged: [String]?
    let duration: Double?

    var safeSummary: String { summary ?? "" }
    var safeFilesChanged: [String] { filesChanged ?? [] }
    var safeDuration: Double { duration ?? 0 }
}

struct SessionUpdatePayload: Codable {
    let status: SessionStatus
    let currentFile: String?
    let step: String?
}

struct PermissionRequestPayload: Codable, Identifiable {
    let requestId: String
    let toolName: String
    let toolCategory: String?
    let toolInput: [String: JSONValue]
    let riskLevel: RiskLevel
    let summary: String
    let diff: DiffPayload?
    let target: String?
    let rawPayload: JSONValue?

    var id: String { requestId }
    var safeToolCategory: String { toolCategory ?? "unknown" }
    var safeTarget: String { target ?? "" }
}

struct DiffPayload: Codable {
    let filePath: String
    let oldContent: String?
    let newContent: String?
    let hunks: [DiffHunk]
    let additions: Int
    let deletions: Int
    let isBinary: Bool?
    let isTruncated: Bool?

    var safeBinary: Bool { isBinary ?? false }
    var safeTruncated: Bool { isTruncated ?? false }
}

struct DiffHunk: Codable {
    let oldStart: Int
    let oldLines: Int
    let newStart: Int
    let newLines: Int
    let lines: [String]
}

struct ToolCompletePayload: Codable {
    let toolName: String
    let toolInput: [String: JSONValue]?
    let toolOutput: String?
    let success: Bool
    let duration: Double?

    var safeDuration: Double { duration ?? 0 }
    var safeOutput: String { toolOutput ?? "" }
}

struct MessagePayload: Codable {
    let role: MessageRole
    let text: String
    let isThinking: Bool?

    var safeIsThinking: Bool { isThinking ?? false }
}

struct ProgressPayload: Codable {
    let currentFile: String?
    let step: String?
    let tokenUsage: TokenUsage?

    struct TokenUsage: Codable {
        let input: Int?
        let output: Int?
    }
}

struct ErrorPayload: Codable {
    let message: String
    let code: String?
    let recoverable: Bool?

    var safeCode: String { code ?? "UNKNOWN" }
    var safeRecoverable: Bool { recoverable ?? true }
}

struct HeartbeatPayload: Codable {
    let serverTime: String
    let activeSessions: Int
}

struct SessionInfo: Codable, Identifiable {
    let id: String
    let agent: String
    let agentVersion: String?
    let task: String?
    let cwd: String?
    let status: SessionStatus
    let tmuxSession: String?
    let createdAt: Double
    let updatedAt: Double
    let pendingApprovals: Int?

    var safeAgentVersion: String { agentVersion ?? "" }
    var safeTask: String { task ?? "" }
    var safeCwd: String { cwd ?? "" }
    var safePendingApprovals: Int { pendingApprovals ?? 0 }
}

// MARK: - User Question (AskUserQuestion)

struct UserQuestionPayload: Codable {
    let sessionId: String?
    let questions: [UserQuestion]
}

struct UserQuestion: Codable, Identifiable {
    let question: String
    let header: String
    let multiSelect: Bool
    let options: [UserQuestionOption]

    var id: String { header }
}

struct UserQuestionOption: Codable, Identifiable {
    let label: String
    let description: String

    var id: String { label }
}

struct SessionListPayload: Codable {
    let sessions: [SessionInfo]
}

struct SessionSnapshotPayload: Codable {
    let session: SessionInfo
    let recentEvents: [JSONValue]
    let pendingApprovals: [PermissionRequestPayload]
}

// MARK: - Event Types

enum EventType: String {
    case sessionStart = "session_start"
    case sessionEnd = "session_end"
    case sessionUpdate = "session_update"
    case permissionRequest = "permission_request"
    case toolComplete = "tool_complete"
    case message = "message"
    case progress = "progress"
    case error = "error"
    case heartbeat = "heartbeat"
    case sessionList = "session_list"
    case sessionSnapshot = "session_snapshot"
    case userQuestion = "user_question"
}

// MARK: - Action Types (Client → Gateway)

enum ActionType: String {
    case approve
    case deny
    case editApprove = "edit_approve"
    case textInput = "text_input"
    case stop
    case pause
    case startSession = "start_session"
    case terminalInput = "terminal_input"
    case batchApprove = "batch_approve"
    case resumeFromSeq = "resume_from_seq"
    case auth
}

// MARK: - Action Payloads

struct ApproveActionPayload: Codable {
    let requestId: String
    let scope: ApprovalScope
}

struct DenyActionPayload: Codable {
    let requestId: String
    let reason: String?
}

struct TextInputActionPayload: Codable {
    let text: String
}

struct StopActionPayload: Codable {
    let force: Bool
}

struct ResumeFromSeqPayload: Codable {
    let lastSeq: Int
}

struct BatchApprovePayload: Codable {
    let requestIds: [String]
    let scope: ApprovalScope
    let maxRiskLevel: RiskLevel?
}

struct AuthPayload: Codable {
    let token: String
}

// MARK: - Envelope Builder

enum EnvelopeBuilder {
    static func build<P: Encodable>(
        type: ActionType,
        payload: P,
        sessionId: String?,
        seq: Int
    ) throws -> Data {
        let envelope: [String: Any] = [
            "v": ProtocolConstants.version,
            "seq": seq,
            "type": type.rawValue,
            "ts": ISO8601DateFormatter().string(from: Date()),
            "sessionId": sessionId as Any,
        ]

        // Encode payload separately, merge into envelope
        let payloadData = try JSONEncoder().encode(payload)
        let payloadDict = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any] ?? [:]

        var full = envelope
        full["payload"] = payloadDict

        return try JSONSerialization.data(withJSONObject: full)
    }
}

// MARK: - Payload Decoder Helper

enum PayloadDecoder {
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? decoder.decode(type, from: data)
    }
}
