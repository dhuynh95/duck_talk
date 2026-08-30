import ActivityKit
import AppIntents
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
                // Solid, not translucent: a card that lets the wallpaper through takes
                // its colour from whatever photo is behind it, and grey-900 stops being
                // grey-900. The system already floats this thing; it needs no help.
                .activityBackgroundTint(Brand.background)
                .activitySystemActionForegroundColor(Brand.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        mark(20)
                        elapsed(context.attributes.startedAt)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Brand.tertiaryText)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 8) {
                        mute(context.state)
                        stop
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(line(context.state))
                        .font(.callout)
                        .foregroundStyle(Brand.secondaryText)
                        .lineLimit(2)
                }
            } compactLeading: {
                mark(18)
            } compactTrailing: {
                // Orange for the same reason it is orange in the app: a session is
                // running. This is the whole of the island when you are in another app.
                elapsed(context.attributes.startedAt)
                    .monospacedDigit()
                    .foregroundStyle(Brand.accent)
            } minimal: {
                mark(18)
            }
        }
    }

    /// The duck, from Shared/Brand.xcassets — the app's own face rather than a system
    /// glyph, which is what makes the island recognisably this app at a glance.
    private func mark(_ size: CGFloat) -> some View {
        Image("Logo")
            .resizable()
            .scaledToFit()
            .frame(width: size)
    }

    /// Who is running, for how long, how to stop it — and the one line that changes.
    ///
    /// Four things, no more: at arm's length on a locked phone the only question is
    /// what it is hearing, and everything else is there to say the session is alive and
    /// to end it.
    private func card(_ state: LiveSession.ContentState, since startedAt: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                mark(26)
                Text("Duck Talk").font(.headline)
                Spacer()
                elapsed(startedAt).font(.subheadline.monospacedDigit()).foregroundStyle(Brand.tertiaryText)
                mute(state)
                stop
            }
            Text(line(state))
                .font(.callout)
                .foregroundStyle(Brand.secondaryText)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// End the session without unlocking. The intent runs in the app, so this really
    /// does stop the microphone rather than only clearing the card away.
    ///
    /// The same plain circle the app's own stop wears. It was red, which was the only
    /// red in the product and made ending a session look like deleting something.
    private var stop: some View {
        control("xmark", intent: StopListening(), label: "Stop listening")
    }

    /// Stop being heard without ending the session. Lit on the accent while muted —
    /// the same rule as the composer, where the orange leaves the border and lands here.
    private func mute(_ state: LiveSession.ContentState) -> some View {
        control("mic.slash", intent: MuteListening(), label: state.muted ? "Unmute" : "Mute", accent: state.muted)
    }

    /// One face for both buttons, so they read as a pair here and as the pair in the
    /// app's composer. The intent runs in the app, which is what makes either work.
    private func control(_ symbol: String, intent: some LiveActivityIntent, label: String, accent: Bool = false) -> some View {
        Button(intent: intent) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(accent ? Brand.background : Brand.text)
                .frame(width: 34, height: 34)
                .background(accent ? Brand.accent : Brand.fill, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    /// The line being sent, which is what the card is for. What you are saying wins
    /// over what was answered: the newer of the two is the one worth a glance, and only
    /// one line fits. With neither, the state itself is the news — still listening, or
    /// reconnecting — which is why there is no separate row for it.
    private func line(_ state: LiveSession.ContentState) -> String {
        if !state.heard.isEmpty { return state.heard }
        if !state.said.isEmpty { return state.said }
        if state.muted { return "Muted" }
        return state.status == "live" ? "Listening" : state.status.capitalized
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
