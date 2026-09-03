import SwiftUI

/// One thing the ears keep getting wrong, and what was actually said.
///
/// `clip` is the utterance it was taught from, which the relay keeps as a file and
/// `ClipChip` plays. One made by hand has none, and so does one whose audio has aged
/// out — the pair is the correction, the sound is the evidence for it.
struct Correction: Identifiable, Codable, Hashable {
    let at: Double
    var heard: String
    var meant: String
    var clip: Double?

    var id: Double { at }
}

/// The settings screens' connection to the relay.
///
/// The relay owns the files; this holds nothing of its own between visits, and every
/// message it sends is answered with all of the state, so what is on screen is what
/// is on disk. `?data=1` opens neither Gemini nor Claude, so this costs nothing to
/// open whether or not a voice session is running.
@Observable
@MainActor
final class RelayStore {
    private(set) var items: [Correction] = []
    /// What the relay says to each model, described by the relay itself.
    private(set) var prompts: [Prompt] = []
    /// Which models this Mac can offer. Asked of Claude Code rather than written into
    /// the app, so a model added to your account appears here with nothing to change.
    private(set) var models: [ClaudeModel] = []
    /// The project's skills, for the composer's "/" autocomplete. Asked of Claude Code
    /// like the models, and filtered on the phone as you type.
    private(set) var skills: [SkillInfo] = []
    /// Every conversation Claude Code has in this project, newest first.
    private(set) var chats: [Chat] = []
    /// The one chat asked for by `openChat`, and which one it was — the messages are
    /// the only thing here big enough to be worth asking for rather than always sent.
    private(set) var messages: [ChatMessage] = []
    private(set) var loaded: String?
    /// True when `loaded` is a chat that was just branched off another, rather than
    /// one that was opened. The home screen switches to it either way; this is only
    /// how it knows a fork succeeded.
    private(set) var wasForked = false
    private(set) var error: String?
    /// A relay is answering right now. True once a frame comes back — which is proof of
    /// a relay, where an opened socket is only proof of something accepting TCP — and
    /// false the moment the connection drops. The home screen draws its status from this.
    private(set) var connected = false

    private var task: URLSessionWebSocketTask?
    /// The address someone wants held. It outlives any one socket, so it is what the
    /// loop below runs on, and nil is the only thing that stops it.
    private var wanted: String?

    /// Hold a data socket to `serverURL` for as long as someone wants one.
    ///
    /// The same shape as `VoiceSession.run`, for the same reason: a relay that is not up
    /// yet, a Mac that slept, or an address just corrected should cost a reconnect and
    /// not a screen that stays empty for the life of the app. Before, the first failure
    /// left `task` set and every later `connect` guarded itself out — the model capsule
    /// never filled in, and nothing said why.
    ///
    /// Asking for the address already held does nothing; asking for a different one
    /// re-aims the loop, so editing the server address is the whole of reconnecting.
    func connect(to serverURL: String) {
        guard wanted != serverURL else { return }
        wanted = serverURL
        // Nothing has answered at the new address yet, and the old answer is not evidence
        // about it — so the pill and the Server sheet go back to not knowing until a frame
        // comes back, rather than calling a fresh address reachable on the last one's word.
        connected = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        Task { await hold(serverURL) }
    }

    func disconnect() {
        wanted = nil
        connected = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func hold(_ serverURL: String) async {
        guard let url = Relay.url(serverURL, query: "?data=1") else {
            error = Relay.badAddress
            return
        }
        var backoff: Duration = .milliseconds(250)
        while wanted == serverURL {
            let task = URLSession.shared.webSocketTask(with: url)
            self.task = task
            task.resume()
            send(["type": "read"])  // anything is answered with all of it
            let openedAt = ContinuousClock.now
            do {
                while wanted == serverURL {
                    if case .string(let json) = try await task.receive() { receive(json) }
                }
            } catch let failure {
                if wanted == serverURL { error = failure.localizedDescription }
            }
            task.cancel(with: .normalClosure, reason: nil)
            connected = false
            guard wanted == serverURL else { break }
            // A connection that lasted is not a failing one; only a fast drop backs off.
            if openedAt.duration(to: .now) > .seconds(5) { backoff = .milliseconds(250) }
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, .seconds(5))
        }
    }

    func save(_ correction: Correction) {
        var msg: [String: Any] = ["type": "correction_save", "at": correction.at, "heard": correction.heard, "meant": correction.meant]
        if let clip = correction.clip { msg["clip"] = clip }
        send(msg)
    }

    func delete(_ correction: Correction) {
        send(["type": "correction_delete", "at": correction.at])
    }

    func savePrompt(_ name: String, _ text: String) {
        send(["type": "prompt_save", "name": name, "text": text])
    }

    func openChat(_ id: String) {
        send(["type": "chat_open", "id": id])
    }

    /// Branch `id` at one of its messages. The answer is the new chat, already loaded.
    func fork(_ id: String, at uuid: String) {
        send(["type": "fork", "id": id, "at": uuid])
    }

    /// The three things you can do to a chat without opening it. Each is answered with
    /// the whole list again, in its new order — so nothing here has to remember what it
    /// just did, or undo it when the relay disagrees.
    func star(_ id: String, _ on: Bool) {
        send(["type": "chat_star", "id": id, "starred": on])
    }

    func rename(_ id: String, to title: String) {
        send(["type": "chat_rename", "id": id, "text": title])
    }

    func delete(_ id: String) {
        send(["type": "chat_delete", "id": id])
    }

    private struct State: Decodable {
        let type: String
        let items: [Correction]?
        let prompts: [Prompt]?
        let models: [ClaudeModel]?
        let skills: [SkillInfo]?
        let chats: [Chat]?
        let id: String?
        let messages: [ChatMessage]?
        let forked: Bool?
    }

    private func receive(_ json: String) {
        guard let data = json.data(using: .utf8),
              let state = try? JSONDecoder().decode(State.self, from: data) else { return }
        if let items = state.items { self.items = items.reversed() }  // newest first
        if let prompts = state.prompts { self.prompts = prompts }
        if let models = state.models { self.models = models }
        if let skills = state.skills { self.skills = skills }
        if let chats = state.chats { self.chats = chats }  // already newest first
        if let messages = state.messages {
            self.messages = messages
            wasForked = state.forked ?? false
            loaded = state.id
        }
        error = nil
        connected = true  // a frame came back, so there is a relay there
    }

    private func send(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(json)) { _ in }
    }
}

/// What the ears keep mishearing, and what you actually said. Swipe to delete, tap to
/// edit, `+` to add one by hand.
struct CorrectionsView: View {
    let serverURL: String
    /// A correction to open straight into, rather than the list — how "fix" on a
    /// misheard line in the transcript arrives here. The same screen either way: a
    /// correction is a correction, wherever you noticed you needed one.
    var seed: Correction?
    @State private var store = RelayStore()
    @State private var path: [Correction] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if store.items.isEmpty { empty } else { list }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Brand.background)
            .navigationTitle("Corrections")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { path.append(blank()) } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add correction")
                }
            }
            .navigationDestination(for: Correction.self) { correction in
                CorrectionDetail(
                    correction: correction,
                    serverURL: serverURL,
                    isNew: !store.items.contains { $0.id == correction.id },
                    onSave: { edited in store.save(edited); path.removeLast() },
                    onDelete: { store.delete(correction); path.removeLast() },
                )
            }
        }
        .onAppear {
            store.connect(to: serverURL)
            if let seed, path.isEmpty { path.append(seed) }
        }
        .onDisappear { store.disconnect() }
    }

    private var list: some View {
        List {
            Section {
                ForEach(store.items) { correction in
                    NavigationLink(value: correction) { row(correction) }
                }
                .onDelete { offsets in offsets.map { store.items[$0] }.forEach(store.delete) }
            } footer: {
                Text("Used to bias the recogniser when a session starts, and to auto-correct what you said.")
            }
        }
        .brandList()
    }

    private func row(_ correction: Correction) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                // Only a mark that there is something to hear — playing it is what
                // opening the row is for.
                if correction.clip != nil {
                    Image(systemName: "waveform")
                        .font(.caption2)
                        .foregroundStyle(Brand.tertiaryText)
                }
                Text(correction.heard)
                    .font(.callout)
                    .foregroundStyle(Brand.secondaryText)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(Brand.tertiaryText)
                Text(correction.meant).font(.callout)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Text("Nothing learned yet.")
                .font(.headline)
            Text("Turn on Review, and when the ears mishear you, fix the text before you accept it. That edit lands here.")
                .font(.callout)
                .foregroundStyle(Brand.secondaryText)
                .multilineTextAlignment(.center)
            Button("Add one by hand") { path.append(blank()) }
                .buttonStyle(.bordered)
            if let error = store.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(32)
    }

    /// A correction that does not exist yet. `at` is its id from the moment it is made,
    /// so saving it once creates it and saving it again edits the same row.
    private func blank() -> Correction {
        Correction(at: Date().timeIntervalSince1970 * 1000, heard: "", meant: "", clip: nil)
    }
}

/// One correction, being written. The same screen adds and edits; only an existing
/// one can be deleted. Going back leaves it as it was — Save is what writes.
private struct CorrectionDetail: View {
    @State var correction: Correction
    let serverURL: String
    let isNew: Bool
    let onSave: (Correction) -> Void
    let onDelete: () -> Void

    private var complete: Bool {
        !correction.heard.trimmingCharacters(in: .whitespaces).isEmpty
            && !correction.meant.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        Form {
            // Above the pair, because it is what the pair is about: play it and the
            // two fields stop being a memory test.
            if let clip = correction.clip {
                Section {
                    ClipChip(clip: clip, serverURL: serverURL)
                } footer: {
                    Text("What the ears were given, exactly as they got it.")
                }
            }
                // Never "corrected" — iOS autocorrect rewrites the very words you are
                // here to fix.
            Section("What it heard") {
                    TextField("what the ears produced", text: $correction.heard, axis: .vertical)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityLabel("Heard")
                }
                Section("What you meant") {
                    TextField("what you actually said", text: $correction.meant, axis: .vertical)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityLabel("Meant")
                }
            if !isNew {
                Section {
                    Button("Delete", role: .destructive) { onDelete() }
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .brandList()
        .navigationTitle(isNew ? "New correction" : "Correction")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { onSave(correction) }.disabled(!complete)
            }
        }
    }
}
