import SwiftUI

/// The Reduck palette, as the app draws it.
///
/// Two rules from the brand guide decide everything here. Reduck is dark-theme-first,
/// so the roles below are the dark theme and the app is pinned to it (see
/// `DuckTalkApp`). And the neutrals are Reduck's own slate greys, not the system's:
/// iOS dark mode grounds a screen in pure black and paints primary text pure white,
/// and the guide rules both out — grey-900 under everything, grey-800 for a surface
/// that sits on it, grey-100 for the words.
///
/// Only the roles are used at call sites. The scale is here so a role can be re-pointed
/// at a different step without a new colour appearing in the app.
///
/// The accent is the one exception that also lives outside this file: `AccentColor` in
/// the asset catalogue carries the same orange, because a cursor, a toolbar button and
/// a list checkmark are tinted by the system rather than drawn by us.
enum Brand {
    // The scale, from src/lib/styles/colorPalette.css in the web app.
    static let grey100 = Color(hex: 0xF3F4F6)
    static let grey300 = Color(hex: 0xD1D5DB)
    static let grey400 = Color(hex: 0x9CA3AF)
    static let grey600 = Color(hex: 0x4B5563)
    static let grey700 = Color(hex: 0x2C3644)
    static let grey800 = Color(hex: 0x1F2937)
    static let grey900 = Color(hex: 0x111827)
    static let orange400 = Color(hex: 0xFB923C)

    /// Under everything.
    static let background = grey900
    /// Anything that sits on the background and has to be seen to: the composer, a
    /// list row, a sheet's card.
    static let surface = grey800
    /// A control's own ground — the circle behind a glyph, the mode capsule.
    static let fill = grey700
    static let border = grey600
    /// The primary accent, which in the dark theme is brand-400.
    static let accent = orange400
    static let text = grey100
    static let secondaryText = grey300
    static let tertiaryText = grey400

    /// What anything that floats over the conversation is made of.
    ///
    /// One rule decides the whole layout: what *is* the conversation is flat, and what
    /// sits over it is glass. So the transcript runs edge to edge and scrolls under the
    /// header and the composer, and those read as above it rather than as a strip that
    /// cost the conversation its room. Over grey-900 the blur lands about where grey-800
    /// does, which is why it can stand in for a surface without a second colour.
    static let floating: Material = .ultraThinMaterial
}

extension View {
    /// The one treatment for anything that floats over the conversation: glass, and a
    /// shadow under it.
    ///
    /// The shadow is not decoration. A sentence scrolls right behind these, and blur
    /// alone leaves a glyph and the text under it in the same grey — the dark edge is
    /// what separates the two, and it is the only thing that has to be true of every
    /// floating control, so it is said once here rather than at each of them.
    func floating(in shape: some Shape) -> some View {
        background(Brand.floating, in: shape)
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
