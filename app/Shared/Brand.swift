import SwiftUI

/// The Reduck palette, as the app draws it — one name per role, and the brand's own
/// token beside each so the two can be checked against the guide.
///
/// Two rules from that guide decide everything here. Reduck is dark-theme-first, so
/// these are the dark theme and the app is pinned to it (see `DuckTalkApp`). And the
/// neutrals are Reduck's own slate greys, not the system's: iOS dark mode grounds a
/// screen in pure black and paints primary text pure white, and the guide rules out
/// both.
///
/// The hexes are the web app's own tokens, from its `src/lib/styles/colorPalette.css`.
///
/// The accent lives here and once more outside this file, as `AccentColor` in
/// Shared/Brand.xcassets, because a cursor, a toolbar button and a list checkmark are
/// tinted by the system rather than drawn by us. Same orange, two consumers.
enum Brand {
    /// Under everything. grey-900.
    static let background = Color(hex: 0x111827)
    /// Anything that sits on the background and has to be seen to: a list row, a sheet's
    /// card, the search box. grey-800.
    static let surface = Color(hex: 0x1F2937)
    /// A control's own ground — the circle behind a glyph, the mode capsule. grey-700.
    static let fill = Color(hex: 0x2C3644)
    /// grey-600.
    static let border = Color(hex: 0x4B5563)
    /// The primary accent, which in the dark theme is brand-400.
    static let accent = Color(hex: 0xFB923C)
    /// grey-100.
    static let text = Color(hex: 0xF3F4F6)
    /// grey-300.
    static let secondaryText = Color(hex: 0xD1D5DB)
    /// grey-400.
    static let tertiaryText = Color(hex: 0x9CA3AF)
}

extension View {
    /// The one treatment for anything that floats over the conversation: glass, and a
    /// shadow under it.
    ///
    /// One rule decides the layout of both screens — what *is* the conversation is
    /// flat, what sits over it is glass — so the transcript and the chat list run edge
    /// to edge and scroll underneath the header, the composer and the New chat pill,
    /// rather than each losing a strip to a bar.
    ///
    /// The shadow is not decoration. A sentence scrolls right behind these, and blur
    /// alone leaves a glyph and the text under it in the same grey. Over grey-900 the
    /// blur lands about where grey-800 does, which is why glass can stand in for a
    /// surface without a second colour.
    func floating(in shape: some Shape) -> some View {
        background(.ultraThinMaterial, in: shape)
            .shadow(color: .black.opacity(0.5), radius: 10, y: 3)
    }

    /// A List or Form standing on the brand ground.
    ///
    /// Three lines because iOS paints two things we do not want and one we do: a
    /// near-black grouped background behind the list, a near-black fill behind every
    /// row, and nothing at all where grey-900 should be. Said once here so the settings
    /// screens each say it once.
    func brandList() -> some View {
        scrollContentBackground(.hidden)
            .background(Brand.background)
            .listRowBackground(Brand.surface)
    }
}

extension Color {
    /// A palette entry as it is written in the brand guide: one 24-bit RGB number.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
        )
    }
}
