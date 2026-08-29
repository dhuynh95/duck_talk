import SwiftUI

/// The one control on the home screen: a row of bars that grows with your voice.
///
/// Every bar is the same number — the microphone level, 0…1 — shaped by how far it
/// sits from the middle. So the row is symmetric, the middle is always tallest, and
/// louder simply means taller. There is no history, no per-bar signal and no timer:
/// one value in, one shape out, which is why it can only ever move when you speak.
///
/// It never becomes a different button — starting and stopping are not the same
/// gesture, so stopping lives beside it and this stays the one thing you tap to talk.
struct ListenButton: View {
    var live: Bool
    /// 0…1 microphone level, already metered and smoothed by `AudioPipe`.
    var level: CGFloat
    /// What the accessibility tree reports — the test harness reads this.
    var status: String
    var start: () -> Void

    private let size: CGFloat = 76
    private let bars = 7
    private let barWidth: CGFloat = 3.5
    private let spacing: CGFloat = 3.5
    private let quiet: CGFloat = 4    // height of a bar with nothing to show
    private let loud: CGFloat = 58    // height of the middle bar at full level

    var body: some View {
        Button(action: { if !live { start() } }) {
            ZStack {
                Circle()
                    .fill(live ? Color.accentColor.opacity(0.12) : Color(.secondarySystemBackground))
                    .frame(width: size, height: size)

                HStack(spacing: spacing) {
                    ForEach(0..<bars, id: \.self) { i in
                        Capsule()
                            .fill(live ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
                            .frame(width: barWidth, height: height(i))
                    }
                }
                .animation(.easeOut(duration: 0.1), value: level)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("listen")
        .accessibilityLabel("Listen")
        .accessibilityValue(status)
    }

    /// Tallest in the middle, tapering to the ends, all of it scaled by the level.
    private func height(_ i: Int) -> CGFloat {
        let middle = CGFloat(bars / 2)
        let taper = 1 - 0.62 * abs(CGFloat(i) - middle) / middle
        // Idle still shows the taper, so a resting button reads as a waveform rather
        // than a row of dots.
        let amount = live ? level : 0.3
        return quiet + (loud - quiet) * amount * taper
    }
}

#Preview {
    VStack(spacing: 30) {
        ListenButton(live: false, level: 0, status: "idle") {}
        ListenButton(live: true, level: 0.25, status: "live") {}
        ListenButton(live: true, level: 1.0, status: "live") {}
    }
}
