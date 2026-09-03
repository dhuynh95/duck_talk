import SwiftUI

/// A picture on its way to Claude, and the square that draws one.
///
/// The id is minted here on the phone rather than by the relay, because it has to exist
/// before any socket does: a picture chosen with nothing running is still that picture
/// when you finally press send. It is the same kind of id a clip has — the moment it
/// happened — so the relay files it under that name and the turn log needs no index.
///
/// One format, JPEG, capped at 1568 points on the long edge. The model downsamples past
/// that anyway, so resolution is the knob that matters and the codec is not; a phone
/// screenshot lands around 170 KB, which is a frame on the wire and nothing on disk.
struct Attachment: Identifiable {
    let id: Double
    let data: Data

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

/// A picture to draw, which is either one this phone still has or one the relay does.
///
/// Both states are real and neither is a fallback for the other. A picture picked on this
/// phone is in hand from the moment it is chosen — before any socket exists to send it on
/// — so a line just sent draws instantly and asks nobody. A chat reopened next week has
/// only ids, because sending a month of JPEGs to draw a row of thumbnails is the one
/// thing worth not doing.
///
/// Drawing the just-sent one by id is what an earlier version did, and it lost a race it
/// could not win: the transcript row appears the moment you press send, which is before
/// the socket carrying the picture has reached the relay.
enum Picture {
    /// Picked on this phone, and in hand.
    case picked(Data)
    /// Sent, and kept by the relay under this id.
    case stored(Double)
}

/// One picture, small — in the composer while it waits to be sent, and in the transcript
/// once it has been. Tapping it shows it full size, which is the whole reason a thumbnail
/// is worth drawing: a 62-point screenshot is a rectangle.
struct AttachThumb: View {
    let source: Picture
    let serverURL: String
    /// Present only in the composer: a picture already sent cannot be taken back.
    var onRemove: (() -> Void)?

    @State private var fetched: Data?
    @State private var full = false

    private static let side: CGFloat = 62

    private var bytes: Data? {
        if case .picked(let data) = source { return data }
        return fetched
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button { if bytes != nil { full = true } } label: {
                Group {
                    if let bytes, let image = UIImage(data: bytes) {
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
            .accessibilityLabel("Picture")

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
                .accessibilityLabel("Remove picture")
            }
        }
        .task(id: id) { await load() }
        .fullScreenCover(isPresented: $full) {
            if let bytes, let image = UIImage(data: bytes) { Preview(image: image) }
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

    /// The picture, as big as the screen. Tap anywhere to put it away — there is one
    /// thing on this view and one thing to do with it.
    private struct Preview: View {
        let image: UIImage
        @Environment(\.dismiss) private var dismiss

        var body: some View {
            ZStack {
                Color.black.ignoresSafeArea()
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            }
            .contentShape(Rectangle())
            .onTapGesture { dismiss() }
            .accessibilityIdentifier("attachment-full")
            .accessibilityLabel("Picture, full size. Tap to close.")
        }
    }
}
