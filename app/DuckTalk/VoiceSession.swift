import ActivityKit
import Foundation
import Observation

/// One conversation with Claude, reached two ways: by talking, or by typing.
///
///   talking   mic → pipe.onChunk → socket (binary) ─┐
///             socket (binary) → pipe.play           ├─ socket (text JSON) → transcript
///   typing    one socket, one text frame ───────────┘
///
/// The two are exclusive, and the difference is only how the instruction is made — the
/// relay, Claude, and the events that come back are the same either way, so `handle`
/// is shared and `ask` is a connection that opens for one turn and closes. The relay
/// opens ears only for a connection that sends audio, so typing costs no Gemini
/// session and no spoken reply; it needs no flag to say so.
///
/// `chatId` is what makes them one conversation: the relay names the chat at every
/// `turn_end`, and every connection opened after that resumes it.
///
/// What Claude *is* — which model answers, and what it is allowed to do — travels the
/// same way but as a frame rather than in the URL, because the relay puts both on the
/// session it already has running. So it is sent whenever a socket opens and whenever
/// the choice changes, and it holds from the next turn either way.
///
/// What you are saying and what has been said are kept apart, because the screen
/// keeps them apart: `utterance` is the sentence being transcribed right now, and
/// `lines` is everything already sent. An utterance joins `lines` at the moment the
/// relay shows it was actually sent — Claude answering it, or you accepting it in
/// review — so nothing appears in the history that never ran.
@Observable
@MainActor
final class VoiceSession {
    /// There is one session, and this is it. The screen shows it and the lock
    /// screen's Stop button ends it — two views of one running thing, which only
    /// works while there is no second one for them to disagree about.
    static let shared = VoiceSession()

    enum Status: String { case idle, connecting, live, reconnecting }

    /// One entry in the transcript, appended in the order it happened: what you said,
    /// what Claude said, and the run of tools it used in between.
    struct Line: Identifiable {
        enum Kind { case user, model, tools }

        let id = UUID()
        let kind: Kind
        var text = ""
        var tools: [String] = []  // kind == .tools
        var running = false
        /// Where this line sits in the stored conversation, and so where a fork can
        /// cut. Only lines loaded from a past chat have one — a line just spoken is
        /// not in the transcript on disk yet, so there is nothing to branch from.
        var uuid: String?
        /// The audio this line was heard from, when it was spoken rather than typed.
        /// It is what makes a mishearing fixable after the fact — see `fix` on the
        /// home screen.
        var clip: Double?

        init(kind: Kind, text: String = "", tools: [String] = [], running: Bool = false, uuid: String? = nil, clip: Double? = nil) {
            self.kind = kind; self.text = text; self.tools = tools; self.running = running; self.uuid = uuid; self.clip = clip
        }

        /// One message of a stored chat, as a line of the transcript.
        init(_ message: ChatMessage) {
            self.init(kind: message.role == "user" ? .user : .model, text: message.text, uuid: message.uuid, clip: message.clip)
        }

        /// The tool now running, or — once the run is over — what it did, collapsed.
        /// Names are all the relay sends, so this summary is the whole story and
        /// there is nothing to expand into.
        var toolLabel: String {
            if running, let current = tools.last { return "\(current)…" }
            var counted: [(name: String, n: Int)] = []
            for tool in tools {
                if let i = counted.firstIndex(where: { $0.name == tool }) { counted[i].n += 1 }
                else { counted.append((tool, 1)) }
            }
            return counted.map { $0.n > 1 ? "\($0.name) ×\($0.n)" : $0.name }.joined(separator: ", ")
        }
    }

    private(set) var status: Status = .idle
    private(set) var lines: [Line] = []
    private(set) var error: String?
    private(set) var level: Float = 0  // 0…1 live loudness, for the waveform
    /// The microphone is sending silence. The session, the ears and Claude stay warm;
    /// only what they hear changes. `AudioPipe.muted` is the bit that does it — this is
    /// that bit as the screen and the lock screen read it.
    private(set) var muted = false
    /// What is being said right now, revised as it is spoken. Not yet history.
    private(set) var utterance: String?
    /// The audio it was heard from, held until the utterance becomes a line — so a
    /// line in the transcript can be played back and corrected, and so the review card
    /// can play what it is asking you about. One holder, because there is one utterance
    /// in flight and the review card is that utterance waiting to be sent.
    private(set) var heardClip: Double?
    /// The instruction the server is holding for a yes/no/edit, in review mode.
    private(set) var pending: String?
    /// A typed instruction is running: sent, and the reply has not finished arriving.
    private(set) var asking = false
    /// The conversation this screen is in, named by the relay and carried into every
    /// connection opened after it — which is what makes a typed turn and a spoken one
    /// the same chat.
    private(set) var chatId: String?

    private var task: URLSessionWebSocketTask?
    /// The socket of a typed turn, which lives exactly as long as that turn.
    private var askTask: URLSessionWebSocketTask?
    /// What Claude should be: which model answers, and what it is allowed to do. Held
    /// here rather than taken as an argument at connect, because the relay puts both on
    /// the session already running — so they are sent on every socket this class opens,
    /// and again the moment either changes.
    private var model = ""
    private var permission = ""
    private var pipe: AudioPipe?
    private var turnEnded = false
    private var replied = false  // a reply byte has been marked for this turn
    private var wantLive = false // the user's intent, which outlives any one socket
    private var url: URL?
    private var activity: Activity<LiveSession>?

    func connect(url: URL) {
        guard status == .idle, !asking else { return }
        self.url = url
        wantLive = true
        error = nil
        utterance = nil
        startActivity() // while the app is in the foreground, which is the only time allowed
        Task { await run() }
    }

    /// The chat this screen is in, added to a connection about to be opened. Written
    /// here rather than by the caller so that every way in — talking, typing, a
    /// reconnect — carries the conversation without being told to.
    private func resuming(_ url: URL) -> URL {
        guard let chatId else { return url }
        return URL(string: url.absoluteString + "&resume=\(chatId)") ?? url
    }

    /// Put a conversation on screen without starting one — opening a past chat, or
    /// clearing for a new one.
    ///
    /// The transcript is what is on screen, live session or not, which is why
    /// `connect` no longer empties it: a resumed chat has to survive being connected
    /// to, and emptying it is something only "New chat" ever means.
    func show(_ past: [ChatMessage], id: String?) {
        guard status == .idle, !asking else { return }
        lines = past.map(Line.init)
        chatId = id
        utterance = nil
        pending = nil
        error = nil
    }

    /// Hold a socket to the relay for as long as the user wants one. A relay restart,
    /// a dropped network or a sleeping laptop should cost a reconnect, not the
    /// session — so only Stop ends this, and the mic keeps running throughout
    /// (restarting the audio session is what actually breaks, and it is expensive).
    private func run() async {
        let pipe = AudioPipe()
        pipe.onLevel = { [weak self] l in
            Task { @MainActor in self?.level = l }
        }
        status = .connecting
        do {
            try await pipe.start()
        } catch {
            self.error = error.localizedDescription
            stop()
            return
        }
        self.pipe = pipe

        var backoff: Duration = .milliseconds(250)
        while wantLive, let base = url {
            // Resolved per attempt, not once: by the time a dropped session reconnects
            // the chat has a name, and reconnecting means carrying it on.
            let task = URLSession.shared.webSocketTask(with: resuming(base))
            self.task = task
            // The mic feeds whichever socket is current, so a reconnect rebinds it.
            pipe.onChunk = { data in task.send(.data(data)) { _ in } }
            task.resume()
            sendClaude(to: task) // before anything is said on it
            status = .live
            error = nil
            publish()

            let openedAt = ContinuousClock.now
            do {
                try await receiveLoop(task)
            } catch {
                if wantLive { self.error = error.localizedDescription }
            }

            task.cancel(with: .normalClosure, reason: nil)
            self.task = nil
            pending = nil
            utterance = nil
            heardClip = nil
            replied = false
            guard wantLive else { break }

            // A connection that lasted is not a failing one; only a fast drop backs off.
            if openedAt.duration(to: .now) > .seconds(5) { backoff = .milliseconds(250) }
            status = .reconnecting
            publish() // a session that lost the relay must not still read "Listening"
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, .seconds(5))
        }
        stop()
    }

    /// Stop being heard, or start again. Reached from the composer and, through
    /// `MuteListening`, from the lock screen — one bit either way.
    func toggleMute() {
        guard let pipe else { return }
        muted.toggle()
        pipe.muted = muted
        publish() // the card draws the button in its new state, and says "Muted"
    }

    func stop() {
        wantLive = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        pipe?.stop()
        pipe = nil
        level = 0
        muted = false // a new session starts hearing
        pending = nil
        utterance = nil
        heardClip = nil
        status = .idle
        endActivity()
    }

    /// Say what Claude should be. Reaches whatever socket is open now, and every socket
    /// opened after it — so a choice made while typing still holds when you start
    /// talking, and one made mid-conversation holds from the next turn.
    func use(model: String, permission: String) {
        self.model = model
        self.permission = permission
        sendClaude(to: task)
        sendClaude(to: askTask)
    }

    /// The one frame that carries it — the same message whether a socket has just opened
    /// or the choice has just changed, so there is no separate first-time path to keep in
    /// step with this one.
    private func sendClaude(to task: URLSessionWebSocketTask?) {
        // Empty only before `use` has been called at all, which is a socket opening
        // during launch — the relay's own defaults hold until the next one is sent.
        guard let task, !model.isEmpty, !permission.isEmpty else { return }
        let msg = ["type": "claude", "model": model, "permission": permission]
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        task.send(.string(json)) { _ in }
    }

    // MARK: - Typing
    //
    // One turn, one socket. There is no microphone to keep alive between turns and
    // nothing to reconnect to, so the connection is the turn: it opens with the
    // instruction and closes when the reply is done. Everything in between is the
    // same events a spoken turn produces, so `handle` is the whole of it.

    func ask(_ text: String, url: URL) {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty, status == .idle, !asking else { return }
        // Nothing has to prove this was sent — you wrote it — so it is history at once.
        lines.append(Line(kind: .user, text: said))
        asking = true
        Task { await converse(said, url: resuming(url)) }
    }

    /// Drop the turn. The socket is the turn, so closing it is the whole cancel.
    func cancelAsk() {
        askTask?.cancel(with: .normalClosure, reason: nil)
    }

    private func converse(_ said: String, url: URL) async {
        let task = URLSession.shared.webSocketTask(with: url)
        askTask = task
        task.resume()
        sendClaude(to: task) // ahead of the instruction, so the turn runs as asked
        defer {
            task.cancel(with: .normalClosure, reason: nil)
            askTask = nil
            asking = false
            endToolRun()
        }
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": "text", "text": said]),
              let json = String(data: data, encoding: .utf8) else { return }
        do {
            try await task.send(.string(json))
            // `turn_end` clears `asking`, so the relay ending the turn is what ends the
            // loop; a cancel throws out of `receive`, which is the other way it ends.
            while asking {
                guard case .string(let json) = try await task.receive() else { continue }
                handle(json)
            }
        } catch {
            if asking, !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    // MARK: - Lock screen
    //
    // The same session, shown where you can see it once the screen is off. It is a
    // second view of the state above, never a second copy: `publish` reads what is
    // already published and sends that. Called at turn boundaries only — the system
    // budgets how often a Live Activity may change, and there is nothing legible to
    // show between one word and the next anyway.

    private func startActivity() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, activity == nil else { return }
        activity = try? Activity.request(
            attributes: LiveSession(startedAt: .now),
            content: ActivityContent(state: snapshot(), staleDate: nil),
        )
    }

    private func publish() {
        guard let activity else { return }
        let state = snapshot()
        Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    private func endActivity() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func snapshot() -> LiveSession.ContentState {
        LiveSession.ContentState(
            status: status.rawValue,
            muted: muted,
            heard: pending ?? utterance ?? "",
            said: lines.last(where: { $0.kind == .model })?.text ?? "",
        )
    }

    /// Run the held instruction, as edited on screen. An edit teaches the server what
    /// was really said, so the same mishearing stops repeating.
    ///
    /// There is no opposite. Refusing one is not doing anything with it: say something
    /// else, or stop listening. A button for that would be a third thing to aim at in
    /// the one place the screen is asking you a yes-or-no question.
    func approve(_ text: String) {
        guard pending != nil else { return }
        pending = nil
        commit(text) // accepting is what sends it, so that is when it becomes history
        send(["type": "approve", "text": text])
    }

    /// Move what was said into the history, now that it has actually been sent — with
    /// the audio it was heard from, which is what makes the line correctable later.
    private func commit(_ text: String? = nil) {
        let said = (text ?? utterance)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let clip = heardClip
        utterance = nil
        heardClip = nil
        guard let said, !said.isEmpty else { return }
        lines.append(Line(kind: .user, text: said, clip: clip))
    }

    private func send(_ msg: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(json)) { _ in }
    }

    // MARK: - Receive

    private func receiveLoop(_ task: URLSessionWebSocketTask) async throws {
        while wantLive {
            switch try await task.receive() {
            case .data(let pcm):
                markFirstReply(task)
                pipe?.play(pcm)
            case .string(let json):
                handle(json)
            @unknown default:
                break
            }
        }
    }

    /// Tell the relay the moment the first byte of a reply arrived. The relay already
    /// knows when it sent that byte, and on the simulator both clocks are this Mac's,
    /// so the two timestamps subtract into the real cost of the hop. Once per turn.
    private func markFirstReply(_ task: URLSessionWebSocketTask) {
        guard !replied else { return }
        replied = true
        let at = Int(Date().timeIntervalSince1970 * 1000)
        task.send(.string(#"{"type":"mark","name":"reply_in","at":\#(at)}"#)) { _ in }
    }

    /// The tools stop running when speech resumes or the turn ends.
    private func endToolRun() {
        if let i = lines.indices.last, lines[i].kind == .tools { lines[i].running = false }
    }

    private struct Event: Decodable {
        let type: String
        let text: String?
        /// On a finished `user`: the audio that utterance was heard from.
        let clip: Double?
        /// Live transcription revises its guess as you speak, so each update carries the
        /// whole utterance and replaces the last one instead of extending it.
        let partial: Bool?
        /// On `turn_end`: which chat this connection turned out to be in.
        let session: String?
    }

    private func handle(_ json: String) {
        guard let data = json.data(using: .utf8),
              let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
        switch event.type {
        case "user":
            // Speech arrives as the whole utterance so far, revised as it is spoken, so
            // it replaces rather than extends. It stays out of the history until it is
            // sent — barging in over a reply replaces it, and a rejected one is dropped.
            utterance = event.text
            turnEnded = false
            // The audio arrives with the finished text, never with a revision of it.
            if event.partial != true { heardClip = event.clip; publish() }
        case "model":
            commit() // Claude answering is proof the instruction went
            if !turnEnded, let last = lines.last, last.kind == .model {
                lines[lines.count - 1].text += event.text ?? ""   // Claude's reply joins up
            } else {
                turnEnded = false
                lines.append(Line(kind: .model, text: event.text ?? ""))
            }
        case "approval":
            // Held for a decision: the box stops being a transcript and becomes a
            // question, so only one of the two is ever on screen.
            utterance = nil
            pending = event.text
            publish()
        case "tool":
            // A name starts a tool, no name ends it. Consecutive tools join one line,
            // so a burst of them reads as a single step and speech breaks the group.
            if let name = event.text {
                commit() // a tool running is proof too, and it can come before any text
                turnEnded = false
                if let i = lines.indices.last, lines[i].kind == .tools {
                    lines[i].tools.append(name)
                    lines[i].running = true
                } else {
                    lines.append(Line(kind: .tools, tools: [name], running: true))
                }
            } else {
                endToolRun()
            }
        case "turn_end":
            // A turn that answered nothing still ran, so whatever is still uncommitted
            // belongs in the history now.
            commit()
            turnEnded = true
            replied = false
            pending = nil
            // Now the conversation has a name, so the next connection can carry it on.
            if let session = event.session { chatId = session }
            asking = false // a typed turn is its socket, and this closes it
            endToolRun()
            publish() // the reply is complete; this is the readable moment
        case "interrupted":
            // Sent whenever a held instruction is decided — by voice or by the buttons —
            // so the card goes away however the decision was made. What is being said
            // now is the barge-in, and it stays in the box.
            pending = nil
            endToolRun()
            pipe?.flush()
        case "error":
            error = event.text
        default:
            break
        }
    }
}
