import Foundation
import Network
import UIKit
import os

private let logger = Logger(subsystem: "com.agentpager.ios", category: "GatewayClient")

// MARK: - Connection Status

enum ConnectionStatus: String {
    case disconnected
    case connecting
    case connected
}

// MARK: - Gateway Client

@MainActor
final class GatewayClient {
    // Configuration
    var host: String {
        didSet { UserDefaults.standard.set(host, forKey: "gateway_host") }
    }
    var port: Int {
        didSet { UserDefaults.standard.set(port, forKey: "gateway_port") }
    }

    // Relay configuration (cloud connectivity)
    var relayUrl: String? {
        didSet { UserDefaults.standard.set(relayUrl, forKey: "relay_url") }
    }
    var roomId: String? {
        didSet { UserDefaults.standard.set(roomId, forKey: "relay_room_id") }
    }
    var roomSecret: String? {
        didSet {
            if let value = roomSecret {
                _ = KeychainHelper.save(key: "relay_room_secret", string: value)
            } else {
                KeychainHelper.delete(key: "relay_room_secret")
            }
        }
    }
    var authToken: String? {
        didSet {
            if let value = authToken {
                _ = KeychainHelper.save(key: "relay_auth_token", string: value)
            } else {
                KeychainHelper.delete(key: "relay_auth_token")
            }
        }
    }

    /// Whether to use relay instead of direct LAN connection
    var useRelay: Bool {
        relayUrl != nil && roomId != nil && (roomSecret != nil || authToken != nil)
    }

    // State
    private(set) var status: ConnectionStatus = .disconnected
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var outSeq: Int = 0
    private var reconnectAttempt: Int = 0
    private var reconnectTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var heartbeatTimer: Task<Void, Never>?
    private var lastMessageTime: Date = .distantPast

    // Callback
    var onMessage: ((MessageEnvelope) -> Void)?
    var onStatusChange: ((ConnectionStatus) -> Void)?

    // Network monitoring
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "com.agentpager.network-monitor")
    private var wasConnected = false

    // Offline action queue
    private var offlineQueue: [Data] = []

    // E2E encryption
    var cryptoService: CryptoService?

    // Background task to keep WebSocket alive briefly after backgrounding
    private var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid

    init() {
        self.host = UserDefaults.standard.string(forKey: "gateway_host") ?? "192.168.1.184"
        self.port = UserDefaults.standard.integer(forKey: "gateway_port")
        if self.port == 0 { self.port = ProtocolConstants.defaultWSPort }

        // Load relay config
        self.relayUrl = UserDefaults.standard.string(forKey: "relay_url")
        self.roomId = UserDefaults.standard.string(forKey: "relay_room_id")

        // Load secrets from Keychain, with UserDefaults migration fallback.
        // If found in UserDefaults (pre-Keychain builds), migrate to Keychain and delete from UserDefaults.
        self.roomSecret = Self.loadSecretWithMigration(key: "relay_room_secret")
        self.authToken = Self.loadSecretWithMigration(key: "relay_auth_token")

        startNetworkMonitor()
    }

    /// Load a secret from Keychain, falling back to UserDefaults for migration.
    /// If found in UserDefaults, writes to Keychain and deletes from UserDefaults.
    private static func loadSecretWithMigration(key: String) -> String? {
        // Try Keychain first (preferred)
        if let value = KeychainHelper.loadString(key: key) {
            return value
        }

        // Fallback: migrate from UserDefaults (unencrypted) to Keychain
        if let legacy = UserDefaults.standard.string(forKey: key) {
            logger.info("Migrating \(key) from UserDefaults to Keychain")
            _ = KeychainHelper.save(key: key, string: legacy)
            UserDefaults.standard.removeObject(forKey: key)
            return legacy
        }

        return nil
    }

    deinit {
        monitor.cancel()
    }

    // MARK: - Connect / Disconnect

    func connect() {
        guard status == .disconnected else { return }
        setStatus(.connecting)
        reconnectAttempt = 0
        establishConnection()
    }

    func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        setStatus(.disconnected)
    }

    // MARK: - Send

    func send(type: ActionType, payload: some Encodable, sessionId: String? = nil) {
        do {
            let envelopeData = try EnvelopeBuilder.build(
                type: type,
                payload: payload,
                sessionId: sessionId,
                seq: outSeq
            )
            outSeq += 1

            // E2E encrypt if available and using relay
            let data: Data
            if useRelay, let crypto = cryptoService, crypto.isReady,
               let envelopeString = String(data: envelopeData, encoding: .utf8),
               let encrypted = crypto.encrypt(envelopeString) {
                let e2eMessage: [String: Any] = [
                    "e2e": true,
                    "nonce": encrypted.nonce,
                    "ciphertext": encrypted.ciphertext,
                ]
                data = try JSONSerialization.data(withJSONObject: e2eMessage)
            } else {
                data = envelopeData
            }

            if status == .connected, let ws = webSocketTask {
                let message = URLSessionWebSocketTask.Message.data(data)
                ws.send(message) { error in
                    if let error {
                        logger.error("Send failed: \(error.localizedDescription)")
                    }
                }
            } else {
                // Queue for later
                offlineQueue.append(data)
                logger.info("Action queued (offline), queue size: \(self.offlineQueue.count)")
            }
        } catch {
            logger.error("Failed to encode action: \(error.localizedDescription)")
        }
    }

    func sendResumeFromSeq(_ lastSeq: Int) {
        send(type: .resumeFromSeq, payload: ResumeFromSeqPayload(lastSeq: lastSeq))
    }

    // MARK: - Private: Connection

    private func establishConnection() {
        // Build URL: relay (wss) or LAN (ws)
        let urlString: String
        let bearerToken: String?

        if useRelay, let relayUrl = relayUrl, let roomId = roomId {
            urlString = "\(relayUrl)/ws/client?room=\(roomId)"
            bearerToken = authToken ?? roomSecret
        } else {
            urlString = "ws://\(host):\(port)/ws"
            bearerToken = nil
        }

        guard let url = URL(string: urlString) else {
            logger.error("Invalid URL: \(urlString)")
            setStatus(.disconnected)
            return
        }

        // Tear down any existing connection first to prevent duplicate receive loops
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil

        logger.info("Connecting to \(urlString)")

        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config)

        var request = URLRequest(url: url)
        if let token = bearerToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let ws = session!.webSocketTask(with: request)
        webSocketTask = ws
        ws.resume()

        // Start receive loop
        let wsRef = ws
        receiveTask = Task.detached { [weak self] in
            await self?.receiveLoop(ws: wsRef)
        }

        // Optimistic: mark connected after a short delay if no error
        // The receive loop will detect actual connection state
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, self.status == .connecting else { return }
            // If we haven't been disconnected, we're connected
            self.setStatus(.connected)
            self.reconnectAttempt = 0
            self.flushOfflineQueue()
            self.startHeartbeatMonitor()
        }
    }

    private nonisolated func receiveLoop(ws: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await ws.receive()

                var data: Data?
                switch message {
                case .data(let d):
                    data = d
                case .string(let text):
                    data = text.data(using: .utf8)
                @unknown default:
                    break
                }

                if let data {
                    await MainActor.run { [weak self] in
                        self?.lastMessageTime = Date()
                        if self?.status != .connected {
                            self?.setStatus(.connected)
                            self?.reconnectAttempt = 0
                            self?.flushOfflineQueue()
                            self?.startHeartbeatMonitor()
                        }
                        self?.handleMessage(data)
                    }
                }
            } catch {
                logger.error("WebSocket receive error: \(error.localizedDescription)")
                await MainActor.run { [weak self] in
                    self?.handleDisconnect()
                }
                return
            }
        }
    }

    private func handleMessage(_ data: Data) {
        // Check for E2E encrypted message
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           json["e2e"] as? Bool == true,
           let nonce = json["nonce"] as? String,
           let ciphertext = json["ciphertext"] as? String,
           let crypto = cryptoService, crypto.isReady {
            // Decrypt E2E message
            if let plaintext = crypto.decrypt(ciphertextBase64: ciphertext, nonceBase64: nonce),
               let decryptedData = plaintext.data(using: .utf8) {
                do {
                    let envelope = try JSONDecoder().decode(MessageEnvelope.self, from: decryptedData)
                    onMessage?(envelope)
                } catch {
                    logger.error("Failed to decode decrypted message: \(error.localizedDescription)")
                }
            } else {
                logger.error("E2E decryption failed")
            }
            return
        }

        // Plain text message (LAN mode)
        do {
            let envelope = try JSONDecoder().decode(MessageEnvelope.self, from: data)
            onMessage?(envelope)
        } catch {
            logger.error("Failed to decode message: \(error.localizedDescription)")
            if let text = String(data: data, encoding: .utf8) {
                logger.debug("Raw message: \(text.prefix(500))")
            }
        }
    }

    // MARK: - Reconnection

    private func handleDisconnect() {
        guard status != .disconnected else { return }

        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        webSocketTask?.cancel(with: .abnormalClosure, reason: nil)
        webSocketTask = nil

        setStatus(.disconnected)
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            guard let self else { return }

            let base = Double(ProtocolConstants.reconnectBaseMs)
            let max = Double(ProtocolConstants.reconnectMaxMs)
            let delay = min(base * pow(2.0, Double(reconnectAttempt)), max)
            let jitter = delay * 0.25 * Double.random(in: 0...1)
            let totalMs = delay + jitter

            logger.info("Reconnecting in \(Int(totalMs))ms (attempt \(self.reconnectAttempt + 1))")

            try? await Task.sleep(for: .milliseconds(Int(totalMs)))

            guard !Task.isCancelled else { return }

            await MainActor.run {
                self.reconnectAttempt += 1
                self.setStatus(.connecting)
                self.establishConnection()
            }
        }
    }

    // MARK: - Heartbeat Monitor

    private func startHeartbeatMonitor() {
        heartbeatTimer?.cancel()
        heartbeatTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }

                let elapsed = Date().timeIntervalSince(self.lastMessageTime)
                let timeout = Double(ProtocolConstants.heartbeatIntervalMs * ProtocolConstants.maxMissedHeartbeats) / 1000.0

                if elapsed > timeout {
                    logger.warning("Heartbeat timeout — no message for \(Int(elapsed))s")
                    await MainActor.run {
                        self.handleDisconnect()
                    }
                    return
                }
            }
        }
    }

    // MARK: - Network Monitor

    private func startNetworkMonitor() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if path.status == .satisfied && self.status == .disconnected && self.wasConnected {
                    logger.info("Network restored — reconnecting")
                    self.connect()
                }
                self.wasConnected = path.status == .satisfied
            }
        }
        monitor.start(queue: monitorQueue)
    }

    // MARK: - Offline Queue

    private func flushOfflineQueue() {
        guard !offlineQueue.isEmpty, let ws = webSocketTask else { return }
        logger.info("Flushing \(self.offlineQueue.count) queued actions")

        for data in offlineQueue {
            ws.send(.data(data)) { error in
                if let error {
                    logger.error("Flush send failed: \(error.localizedDescription)")
                }
            }
        }
        offlineQueue.removeAll()
    }

    // MARK: - Background Task

    func beginBackgroundKeepAlive() {
        guard backgroundTaskID == .invalid else { return }
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "AgentPager WebSocket") { [weak self] in
            // iOS is about to kill us — clean up
            logger.info("Background time expired")
            self?.endBackgroundKeepAlive()
        }
        logger.info("Background keep-alive started (task \(self.backgroundTaskID.rawValue))")
    }

    func endBackgroundKeepAlive() {
        guard backgroundTaskID != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTaskID)
        backgroundTaskID = .invalid
        logger.info("Background keep-alive ended")
    }

    // MARK: - Status

    private func setStatus(_ newStatus: ConnectionStatus) {
        guard status != newStatus else { return }
        status = newStatus
        logger.info("Connection status: \(newStatus.rawValue)")
        onStatusChange?(newStatus)
    }
}
