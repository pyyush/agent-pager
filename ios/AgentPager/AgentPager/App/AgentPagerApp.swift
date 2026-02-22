import SwiftUI
import UserNotifications

@main
struct AgentPagerApp: App {
    @State private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            Group {
                if appState.authService.isAuthenticated || !appState.requireAuth {
                    ContentView()
                } else {
                    SignInView(authService: appState.authService)
                }
            }
            .environment(appState)
            .onAppear {
                appState.start()
                appDelegate.appState = appState
            }
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .active:
                    appState.onForeground()
                case .background:
                    appState.onBackground()
                default:
                    break
                }
            }
        }
    }
}

// MARK: - App Delegate (APNs registration)

class AppDelegate: NSObject, UIApplicationDelegate {
    var appState: AppState?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        Task { @MainActor in
            appState?.handleAPNsToken(token)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("APNs registration failed: \(error.localizedDescription)")
    }
}
