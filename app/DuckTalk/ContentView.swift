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
            }

            Text("\(session.status.rawValue)   ↑ \(kb(session.bytesUp))   ↓ \(kb(session.bytesDown))")
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Status")
                .accessibilityValue("\(session.status.rawValue), sent \(kb(session.bytesUp)), received \(kb(session.bytesDown))")

            // The audio route, on screen: a wrong one is why the model can hear
            // itself, or hear nothing. Cheaper to read than to diagnose.
            Text(AudioPipe.route)
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .accessibilityLabel("Audio route")

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

    private func kb(_ n: Int) -> String { "\(n / 1024) KB" }
}

#Preview {
    ContentView()
}
