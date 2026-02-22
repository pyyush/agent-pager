import SwiftUI

// MARK: - Permission Request

struct PermissionRequest: Identifiable {
    let id: String
    let payload: PermissionRequestPayload
    let receivedAt: Date
    var resolution: PermissionResolution = .pending
    var resolvedAt: Date?

    init(from payload: PermissionRequestPayload) {
        self.id = payload.requestId
        self.payload = payload
        self.receivedAt = Date()
    }

    var toolName: String { payload.toolName }
    var riskLevel: RiskLevel { payload.riskLevel }
    var summary: String { payload.summary }
    var target: String { payload.safeTarget }
    var diff: DiffPayload? { payload.diff }
    var toolInput: [String: JSONValue] { payload.toolInput }
    var isPending: Bool { resolution == .pending }
}

// MARK: - Resolution

enum PermissionResolution: String {
    case pending
    case approved
    case denied
}

// MARK: - Display Helpers

extension RiskLevel {
    var color: Color {
        switch self {
        case .safe: return .green
        case .moderate: return .yellow
        case .dangerous: return .red
        }
    }

    var label: String {
        rawValue.capitalized
    }

    var barColor: Color {
        switch self {
        case .safe: return .green
        case .moderate: return .orange
        case .dangerous: return .red
        }
    }
}

extension SessionStatus {
    var color: Color {
        switch self {
        case .running: return .green
        case .waiting: return .yellow
        case .created: return .blue
        case .done: return .gray
        case .stopped: return .gray
        case .error: return .red
        }
    }

    var label: String {
        rawValue.capitalized
    }

    var icon: String {
        switch self {
        case .running: return "play.circle.fill"
        case .waiting: return "hourglass.circle.fill"
        case .created: return "circle.dotted"
        case .done: return "checkmark.circle.fill"
        case .stopped: return "stop.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }
}

// MARK: - Tool Icons

enum ToolIcon {
    static func sfSymbol(for toolName: String) -> String {
        switch toolName {
        case "Read": return "doc.text"
        case "Write": return "pencil.line"
        case "Edit": return "pencil"
        case "Bash": return "terminal"
        case "Glob": return "magnifyingglass"
        case "Grep": return "text.magnifyingglass"
        case "WebSearch": return "globe"
        case "WebFetch": return "globe"
        case "Task": return "person.2"
        case "NotebookEdit": return "book"
        default: return "wrench"
        }
    }
}
