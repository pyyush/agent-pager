import SwiftUI

struct InputBarView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String
    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("Message agent...", text: $text)
                .textFieldStyle(.plain)
                .font(.subheadline)
                .focused($isFocused)
                .onSubmit { sendMessage() }

            Button {
                sendMessage()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(text.isEmpty ? Color(.quaternaryLabel) : Color.accentColor)
            }
            .disabled(text.isEmpty)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func sendMessage() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        appState.sendTextInput(trimmed, sessionId: sessionId)
        text = ""
        isFocused = false
    }
}

// MARK: - Previews

#if DEBUG
#Preview {
    PreviewWrapper {
        VStack {
            Spacer()
            InputBarView(sessionId: "sess-001")
        }
    }
}
#endif
