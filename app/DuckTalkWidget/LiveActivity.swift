import ActivityKit
import SwiftUI
import WidgetKit

/// The session as it looks once the screen is off — a card on the Lock Screen, and a
/// pill in the Dynamic Island while you are in another app.
///
/// This view draws and nothing else. A Live Activity buys no background time: the
/// microphone keeps running because of the `audio` entry in UIBackgroundModes, and
/// deleting every line here would leave the session running exactly as it is, just
/// invisible. Which is the reason to have it — a thing that runs commands from your
/// pocket should say so somewhere you can see without unlocking.
struct DuckTalkLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveSession.self) { context in
            card(context.state, since: context.attributes.startedAt)
                .padding(16)
                .activityBackgroundTint(.black.opacity(0.6))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Image(systemName: "waveform")
                        elapsed(context.attributes.startedAt).font(.caption.monospacedDigit())
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    stop
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(line(context.state)).font(.callout).lineLimit(2)
                }
            } compactLeading: {
                Image(systemName: "waveform")
            } compactTrailing: {
                elapsed(context.attributes.startedAt).monospacedDigit()
            } minimal: {
                Image(systemName: "waveform")
            }
        }
    }

    /// Two lines: whether it is still listening, and the last thing said. Anything
    /// more is unreadable at arm's length on a locked phone.
    private func card(_ state: LiveSession.ContentState, since startedAt: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "waveform")
                    .foregroundStyle(state.status == "live" ? .green : .orange)
                Text(state.status == "live" ? "Listening" : state.status.capitalized)
                    .font(.headline)
                Spacer()
                elapsed(startedAt).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                stop
            }
            Text(line(state))
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// End the session without unlocking. The intent runs in the app, so this really
    /// does stop the microphone rather than only clearing the card away.
    private var stop: some View {
        Button(intent: StopListening()) {
            Image(systemName: "xmark")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(.red, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop listening")
    }

    /// What you are saying wins over what was said: the newer of the two is the one
    /// worth a glance, and only one line fits.
    private func line(_ state: LiveSession.ContentState) -> String {
        if !state.heard.isEmpty { return state.heard }
        if !state.said.isEmpty { return state.said }
        return "Say something."
    }

    /// Counted by the system from the start date, so the card keeps ticking between
    /// updates instead of freezing at whatever the app last sent.
    private func elapsed(_ startedAt: Date) -> Text {
        Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
    }
}

@main
struct DuckTalkWidgets: WidgetBundle {
    var body: some Widget {
        DuckTalkLiveActivity()
    }
}
