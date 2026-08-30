import SwiftUI

@main
struct DuckTalkApp: App {
    /// Say what the lock screen's Stop button does, before anything can press it.
    /// The system may launch this process *because* of that press, so the wiring
    /// belongs here — the earliest code the app runs — and not in a view that a
    /// backgrounded launch never shows.
    init() {
        StopListening.action = { VoiceSession.shared.stop() }
    }

    var body: some Scene {
        WindowGroup {
            // Reduck is dark-theme-first — the light theme is not a theme yet — so the
            // app is one palette rather than two, and Brand's roles are that palette.
            ContentView()
                .preferredColorScheme(.dark)
                .foregroundStyle(Brand.text) // never pure white on dark
        }
    }
}
