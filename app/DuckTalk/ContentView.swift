import SwiftUI

/// One screen: where's the server, echo or Gemini, connect, watch the transcript.
struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "ws://localhost:8765"
    @AppStorage("mode") private var mode = "direct"
    @AppStorage("autocorrect") private var autocorrect = false
    @State private var session = VoiceSession()
    @State private var draft = ""

    private var live: Bool { session.status != .idle }

    /// One exclusive mode, plus auto-correct as an independent axis.
    private var url: URL? {
        var query = "?mode=\(mode)"
        if autocorrect && mode != "echo" { query += "&correct=1" }
        return URL(string: serverURL + query)
    }

    var body: some View {
        VStack(spacing: 16) {
            TextField("ws://host:8765", text: $serverURL)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .disabled(live)
                .accessibilityLabel("Server URL")

            Picker("Mode", selection: $mode) {
                Text("Direct").tag("direct")
                Text("Review").tag("review")
                Text("Echo").tag("echo")
            }
            .pickerStyle(.segmented)
            .disabled(live)
            .accessibilityLabel("Mode")

            if mode == "echo" {
                Text("Skips Gemini — you hear yourself.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Toggle("Auto-correct what I said", isOn: $autocorrect)
                    .font(.callout)
                    .disabled(live)
                    .accessibilityLabel("Auto-correct")
            }

            transcript

            if session.pending != nil { approval }

            if let error = session.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("error")
            }

            // Proof the mic is live: it ripples on its own and swells as you speak.
            if live {
                Waveform(level: CGFloat(session.level))
                    .padding(.vertical, 8)
            }

            Text("\(session.status.rawValue)   ↑ \(sent)   ↓ \(received)")
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Status")
                .accessibilityValue("\(session.status.rawValue), sent \(sent), received \(received)")

            // The audio route, on screen: a wrong one is why the model can hear
            // itself, or hear nothing. Cheaper to read than to diagnose.
            Text(AudioPipe.route)
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("route")

            Button(live ? "Stop" : "Connect") {
                if live {
                    session.stop()
                } else if let url {
                    session.connect(url: url)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(live ? .red : .accentColor)
            .accessibilityLabel(live ? "Stop" : "Connect")
        }
        .padding()
    }

    /// What the server heard, before it runs. Edit the text and Accept — that edit is
    /// how the relay learns what you actually said.
    private var approval: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Run this?")
                .font(.caption)
                .foregroundStyle(.secondary)

            TextField("instruction", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .accessibilityLabel("Instruction")

            HStack {
                Button("Reject") { session.reject() }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Reject")
                Spacer()
                Button("Accept") { session.approve(draft) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel("Accept")
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        .onChange(of: session.pending) {
            if let text = session.pending { draft = text }
        }
        .onAppear { draft = session.pending ?? "" }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(session.lines) { line in
                        Text(line.text)
                            .frame(maxWidth: .infinity, alignment: line.role == "user" ? .trailing : .leading)
                            .foregroundStyle(line.role == "user" ? .secondary : .primary)
                            .id(line.id)
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(maxHeight: .infinity)
            .onChange(of: session.lines.last?.text) {
                if let id = session.lines.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }

    // Seconds of audio, not kilobytes: this is the number that can be held against
    // what the relay logged and what a microphone heard. Mic is 16 kHz Int16
    // (32 bytes/ms), the reply 24 kHz Int16 (48 bytes/ms).
    private var sent: String { secs(session.bytesUp, perSecond: 32_000) }
    private var received: String { secs(session.bytesDown, perSecond: 48_000) }

    private func secs(_ bytes: Int, perSecond: Int) -> String {
        String(format: "%.1fs", Double(bytes) / Double(perSecond))
    }
}

#Preview {
    ContentView()
}
