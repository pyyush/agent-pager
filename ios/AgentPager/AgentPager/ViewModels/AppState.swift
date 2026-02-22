import SwiftUI
import os

private let logger = Logger(subsystem: "com.agentpager.ios", category: "AppState")

// MARK: - User Settings

@Observable
@MainActor
final class UserSettings {
    var maxSessions: Int {
        didSet { UserDefaults.standard.set(maxSessions, forKey: "maxSessions") }
    }
    var maxEventsPerSession: Int {
        didSet { UserDefaults.standard.set(maxEventsPerSession, forKey: "maxEventsPerSession") }
    }

    init() {
        let savedSessions = UserDefaults.standard.integer(forKey: "maxSessions")
        let savedEvents = UserDefaults.standard.integer(forKey: "maxEventsPerSession")
        self.maxSessions = savedSessions > 0 ? savedSessions : ProtocolConstants.defaultMaxSessions
        self.maxEventsPerSession = savedEvents > 0 ? savedEvents : ProtocolConstants.defaultEventBufferSize
    }
}

// MARK: - App State

@Observable
@MainActor
final class AppState {
    // Connection
    var connectionStatus: ConnectionStatus = .disconnected
    var lastSeq: Int = 0

    // Sessions
    var sessions: [String: ClientSession] = [:]

    // Navigation
    var selectedSessionId: String?
    var navigateToSessionId: String?

    // Services
    let gateway = GatewayClient()
    let notifications = NotificationService()
    let settings = UserSettings()
    let authService = AuthService()
    let cryptoService = CryptoService()

    /// Whether to require auth (true when relay is configured)
    var requireAuth: Bool {
        gateway.useRelay
    }

    // App lifecycle
    var isInBackground = false

    init() {
        gateway.onMessage = { [weak self] envelope in
            self?.handleMessage(envelope)
        }
        gateway.onStatusChange = { [weak self] status in
            self?.connectionStatus = status
            if status == .connected, let self, self.lastSeq > 0 {
                self.gateway.sendResumeFromSeq(self.lastSeq)
            }
        }

        // Notification callbacks
        notifications.onApprove = { [weak self] requestId, scope in
            self?.approveRequest(requestId: requestId, scope: scope)
        }
        notifications.onDeny = { [weak self] requestId in
            self?.denyRequest(requestId: requestId)
        }
        notifications.onTapNotification = { [weak self] sessionId in
            self?.navigateToSessionId = sessionId
        }
    }

    // MARK: - Sorted Sessions

    var sortedSessions: [ClientSession] {
        sessions.values.sorted { a, b in
            if a.sortOrder != b.sortOrder { return a.sortOrder < b.sortOrder }
            return a.updatedAt > b.updatedAt
        }
    }

    var totalPendingCount: Int {
        sessions.values.reduce(0) { $0 + $1.pendingCount }
    }

    // MARK: - Lifecycle

    func start() {
        // Pass auth token to gateway if available
        if let token = authService.token {
            gateway.authToken = token
        }
        // Pass crypto service for E2E encryption
        gateway.cryptoService = cryptoService
        gateway.connect()
        Task {
            await notifications.requestPermission()
        }
        loadPersistedState()
    }

    /// Handle APNs device token registration.
    func handleAPNsToken(_ token: String) {
        logger.info("APNs token: \(token.prefix(16))...")
        UserDefaults.standard.set(token, forKey: "apns_device_token")

        // Register with relay if authenticated
        if let authToken = authService.token {
            Task {
                let relayUrl = gateway.relayUrl ?? ProtocolConstants.defaultRelayUrl
                let api = RelayAPI(baseUrl: relayUrl, authToken: authToken)
                do {
                    let deviceName = UIDevice.current.name
                    let result = try await api.registerDevice(apnsToken: token, deviceName: deviceName)
                    logger.info("APNs token registered with relay (device: \(result.deviceId.prefix(8)))")
                } catch {
                    logger.error("Failed to register APNs token: \(error.localizedDescription)")
                }
            }
        }
    }

    func onForeground() {
        isInBackground = false
        gateway.endBackgroundKeepAlive()
        if connectionStatus == .disconnected {
            gateway.connect()
        }
    }

    func onBackground() {
        isInBackground = true
        persistState()
        // Keep WebSocket alive for ~30s so notifications still fire
        gateway.beginBackgroundKeepAlive()
    }

    // MARK: - Actions

    func approveRequest(requestId: String, scope: ApprovalScope = .once) {
        guard let (sessionId, _) = findRequest(requestId) else {
            logger.warning("Cannot approve — request \(requestId) not found")
            return
        }

        gateway.send(
            type: .approve,
            payload: ApproveActionPayload(requestId: requestId, scope: scope),
            sessionId: sessionId
        )

        resolveRequest(requestId: requestId, resolution: .approved)
        notifications.clearNotification(requestId: requestId)
    }

    func denyRequest(requestId: String, reason: String? = nil) {
        guard let (sessionId, _) = findRequest(requestId) else {
            logger.warning("Cannot deny — request \(requestId) not found")
            return
        }

        gateway.send(
            type: .deny,
            payload: DenyActionPayload(requestId: requestId, reason: reason),
            sessionId: sessionId
        )

        resolveRequest(requestId: requestId, resolution: .denied)
        notifications.clearNotification(requestId: requestId)
    }

    func sendTextInput(_ text: String, sessionId: String) {
        gateway.send(
            type: .textInput,
            payload: TextInputActionPayload(text: text),
            sessionId: sessionId
        )

        // Add local event so the user's input appears in the event stream
        let event = SessionEvent(
            seq: lastSeq,
            type: .message,
            timestamp: Date(),
            data: .userInput(text: text)
        )
        appendEvent(event, to: sessionId)
    }

    func removeSession(_ sessionId: String) {
        sessions.removeValue(forKey: sessionId)
    }

    func stopSession(_ sessionId: String, force: Bool = false) {
        gateway.send(
            type: .stop,
            payload: StopActionPayload(force: force),
            sessionId: sessionId
        )
    }

    // MARK: - Message Handling

    private func handleMessage(_ envelope: MessageEnvelope) {
        lastSeq = max(lastSeq, envelope.seq)

        guard let eventType = EventType(rawValue: envelope.type) else {
            logger.debug("Unknown event type: \(envelope.type)")
            return
        }

        switch eventType {
        case .heartbeat:
            // Just the receipt is enough — lastMessageTime tracked in GatewayClient
            break

        case .sessionList:
            handleSessionList(envelope.payload)

        case .sessionStart:
            handleSessionStart(envelope)

        case .sessionEnd:
            handleSessionEnd(envelope)

        case .sessionUpdate:
            handleSessionUpdate(envelope)

        case .sessionSnapshot:
            handleSessionSnapshot(envelope.payload)

        case .permissionRequest:
            handlePermissionRequest(envelope)

        case .toolComplete:
            handleToolComplete(envelope)

        case .message:
            handleMessageEvent(envelope)

        case .progress:
            handleProgress(envelope)

        case .error:
            handleError(envelope)

        case .userQuestion:
            handleUserQuestion(envelope)
        }
    }

    // MARK: - Event Handlers

    private func handleSessionList(_ payload: JSONValue) {
        guard let listPayload = PayloadDecoder.decode(SessionListPayload.self, from: payload) else {
            logger.error("Failed to decode session_list payload")
            return
        }

        // Merge server session list with local state.
        // Add/update sessions from server. Remove local sessions that are
        // finished AND not on the server (stale from previous gateway runs).
        // Keep active local sessions even if server doesn't list them yet
        // (race condition during reconnect).
        let serverIds = Set(listPayload.sessions.map { $0.id })
        let finishedStatuses: Set<SessionStatus> = [.done, .stopped, .error]

        // Update/add sessions from server
        for info in listPayload.sessions {
            if var existing = sessions[info.id] {
                existing.status = info.status
                existing.cwd = info.safeCwd
                existing.task = info.safeTask
                existing.agentVersion = info.safeAgentVersion
                existing.tmuxSession = info.tmuxSession
                existing.updatedAt = Date(timeIntervalSince1970: info.updatedAt / 1000)
                sessions[info.id] = existing
            } else {
                sessions[info.id] = ClientSession(from: info)
            }
        }

        // Remove local sessions not on server — server is source of truth
        for id in sessions.keys {
            if !serverIds.contains(id) {
                sessions.removeValue(forKey: id)
            }
        }

        logger.info("Session list: \(listPayload.sessions.count) sessions (replaced, cleared stale)")
    }

    private func handleSessionStart(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(SessionStartPayload.self, from: envelope.payload) else {
            logger.error("Failed to decode session_start")
            return
        }

        sessions[sessionId] = ClientSession(from: payload, sessionId: sessionId)
        pruneFinishedSessions()
        logger.info("Session started: \(sessionId) (\(payload.agent))")
    }

    private func handleSessionEnd(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(SessionEndPayload.self, from: envelope.payload) else {
            return
        }

        sessions[sessionId]?.status = payload.status
        sessions[sessionId]?.updatedAt = Date()
        logger.info("Session ended: \(sessionId) → \(payload.status.rawValue)")
    }

    private func handleSessionUpdate(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(SessionUpdatePayload.self, from: envelope.payload) else {
            return
        }

        sessions[sessionId]?.status = payload.status
        sessions[sessionId]?.updatedAt = Date()
    }

    private func handleSessionSnapshot(_ payload: JSONValue) {
        guard let snapshot = PayloadDecoder.decode(SessionSnapshotPayload.self, from: payload) else {
            logger.error("Failed to decode session_snapshot")
            return
        }

        var session = ClientSession(from: snapshot.session)
        for approval in snapshot.pendingApprovals {
            session.pendingApprovals[approval.requestId] = PermissionRequest(from: approval)
        }
        sessions[snapshot.session.id] = session

        logger.info("Session snapshot: \(snapshot.session.id), \(snapshot.pendingApprovals.count) pending")
    }

    private func handlePermissionRequest(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(PermissionRequestPayload.self, from: envelope.payload) else {
            logger.error("Failed to decode permission_request")
            return
        }

        let request = PermissionRequest(from: payload)
        sessions[sessionId]?.pendingApprovals[payload.requestId] = request
        sessions[sessionId]?.status = .waiting
        sessions[sessionId]?.updatedAt = Date()

        // Haptic for new permission request
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()

        // Notification if backgrounded or on a different session
        if isInBackground || selectedSessionId != sessionId {
            notifications.showPermissionNotification(request: request, sessionId: sessionId)
        }

        logger.info("Permission request: \(payload.toolName) (\(payload.riskLevel.rawValue)) for session \(sessionId)")
    }

    private func handleToolComplete(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(ToolCompletePayload.self, from: envelope.payload) else {
            return
        }

        let event = SessionEvent(
            seq: envelope.seq,
            type: .toolComplete,
            timestamp: Date(),
            data: .toolComplete(payload)
        )
        appendEvent(event, to: sessionId)

        // If session was waiting and now a tool completed, it's running again
        if sessions[sessionId]?.status == .waiting {
            sessions[sessionId]?.status = .running
        }
    }

    private func handleMessageEvent(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(MessagePayload.self, from: envelope.payload) else {
            return
        }

        let event = SessionEvent(
            seq: envelope.seq,
            type: .message,
            timestamp: Date(),
            data: .message(payload)
        )
        appendEvent(event, to: sessionId)
    }

    private func handleProgress(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(ProgressPayload.self, from: envelope.payload) else {
            return
        }

        let event = SessionEvent(
            seq: envelope.seq,
            type: .progress,
            timestamp: Date(),
            data: .progress(payload)
        )
        appendEvent(event, to: sessionId)
    }

    private func handleUserQuestion(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(UserQuestionPayload.self, from: envelope.payload) else {
            logger.error("Failed to decode user_question")
            return
        }

        let event = SessionEvent(
            seq: envelope.seq,
            type: .userQuestion,
            timestamp: Date(),
            data: .userQuestion(payload)
        )
        appendEvent(event, to: sessionId)

        // Haptic
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()

        // Notification if backgrounded
        if isInBackground || selectedSessionId != sessionId {
            notifications.showQuestionNotification(
                question: payload.questions.first?.question ?? "Agent has a question",
                sessionId: sessionId
            )
        }

        logger.info("User question: \(payload.questions.count) questions for session \(sessionId)")
    }

    private func handleError(_ envelope: MessageEnvelope) {
        guard let sessionId = envelope.sessionId,
              let payload = PayloadDecoder.decode(ErrorPayload.self, from: envelope.payload) else {
            return
        }

        let event = SessionEvent(
            seq: envelope.seq,
            type: .error,
            timestamp: Date(),
            data: .error(payload)
        )
        appendEvent(event, to: sessionId)
    }

    // MARK: - Helpers

    private func findRequest(_ requestId: String) -> (String, PermissionRequest)? {
        for (sessionId, session) in sessions {
            if let request = session.pendingApprovals[requestId] {
                return (sessionId, request)
            }
        }
        return nil
    }

    private func resolveRequest(requestId: String, resolution: PermissionResolution) {
        for sessionId in sessions.keys {
            if sessions[sessionId]?.pendingApprovals[requestId] != nil {
                sessions[sessionId]?.pendingApprovals[requestId]?.resolution = resolution
                sessions[sessionId]?.pendingApprovals[requestId]?.resolvedAt = Date()
                sessions[sessionId]?.updatedAt = Date()

                // Add resolution event
                let toolName = sessions[sessionId]?.pendingApprovals[requestId]?.toolName ?? "Unknown"
                let event = SessionEvent(
                    seq: lastSeq,
                    type: .permissionRequest,
                    timestamp: Date(),
                    data: .permissionResolved(requestId: requestId, resolution: resolution, toolName: toolName)
                )
                appendEvent(event, to: sessionId)

                // Check if any pending left — update status
                if sessions[sessionId]?.pendingCount == 0,
                   sessions[sessionId]?.status == .waiting {
                    sessions[sessionId]?.status = .running
                }
                break
            }
        }
    }

    /// Keep at most `maxSessions` sessions. Drop the oldest finished sessions first.
    private func pruneFinishedSessions() {
        guard sessions.count > settings.maxSessions else { return }

        let finishedStatuses: Set<SessionStatus> = [.done, .stopped, .error]
        let finished = sessions.values
            .filter { finishedStatuses.contains($0.status) }
            .sorted { $0.updatedAt < $1.updatedAt }

        var toRemove = sessions.count - settings.maxSessions
        for session in finished {
            guard toRemove > 0 else { break }
            sessions.removeValue(forKey: session.id)
            toRemove -= 1
        }
    }

    private func appendEvent(_ event: SessionEvent, to sessionId: String) {
        sessions[sessionId]?.events.append(event)
        // Cap event buffer
        if let count = sessions[sessionId]?.events.count, count > settings.maxEventsPerSession {
            sessions[sessionId]?.events.removeFirst(count - settings.maxEventsPerSession)
        }
    }

    // MARK: - Persistence

    private func persistState() {
        UserDefaults.standard.set(lastSeq, forKey: "last_seq")
    }

    private func loadPersistedState() {
        lastSeq = UserDefaults.standard.integer(forKey: "last_seq")
    }
}
