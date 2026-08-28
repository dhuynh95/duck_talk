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
    enum Status: String { case idle, connecting, live }

    struct Line: Identifiable {
        let id = UUID()
        let role: String
        var text: String
    }

    private(set) var status: Status = .idle
    private(set) var lines: [Line] = []
    private(set) var error: String?
    private(set) var bytesUp = 0
    private(set) var bytesDown = 0
    private(set) var level: Float = 0  // 0…1 live loudness, for the waveform

    private var task: URLSessionWebSocketTask?
    private var pipe: AudioPipe?
    private var turnEnded = false
    private var replied = false  // a reply byte has been marked for this turn

    func connect(url: URL) {
        guard status == .idle else { return }
        status = .connecting
        error = nil
        lines = []
        bytesUp = 0
        bytesDown = 0

        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task
        task.resume()

        let pipe = AudioPipe()
        pipe.onChunk = { [weak self] data in
            task.send(.data(data)) { _ in }
            Task { @MainActor in self?.bytesUp += data.count }
        }
        pipe.onLevel = { [weak self] l in
            Task { @MainActor in self?.level = l }
        }
        self.pipe = pipe

        Task {
            do {
                try await pipe.start()
                status = .live
                try await receiveLoop(task)
            } catch {
                if status != .idle { self.error = error.localizedDescription }
            }
            stop()
        }
    }

    func stop() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        pipe?.stop()
        pipe = nil
        level = 0
        status = .idle
    }

    // MARK: - Receive

    private func receiveLoop(_ task: URLSessionWebSocketTask) async throws {
        while status != .idle {
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

    private struct Event: Decodable {
        let type: String
        let text: String?
    }

    private func handle(_ json: String) {
        guard let data = json.data(using: .utf8),
              let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
        switch event.type {
        case "user", "model":
            // Transcripts arrive as fragments; extend the current line while the speaker
            // is the same and the turn is still open.
            if !turnEnded, let last = lines.last, last.role == event.type {
                lines[lines.count - 1].text += event.text ?? ""
            } else {
                turnEnded = false
                lines.append(Line(role: event.type, text: event.text ?? ""))
            }
        case "turn_end":
            turnEnded = true
            replied = false
        case "interrupted":
            pipe?.flush()
        case "error":
            error = event.text
        default:
            break
        }
    }
}
