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

    private var task: URLSessionWebSocketTask?
    private var pipe: AudioPipe?

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
        status = .idle
    }

    // MARK: - Receive

    private func receiveLoop(_ task: URLSessionWebSocketTask) async throws {
        while status != .idle {
            switch try await task.receive() {
            case .data(let pcm):
                bytesDown += pcm.count
                pipe?.play(pcm)
            case .string(let json):
                handle(json)
            @unknown default:
                break
            }
        }
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
            // Transcripts arrive as fragments; extend the current line while the speaker is the same.
            if let last = lines.last, last.role == event.type {
                lines[lines.count - 1].text += event.text ?? ""
            } else {
                lines.append(Line(role: event.type, text: event.text ?? ""))
            }
        case "interrupted":
            pipe?.flush()
        case "error":
            error = event.text
        default:
            break
        }
    }
}
