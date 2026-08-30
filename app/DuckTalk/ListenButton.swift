import SwiftUI

/// What a control sits on: `plain` for a glyph you press on a surface, `accent` for the
/// one that is what you are about to do, `glass` for one floating over the conversation
/// itself, and `bare` for the waveform — which is your voice rather than a button face,
/// and wears no chrome.
enum SlotFill { case bare, plain, accent, glass }

extension View {
    /// The one size and place every control in the bar shares, so swapping between the
    /// microphone, the send arrow and the stop moves nothing under your thumb.
    ///
    /// A glass one is the same circle with the treatment every floating thing gets —
    /// see `floating(in:)`, which is where the shadow comes from.
    @ViewBuilder
    func slot(_ fill: SlotFill = .plain) -> some View {
        let sized = frame(width: 38, height: 38).contentShape(Circle())
        switch fill {
        case .bare: sized
        case .plain: sized.background(Circle().fill(Brand.fill))
        case .accent: sized.background(Circle().fill(Brand.accent))
        case .glass: sized.floating(in: Circle())
        }
    }
}

/// The face of that control that belongs to the microphone: silent, it is a
/// microphone; listening, it is your voice.
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

    private let bars = 7
    private let barWidth: CGFloat = 3
    private let spacing: CGFloat = 3
    private let quiet: CGFloat = 3    // height of a bar with nothing to show
    private let loud: CGFloat = 26    // height of the middle bar at full level

    var body: some View {
        Button(action: { if !live { start() } }) {
            if live {
                HStack(spacing: spacing) {
                    ForEach(0..<bars, id: \.self) { i in
                        Capsule()
                            .fill(Brand.accent)
                            .frame(width: barWidth, height: height(i))
                    }
                }
                .animation(.easeOut(duration: 0.1), value: level)
                .slot(.bare) // your voice, not a button — it needs nothing behind it
            } else {
                // A waveform with nothing to show is a row of dots that says nothing.
                // Silent, the control names what it does instead — and it is the one
                // thing lit on the screen, which is the whole of "tap to talk".
                Image(systemName: "mic.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Brand.background)
                    .slot(.accent)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("listen")
        .accessibilityLabel("Listen")
        .accessibilityValue(status)
    }

    /// Tallest in the middle, tapering to the ends, all of it scaled by the level.
    ///
    /// The floor is what keeps a listening-but-silent moment looking like a waveform
    /// rather than a row of dots: at rest it has a shape, and your voice grows it.
    private func height(_ i: Int) -> CGFloat {
        let middle = CGFloat(bars / 2)
        let taper = 1 - 0.62 * abs(CGFloat(i) - middle) / middle
        return quiet + (loud - quiet) * max(level, 0.22) * taper
    }
}

#Preview {
    VStack(spacing: 30) {
        ListenButton(live: false, level: 0, status: "idle") {}
        ListenButton(live: true, level: 0.25, status: "live") {}
        ListenButton(live: true, level: 1.0, status: "live") {}
    }
}
