import SwiftUI

struct PermissionCardView: View {
    @Environment(AppState.self) private var appState
    let request: PermissionRequest
    let sessionId: String

    @State private var showDangerousConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Tool + risk
            HStack {
                Image(systemName: ToolIcon.sfSymbol(for: request.toolName))
                    .foregroundStyle(request.riskLevel.color)
                Text(request.toolName)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if request.riskLevel == .dangerous {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            // Command / target
            if !request.target.isEmpty {
                Text(request.target)
                    .font(.caption.monospaced())
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Diff
            if let diff = request.diff {
                DiffView(diff: diff)
            }

            // Actions
            if request.isPending {
                HStack(spacing: 10) {
                    Button {
                        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
                        appState.denyRequest(requestId: request.id)
                    } label: {
                        Text("Deny")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)

                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        if request.riskLevel == .dangerous {
                            showDangerousConfirm = true
                        } else {
                            appState.approveRequest(requestId: request.id)
                        }
                    } label: {
                        Text("Approve")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(approveColor)

                    Menu {
                        Button {
                            if request.riskLevel == .dangerous {
                                showDangerousConfirm = true
                            } else {
                                appState.approveRequest(requestId: request.id, scope: .session)
                            }
                        } label: {
                            Label("Approve for Session", systemImage: "checkmark.circle")
                        }
                        Button {
                            if request.riskLevel == .dangerous {
                                showDangerousConfirm = true
                            } else {
                                appState.approveRequest(requestId: request.id, scope: .tool)
                            }
                        } label: {
                            Label("Approve for Tool", systemImage: "wrench")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .opacity(request.isPending ? 1 : 0.5)
        .sheet(isPresented: $showDangerousConfirm) {
            DangerousConfirmSheet(request: request) {
                appState.approveRequest(requestId: request.id)
            }
            .presentationDetents([.medium])
        }
    }

    private var approveColor: Color {
        switch request.riskLevel {
        case .safe: return .green
        case .moderate: return .orange
        case .dangerous: return .red
        }
    }

}

// MARK: - Previews

#if DEBUG
#Preview("Moderate Risk") {
    PreviewWrapper {
        ScrollView {
            PermissionCardView(
                request: PreviewData.bashRequest,
                sessionId: "sess-001"
            )
            .padding()
        }
    }
}

#Preview("Safe with Diff") {
    PreviewWrapper {
        ScrollView {
            PermissionCardView(
                request: PreviewData.writeRequest,
                sessionId: "sess-001"
            )
            .padding()
        }
    }
}

#Preview("Dangerous") {
    PreviewWrapper {
        ScrollView {
            PermissionCardView(
                request: PreviewData.dangerousRequest,
                sessionId: "sess-001"
            )
            .padding()
        }
    }
}
#endif
