import SwiftUI

/// Something on its way to Claude beside the words — a picture, or a pasted text — and
/// the square that draws one.
///
/// The id is minted here on the phone rather than by the relay, because it has to exist
/// before any socket does: a picture chosen with nothing running is still that picture
/// when you finally press send. It is the same kind of id a clip has — the moment it
/// happened — so the relay files it under that name and the turn log needs no index.
///
/// A picture is one format, JPEG, capped at 1568 points on the long edge. The model
/// downsamples past that anyway, so resolution is the knob that matters and the codec is
/// not; a phone screenshot lands around 170 KB, which is a frame on the wire and nothing
/// on disk.
///
/// A paste is the text itself. It reaches Claude whole, as the API's own document block —
/// the way Claude.ai sends a long paste — and only its *display* collapses to a chip, the
/// way Claude Code shows `[Pasted text #1 +120 lines]` and sends every line.
struct Attachment: Identifiable {
    enum Content {
        case image(Data)
        case text(String)
    }

    let id: Double
    let content: Content

    /// The longest edge Claude's vision makes use of. Above it the bytes grow and
    /// nothing is read that was not read before.
    private static let cap: CGFloat = 1568

    /// A picture as it should travel, or nil if it cannot be encoded at all.
    static func jpeg(_ image: UIImage) -> Data? {
        let side = max(image.size.width, image.size.height)
        let scale = min(1, Self.cap / max(side, 1))
        // scale 1 in the format, so points are pixels: an image already the right size
        // is not tripled on a 3× screen on its way through the renderer.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let shrunk = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return shrunk.jpegData(compressionQuality: 0.8)
    }
}

/// One thing a line was given with, as it can be drawn: a picture this phone still has,
/// a picture the relay has, or a pasted text — which is small enough to always be in hand.
///
/// The two picture states are real and neither is a fallback for the other. A picture
/// picked on this phone is in hand from the moment it is chosen — before any socket
/// exists to send it on — so a line just sent draws instantly and asks nobody. A chat
/// reopened next week has only ids, because sending a month of JPEGs to draw a row of
/// thumbnails is the one thing worth not doing. A paste has no such split: the relay
/// sends it whole with the chat, because kilobytes of text cost less than a round trip.
///
/// Drawing the just-sent picture by id is what an earlier version did, and it lost a race
/// it could not win: the transcript row appears the moment you press send, which is
/// before the socket carrying the picture has reached the relay.
enum Piece {
    /// Picked on this phone, and in hand.
    case picked(Data)
    /// Sent, and kept by the relay under this id.
    case stored(Double)
    /// Pasted — in hand whether just sent or read back out of a stored chat.
    case text(String)

    /// What is pending, as it will be drawn once sent.
    init(_ attachment: Attachment) {
        switch attachment.content {
        case .image(let data): self = .picked(data)
        case .text(let text): self = .text(text)
        }
    }
}

extension Attachment {
    /// A piece back in hand — for a retract, which returns a just-sent line to the
    /// composer. Nil for a stored picture, which no just-sent line has. Id 0: the caller
    /// mints one.
    init?(_ piece: Piece) {
        switch piece {
        case .picked(let data): self.init(id: 0, content: .image(data))
        case .text(let text): self.init(id: 0, content: .text(text))
        case .stored: return nil
        }
    }
}

/// One piece, small — in the composer while it waits to be sent, and in the transcript
/// once it has been. Tapping it shows it full size, which is the whole reason a thumbnail
/// is worth drawing: a 62-point screenshot is a rectangle, and a 62-point paste is a tag.
struct AttachThumb: View {
    let source: Piece
    let serverURL: String
    /// Present only in the composer: a piece already sent cannot be taken back.
    var onRemove: (() -> Void)?

    @State private var fetched: Data?
    @State private var full = false

    private static let side: CGFloat = 62

    private var bytes: Data? {
        if case .picked(let data) = source { return data }
        return fetched
    }

    private var pasted: String? {
        if case .text(let text) = source { return text }
        return nil
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button { if bytes != nil || pasted != nil { full = true } } label: {
                Group {
                    if let pasted {
                        // The TXT tag and the opening words: enough to tell two pastes
                        // apart, and no more — the tap is what reads it.
                        VStack(alignment: .leading, spacing: 3) {
                            Text("TXT")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Brand.tertiaryText)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .overlay(Capsule().strokeBorder(Brand.border))
                            Text(pasted.trimmingCharacters(in: .whitespacesAndNewlines))
                                .font(.system(size: 9))
                                .foregroundStyle(Brand.secondaryText)
                                .lineLimit(3)
                                .multilineTextAlignment(.leading)
                        }
                        .padding(6)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    } else if let bytes, let image = UIImage(data: bytes) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        // Gone, or still coming. Either way there is nothing to show and
                        // nothing worth explaining in 62 points.
                        Image(systemName: "photo")
                            .font(.caption)
                            .foregroundStyle(Brand.tertiaryText)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .frame(width: Self.side, height: Self.side)
                .background(Brand.fill)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Brand.border.opacity(0.6), lineWidth: 0.5)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("attachment")
            .accessibilityLabel(pasted == nil ? "Picture" : "Pasted text")

            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.body)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(Brand.text, Brand.fill)
                }
                .buttonStyle(.plain)
                .offset(x: 6, y: -6)
                .accessibilityIdentifier("drop-attachment")
                .accessibilityLabel("Remove")
            }
        }
        .task(id: id) { await load() }
        .fullScreenCover(isPresented: $full) {
            if let pasted { Preview(text: pasted) }
            else if let bytes, let image = UIImage(data: bytes) { Preview(image: image) }
        }
    }

    private var id: Double? {
        if case .stored(let id) = source { return id }
        return nil
    }

    /// One socket, one question, one frame back — `Relay.ask`, the same door `ClipChip`
    /// uses, for the same reason: a picture is a blob asked for on demand, not state to be
    /// kept in step, so it does not belong in `RelayStore` and a thumbnail nobody scrolls
    /// to costs nothing.
    private func load() async {
        guard case .stored(let id) = source, fetched == nil else { return }
        fetched = await Relay.ask(serverURL, ["type": "image_get", "id": id])
    }

    /// The piece, as big as the screen: the picture scaled to fit, or the text to read.
    /// Tap anywhere to put it away — there is one thing on this view and one thing to do
    /// with it.
    private struct Preview: View {
        var image: UIImage?
        var text: String?
        @Environment(\.dismiss) private var dismiss

        var body: some View {
            ZStack {
                Color.black.ignoresSafeArea()
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                } else if let text {
                    ScrollView {
                        Text(text)
                            .font(.footnote.monospaced())
                            .foregroundStyle(Brand.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(20)
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { dismiss() }
            .accessibilityIdentifier("attachment-full")
            .accessibilityLabel("Full size. Tap to close.")
        }
    }
}
