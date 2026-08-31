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
    /// The three choices, each stored as the string the relay speaks in and read back as
    /// its own type below. The phone decides all three and the relay obeys — but `mode`
    /// travels in the URL and the other two as a message, because the relay can put
    /// those on the session it already has running and so they can change
    /// mid-conversation.
    @AppStorage("mode") private var modeName = Mode.direct.rawValue
    @AppStorage("model") private var model = "default"
    @AppStorage("permission") private var permissionName = Permission.plan.rawValue
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
    /// How tall the composer is right now — see `ComposerHeight`.
    @State private var composerHeight: CGFloat = 0

    private var live: Bool { session.status != .idle }
    /// The stored strings as what they mean. A value from a version that named things
    /// differently falls back rather than crashing.
    private var mode: Mode { Mode(rawValue: modeName) ?? .direct }
    private var permission: Permission { Permission(rawValue: permissionName) ?? .plan }

    /// One exclusive mode, plus auto-correct as an independent axis. Which chat is
    /// being carried on is the session's own business — it appends `resume` itself, so
    /// a turn typed after one spoken lands in the same conversation.
    private var url: URL? {
        URL(string: serverURL + "?mode=\(mode.rawValue)" + (autocorrect ? "&correct=1" : ""))
    }

    var body: some View {
        // Two layers, and which one a thing belongs to is the whole of the layout: the
        // conversation runs edge to edge and scrolls the full height of the screen, and
        // everything you press floats over it in glass. Nothing takes a strip away.
        ZStack {
            conversation
            chrome
        }
        .background(Brand.background.ignoresSafeArea())
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
        // Every sheet stands on the same ground as the screen behind it, which is the
        // one place to say so — the lists inside only have to stop painting their own.
        .sheet(item: $sheet) { which in
            Group {
                switch which {
                case .prompts: PromptsView(serverURL: serverURL)
                case .corrections(let seed): CorrectionsView(serverURL: serverURL, seed: seed)
                case .server: ServerView(serverURL: $serverURL)
                case .mode: ChoiceSheet(title: "Mode", choices: Mode.choices, picked: $modeName)
                case .permission: ChoiceSheet(title: "What Claude may do", choices: Permission.choices, picked: $permissionName)
                // The only list the phone does not know by heart: which models this Mac
                // can offer is the relay's to say, so the rows come down the socket.
                case .model:
                    ChoiceSheet(
                        title: "Model",
                        choices: relay.models.map { Choice(id: $0.value, title: $0.displayName, detail: $0.description) },
                        picked: $model,
                        loading: relay.models.isEmpty,
                    )
                }
            }
            .presentationBackground(Brand.background)
        }
        // The keyboard belongs to the composer, so whatever takes over from it takes
        // the keyboard too. One rule, rather than a dismissal at every door.
        .onChange(of: elsewhere) { if elsewhere { typing = false } }
        // How far the transcript has to stop short of the composer. Measured rather
        // than guessed, because the composer grows with what you type.
        .onPreferenceChange(ComposerHeight.self) { composerHeight = $0 }
        // The one place that tells the session what Claude should be — on arrival, and
        // again on every change. The session carries it to the socket it has open and to
        // every socket it opens after, so talking and typing never disagree about it.
        .task(id: "\(model)|\(permissionName)") { session.use(model: model, permission: permissionName) }
        // Which models exist is the relay's to say, and the capsule needs the answer
        // before any sheet is opened. Connecting twice is a no-op — forking shares this
        // store.
        .onAppear { relay.connect(to: serverURL) }
    }

    /// What the app is. Full bleed, and the only thing under the chrome.
    private var conversation: some View {
        // Anywhere that is not the composer is somewhere to put the keyboard away.
        Group {
            if session.lines.isEmpty { blank } else { transcript }
        }
        .contentShape(Rectangle())
        .onTapGesture { typing = false }
    }

    /// What floats over it. The spacer between draws nothing, so a tap in the middle of
    /// the screen reaches the conversation rather than this layer.
    private var chrome: some View {
        VStack(spacing: 8) {
            header
            Spacer(minLength: 0)
            if let error = session.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
                    .accessibilityIdentifier("error")
            }
            composer
                .background {
                    GeometryReader { box in
                        Color.clear.preference(key: ComposerHeight.self, value: box.size.height)
                    }
                }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// Something other than the composer has the screen: the drawer, a sheet, or a
    /// session that is listening.
    private var elsewhere: Bool { drawer || sheet != nil || live }

    /// Which sheet is up. `corrections` carries the one to open on, so a line you want
    /// fixed and the Corrections menu item land on the same screen — one editor, two
    /// doors, and nothing to keep in step.
    private enum Sheet: Identifiable {
        case prompts, corrections(Correction?), server, mode, model, permission
        var id: String {
            switch self {
            case .prompts: return "prompts"
            case .corrections: return "corrections"
            case .server: return "server"
            case .mode: return "mode"
            case .model: return "model"
            case .permission: return "permission"
            }
        }
    }

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
    ///
    /// All three float over the transcript, so all three are glass: over moving text a
    /// bare glyph is unreadable half the time, and a bar drawn behind them would take
    /// the room the conversation is using.
    private var header: some View {
        ZStack {
            if let chat {
                Text(chat.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .floating(in: Capsule())
                    .padding(.horizontal, 52) // clear of the two circles, either side
                    .accessibilityIdentifier("chat-title")
            }
            HStack {
                Button { drawer = true } label: {
                    Image(systemName: "line.3.horizontal").font(.title3).slot(.glass)
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
            // Held for review, and the audio it was heard from: play it and the text
            // below stops being a guess. Inline rather than a sheet — mid-hold you are
            // deciding whether to *run* something, and nothing modal belongs between
            // you and that.
            if held != nil, let clip = session.heardClip {
                // The spacer, not a frame on the chip: a capsule you can miss by
                // aiming at it is worse than a small one, and a full-width button
                // around a small glyph is exactly that.
                HStack {
                    ClipChip(clip: clip, serverURL: serverURL)
                    Spacer()
                }
            }
            ZStack(alignment: .topLeading) {
                TextField("Message", text: text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .italic(hearing)
                    .foregroundStyle(hearing ? Brand.secondaryText : Brand.text)
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
        .floating(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        // Listening, the box is the only live thing on the screen, and its edge says
        // so — in the accent, which is where the orange goes once it has left the
        // microphone. Nothing else changes, because nothing else has to.
        // Orange means live *and hearing*. Muted, the edge stays drawn — the session is
        // still up — but in the border grey, and the orange moves to the mute button.
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(live ? (session.muted ? Brand.border : Brand.accent) : .clear, lineWidth: 2)
        }
        .animation(.easeOut(duration: 0.2), value: live)
        .animation(.easeOut(duration: 0.2), value: session.muted)
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
            HStack(spacing: 8) {
                // Left of the microphone is what Claude is, and it stays through a live
                // session: the relay puts both on the session already running, so they
                // are things you can change mid-conversation rather than things you
                // settle beforehand.
                capsule(modelLabel) { sheet = .model }
                    .accessibilityIdentifier("model")
                    .accessibilityLabel("Model")
                    .accessibilityValue(modelLabel)
                capsule(permission.short) { sheet = .permission }
                    .accessibilityIdentifier("permission")
                    .accessibilityLabel("What Claude may do")
                    .accessibilityValue(permission.title)
                Spacer()
                // Right of it is the session: how it will run, until it is running, and
                // then how to quieten it or end it.
                if live {
                    // Mute lit on the accent when it is on: the orange has left the
                    // border and the bars, and this is where it went. Same order as the
                    // lock-screen card, so the thumb learns one layout.
                    glyph("mic.slash", accent: session.muted) { session.toggleMute() }
                        .accessibilityIdentifier("mute")
                        .accessibilityLabel(session.muted ? "Unmute" : "Mute")
                    glyph("xmark", accent: false) { session.stop() }
                        .accessibilityIdentifier("end")
                        .accessibilityLabel("Stop listening")
                } else {
                    // Bound at connect time on the relay, so it is settled before a
                    // session starts and cannot change under one — which is why this one
                    // goes away while live and the two on the left do not. It opens a
                    // sheet rather than toggling silently: which mode you are in decides
                    // whether what you say runs immediately, so it is worth naming.
                    capsule(mode.title) { sheet = .mode }
                        .accessibilityIdentifier("mode")
                        .accessibilityLabel("Mode")
                        .accessibilityValue(mode.title)
                }
            }
        }
    }

    /// What the model capsule says: the model that will actually answer, in one word —
    /// so choosing "Default (recommended)" reads as "Opus" rather than as "Default",
    /// which names an alias and not a model. The stored value until the list arrives,
    /// because the capsule has to say something before the first data connection answers.
    private var modelLabel: String {
        relay.models.first { $0.value == model }?.shortName ?? (model.isEmpty ? "Model" : model)
    }

    /// A word you can press. Every choice in the bar wears this one face, so which of
    /// them you are looking at is the word rather than the shape.
    private func capsule(_ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Brand.secondaryText)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Brand.fill, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    /// One of the control's other faces — the same circle the microphone wears, with a
    /// glyph in it instead of your voice.
    private func glyph(_ symbol: String, accent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                // On the accent it is the ground colour, not white — the same pairing
                // the web app's primary button makes: orange-400 under grey-900.
                .foregroundStyle(accent ? Brand.background : Brand.text)
                .slot(accent ? .accent : .plain)
        }
        .buttonStyle(.plain)
    }

    private var settings: some View {
        Menu {
            Button { sheet = .prompts } label: { Label("Prompts", systemImage: "text.bubble") }
            Button { sheet = .corrections(nil) } label: { Label("Corrections", systemImage: "text.badge.checkmark") }
            Toggle(isOn: $autocorrect) { Label("Auto-correct", systemImage: "wand.and.stars") }
                .disabled(live)
            Divider()
            Button { sheet = .server } label: { Label("Server", systemImage: "network") }
        } label: {
            Image(systemName: "gearshape").font(.title3).slot(.glass)
        }
        .accessibilityIdentifier("settings")
        .accessibilityLabel("Settings")
    }

    // MARK: - Messages

    /// Nothing said yet, so the screen is the mark and the name.
    ///
    /// No instructions: the microphone is the only thing lit on the screen and the field
    /// says "Message", which is the whole of "tap to talk, or type" without a sentence
    /// asking to be read. The one link in the app is here, because who made this is
    /// worth a tap exactly when there is nothing else to do.
    private var blank: some View {
        VStack(spacing: 14) {
            Image("Logo")
                .resizable()
                .scaledToFit()
                .frame(width: 76)
                .accessibilityHidden(true)
            VStack(spacing: 2) {
                Text("Duck Talk").font(.title3.weight(.medium))
                Link(destination: URL(string: "https://reduck.ai")!) {
                    Text("by ").foregroundStyle(Brand.tertiaryText)
                        + Text("Reduck").foregroundStyle(Brand.accent)
                }
                .font(.subheadline)
                .accessibilityLabel("Reduck")
            }
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
            .padding(.horizontal, 16)
            // The stack is upside down, so its top edge is the bottom of the screen:
            // this is the room the composer floats in, and the bottom padding is the
            // header's. Both are room the conversation can still scroll through.
            .padding(.top, composerHeight + 16)
            .padding(.bottom, Self.headerHeight)
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
                .foregroundStyle(Brand.tertiaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                // What you said wears a surface; what Claude said does not. That
                // alternation is what makes a long transcript scannable — the eye finds
                // the turns without reading them, so neither side needs a name on it.
                // The bubble hugs its own text, which is why the width comes after it.
                Text(line.text)
                    .foregroundStyle(Brand.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Brand.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                actions(line)
            }
        case .model:
            VStack(alignment: .leading, spacing: 6) {
                Text(line.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                actions(line)
            }
        }
    }

    /// What you can do to a message, under every one of them. Small and tertiary: they
    /// are always there, so they must never compete with the words.
    ///
    /// **Never label these with words.** A glyph in a transcript is read every time the
    /// eye passes the row, and a word beside it earns its width once and costs it
    /// forever — the row stops being a margin and becomes a second thing to read. The
    /// word belongs in `accessibilityLabel`, where it is said only to someone who
    /// asked. This is the rule for every icon under a message, not just these three.
    ///
    /// One row, and what is in it follows from the line: the only thing to do with
    /// what you said is fix what was misheard, and the things to do with an answer are
    /// branch from it or take its text.
    private func actions(_ line: VoiceSession.Line) -> some View {
        HStack(spacing: 18) {
            // Only a line that was heard has audio, so this is also what says the line
            // is yours. Direct mode runs what it heard before you can stop it, which
            // makes this the only door to a correction that Review was not on for.
            if let clip = line.clip {
                Button {
                    sheet = .corrections(Correction(at: Date().timeIntervalSince1970 * 1000,
                                                    heard: line.text, meant: line.text, clip: clip))
                } label: {
                    Image(systemName: "pencil")
                }
                .accessibilityIdentifier("fix")
                .accessibilityLabel("Fix what was heard")
            }
            if line.kind == .model {
                // A reply just spoken is not on disk yet, so there is nothing to
                // branch from — which is why this is not the same condition as copy.
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
        }
        .font(.footnote)
        .foregroundStyle(Brand.tertiaryText)
        .buttonStyle(.plain)
    }
}

extension ContentView {
    /// The room the floating header needs. Fixed, because it is one row of circles.
    static let headerHeight: CGFloat = 46
}

/// How tall the composer is, from the composer itself.
///
/// The transcript scrolls underneath it, so this is not layout — it is how far the
/// transcript's own content stops short, which is the difference between the newest
/// message sitting just above the composer and being hidden behind it. It has to be
/// measured because the composer grows to six lines as you type.
///
/// `max` rather than last-wins: every other view in the screen reports the default of
/// zero, and the fold sees all of them — taking the last one read the composer as
/// nothing at all, and the transcript ran under it.
private struct ComposerHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Where the relay is, and whether it answers — the two facts that explain a session
/// which will not start. Off the home screen because you set them once.
///
/// The address is checked as you type, not when you press Listen. A relay that is not
/// there fails in the same place you typed the address, with the field still under
/// your thumb — rather than a screen later, or worse, a reply from yesterday's relay
/// about some other folder. Where the address comes from is the relay's own startup
/// lines: it is the one process that knows every way it can be reached.
struct ServerView: View {
    @Binding var serverURL: String
    @Environment(\.dismiss) private var dismiss
    @State private var probe = Probe.idle

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ws://host:8765", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .accessibilityLabel("Server URL")
                    Label(probe.text, systemImage: probe.symbol)
                        .font(.footnote)
                        .foregroundStyle(probe.color)
                        .accessibilityIdentifier("reach")
                } footer: {
                    Text("Copy one of the addresses the relay prints when it starts: `localhost` for the simulator, your Mac\u{2019}s Wi-Fi address for a phone on the same network, or its `wss://\u{2026}ts.net` name to reach it from anywhere, cellular included.")
                }
                Section("Audio route") {
                    Text(AudioPipe.route)
                        .font(.caption.monospaced())
                        .foregroundStyle(Brand.secondaryText)
                        .accessibilityIdentifier("route")
                }
            }
            .brandList()
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            // Checked on arrival and on every edit, half a second after the last
            // keystroke so a URL being typed is not dialled once per character.
            .task(id: serverURL) {
                probe = .checking
                try? await Task.sleep(for: .milliseconds(500))
                guard !Task.isCancelled else { return }
                probe = await Probe.dial(serverURL)
            }
        }
    }

    /// One WebSocket opened and closed: the cheapest question the relay can answer.
    enum Probe {
        case idle, checking, reachable, unreachable(String)

        static func dial(_ text: String) async -> Probe {
            guard let url = URL(string: text), let scheme = url.scheme, ["ws", "wss"].contains(scheme), url.host != nil else {
                return .unreachable("Needs a ws:// or wss:// address")
            }
            let task = URLSession.shared.webSocketTask(with: url)
            task.resume()
            defer { task.cancel(with: .normalClosure, reason: nil) }
            do {
                // A ping is answered only once the handshake is complete, so it is the
                // proof of a relay and not just of a host that accepted the TCP connection.
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                    task.sendPing { error in error.map { c.resume(throwing: $0) } ?? c.resume() }
                }
                return .reachable
            } catch {
                return .unreachable(error.localizedDescription)
            }
        }

        var text: String {
            switch self {
            case .idle: return " "
            case .checking: return "Checking\u{2026}"
            case .reachable: return "Reachable"
            case .unreachable(let why): return why
            }
        }
        var symbol: String {
            switch self {
            case .idle, .checking: return "circle.dotted"
            case .reachable: return "checkmark.circle.fill"
            case .unreachable: return "xmark.circle.fill"
            }
        }
        var color: Color {
            switch self {
            case .idle, .checking: return Brand.secondaryText
            case .reachable: return .green
            case .unreachable: return .red
            }
        }
    }
}

#Preview {
    ContentView()
}
