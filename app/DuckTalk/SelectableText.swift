import SwiftUI

/// A message in the transcript, as text you can take a piece of.
///
/// SwiftUI's own `.textSelection(.enabled)` selects a `Text` whole — one long press
/// takes the entire message and offers Copy, with no handles to drag and no way to lift
/// a sentence out of a paragraph. That is not what selecting text means on this phone.
/// The behaviour everyone knows — long press grabs a word, two handles widen it, the
/// menu offers Copy and Select All and Look Up — belongs to UIKit's text interaction,
/// and there is no way to reach it from a `Text`. So the transcript's words are a
/// `UITextView` that cannot be edited, and everything else about the rows is unchanged.
///
/// It takes no font and no colour. Both callers draw body text in `Brand.text`, and a
/// parameter that is always given the same value is a parameter to delete.
///
/// Two settings do the load-bearing work. `isScrollEnabled = false` turns the text view
/// from a scroll view into something that reports its own height, which is what lets it
/// sit in the transcript's `LazyVStack` and hug its text the way the user bubble needs —
/// and it also stops it competing with the transcript for the scroll gesture. And the
/// zeroed insets make it start exactly where a `Text` would, so the padding around it in
/// `ContentView` still means what it says.
struct SelectableText: UIViewRepresentable {
    let text: String

    init(_ text: String) { self.text = text }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        // Claude is told never to write a URL, and a phone number in a sentence about
        // code is a false positive — so nothing here is a link, and a long press is
        // always a selection.
        view.dataDetectorTypes = []
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        // Assigning the same string would collapse a selection the user is still
        // dragging — and a streaming reply assigns on every token.
        if view.text != text { view.text = text }
        view.font = .preferredFont(forTextStyle: .body)
        view.textColor = UIColor(Brand.text)
    }

    /// The height the text really needs at the width it is offered — asked of the text
    /// view rather than guessed, which is the whole reason `isScrollEnabled` is off.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? .greatestFiniteMagnitude
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
}
