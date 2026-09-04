import Foundation
import Observation

/// One conversation with Claude, on one socket, reached by talking or by typing.
///
///   socket  ?resume=<chat> ──▶ relay ──▶ the chat's Claude session
///     typing    a text frame on it
///     talking   mic → AudioPipe → binary frames on it; reply PCM → AudioPipe
///     watching  just being connected — a working chat streams its turn as it goes
///
/// There is one socket because there is one chat on screen. What varies is whether
/// audio is flowing on it: the relay opens its ears on the first microphone buffer and
/// closes them when the buffers stop, so talking is a property of the connection rather
/// than a different connection. Switching from typing to talking, or coming back to a
/// chat mid-turn, is therefore not a switch at all.
///
/// The socket is held while there is a reason to — `wantSocket`: the microphone is
/// open, a turn this screen sent is in flight, or the relay says the chat is working.
/// When none is true it closes, and the relay keeps the chat's work going without it.
///
/// `chatId` is what makes every socket land in the same conversation. The relay names
/// the chat at `turn_start`, so even the first turn of a new chat has an id before it is
/// over, and a microphone opened in the middle of it resumes it rather than starting one.
///
/// What Claude *is* — model, permission, effort — and the pictures for the next
/// instruction ride the socket as frames, sent when it opens and when they change.
///
/// What you are saying and what has been said are kept apart, because the screen keeps
/// them apart: `utterance` is the sentence being transcribed right now, and `lines` is
/// everything already sent. An utterance joins `lines` when the relay shows it was
/// actually sent, so nothing appears in the history that never ran.
@Observable
@MainActor
final class VoiceSession {
    /// There is one session, and this is it — the screen shows it and the call UI's
    /// buttons act on it, which only works while there is no second one.
    static let shared = VoiceSession()

    /// The microphone, and only the microphone. `connecting` is the call being placed.
    /// The test harness reads this off the listen button.
    enum Status: String { case idle, connecting, live }

    /// One entry in the transcript, appended in the order it happened: what you said,
    /// what Claude said, and the run of tools it used in between.
    struct Line: Identifiable {
        enum Kind { case user, model, tools }

        let id = UUID()
        let kind: Kind
        var text = ""
        var tools: [String] = []  // kind == .tools
        var running = false
        /// Where this line sits in the stored conversation, and so where a fork can cut.
        /// Set for a loaded line, and for a line just said once `turn_end` names it.
        var uuid: String?
        /// Where a fork has to cut to replace this line — see `ChatMessage.after`. It is
        /// what makes a message editable; the first line of a chat has none.
        var after: String?
        /// The audio this line was heard from, when it was spoken rather than typed.
        var clip: Double?
        /// What it was given with — pictures in hand for a line just sent and by id for
        /// one read back out of a stored chat, pasted texts whole either way. See `Piece`.
        var given: [Piece] = []

        init(kind: Kind, text: String = "", tools: [String] = [], running: Bool = false, uuid: String? = nil, after: String? = nil, clip: Double? = nil, given: [Piece] = []) {
            self.kind = kind; self.text = text; self.tools = tools; self.running = running; self.uuid = uuid; self.after = after; self.clip = clip; self.given = given
        }

        /// One message of a stored chat, as a line of the transcript.
        init(_ message: ChatMessage) {
            self.init(
                kind: message.role == "user" ? .user : .model,
                text: message.text,
                uuid: message.uuid,
                after: message.after,
                clip: message.clip,
                given: (message.images ?? []).map(Piece.stored) + (message.pastes ?? []).map(Piece.text),
            )
        }

        /// What the run did, collapsed. Names are all the relay sends, so this summary
        /// is the whole story. Whether Claude is still at it is not said here: the
        /// Working row under the transcript says so, from the relay's own word.
        var toolLabel: String {
            var counted: [(name: String, n: Int)] = []
            for tool in tools {
                if let i = counted.firstIndex(where: { $0.name == tool }) { counted[i].n += 1 }
                else { counted.append((tool, 1)) }
            }
            return counted.map { $0.n > 1 ? "\($0.name) ×\($0.n)" : $0.name }.joined(separator: ", ")
        }
    }

    // MARK: - What the screen reads

    private(set) var status: Status = .idle
    private(set) var lines: [Line] = []
    private(set) var error: String?
    private(set) var level: Float = 0  // 0…1 live loudness, for the waveform
    /// The microphone is sending silence. The socket, the ears and Claude stay warm;
    /// only what they hear changes.
    private(set) var muted = false
    /// What is being said right now, revised as it is spoken. Not yet history.
    private(set) var utterance: String?
    /// The audio it was heard from, held until the utterance becomes a line — so the
    /// review card can play what it is asking about, and the line can be corrected.
    private(set) var heardClip: Double?
    /// What the next instruction will be given with — pictures and pasted texts. Held
    /// until the instruction is committed to the transcript, and gone from the composer
    /// with the words; a retract puts them back along with the words.
    private(set) var attached: [Attachment] = []
    /// The last id minted. Ids are the moment a picture was picked, and picking several
    /// at once would otherwise mint one name for all of them.
    private var lastAttachId: Double = 0
    /// The instruction the relay is holding for a yes/no/edit, in review mode.
    private(set) var pending: String?
    /// A turn this screen sent is running, from the send until its `turn_end`. One of
    /// the three reasons to hold the socket, and the only one that can be true for a
    /// new chat before the relay's list has a row to say so.
    private(set) var inFlight = false
    /// The conversation this screen is in. Named by the relay at `turn_start`, and
    /// carried into every socket opened after — which is what makes a typed turn, a
    /// spoken one and a reconnect the same chat.
    private(set) var chatId: String?
    /// Something worth saying that is not a failure, so it is not `error` and not red.
    private(set) var notice: String?

    // MARK: - What the screen tells

    /// The relay's word that this chat has work in flight, read off the home screen's
    /// data socket and handed in here — the third reason to hold the socket. A working
    /// chat is watched: its turn streams onto the screen as it goes.
    var working = false { didSet { if working != oldValue { reconcile() } } }

    /// Where the relay is and how this chat runs — `?mode=`, `?correct=` ride the URL.
    /// Set by the screen; a change reconnects, since a socket is one of these.
    var url: URL? { didSet { if url != oldValue { drop(); reconcile() } } }

    /// The speaker, on or off — the spoken reply and the filler chimes together. Handed
    /// in like the model choice so this class reads no settings. Off takes effect
    /// mid-reply: what the speaker holds is dropped, and what still arrives is consumed
    /// unplayed — see `AudioPipe.output`.
    var output = true {
        didSet { pipe?.output = output }
    }

    // MARK: - The one socket

    private var socket: URLSessionWebSocketTask?
    /// The loop that holds it, or nil when nothing wants one.
    private var holding: Task<Void, Never>?
    private var wantSocket: Bool { status != .idle || inFlight || working }

    /// Open or close the socket to match `wantSocket`. Every path that changes one of
    /// its three inputs lands here, so one place decides.
    private func reconcile() {
        if wantSocket, holding == nil { holding = Task { await hold() } }
        if !wantSocket, holding != nil { drop() }
    }

    /// Close the socket now. The relay keeps the chat's work going without it.
    private func drop() {
        holding?.cancel()
        holding = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        outbox.removeAll() // said to the chat being left, not the next one
        pending = nil
        utterance = nil
        heardClip = nil
        replied = false
    }

    /// The chat this screen is in, added to the URL about to be dialled — so every way
    /// in carries the conversation without being told to.
    private func resumed(_ base: URL) -> URL {
        guard let chatId else { return base }
        return URL(string: base.absoluteString + "&resume=\(chatId)") ?? base
    }

    /// Hold the socket for as long as something wants it. A relay restart, a dropped
    /// network or a sleeping laptop cost a reconnect, not the conversation — and the
    /// reconnect carries the chat, so a turn in flight is picked up where it is.
    private func hold() async {
        var backoff: Duration = .milliseconds(250)
        while !Task.isCancelled, wantSocket, let base = url {
            let task = URLSession.shared.webSocketTask(with: resumed(base))
            socket = task
            task.resume()
            sendClaude()      // what Claude should be, before anything is said on it
            sendAttachments() // and the pictures picked before the socket existed
            let queued = outbox // then what was said while there was no socket
            outbox.removeAll()
            queued.forEach(send)
            error = nil
            if notice == Self.healing { notice = nil }
            call.reportConnected() // the call UI stops saying "connecting"; once only

            let openedAt = ContinuousClock.now
            do {
                while !Task.isCancelled {
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
            } catch {
                // A dropped socket while something still wants one is not news for the
                // screen; the loop is the answer. Raw errno text explains nothing.
            }
            task.cancel(with: .normalClosure, reason: nil)
            if socket === task { socket = nil }
            guard !Task.isCancelled, wantSocket else { break }

            // A connection that lasted is not a failing one; only a fast drop backs off.
            if openedAt.duration(to: .now) > .seconds(5) { backoff = .milliseconds(250) }
            // Silent unless it lasts: a drop healed inside a breath is not an event.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(3))
                guard let self, self.holding != nil, self.socket == nil else { return }
                self.notice = Self.healing
            }
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, .seconds(5))
        }
        holding = nil
    }

    /// The one notice this class clears on its own, so it can never take down a
    /// message someone else put up.
    private static let healing = "Reconnecting — Claude keeps working."

    /// Anything this screen says to the relay. `Any` rather than `String` because some
    /// frames carry numbers, and one trip through JSONSerialization keeps a quote inside
    /// a value from ending the value.
    ///
    /// `reconcile()` opens the socket on a task, so the frame that made it want one — a
    /// typed instruction, a stop — arrives here before there is a socket to put it on.
    /// It waits in the outbox and goes out the moment `hold` has one, after the frames
    /// that say what Claude should be. Measured: without this the relay saw the
    /// `claude` frame and never the instruction.
    private var outbox: [[String: Any]] = []

    private func send(_ msg: [String: Any]) {
        guard let socket else { outbox.append(msg); return }
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(json)) { _ in }
    }

    // MARK: - The conversation on screen

    /// Put a conversation on screen without starting one — opening a past chat, or
    /// clearing for a new one. Leaving a chat mid-turn is detaching, never stopping:
    /// the relay runs the turn to the end, and the drawer's pill says so.
    func show(_ past: [ChatMessage], id: String?) {
        stopListening()
        inFlight = false
        working = false // the new chat's own word arrives with the next list
        drop()
        lines = past.map(Line.init)
        chatId = id
        attached = [] // picked for the conversation you were in, not this one
        error = nil
        reconcile()
    }

    /// Type an instruction. Nothing has to prove it was sent — you wrote it — so it is
    /// history at once, and the socket opens if nothing held it.
    func send(_ text: String) {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return }
        lines.append(Line(kind: .user, text: said, given: take()))
        inFlight = true
        reconcile()
        send(["type": "text", "text": said])
    }

    /// Run the held instruction, as edited on screen. An edit teaches the relay what
    /// was really said. There is no opposite: say something else, or stop listening.
    func approve(_ text: String) {
        guard pending != nil else { return }
        pending = nil
        commit(text) // accepting is what sends it, so that is when it becomes history
        send(["type": "approve", "text": text])
    }

    /// Stop everything this screen is about: Claude's work in this chat — the turn and
    /// its background tasks, which is what the relay makes of `stop` — and the
    /// microphone if it is open. One button, whatever is running.
    func stopAll() {
        send(["type": "stop"])
        stopListening()
    }

    // MARK: - The microphone

    private var pipe: AudioPipe?
    /// The session as the system sees it. What buys the AirPods stem: a single press
    /// arrives through `call.onMute`, a double press through `call.onEnded`.
    private let call = Call()

    init() {
        call.onMute = { [weak self] on in
            Task { @MainActor in self?.applyMute(on) }
        }
        call.onEnded = { [weak self] byUser in
            Task { @MainActor in self?.callEnded(byUser: byUser) }
        }
        call.onAudioSession = { [weak self] active in
            Task { @MainActor in active ? self?.pipe?.resume() : self?.pipe?.suspend() }
        }
    }

    /// Start talking. The socket opens if nothing held it, the microphone feeds
    /// whichever socket is current, and the relay opens its ears on the first buffer —
    /// mid-turn included, in which case it reads the latest line and carries on.
    func listen() {
        guard status == .idle else { return }
        status = .connecting
        error = nil
        reconcile()
        Task { await startMic() }
    }

    private func startMic() async {
        let pipe = AudioPipe()
        pipe.output = output
        pipe.onLevel = { [weak self] l in Task { @MainActor in self?.level = l } }
        // What the speaker really played — the relay's only way to tell a reply that
        // was heard from one that was cut off. Sent when it runs dry.
        pipe.onDrained = { [weak self] ms in Task { @MainActor in self?.send(["type": "played", "ms": Int(ms)]) } }
        // What the audio system did, in its own terms, on the one clock.
        pipe.onAudio = { [weak self] what in Task { @MainActor in self?.mark("audio", note: what) } }
        pipe.onProblem = { [weak self] why in Task { @MainActor in self?.error = why } }
        // Whichever socket is current when the buffer arrives: a reconnect needs no
        // rebinding, and a buffer with no socket is simply not sent.
        pipe.onChunk = { [weak self] data in
            Task { @MainActor in self?.socket?.send(.data(data)) { _ in } }
        }
        do {
            // In this order: the mic, or no call UI; the call, which is the system
            // configuring and activating the audio session; then the engine on it.
            try await AudioPipe.requestMic()
            try await call.begin()
            try pipe.start()
        } catch {
            self.error = error.localizedDescription
            stopListening()
            return
        }
        guard status == .connecting else { pipe.stop(); return } // stopped while starting
        self.pipe = pipe
        status = .live
        call.reportConnected()
    }

    /// Stop talking. The socket stays if a turn is running — the reply keeps arriving
    /// as text — and closes otherwise. The relay hears the audio stop and closes its
    /// ears, which is what ends the spoken reply. Idempotent.
    func stopListening() {
        guard status != .idle else { return }
        call.end() // hang up however we got here; a no-op if the call already ended
        pipe?.stop()
        pipe = nil
        level = 0
        muted = false // the next session starts hearing
        notice = nil
        status = .idle
        reconcile()
    }

    /// The call is over — but only a person ending it means stop. The system dropping
    /// it (a provider reset) is damage to a session the user still wants, so it is
    /// healed instead; the socket is alive under it either way.
    private func callEnded(byUser: Bool) {
        if byUser || status == .idle { return stopListening() }
        Task { await healCall() }
    }

    /// One try to get the call — and with it the audio session — back. Failing that,
    /// only the voice is given up: the reply still streams as text on the socket.
    private func healCall() async {
        do {
            try await call.begin()
            // A re-begin's first activation resolves `begin` itself rather than firing
            // `onAudioSession`, so the engine is told here.
            pipe?.resume()
        } catch {
            stopListening()
            notice = "Voice lost — tap the mic to reconnect."
        }
    }

    /// Stop being heard, or start again. A request, not a flip: it goes up through
    /// the call and comes back through `applyMute` — the same road an AirPods stem
    /// press takes — so the call UI, the stem and this button can never disagree.
    func toggleMute() {
        guard pipe != nil else { return }
        weAsked = true
        call.setMuted(!muted)
    }

    /// Whether the mute about to arrive is the answer to our own request. Every other
    /// mute was volunteered by the system, and the log should say which.
    private var weAsked = false

    private func applyMute(_ on: Bool) {
        guard let pipe, muted != on else { return }
        let byUs = weAsked
        weAsked = false
        muted = on
        pipe.muted = on
        mark(on ? "mute" : "unmute", note: byUs ? "you" : "system")
        // A mute nobody on this screen asked for is worth a word; anything else makes
        // it untrue, so anything else clears it.
        notice = !byUs && on ? "Muted by your headphones or the call screen." : nil
    }

    // MARK: - Frames out

    private var model = ""
    private var permission = ""
    private var effort = ""

    /// Say what Claude should be. Reaches the socket open now and every one after.
    func use(model: String, permission: String, effort: String) {
        self.model = model
        self.permission = permission
        self.effort = effort
        sendClaude()
    }

    /// The one frame that carries it, whether a socket has just opened or the choice
    /// has just changed. Empty only before `use` has been called at all, and then the
    /// relay's own defaults hold.
    private func sendClaude() {
        guard !model.isEmpty, !permission.isEmpty else { return }
        var msg = ["type": "claude", "model": model, "permission": permission]
        if !effort.isEmpty { msg["effort"] = effort }
        send(msg)
    }

    /// Keep a picture or a pasted text for the next instruction, and tell the socket if
    /// there is one. The id is minted here because it has to exist before any socket does.
    func attach(_ content: Attachment.Content) {
        let attachment = Attachment(id: mint(), content: content)
        attached.append(attachment)
        // Only onto a socket that is up. Attachments are state, not events: every socket
        // opening is told all of them by `sendAttachments`, so queueing this one in the
        // outbox as well sent it twice — and Claude was shown the same picture twice.
        if socket != nil { sendAttachment(attachment) }
    }

    /// A fresh id: the moment, nudged past the last one so two picks in one millisecond
    /// stay two.
    private func mint() -> Double {
        lastAttachId = max((Date().timeIntervalSince1970 * 1000).rounded(), lastAttachId + 1)
        return lastAttachId
    }

    /// Take one back, before it has been sent. Afterwards there is nothing to take back:
    /// the transcript shows what the turn was actually given.
    func drop(_ attachment: Attachment) {
        attached.removeAll { $0.id == attachment.id }
    }

    /// Everything still pending, onto the socket just opened — the twin of `sendClaude`,
    /// answering the same question: what does a socket need to be told first.
    private func sendAttachments() { attached.forEach(sendAttachment) }

    /// One frame either way; which field it carries says which kind it is.
    private func sendAttachment(_ a: Attachment) {
        switch a.content {
        case .image(let jpeg): send(["type": "attach", "id": a.id, "data": jpeg.base64EncodedString()])
        case .text(let text): send(["type": "attach", "id": a.id, "text": text])
        }
    }

    /// A `mark`: a moment only the phone can see. `reply_in` and `speech_end` carry
    /// `at` and are stamped into the turn record; everything else carries a `note` and
    /// is only narrated in the log. A note says what was observed, never what it means.
    private func mark(_ name: String, at ms: Double? = nil, note: String? = nil) {
        var msg: [String: Any] = ["type": "mark", "name": name]
        if let ms { msg["at"] = Int(ms) }
        if let note { msg["note"] = note }
        send(msg)
    }

    private var replied = false

    /// The first byte of a reply arrived. The relay knows when it sent it, and the two
    /// clocks are one Mac's in the simulator, so it subtracts. Once per turn.
    private func markFirstReply() {
        guard !replied else { return }
        replied = true
        mark("reply_in", at: Date().timeIntervalSince1970 * 1000)
    }

    // MARK: - Frames in

    private var turnEnded = false
    /// This turn has already put lines in the history — what a retract may undo, and
    /// all it may undo. See the `interrupted` case.
    private var committed = false

    /// Move what was said into the history, now that it has actually been sent — with
    /// the audio it was heard from, which is what makes the line correctable later.
    private func commit(_ text: String? = nil) {
        let said = (text ?? utterance)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let clip = heardClip
        utterance = nil
        heardClip = nil
        guard let said, !said.isEmpty else { return }
        lines.append(Line(kind: .user, text: said, clip: clip, given: take()))
        committed = true
    }

    /// The pending pieces, handed to the line being committed — moved, not copied, so
    /// the composer empties the way it does for the words. Any not yet sent go into the
    /// outbox here, ahead of the frame that follows, so a socket opening later replays
    /// them in order; the relay then holds them for the turn, and a retract costs nothing
    /// there — see `interrupted`, which hands the line's pieces back.
    private func take() -> [Piece] {
        if socket == nil { attached.forEach(sendAttachment) }
        defer { attached = [] }
        return attached.map(Piece.init)
    }

    /// A turn is in flight, or over — and while one is, the filler chimes cover
    /// whatever the speaker has nothing to play for. On means proof, never prediction:
    /// asserted only by a sign of work arriving, so a turn that provably runs is
    /// guaranteed a closer. AudioPipe decides whether the wait *sounds* right now.
    private func waiting(_ on: Bool) { pipe?.waiting = on }

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
        /// On `turn_start` and `turn_end`: which chat this connection is in.
        let session: String?
        /// On `tool`: the Agent call this tool ran inside, nil for Claude's own.
        let parent: String?
        /// On `interrupted`: the turn was taken back; what it put in the history comes off.
        let retract: Bool?
        /// On `turn_end`: where the turn's two messages now sit in the stored chat —
        /// what makes a line just said forkable and editable without reopening it.
        let user: Saved?
        let model: Saved?

        struct Saved: Decodable {
            let uuid: String
            let after: String?
        }
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
            if event.partial != true {
                heardClip = event.clip
                // When the mic last crossed the meter's floor is when speech actually
                // stopped — the one number only the phone can know. Not sent over an
                // approval card: that utterance was the decision, not the instruction.
                if pending == nil, let at = pipe?.lastLoudAt, at > 0 { mark("speech_end", at: at) }
            }
        case "turn_start":
            // The turn is running — one this screen sent, or one it is watching. The
            // chat now has a name, so every socket after this one carries it: a mic
            // opened mid-turn on a new chat resumes it rather than starting another.
            if let session = event.session { chatId = session }
            inFlight = true
            commit()
            // Whatever text comes next starts its own line: on a turn joined mid-way,
            // the last line is a block the transcript already holds complete.
            turnEnded = true
            waiting(true)
            pipe?.expectReply() // a new reply, so the played count starts from nothing
        case "model":
            commit() // Claude answering is proof the instruction went
            waiting(true)
            if !turnEnded, let last = lines.last, last.kind == .model {
                lines[lines.count - 1].text += event.text ?? ""
            } else {
                turnEnded = false
                lines.append(Line(kind: .model, text: event.text ?? ""))
            }
        case "approval":
            // Held for a decision: the box stops being a transcript and becomes a question.
            utterance = nil
            pending = event.text
        case "tool":
            // A name starts a tool, no name ends it. Consecutive tools join one line, and
            // a subagent's tools join the Agent's line, which is where they belong.
            if let name = event.text {
                commit()
                waiting(true)
                turnEnded = false
                if let i = lines.indices.last, lines[i].kind == .tools {
                    lines[i].tools.append(name)
                    lines[i].running = true
                } else {
                    lines.append(Line(kind: .tools, tools: [name], running: true))
                }
            } else if event.parent == nil {
                // A subagent finishing a tool says nothing about the Agent that started
                // it, which is usually still working — often for minutes.
                endToolRun()
            }
        case "turn_end":
            commit() // a turn that answered nothing still ran
            committed = false
            turnEnded = true
            replied = false
            pending = nil
            waiting(false)
            if let session = event.session { chatId = session }
            // The turn's two messages have a place in the store now, so the lines just
            // said get the handles a loaded line has: Edit on yours, Fork on Claude's.
            if let saved = event.user, let i = lines.lastIndex(where: { $0.kind == .user }) {
                lines[i].uuid = saved.uuid
                lines[i].after = saved.after
            }
            if let saved = event.model, let i = lines.lastIndex(where: { $0.kind == .model }) {
                lines[i].uuid = saved.uuid
            }
            endToolRun()
            inFlight = false
            reconcile() // nothing else holding the socket → it closes
        case "interrupted":
            // Sent whenever a held instruction is decided, and on a barge-in.
            pending = nil
            waiting(false)
            // A retract: you are still speaking the instruction, and what Claude said to
            // the fragment must not sit beside the real answer. Only what this turn
            // committed may come off.
            if event.retract == true, committed {
                while let last = lines.last, last.kind != .user { lines.removeLast() }
                // The line's pieces come back to the composer with the words: the relay
                // still holds them for the re-run, so none is sent again — and a socket
                // that reconnects meanwhile is told them like anything else pending.
                if let line = lines.popLast() { attached = line.given.compactMap { Attachment($0) }.map { Attachment(id: mint(), content: $0.content) } }
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
