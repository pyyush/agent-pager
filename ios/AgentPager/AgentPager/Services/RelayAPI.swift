import Foundation
import os

private let logger = Logger(subsystem: "com.agentpager.ios", category: "RelayAPI")

/// HTTP client for the AgentPager relay REST API.
@MainActor
final class RelayAPI {
    private let baseUrl: String
    private var authToken: String?

    init(baseUrl: String = ProtocolConstants.defaultRelayUrl, authToken: String? = nil) {
        // Convert wss:// to https:// for REST API
        self.baseUrl = baseUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
        self.authToken = authToken
    }

    func setAuthToken(_ token: String) {
        self.authToken = token
    }

    // MARK: - Room Management

    struct CreateRoomResponse: Codable {
        let roomId: String
        let roomSecret: String
    }

    func createRoom() async throws -> CreateRoomResponse {
        let url = URL(string: "\(baseUrl)/api/rooms")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        addAuth(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(CreateRoomResponse.self, from: data)
    }

    struct RoomStatusResponse: Codable {
        let roomId: String
        let gatewayConnected: Bool
        let clientCount: Int
    }

    func getRoomStatus(roomId: String) async throws -> RoomStatusResponse {
        let url = URL(string: "\(baseUrl)/api/rooms/\(roomId)/status")!
        var request = URLRequest(url: url)
        addAuth(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(RoomStatusResponse.self, from: data)
    }

    // MARK: - Device Registration (APNs)

    struct RegisterDeviceResponse: Codable {
        let deviceId: String
    }

    func registerDevice(apnsToken: String, deviceName: String? = nil) async throws -> RegisterDeviceResponse {
        let url = URL(string: "\(baseUrl)/api/devices")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        addAuth(&request)

        var body: [String: String] = ["apnsToken": apnsToken]
        if let name = deviceName {
            body["deviceName"] = name
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(RegisterDeviceResponse.self, from: data)
    }

    // MARK: - Health

    struct HealthResponse: Codable {
        let status: String
        let timestamp: Int
    }

    func health() async throws -> HealthResponse {
        let url = URL(string: "\(baseUrl)/api/health")!
        let (data, response) = try await URLSession.shared.data(from: url)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(HealthResponse.self, from: data)
    }

    // MARK: - Helpers

    private func addAuth(_ request: inout URLRequest) {
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func checkResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw RelayAPIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            logger.error("API error \(http.statusCode): \(body)")
            throw RelayAPIError.httpError(statusCode: http.statusCode, body: body)
        }
    }
}

enum RelayAPIError: Error, LocalizedError {
    case invalidResponse
    case httpError(statusCode: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from relay"
        case .httpError(let code, let body):
            return "HTTP \(code): \(body)"
        }
    }
}
