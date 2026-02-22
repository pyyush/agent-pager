import SwiftUI

struct DiffView: View {
    let diff: DiffPayload
    @State private var isExpanded = false

    private let maxCollapsedLines = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // File header
            fileHeader

            if diff.safeBinary {
                Text("Binary file changed")
                    .font(.caption.italic())
                    .foregroundStyle(.secondary)
            } else if diff.safeTruncated {
                Text("Diff too large — truncated")
                    .font(.caption.italic())
                    .foregroundStyle(.orange)
            } else if diff.hunks.isEmpty {
                Text(diff.additions == 0 && diff.deletions == 0 ? "New file" : "No changes")
                    .font(.caption.italic())
                    .foregroundStyle(.secondary)
            } else {
                diffContent
            }
        }
        .padding(8)
        .background(Color(.systemBackground).opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.separator).opacity(0.3), lineWidth: 0.5)
        )
    }

    // MARK: - File Header

    private var fileHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text")
                .font(.caption2)
                .foregroundStyle(.secondary)

            Text(shortenPath(diff.filePath))
                .font(.caption.monospaced().weight(.medium))
                .lineLimit(1)

            Spacer()

            HStack(spacing: 4) {
                if diff.additions > 0 {
                    Text("+\(diff.additions)")
                        .font(.caption2.monospaced().weight(.bold))
                        .foregroundStyle(.green)
                }
                if diff.deletions > 0 {
                    Text("-\(diff.deletions)")
                        .font(.caption2.monospaced().weight(.bold))
                        .foregroundStyle(.red)
                }
            }
        }
    }

    // MARK: - Diff Content

    @ViewBuilder
    private var diffContent: some View {
        let allLines = collectAllLines()
        let displayLines = isExpanded ? allLines : Array(allLines.prefix(maxCollapsedLines))

        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(displayLines.enumerated()), id: \.offset) { _, line in
                DiffLineView(line: line)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 4))

        // Expand/collapse button
        if allLines.count > maxCollapsedLines {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                Text(isExpanded
                    ? "Show less"
                    : "Show \(allLines.count - maxCollapsedLines) more lines")
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            }
        }
    }

    // MARK: - Helpers

    private func collectAllLines() -> [DiffLine] {
        var result: [DiffLine] = []
        for hunk in diff.hunks {
            result.append(DiffLine(
                type: .hunkHeader,
                text: "@@ -\(hunk.oldStart),\(hunk.oldLines) +\(hunk.newStart),\(hunk.newLines) @@"
            ))
            for line in hunk.lines {
                if line.hasPrefix("+") {
                    result.append(DiffLine(type: .addition, text: line))
                } else if line.hasPrefix("-") {
                    result.append(DiffLine(type: .deletion, text: line))
                } else {
                    result.append(DiffLine(type: .context, text: line))
                }
            }
        }
        return result
    }

    private func shortenPath(_ path: String) -> String {
        let components = path.split(separator: "/")
        if components.count <= 3 { return path }
        return ".../\(components.suffix(3).joined(separator: "/"))"
    }
}

// MARK: - Diff Line Model

struct DiffLine {
    enum LineType {
        case addition, deletion, context, hunkHeader
    }
    let type: LineType
    let text: String
}

// MARK: - Diff Line View

struct DiffLineView: View {
    let line: DiffLine

    var body: some View {
        Text(line.text)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(foregroundColor)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(backgroundColor)
    }

    private var foregroundColor: Color {
        switch line.type {
        case .addition: return .green
        case .deletion: return .red
        case .hunkHeader: return .blue
        case .context: return .primary
        }
    }

    private var backgroundColor: Color {
        switch line.type {
        case .addition: return .green.opacity(0.1)
        case .deletion: return .red.opacity(0.1)
        case .hunkHeader: return .blue.opacity(0.05)
        case .context: return .clear
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Small Diff") {
    DiffView(diff: PreviewData.sampleDiff)
        .padding()
}

#Preview("Large Diff") {
    DiffView(diff: PreviewData.largeDiff)
        .padding()
}
#endif
