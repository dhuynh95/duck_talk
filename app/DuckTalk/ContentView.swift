import SwiftUI

/// The home screen, which is two regions and one control:
///
///   messages   what already happened, frozen
///   input      what is being said now, and will be sent — automatically, or once
///              you accept it in review
///   controls   the listen button, centred, with the mode beside it when idle and a
///              way out of the session when live
///
/// Everything that configures the thing rather than being the conversation lives
/// behind the gear.
struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "ws://localhost:8765"
    @AppStorage("mode") private var mode = Mode.direct
    @AppStorage("autocorrect") private var autocorrect = false
    @State private var session = VoiceSession()
    @State private var draft = ""
    @State private var sheet: Sheet?

    private var live: Bool { session.status != .idle }

    /// One exclusive mode, plus auto-correct as an independent axis.
    private var url: URL? {
        URL(string: serverURL + "?mode=\(mode.rawValue)" + (autocorrect ? "&correct=1" : ""))
    }

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Spacer()
                settings
            }

            transcript

            if session.pending != nil || session.utterance != nil { input }

            if let error = session.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("error")
            }

            controls
        }
        .padding()
        .sheet(item: $sheet) { which in
            switch which {
            case .voice: VoiceView(serverURL: serverURL)
            case .corrections: CorrectionsView(serverURL: serverURL)
            case .server: ServerView(serverURL: $serverURL)
            case .mode: ModeSheet(mode: $mode)
            }
        }
    }

    private enum Sheet: String, Identifiable { case voice, corrections, server, mode; var id: String { rawValue } }

    // MARK: - Controls

    /// The listen button is centred on the screen, not in the row: the mode and the
    /// cancel sit beside it without moving it, so it never shifts under your thumb.
    private var controls: some View {
        ZStack {
            ListenButton(live: live, level: CGFloat(session.level), status: session.status.rawValue) {
                if let url { session.connect(url: url) }
            }
            HStack {
                Spacer()
                if live {
                    Button { session.stop() } label: {
                        Image(systemName: "xmark").font(.title3.weight(.medium))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Stop")
                } else {
                    // Bound at connect time on the relay, so it is settled before a
                    // session starts and cannot change under one. It opens a sheet
                    // rather than toggling silently: which mode you are in decides
                    // whether what you say runs immediately, so it is worth naming.
                    Button { sheet = .mode } label: {
                        VStack(spacing: 3) {
                            Image(systemName: mode.icon).font(.title3)
                            Text(mode.title).font(.caption2)
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("mode")
                    .accessibilityLabel("Mode")
                    .accessibilityValue(mode.title)
                }
            }
        }
        .padding(.bottom, 4)
    }

    private var settings: some View {
        Menu {
            Button { sheet = .voice } label: { Label("Voice", systemImage: "speaker.wave.2") }
            Button { sheet = .corrections } label: { Label("Corrections", systemImage: "text.badge.checkmark") }
            Toggle(isOn: $autocorrect) { Label("Auto-correct", systemImage: "wand.and.stars") }
                .disabled(live)
            Divider()
            Button { sheet = .server } label: { Label("Server", systemImage: "network") }
        } label: {
            Image(systemName: "gearshape").font(.title3)
        }
        .accessibilityIdentifier("settings")
        .accessibilityLabel("Settings")
    }

    // MARK: - Input

    /// One box in two states. Listening, it shows what is being transcribed and is
    /// not yours to touch. Held for review, the same text becomes editable and grows
    /// two buttons — and that edit is how the relay learns what you actually said.
    private var input: some View {
        VStack(alignment: .leading, spacing: 10) {
            if session.pending != nil {
                // Never "corrected" — iOS autocorrect rewrites the very words you are
                // here to fix.
                TextField("instruction", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .lineLimit(1...6)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("instruction")
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
            } else {
                Text(session.utterance ?? "")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("utterance")
                    .accessibilityLabel("Hearing")
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .onChange(of: session.pending) {
            if let text = session.pending { draft = text }
        }
    }

    // MARK: - Messages

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(session.lines) { line in
                        switch line.kind {
                        case .tools:
                            Text(line.toolLabel)
                                .font(.caption.monospaced())
                                .foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        case .user, .model:
                            Text(line.text)
                                .frame(maxWidth: .infinity, alignment: line.kind == .user ? .trailing : .leading)
                                .foregroundStyle(line.kind == .user ? .secondary : .primary)
                                .id(line.id)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(maxHeight: .infinity)
            .onChange(of: tail) {
                if let id = session.lines.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }

    /// What the bottom of the transcript looks like right now — speech grows a line's
    /// text, a tool run grows its list, so both have to move the scroll.
    private var tail: String {
        guard let last = session.lines.last else { return "" }
        return "\(last.id) \(last.text.count) \(last.tools.count) \(last.running)"
    }
}

/// What happens to what you say. Two answers, and the difference matters enough to
/// spell out — one of them runs your words the moment you stop talking.
enum Mode: String, CaseIterable, Identifiable {
    case direct, review

    var id: String { rawValue }

    var title: String {
        switch self {
        case .direct: return "Direct"
        case .review: return "Review"
        }
    }

    var detail: String {
        switch self {
        case .direct: return "Runs as soon as you stop talking"
        case .review: return "Shows you the text first, so you can fix it"
        }
    }

    var icon: String {
        switch self {
        case .direct: return "bolt.circle"
        case .review: return "checkmark.circle"
        }
    }
}

/// Picked from a sheet rather than flipped by a button, so the mode you are about to
/// speak into is named on screen before you commit to it.
struct ModeSheet: View {
    @Binding var mode: Mode
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("Select mode").font(.headline)
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 34, height: 34)
                            .background(Color(.secondarySystemBackground), in: Circle())
                    }
                    .accessibilityLabel("Close")
                    Spacer()
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 20)

            VStack(spacing: 0) {
                ForEach(Array(Mode.allCases.enumerated()), id: \.element.id) { index, option in
                    Button {
                        mode = option
                        dismiss()
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: option.icon)
                                .font(.title3)
                                .foregroundStyle(.tint)
                                .frame(width: 26)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.title).font(.body).foregroundStyle(.primary)
                                Text(option.detail).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if mode == option {
                                Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(.tint)
                            }
                        }
                        .padding(.vertical, 14)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("mode-\(option.rawValue)")
                    .accessibilityLabel(option.title)
                    .accessibilityAddTraits(mode == option ? [.isSelected] : [])

                    if index < Mode.allCases.count - 1 { Divider().padding(.leading, 40) }
                }
            }
            .padding(.horizontal, 16)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal, 16)

            Spacer(minLength: 0)
        }
        .presentationDetents([.height(260)])
        .presentationDragIndicator(.hidden)
    }
}

/// Where the relay is, and what the audio route turned out to be — the two facts
/// that explain a session which will not start or cannot hear. Off the home screen
/// because you set them once.
struct ServerView: View {
    @Binding var serverURL: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ws://host:8765", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .accessibilityLabel("Server URL")
                } footer: {
                    Text("The simulator reaches the Mac on localhost; a physical iPhone needs its address on the network.")
                }
                Section("Audio route") {
                    Text(AudioPipe.route)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("route")
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

#Preview {
    ContentView()
}
