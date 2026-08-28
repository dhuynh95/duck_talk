import SwiftUI

/// One screen: where's the server, echo or Gemini, connect, watch the transcript.
struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "ws://localhost:8765"
    @AppStorage("echo") private var echo = false
    @State private var session = VoiceSession()

    private var live: Bool { session.status != .idle }

    var body: some View {
        VStack(spacing: 16) {
            TextField("ws://host:8765", text: $serverURL)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .disabled(live)
                .accessibilityLabel("Server URL")

            Toggle("Echo (skip Gemini, hear yourself)", isOn: $echo)
                .disabled(live)
                .accessibilityLabel("Echo")

            transcript

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
                } else if let url = URL(string: serverURL + (echo ? "?echo=1" : "")) {
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
