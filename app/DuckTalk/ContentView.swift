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
    private let session = VoiceSession.shared
    @State private var draft = ""
    @State private var sheet: Sheet?
    @State private var drawer = false
    /// The home screen's own connection to the relay, for forking a chat. Not the
    /// drawer's: the drawer is gone from the screen by the time you fork.
    @State private var relay = RelayStore()
    /// The chat on screen, or nil for a new one. Everything about resuming is derived
    /// from this — the title in the header, and whether the session carries `resume`.
    @State private var chat: Chat?

    private var live: Bool { session.status != .idle }

    /// One exclusive mode, plus auto-correct as an independent axis, plus the chat
    /// being carried on if one was opened.
    private var url: URL? {
        URL(string: serverURL + "?mode=\(mode.rawValue)"
            + (autocorrect ? "&correct=1" : "")
            + (chat.map { "&resume=\($0.id)" } ?? ""))
    }

    var body: some View {
        VStack(spacing: 12) {
            header

            if session.lines.isEmpty { blank } else { transcript }

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
        .overlay {
            ChatsDrawer(
                serverURL: serverURL,
                open: $drawer,
                current: chat,
                onOpen: { opened, messages in
                    // Loading a chat is not starting one: the transcript appears, and
                    // the listen button is now the resume button.
                    chat = opened
                    session.show(messages)
                },
                onNew: {
                    chat = nil
                    session.show([])
                },
            )
        }
        // The fork comes back as a chat, already loaded — the same arrival the drawer
        // waits on, so switching to it is the same code.
        .onChange(of: relay.loaded) {
            guard relay.wasForked, let id = relay.loaded else { return }
            chat = relay.chats.first { $0.id == id }
            session.show(relay.messages)
        }
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

    /// Branch the conversation at this answer and land on the result.
    ///
    /// A session is stopped first, never left running beside the new chat: there is
    /// one session, and it belongs to whatever is on screen. What is left is the fork,
    /// idle — so the listen button starts it, exactly as opening a chat does.
    private func forkFrom(_ line: VoiceSession.Line) {
        guard let source = chat, let at = line.uuid else { return }
        if live { session.stop() }
        relay.connect(to: serverURL)
        relay.fork(source.id, at: at)
    }

    // MARK: - Header

    /// The chats on the left, what configures the app on the right, and between them
    /// the name of the conversation you are in — blank when it is a new one, because
    /// a chat has no name until it has been had.
    private var header: some View {
        ZStack {
            if let chat {
                Text(chat.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .padding(.horizontal, 44)
                    .accessibilityIdentifier("chat-title")
            }
            HStack {
                Button { drawer = true } label: {
                    Image(systemName: "line.3.horizontal").font(.title3)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chats")
                .accessibilityLabel("Chats")
                Spacer()
                settings
            }
        }
    }

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

    /// Nothing said yet. The screen is the conversation, so an empty one should say
    /// what to do rather than be blank.
    private var blank: some View {
        VStack(spacing: 6) {
            Text("Duck Talk").font(.title2.weight(.semibold))
            Text("Tap to start talking").font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The conversation, drawn from its end.
    ///
    /// The newest message sits at scroll offset zero, because the stack is upside down
    /// and every row is turned back the right way. That is the invariant the rest of
    /// this used to fight: the end of a transcript is where you always start, and at
    /// offset zero there is nothing above to measure.
    ///
    /// Asking instead to scroll to the last row means measuring every row above it, and
    /// a lazy stack does not know their heights until it builds them — so it guesses,
    /// corrects, and moves the target it was aiming at. At 180 messages that lands
    /// short; at 235 it thrashes and the view stops responding. Nothing here scrolls
    /// anywhere, so there is nothing to land short of, and a reply arriving grows the
    /// stack at offset zero, which is already where you are looking.
    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(session.lines.reversed()) { line in
                    row(line).scaleEffect(x: 1, y: -1)
                }
            }
            .padding(.vertical, 4)
        }
        .scaleEffect(x: 1, y: -1)
        // It would run backwards, being drawn in a flipped view.
        .scrollIndicators(.hidden)
        .frame(maxHeight: .infinity)
    }

    /// One line of the transcript: what you said, what Claude said, or the tools it
    /// used in between.
    @ViewBuilder
    private func row(_ line: VoiceSession.Line) -> some View {
        switch line.kind {
        case .tools:
            Text(line.toolLabel)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .user:
            Text(line.text)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .foregroundStyle(.secondary)
        case .model:
            VStack(alignment: .leading, spacing: 6) {
                Text(line.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                actions(line)
            }
        }
    }

    /// The two things you can do to an answer, under every one of them. Small and
    /// tertiary: they are always there, so they must never compete with the words.
    ///
    /// Fork only appears on a line that exists in the stored conversation — a reply
    /// just spoken is not on disk yet, so there is nothing to branch from. Copy always
    /// works, which is why they are not the same condition.
    private func actions(_ line: VoiceSession.Line) -> some View {
        HStack(spacing: 18) {
            if line.uuid != nil {
                Button { forkFrom(line) } label: {
                    Image(systemName: "arrow.branch")
                }
                .accessibilityIdentifier("fork")
                .accessibilityLabel("Fork from here")
            }
            Button { UIPasteboard.general.string = line.text } label: {
                Image(systemName: "doc.on.doc")
            }
            .accessibilityLabel("Copy")
        }
        .font(.footnote)
        .foregroundStyle(.tertiary)
        .buttonStyle(.plain)
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
