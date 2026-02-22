import SwiftUI

struct QuestionCardView: View {
    @Environment(AppState.self) private var appState
    let payload: UserQuestionPayload

    @State private var answered = false
    @State private var selectedOptions: [String: Set<String>] = [:]
    @State private var otherText: String = ""
    @State private var showOtherField = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(.blue)
                Text("Agent Question")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.blue)
                Spacer()
            }

            ForEach(payload.questions) { question in
                questionView(question)
            }

            if answered {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("Answered")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.green)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(.blue.opacity(0.15), lineWidth: 0.5)
        )
        .padding(.horizontal)
    }

    @ViewBuilder
    private func questionView(_ question: UserQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(question.question)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)

            // Option buttons
            ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                optionButton(
                    index: index + 1,
                    option: option,
                    questionHeader: question.header,
                    multiSelect: question.multiSelect
                )
            }

            // "Other" option
            if showOtherField {
                HStack {
                    TextField("Type your answer...", text: $otherText)
                        .textFieldStyle(.roundedBorder)
                        .font(.subheadline)

                    Button {
                        guard !otherText.isEmpty else { return }
                        sendAnswer(otherText)
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.blue)
                    }
                    .disabled(otherText.isEmpty)
                }
            } else if !answered {
                Button {
                    showOtherField = true
                } label: {
                    HStack {
                        Image(systemName: "pencil")
                        Text("Other")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)
                    .background(.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    private func optionButton(index: Int, option: UserQuestionOption, questionHeader: String, multiSelect: Bool) -> some View {
        Button {
            guard !answered else { return }
            // Claude Code expects the option number (1-based)
            sendAnswer("\(index)")
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)

                if !option.description.isEmpty {
                    Text(option.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(.blue.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(answered)
        .opacity(answered ? 0.5 : 1)
    }

    private func sendAnswer(_ answer: String) {
        guard let sessionId = payload.sessionId else { return }
        appState.sendTextInput(answer, sessionId: sessionId)
        answered = true

        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.impactOccurred()
    }
}

// MARK: - Previews

#if DEBUG
#Preview {
    PreviewWrapper {
        ScrollView {
            QuestionCardView(payload: PreviewData.sampleQuestion)
        }
    }
}
#endif
