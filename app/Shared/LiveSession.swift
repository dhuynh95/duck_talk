import ActivityKit
import Foundation

/// What the lock screen knows about a running session.
///
/// A voice session outlives the screen: you start it, put the phone in your pocket,
/// and keep talking. From that moment this is the only place the session is visible,
/// and the only way to tell one that is still listening from one that quietly died.
///
/// Compiled into both the app and the widget extension, because a Live Activity is
/// two processes agreeing on a shape: the app requests and updates it, the extension
/// draws it, and this file is the only thing they share.
///
/// The fields are a projection of what `VoiceSession` already publishes, not a second
/// copy of it. They are pushed at turn boundaries rather than per token — the system
/// budgets how often a Live Activity may change, and a lock screen redrawn on every
/// word would be unreadable anyway.
struct LiveSession: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// `VoiceSession.Status` as text; this file cannot see that type.
        var status: String
        /// The microphone is sending silence. Projected here so the card can draw the
        /// mute button in the state it is in, and say "Muted" when nothing is heard.
        var muted: Bool
        /// What you are saying now, or the instruction being held for review.
        var heard: String
        /// The last thing Claude said.
        var said: String
    }

    /// When Listen was tapped, so the card can count the session up on its own
    /// without being sent the time.
    var startedAt: Date
}
