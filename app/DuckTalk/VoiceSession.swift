import Foundation
import Observation

/// One voice session: a WebSocket to the relay server, an AudioPipe on each end.
///
///   mic → pipe.onChunk → socket (binary)
///   socket (binary) → pipe.play
///   socket (text JSON) → transcript lines / flush on "interrupted" / error
@Observable
@MainActor
final class VoiceSession {
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
    private(set) var bytesUp = 0
    private(set) var bytesDown = 0
    private(set) var level: Float = 0  // 0…1 live loudness, for the waveform
    /// The instruction the server is holding for a yes/no/edit, in review mode.
    private(set) var pending: String?

    private var task: URLSessionWebSocketTask?
    private var pipe: AudioPipe?
    private var turnEnded = false
    private var utteranceOpen = false  // the current user line is still being revised
    private var replied = false  // a reply byte has been marked for this turn
    private var wantLive = false // the user's intent, which outlives any one socket
    private var url: URL?

    func connect(url: URL) {
        guard status == .idle else { return }
        self.url = url
        wantLive = true
        error = nil
        lines = []
        bytesUp = 0
        bytesDown = 0
        Task { await run() }
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
        while wantLive, let url {
            let task = URLSession.shared.webSocketTask(with: url)
            self.task = task
            // The mic feeds whichever socket is current, so a reconnect rebinds it.
            pipe.onChunk = { [weak self] data in
                task.send(.data(data)) { _ in }
                Task { @MainActor in self?.bytesUp += data.count }
            }
            task.resume()
            status = .live
            error = nil

            let openedAt = ContinuousClock.now
            do {
                try await receiveLoop(task)
            } catch {
                if wantLive { self.error = error.localizedDescription }
            }

            task.cancel(with: .normalClosure, reason: nil)
            self.task = nil
            pending = nil
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

    func stop() {
        wantLive = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        pipe?.stop()
        pipe = nil
        level = 0
        pending = nil
        status = .idle
    }

    /// Run the held instruction, as edited on screen. An edit teaches the server
    /// what was really said, so the same mishearing stops repeating.
    func approve(_ text: String) {
        guard pending != nil else { return }
        pending = nil
        send(["type": "approve", "text": text])
    }

    func reject() {
        guard pending != nil else { return }
        pending = nil
        send(["type": "reject"])
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
                bytesDown += pcm.count
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
        /// Live transcription revises its guess as you speak, so each update carries the
        /// whole utterance and replaces the last one instead of extending it.
        let partial: Bool?
    }

    private func handle(_ json: String) {
        guard let data = json.data(using: .utf8),
              let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
        switch event.type {
        case "user", "model":
            let kind: Line.Kind = event.type == "user" ? .user : .model
            if kind == .user {
                // Speech arrives as the whole utterance so far, revised as it is spoken,
                // so it replaces. A finished one closes the line and the next utterance
                // starts its own.
                if utteranceOpen, let last = lines.last, last.kind == .user {
                    lines[lines.count - 1].text = event.text ?? ""
                } else {
                    lines.append(Line(kind: .user, text: event.text ?? ""))
                }
                utteranceOpen = event.partial == true
                turnEnded = false
            } else if !turnEnded, let last = lines.last, last.kind == .model {
                lines[lines.count - 1].text += event.text ?? ""   // Claude's reply joins up
            } else {
                turnEnded = false
                lines.append(Line(kind: .model, text: event.text ?? ""))
            }
        case "approval":
            pending = event.text
        case "tool":
            // A name starts a tool, no name ends it. Consecutive tools join one line,
            // so a burst of them reads as a single step and speech breaks the group.
            if let name = event.text {
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
            turnEnded = true
            replied = false
            pending = nil
            endToolRun()
        case "interrupted":
            // Sent whenever a held instruction is decided — by voice or by the buttons —
            // so the card goes away however the decision was made.
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
