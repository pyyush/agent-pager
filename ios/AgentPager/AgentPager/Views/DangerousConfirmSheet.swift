import SwiftUI

struct DangerousConfirmSheet: View {
    let request: PermissionRequest
    let onConfirm: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                // Warning icon
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.red)
                    .padding(.top, 20)

                Text("Dangerous Action")
                    .font(.title2.weight(.bold))

                Text("This action has been classified as potentially destructive. Please review carefully before approving.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                // Tool details
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: ToolIcon.sfSymbol(for: request.toolName))
                        Text(request.toolName)
                            .font(.headline)
                    }

                    Text(request.summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    if !request.target.isEmpty {
                        Text(request.target)
                            .font(.caption.monospaced())
                            .foregroundStyle(.red)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.red.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
                .padding()
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)

                Spacer()

                // Buttons
                VStack(spacing: 12) {
                    Button {
                        let generator = UINotificationFeedbackGenerator()
                        generator.notificationOccurred(.warning)
                        onConfirm()
                        dismiss()
                    } label: {
                        Text("Approve Anyway")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(.red)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    Button {
                        dismiss()
                    } label: {
                        Text("Cancel")
                            .font(.headline)
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                }
                .padding(.horizontal)
                .padding(.bottom)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview {
    DangerousConfirmSheet(
        request: PreviewData.dangerousRequest,
        onConfirm: {}
    )
}
#endif
