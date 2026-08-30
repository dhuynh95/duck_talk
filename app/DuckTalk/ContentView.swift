import SwiftUI

/// The home screen, which is the conversation plus one box to add to it:
///
///   messages   what was actually sent and what came back, and nothing else
///   composer   the field — written by you, by the ears, or by the relay when it holds
///              an instruction for review — and under it the one control: a microphone
///              to start talking, your voice while you are, an arrow to send what is in
///              the field, a stop while a typed reply arrives.
///
/// Reviewing is not a second panel and Accept is not a second button: what was heard
/// lands in the same field, and the same arrow sends it, edited or not. An edit is what
/// teaches the relay; ignoring it is how you drop it.
///
/// Talking and typing are exclusive, and the field says so without a word: while the
/// ears are writing it, it is not editable, and touching it stops the session and gives
/// you the keyboard. That is the whole of the mode switch.
///
/// Everything that configures the thing rather than being the conversation lives
/// behind the gear.
struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "ws://localhost:8765"
    @AppStorage("mode") private var mode = Mode.direct
    @AppStorage("autocorrect") private var autocorrect = false
    private let session = VoiceSession.shared
    @State private var draft = ""
    /// The instruction the relay is holding for review, as you may have edited it.
    /// Separate from `draft`, because one is a question put to you and the other is
    /// what you are writing — and nil is how the field knows which it is showing.
    @State private var held: String?
    @FocusState private var typing: Bool
    @State private var sheet: Sheet?
    @State private var drawer = false
    /// The home screen's own connection to the relay, for forking a chat. Not the
    /// drawer's: the drawer is gone from the screen by the time you fork.
    @State private var relay = RelayStore()
    /// The chat on screen, or nil for a new one. Everything about resuming is derived
    /// from this — the title in the header, and whether the session carries `resume`.
    @State private var chat: Chat?

    private var live: Bool { session.status != .idle }

    /// One exclusive mode, plus auto-correct as an independent axis. Which chat is
    /// being carried on is the session's own business — it appends `resume` itself, so
    /// a turn typed after one spoken lands in the same conversation.
    private var url: URL? {
        URL(string: serverURL + "?mode=\(mode.rawValue)" + (autocorrect ? "&correct=1" : ""))
    }

    var body: some View {
        VStack(spacing: 12) {
            header

            // Anywhere that is not the composer is somewhere to put the keyboard away.
            Group {
                if session.lines.isEmpty { blank } else { transcript }
            }
            .contentShape(Rectangle())
            .onTapGesture { typing = false }

            if let error = session.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("error")
            }

            composer
        }
        .padding()
        .overlay {
            ChatsDrawer(
                serverURL: serverURL,
                open: $drawer,
                current: chat,
                onOpen: { opened, messages in
                    // Loading a chat is not starting one: the transcript appears, and
                    // whatever you do next — talk or type — carries it on.
                    chat = opened
                    session.show(messages, id: opened.id)
                },
                onNew: {
                    chat = nil
                    session.show([], id: nil)
                },
            )
        }
        // The fork comes back as a chat, already loaded — the same arrival the drawer
        // waits on, so switching to it is the same code.
        .onChange(of: relay.loaded) {
            guard relay.wasForked, let id = relay.loaded else { return }
            chat = relay.chats.first { $0.id == id }
            session.show(relay.messages, id: id)
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .prompts: PromptsView(serverURL: serverURL)
            case .corrections: CorrectionsView(serverURL: serverURL)
            case .server: ServerView(serverURL: $serverURL)
            case .mode: ModeSheet(mode: $mode)
            }
        }
        // The keyboard belongs to the composer, so whatever takes over from it takes
        // the keyboard too. One rule, rather than a dismissal at every door.
        .onChange(of: elsewhere) { if elsewhere { typing = false } }
    }

    /// Something other than the composer has the screen: the drawer, a sheet, or a
    /// session that is listening.
    private var elsewhere: Bool { drawer || sheet != nil || live }

    private enum Sheet: String, Identifiable { case prompts, corrections, server, mode; var id: String { rawValue } }

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

    // MARK: - Composer

    /// The field, and under it the one control. Which face each of them wears follows
    /// from a single question — what are you about to do — so they can never disagree.
    ///
    /// Live, the field is not yours to type in, and tapping it is how you stop
    /// listening and start typing. The exception is an instruction held for review:
    /// that one is yours to fix, and fixing it is how the relay learns what you said.
    private var composer: some View {
        VStack(spacing: 10) {
            // One field, three writers: you, the ears, and the relay when it holds an
            // instruction back for you to look at. What is being said is not history
            // until it has been sent, so this is where it lives until then.
            ZStack(alignment: .topLeading) {
                TextField("Message", text: text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .italic(hearing)
                    .foregroundStyle(hearing ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    // Never "corrected" while reviewing — iOS autocorrect rewrites the
                    // very words you are there to fix.
                    .autocorrectionDisabled(held != nil)
                    .textInputAutocapitalization(held != nil ? .never : .sentences)
                    .focused($typing)
                    .disabled(hearing)
                    .accessibilityIdentifier("message")
                    .accessibilityLabel(held != nil ? "Instruction" : "Message")
                // Reaching for the keyboard is how you say you would rather type, so it
                // is also how you stop listening. A sibling of the field rather than a
                // layer on it, because `disabled` reaches everything inside.
                if hearing {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture {
                            session.stop()
                            // The field is still disabled this turn of the run loop,
                            // and a disabled field cannot take focus — so ask on the
                            // next one, once stopping has been drawn.
                            Task { typing = true }
                        }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            controls
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        // Listening, the box is the only live thing on the screen, and its edge says
        // so. Nothing else changes, because nothing else has to.
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Color.primary.opacity(live ? 0.85 : 0), lineWidth: 2)
        }
        .animation(.easeOut(duration: 0.2), value: live)
        .onChange(of: session.pending) { held = session.pending }
    }

    /// What pressing the middle button does. The field's contents follow from the same
    /// answer, which is why there is one of these and not two.
    private enum Intent { case talk, send, stop }

    private var intent: Intent {
        if held != nil || (!live && !draft.isEmpty) { return .send }
        if session.asking { return .stop }
        return .talk
    }

    /// The ears are writing the field: it is not yours until they are done, or until
    /// the relay hands you what it heard to look at.
    private var hearing: Bool { live && held == nil }

    /// What the field shows, and who may change it.
    private var text: Binding<String> {
        if held != nil { return Binding(get: { held ?? "" }, set: { held = $0 }) }
        if live { return .constant(session.utterance ?? "") }
        return $draft
    }

    /// Send what is in the field. A held instruction you edited is also the only
    /// evidence of what you actually said, so sending it teaches the relay.
    private func send() {
        if let instruction = held {
            session.approve(instruction)
            held = nil
        } else if let url {
            session.ask(draft, url: url)
            draft = ""
        }
    }

    /// The one control is centred on the screen, not in the row: the mode and the way
    /// out sit beside it without moving it, so it never shifts under your thumb.
    private var controls: some View {
        ZStack {
            switch intent {
            case .send:
                glyph("arrow.up", accent: true) { send() }
                    .accessibilityIdentifier("send")
                    // The same act either way, and the label says which one it is here.
                    .accessibilityLabel(held != nil ? "Accept" : "Send")
            case .stop:
                glyph("stop.fill", accent: false) { session.cancelAsk() }
                    .accessibilityIdentifier("stop-reply")
                    .accessibilityLabel("Stop")
            case .talk:
                ListenButton(live: live, level: CGFloat(session.level), status: session.status.rawValue) {
                    if let url { session.connect(url: url) }
                }
            }
            HStack {
                Spacer()
                if live {
                    glyph("xmark", accent: false) { session.stop() }
                        .accessibilityIdentifier("end")
                        .accessibilityLabel("Stop listening")
                } else {
                    // Bound at connect time on the relay, so it is settled before a
                    // session starts and cannot change under one. It opens a sheet
                    // rather than toggling silently: which mode you are in decides
                    // whether what you say runs immediately, so it is worth naming —
                    // and a name is all it is, because an icon for it would be one
                    // nobody could read without being told.
                    Button { sheet = .mode } label: {
                        Text(mode.title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color(.tertiarySystemFill), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("mode")
                    .accessibilityLabel("Mode")
                    .accessibilityValue(mode.title)
                }
            }
        }
    }

    /// One of the control's other faces — the same circle the microphone wears, with a
    /// glyph in it instead of your voice.
    private func glyph(_ symbol: String, accent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(accent ? AnyShapeStyle(Color.white) : AnyShapeStyle(.primary))
                .slot(accent ? .accent : .plain)
        }
        .buttonStyle(.plain)
    }

    private var settings: some View {
        Menu {
            Button { sheet = .prompts } label: { Label("Prompts", systemImage: "text.bubble") }
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

    // MARK: - Messages

    /// Nothing said yet. The screen is the conversation, so an empty one should say
    /// what to do rather than be blank.
    private var blank: some View {
        VStack(spacing: 6) {
            Text("Duck Talk").font(.title2.weight(.semibold))
            Text("Tap to talk, or type").font(.callout).foregroundStyle(.secondary)
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
        .scrollDismissesKeyboard(.interactively)
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
