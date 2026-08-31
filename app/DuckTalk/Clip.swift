import AVFoundation
import SwiftUI

/// Play back one utterance — the audio the ears actually transcribed.
///
/// The point of it is that a correction stops being a memory test. What you typed as
/// "meant" is a guess until you have heard what you said; with this, the pair is made
/// against the sound.
///
/// It fetches itself, over a `?data=1` socket it opens for the one message and closes
/// — the same shape as `ServerView.Probe.dial`. That is deliberate: a clip is a blob
/// asked for on demand, not state to be kept in step, so it does not belong in
/// `RelayStore`, which exists to hold everything the relay has and answer with all of
/// it. Here there is nothing to drift, and a chip that is never tapped costs nothing.
struct ClipChip: View {
    let clip: Double
    let serverURL: String

    @State private var player: AVAudioPlayer?
    @State private var loading = false
    @State private var at: TimeInterval = 0
    @State private var playing = false
    /// Fetched and there was nothing there — the relay pruned it. Said once, quietly:
    /// the correction is still the correction, this was only its evidence.
    @State private var gone = false

    /// Every tenth of a second while playing, which is what a progress readout needs
    /// and what tells us the player reached the end (AVAudioPlayer's delegate needs an
    /// NSObject; this needs neither).
    private let tick = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                if loading {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: playing ? "pause.fill" : "play.fill")
                        .font(.caption2)
                }
                Text(label)
                    .font(.caption.monospacedDigit())
            }
            .foregroundStyle(gone ? Brand.tertiaryText : Brand.secondaryText)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Brand.fill, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(loading || gone)
        .accessibilityIdentifier("clip")
        .accessibilityLabel(playing ? "Pause" : "Play what was heard")
        .onReceive(tick) { _ in
            guard let player else { return }
            at = player.currentTime
            if playing && !player.isPlaying { playing = false; at = 0 }
        }
        .onDisappear { player?.stop() }
    }

    private var label: String {
        if gone { return "no audio" }
        guard let player else { return loading ? "…" : "Play" }
        return playing ? "\(time(at)) / \(time(player.duration))" : time(player.duration)
    }

    private func time(_ seconds: TimeInterval) -> String {
        String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }

    /// Tap to play, tap again to pause. The audio is fetched on the first tap and kept
    /// for the life of the view, so replaying while editing costs nothing.
    private func toggle() {
        if let player {
            if player.isPlaying { player.pause(); playing = false }
            else { player.play(); playing = true }
            return
        }
        loading = true
        Task {
            let data = await fetch()
            loading = false
            guard let data, let player = try? AVAudioPlayer(data: data) else { return gone = true }
            self.player = player
            player.play()
            playing = true
        }
    }

    /// One socket, one question, one frame back.
    ///
    /// The relay sends the audio before the state frames every message is answered
    /// with, so the first frame is the whole answer: binary is the clip, text means
    /// there was none. Nothing is counted and nothing is waited out.
    private func fetch() async -> Data? {
        guard let url = URL(string: serverURL + "?data=1") else { return nil }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        guard let json = try? JSONSerialization.data(withJSONObject: ["type": "clip_get", "id": clip]),
              let text = String(data: json, encoding: .utf8),
              (try? await task.send(.string(text))) != nil else { return nil }
        guard case .data(let wav) = try? await task.receive() else { return nil }
        return wav
    }
}
