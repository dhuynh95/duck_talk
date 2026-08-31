import SwiftUI

@main
struct DuckTalkApp: App {
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
