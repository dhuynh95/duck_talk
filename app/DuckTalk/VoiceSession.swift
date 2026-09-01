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
/// What Claude *is* — which model answers, what it is allowed to do, and how hard it
/// thinks — travels the same way but as a frame rather than in the URL, because the
/// relay puts all three on the session it already has running. So it is sent whenever a
/// socket opens and whenever the choice changes, and it holds from the next turn either
/// way.
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
    /// What Claude should be: which model answers, what it is allowed to do, and how
    /// hard it thinks. Held here rather than taken as arguments at connect, because the
    /// relay puts all three on the session already running — so they are sent on every
    /// socket this class opens, and again the moment any of them changes.
    private var model = ""
    private var permission = ""
    private var effort = ""
    private var pipe: AudioPipe?
    /// The session as the system sees it. What buys the AirPods stem: a single press
    /// arrives through `call.onMute`, a double press through `call.onEnded`.
    private let call = Call()
    private var turnEnded = false
    /// This turn has already put lines in the history — what a retract has to undo,
    /// and all it may undo. See the `interrupted` case.
    private var committed = false
    private var replied = false  // a reply byte has been marked for this turn
    private var wantLive = false // the user's intent, which outlives any one socket
    private var url: URL?

    init() {
        // The three things the system can say about the call, wired once. Every mute
        // — stem, call UI, or our own button coming back around — lands in the first.
        call.onMute = { [weak self] on in
            Task { @MainActor in self?.applyMute(on) }
        }
        call.onEnded = { [weak self] in
            Task { @MainActor in self?.stop() }
        }
        call.onAudioSession = { [weak self] active in
            Task { @MainActor in active ? self?.pipe?.resume() : self?.pipe?.suspend() }
        }
    }

    func connect(url: URL) {
        guard status == .idle, !asking else { return }
        self.url = url
        wantLive = true
        error = nil
        utterance = nil
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
    ///
    /// A conversation mid-turn is left, never guarded against: closing the socket
    /// does not stop the turn — the relay runs it to the end, and the drawer's
    /// working pill is what says so — so switching away is detaching, and the
    /// finished answer is in the chat when it is next opened. Refusing here instead
    /// let the header change chats while the transcript could not follow it.
    func show(_ past: [ChatMessage], id: String?) {
        if status != .idle { stop() }
        if asking { asking = false; askTask?.cancel(with: .normalClosure, reason: nil) }
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
            // In this order: the mic, or no call UI; the call, which is the system
            // configuring and activating the audio session; then the engine on it.
            try await AudioPipe.requestMic()
            try await call.begin()
            try pipe.start()
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
            call.reportConnected() // the lock screen stops saying "connecting"; once only

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
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, .seconds(5))
        }
        stop()
    }

    /// Stop being heard, or start again. A request, not a flip: it goes up through
    /// the call and comes back through `applyMute` — the same road an AirPods stem
    /// press takes — so the call UI, the stem and this button can never disagree.
    func toggleMute() {
        guard pipe != nil else { return }
        call.setMuted(!muted)
    }

    /// The mute bit actually flipping, wherever the request came from: the stem, the
    /// call UI, or `toggleMute` above.
    private func applyMute(_ on: Bool) {
        guard let pipe, muted != on else { return }
        muted = on
        pipe.muted = on
        // Stamped into the relay's log on the one clock, so a stem press is visible
        // from the Mac — the same channel the device test used.
        mark(on ? "stem_mute" : "stem_unmute", at: Date().timeIntervalSince1970 * 1000)
    }

    func stop() {
        wantLive = false
        call.end() // hang up however we got here; a no-op if the call already ended
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
    }

    /// Say what Claude should be. Reaches whatever socket is open now, and every socket
    /// opened after it — so a choice made while typing still holds when you start
    /// talking, and one made mid-conversation holds from the next turn.
    func use(model: String, permission: String, effort: String) {
        self.model = model
        self.permission = permission
        self.effort = effort
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
        var msg = ["type": "claude", "model": model, "permission": permission]
        if !effort.isEmpty { msg["effort"] = effort }
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

    /// Watch a turn already running in this chat: the same socket as a typed turn,
    /// with nothing to send. The relay attaches it to the live session, replays the
    /// reply so far, and streams the rest — so opening a chat whose pill says
    /// working picks the answer up mid-sentence. Ends the way a typed turn does.
    func follow(url: URL) {
        guard status == .idle, !asking, chatId != nil else { return }
        asking = true
        let before = lines.count
        Task { await converse(nil, url: resuming(url)) }
        // The pill can be stale — a restarted relay forgets its live sessions — and a
        // follow that finds nothing running would wear the stop face forever. A real
        // attach replays synchronously, so a screen still untouched after this long
        // means there is nothing to watch, and the socket is put down.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, self.asking, self.lines.count == before else { return }
            self.cancelAsk()
        }
    }

    /// Stop the turn and put the socket down. Coupled today — the `stop` frame ends
    /// the work, and its `turn_end` (or the close behind it) ends the socket — but
    /// they are two acts on the wire, so the two can be decoupled later.
    func cancelAsk() {
        guard let task = askTask else { return }
        // No longer waiting — said before the close so the socket dropping under the
        // receive loop reads as the cancel it is, not as an error worth showing.
        asking = false
        task.send(.string(#"{"type":"stop"}"#)) { _ in
            task.cancel(with: .normalClosure, reason: nil)
        }
    }

    /// One turn watched to its end — sent by us, or already running on the relay.
    private func converse(_ said: String?, url: URL) async {
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
        do {
            if let said {
                guard let data = try? JSONSerialization.data(withJSONObject: ["type": "text", "text": said]),
                      let json = String(data: data, encoding: .utf8) else { return }
                try await task.send(.string(json))
            }
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
        committed = true
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
                markFirstReply()
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
    private func markFirstReply() {
        guard !replied else { return }
        replied = true
        mark("reply_in", at: Date().timeIntervalSince1970 * 1000)
    }

    /// A turn is in flight, or over — and while one is, the filler chimes cover
    /// whatever the speaker has nothing to play for: the head of the turn, and the
    /// lulls where the voice runs out because Claude went back to its tools.
    ///
    /// On means proof, never prediction: it is asserted only by a silent sign of
    /// work arriving — a tool, or reply text — because a turn that provably runs is
    /// guaranteed a closer (`turn_end`, or `interrupted`), where an utterance the
    /// relay shrugs off (a bare "stop" said to an idle session) would start a loop
    /// nothing ever stops. Whether the wait *sounds* right now is not decided here:
    /// AudioPipe owns the speaker, so only it knows dry from playing — see
    /// `AudioPipe.waiting`. A typed turn has no pipe, so audio keeps buying audio
    /// without being told to.
    private func waiting(_ on: Bool) { pipe?.waiting = on && fillerEnabled }

    /// The gear menu's "Filler sound", handed in like the model choice so this class
    /// reads no settings. Off takes effect mid-wait: a loop already playing stops.
    var fillerEnabled = true {
        didSet { if !fillerEnabled { pipe?.waiting = false } }
    }

    /// A `mark`: a moment only the phone can see, stamped into the relay's turn
    /// record. Hand-built JSON because `send` speaks [String: String] and `at` has to
    /// stay a number, which is the one thing the relay checks before believing it.
    private func mark(_ name: String, at ms: Double) {
        task?.send(.string(#"{"type":"mark","name":"\#(name)","at":\#(Int(ms))}"#)) { _ in }
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
        /// On `tool`: the Agent call this tool ran inside, nil for Claude's own. A
        /// subagent finishing a tool must not end the Agent's run, and this is what
        /// tells the two apart.
        let parent: String?
        /// On `interrupted`: the turn was taken back because you are still speaking
        /// the instruction — what it put in the history comes off.
        let retract: Bool?
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
            if event.partial != true {
                heardClip = event.clip
                // A finished transcript proves there was an utterance to time, and
                // when the mic last crossed the meter's floor is when it actually
                // stopped — the one number only the phone can know, and the relay's
                // `stt` column is the difference. Not sent over an approval card: the
                // utterance that just finished was the decision being spoken, and the
                // instruction it decides about already marked its own end.
                if pending == nil, let at = pipe?.lastLoudAt, at > 0 { mark("speech_end", at: at) }
            }
        case "turn_start":
            // The instruction reached Claude. That is proof enough — and about a
            // second and a half earlier than the first block, which is the longest
            // silence in a turn and used to be the one stretch with no chime and no
            // movement on screen. Everything below still commits and still waits,
            // because a relay too old to send this is a relay this app still works
            // against; against a current one they are no-ops.
            commit()
            turnEnded = false
            waiting(true)
        case "model":
            commit() // Claude answering is proof the instruction went
            waiting(true) // and words with no voice for them yet are still the wait
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
        case "tool":
            // A name starts a tool, no name ends it. Consecutive tools join one line,
            // so a burst of them reads as a single step and speech breaks the group —
            // and a subagent's tools join the Agent's line, which is where they belong.
            if let name = event.text {
                commit() // a tool running is proof too, and it can come before any text
                waiting(true) // the longest waits are exactly here, under the tools
                turnEnded = false
                if let i = lines.indices.last, lines[i].kind == .tools {
                    lines[i].tools.append(name)
                    lines[i].running = true
                } else {
                    lines.append(Line(kind: .tools, tools: [name], running: true))
                }
            } else if event.parent == nil {
                // A subagent finishing a tool says nothing about the Agent that started
                // it, which is usually still working — often for minutes. Ending the run
                // here stopped the spinner on the first subagent's first result.
                endToolRun()
            }
        case "turn_end":
            // A turn that answered nothing still ran, so whatever is still uncommitted
            // belongs in the history now.
            commit()
            committed = false // history now, not this turn's to take back
            turnEnded = true
            replied = false
            pending = nil
            waiting(false) // a turn that never produced a reply byte still ended
            // Now the conversation has a name, so the next connection can carry it on.
            if let session = event.session { chatId = session }
            asking = false // a typed turn is its socket, and this closes it
            endToolRun()
        case "interrupted":
            // Sent whenever a held instruction is decided — by voice or by the buttons —
            // so the card goes away however the decision was made. What is being said
            // now is the barge-in, and it stays in the box.
            pending = nil
            waiting(false) // whatever was being waited for is not coming
            // A retract: you are still speaking the instruction, and a warm Claude can
            // answer the fragment inside the pause that made it. That answer must not
            // sit beside the real one, so the turn's lines come off — back to the last
            // user line inclusive — and the composer, still receiving partials, is the
            // only trace. Only what this turn committed may come off; a retract before
            // any reply has nothing to undo.
            if event.retract == true, committed {
                while let last = lines.last, last.kind != .user { lines.removeLast() }
                if !lines.isEmpty { lines.removeLast() }
                committed = false
            }
            endToolRun()
            pipe?.flush()
        case "error":
            error = event.text
        default:
            break
        }
    }
}
