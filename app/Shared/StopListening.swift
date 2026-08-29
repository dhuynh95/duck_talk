import AppIntents

/// The one thing you can do to a session from a locked phone: end it.
///
/// A `LiveActivityIntent` runs in the *app's* process rather than the widget's,
/// which is the whole reason the button can work: it ends the session that is
/// actually holding the microphone, instead of a second process trying to describe
/// one it cannot see.
///
/// This file is compiled into both targets, and only one of them has a session. The
/// widget needs the type to draw a `Button`; the app fills in what pressing it does.
struct StopListening: LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop"
    static let description = IntentDescription("Stop listening and end the session.")
    /// A button on a card, not a shortcut anyone should find in the Shortcuts app.
    static let isDiscoverable = false
    /// Pressing it must not pull you into the app — the point is to stop without
    /// unlocking.
    static let openAppWhenRun = false

    /// What the app does when the button is pressed, installed at launch. It stays
    /// empty in the widget, which draws the button but never runs it.
    @MainActor static var action: () -> Void = {}

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        Self.action()
        return .result()
    }
}
