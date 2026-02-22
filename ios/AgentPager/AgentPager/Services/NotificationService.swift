import Foundation
import UIKit
import UserNotifications
import os

private let logger = Logger(subsystem: "com.agentpager.ios", category: "Notifications")

// MARK: - Notification Service

@MainActor
final class NotificationService: NSObject {
    static let permissionCategory = "PERMISSION_REQUEST"
    static let approveOnceAction = "APPROVE_ONCE_ACTION"
    static let approveSessionAction = "APPROVE_SESSION_ACTION"
    static let denyAction = "DENY_ACTION"

    private(set) var isAuthorized = false
    var onApprove: ((String, ApprovalScope) -> Void)?  // requestId, scope
    var onDeny: ((String) -> Void)?     // requestId
    var onTapNotification: ((String) -> Void)?  // sessionId

    override init() {
        super.init()
    }

    func requestPermission() async {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            isAuthorized = granted
            if granted {
                registerCategories()
                // Register for remote notifications (APNs)
                await MainActor.run {
                    UIApplication.shared.registerForRemoteNotifications()
                }
                logger.info("Notification permission granted, registering for remote push")
            } else {
                logger.info("Notification permission denied")
            }
        } catch {
            logger.error("Notification permission error: \(error.localizedDescription)")
        }
    }

    private func registerCategories() {
        let approveSession = UNNotificationAction(
            identifier: Self.approveSessionAction,
            title: "Approve (Session)",
            options: [.authenticationRequired]
        )
        let approveOnce = UNNotificationAction(
            identifier: Self.approveOnceAction,
            title: "Approve (Once)",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: Self.denyAction,
            title: "Deny",
            options: [.destructive]
        )

        let category = UNNotificationCategory(
            identifier: Self.permissionCategory,
            actions: [approveSession, approveOnce, deny],
            intentIdentifiers: [],
            options: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    func showPermissionNotification(request: PermissionRequest, sessionId: String) {
        guard isAuthorized else { return }

        let content = UNMutableNotificationContent()
        content.title = "\(toolEmoji(request.toolName)) \(request.toolName) needs approval"
        content.body = request.summary
        content.sound = .default
        content.categoryIdentifier = Self.permissionCategory
        content.threadIdentifier = sessionId
        content.userInfo = [
            "requestId": request.id,
            "sessionId": sessionId,
            "riskLevel": request.riskLevel.rawValue,
        ]

        // Time-sensitive so it shows on lock screen and breaks through Focus
        content.interruptionLevel = .timeSensitive

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let notifRequest = UNNotificationRequest(
            identifier: "permission-\(request.id)",
            content: content,
            trigger: trigger
        )

        UNUserNotificationCenter.current().add(notifRequest) { error in
            if let error {
                logger.error("Failed to show notification: \(error.localizedDescription)")
            }
        }
    }

    func showQuestionNotification(question: String, sessionId: String) {
        guard isAuthorized else { return }

        let content = UNMutableNotificationContent()
        content.title = "Agent has a question"
        content.body = question
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.userInfo = ["sessionId": sessionId]

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let notifRequest = UNNotificationRequest(
            identifier: "question-\(UUID().uuidString)",
            content: content,
            trigger: trigger
        )

        UNUserNotificationCenter.current().add(notifRequest) { error in
            if let error {
                logger.error("Failed to show question notification: \(error.localizedDescription)")
            }
        }
    }

    func clearNotification(requestId: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: ["permission-\(requestId)"]
        )
    }

    private func toolEmoji(_ toolName: String) -> String {
        switch toolName {
        case "Read": return "📄"
        case "Write": return "✏️"
        case "Edit": return "📝"
        case "Bash": return "💻"
        case "Glob", "Grep": return "🔍"
        case "WebSearch", "WebFetch": return "🌐"
        default: return "🔧"
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationService: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let requestId = userInfo["requestId"] as? String ?? ""
        let sessionId = userInfo["sessionId"] as? String ?? ""

        Task { @MainActor in
            switch response.actionIdentifier {
            case Self.approveSessionAction:
                onApprove?(requestId, .session)
            case Self.approveOnceAction:
                onApprove?(requestId, .once)
            case Self.denyAction:
                onDeny?(requestId)
            default:
                // Tapped on the notification itself — navigate to session
                onTapNotification?(sessionId)
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Show banner even when app is in foreground
        completionHandler([.banner, .sound])
    }
}
