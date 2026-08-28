import SwiftUI

/// A live voice waveform: a row of bars that ripples continuously so the screen
/// looks alive the moment a session is up, and swells with `level` (0…1) when the
/// mic or the speaker is actually carrying sound. One amplitude, one colour — the
/// least that reads as "I'm listening / I'm talking".
struct Waveform: View {
    /// 0…1 loudness from `VoiceSession.level`.
    var level: CGFloat

    private let bars = 27
    private let barWidth: CGFloat = 4
    private let spacing: CGFloat = 4
    private let maxHeight: CGFloat = 44
    private let minHeight: CGFloat = 4
    private let idle: CGFloat = 0.18  // resting amplitude when silent, so it never flatlines

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: spacing) {
                ForEach(0..<bars, id: \.self) { i in
                    Capsule()
                        .fill(Color.accentColor)
                        .frame(width: barWidth, height: height(i, t))
                }
            }
            .frame(height: maxHeight)
            .animation(.easeOut(duration: 0.12), value: level)
        }
        .accessibilityHidden(true)
    }

    private func height(_ i: Int, _ t: Double) -> CGFloat {
        let wave = 0.5 + 0.5 * sin(t * 3 + Double(i) * 0.5)  // traveling ripple, 0…1
        let amp = idle + (1 - idle) * level                  // silence rests at `idle`
        let shape = 0.35 + 0.65 * CGFloat(wave)
        return minHeight + (maxHeight - minHeight) * amp * shape
    }
}
