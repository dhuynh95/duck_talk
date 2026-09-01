import PhotosUI
import SwiftUI

/// What you add to a turn besides words: a picture, and what Claude is allowed to do
/// with it.
///
/// Those two look unrelated and are not. Both are things you settle *about the next
/// instruction* rather than things you say — and permission is here rather than in the
/// bar because of how it is used: you glance at the model every turn and you set the
/// permission once and forget it. The bar holds what you check, this holds what you
/// change. On the wire they are identical, both riding the `claude` frame onto the
/// session already running, so moving it cost nothing.
///
/// The recents strip is the whole point of not just opening the system picker: the
/// picture you want is almost always the screenshot you just took. Everything else is
/// behind All photos, which needs no authorisation — so a refused library leaves this
/// sheet whole rather than empty.
///
/// Picking closes the sheet. One tap is one picture; two pictures is `+` twice, which is
/// cheaper than a selection mode with a Done button over it.
struct ContextSheet: View {
    @Binding var permissionName: String
    let onPick: (Data) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var recents = Recents()
    @State private var camera = false
    @State private var library: [PhotosPickerItem] = []
    /// The permission rows have taken the sheet over. Swapped in place rather than
    /// presented: `ModelSheet` records why — a second sheet raised from inside the first
    /// races its own dismissal and lands on no sheet at all.
    @State private var choosingPermission = false

    private var permission: Permission { Permission(rawValue: permissionName) ?? .plan }

    var body: some View {
        if choosingPermission {
            ChoiceSheet(title: "What Claude may do", choices: Permission.choices, picked: $permissionName)
        } else {
            picker
        }
    }

    private var picker: some View {
        VStack(spacing: 0) {
            header
            strip
            permissionRow
            Spacer(minLength: 0)
        }
        .task { await recents.load() }
        .fullScreenCover(isPresented: $camera) {
            Camera { image in
                if let data = Attachment.jpeg(image) { onPick(data) }
                dismiss()
            }
            .ignoresSafeArea()
        }
        // Several at once is free here, where the system picker already has a selection
        // mode of its own — so this is the one door where picking two is one trip.
        .onChange(of: library) {
            guard !library.isEmpty else { return }
            let items = library
            library = []
            Task {
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self),
                          let image = UIImage(data: data),
                          let jpeg = Attachment.jpeg(image) else { continue }
                    onPick(jpeg)
                }
                dismiss()
            }
        }
        .presentationDetents([.height(300)])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        ZStack {
            Text("Add context").font(.headline)
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Brand.secondaryText)
                        .frame(width: 34, height: 34)
                        .background(Brand.fill, in: Circle())
                }
                .accessibilityLabel("Close")
                Spacer()
                PhotosPicker(selection: $library, matching: .images) {
                    Text("All photos")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Brand.text)
                }
                .accessibilityIdentifier("all-photos")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 16)
    }

    /// Camera first, then what you shot most recently — one row, scrolling sideways.
    private var strip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                Button { camera = true } label: {
                    VStack(spacing: 8) {
                        Image(systemName: "camera").font(.title2)
                        Text("Camera").font(.footnote.weight(.medium))
                    }
                    .foregroundStyle(Brand.text)
                    .frame(width: 104, height: 104)
                    .background(Brand.fill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("camera")

                ForEach(recents.items) { item in
                    Button { pick(item) } label: {
                        Image(uiImage: item.thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 104, height: 104)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("recent")
                    .accessibilityLabel("Recent photo")
                }
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
        .frame(height: 104)
    }

    private var permissionRow: some View {
        Button { choosingPermission = true } label: {
            HStack(spacing: 12) {
                // The rung's own icon, so the row says which one you are on twice.
                Image(systemName: permission.icon)
                    .font(.body)
                    .foregroundStyle(.tint)
                    .frame(width: 22)
                Text("Permission").font(.body).foregroundStyle(Brand.text)
                Spacer()
                Text(permission.title).font(.body).foregroundStyle(Brand.secondaryText)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Brand.tertiaryText)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .background(Brand.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .accessibilityIdentifier("permission")
        .accessibilityLabel("What Claude may do")
        .accessibilityValue(permission.title)
    }

    private func pick(_ item: Recents.Item) {
        Task {
            if let image = await recents.full(item), let data = Attachment.jpeg(image) { onPick(data) }
            dismiss()
        }
    }
}

/// The last few pictures in the library, as thumbnails.
///
/// Read straight from PhotoKit rather than through the system picker, because the whole
/// value is skipping a trip: the screenshot you took a minute ago is one tap away. That
/// costs an authorisation, and refusing it costs only this row — All photos above still
/// works, so nothing here fails loudly.
@MainActor
@Observable
final class Recents {
    struct Item: Identifiable {
        let id: String
        let asset: PHAsset
        let thumbnail: UIImage
    }

    private(set) var items: [Item] = []

    /// How many fit in a sideways glance. Past that you wanted All photos.
    private static let count = 12

    func load() async {
        guard items.isEmpty else { return }
        let status = await withCheckedContinuation { (c: CheckedContinuation<PHAuthorizationStatus, Never>) in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { c.resume(returning: $0) }
        }
        guard status == .authorized || status == .limited else { return }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = Self.count
        // Read out of the fetch result before anything is awaited: it is a live object,
        // and the loop below suspends.
        var assets: [PHAsset] = []
        PHAsset.fetchAssets(with: .image, options: options).enumerateObjects { asset, _, _ in assets.append(asset) }

        // Appended one at a time, so the strip fills as the thumbnails arrive rather
        // than all at once at the end — and so a slow one costs only its own square.
        for asset in assets {
            guard let thumbnail = await image(asset, side: 312, fill: true) else { continue }
            items.append(Item(id: asset.localIdentifier, asset: asset, thumbnail: thumbnail))
        }
    }

    /// The picture itself, at the size that will actually be sent — asked for only when
    /// one is tapped, so scrolling the strip never fetches from iCloud.
    func full(_ item: Item) async -> UIImage? {
        await image(item.asset, side: 1568, fill: false)
    }

    /// One picture out of PhotoKit, awaited — a thumbnail that fills its square, or the
    /// whole picture at the size that will be sent.
    ///
    /// Awaited because `requestImage` answers whenever it answers, which is after the
    /// loop that asked; reading its results as if they had already arrived is what left
    /// the strip empty the first time.
    ///
    /// Always the high-quality delivery, even for a 312-point thumbnail. `fastFormat`
    /// is the obvious choice there and it returns no image at all on this runtime —
    /// PHPhotosErrorDomain 3303, for every asset in the library, screenshots included.
    /// High quality at this size is a few milliseconds and cannot fail that way.
    private func image(_ asset: PHAsset, side: CGFloat, fill: Bool) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        return await withCheckedContinuation { (c: CheckedContinuation<UIImage?, Never>) in
            var answered = false
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: CGSize(width: side, height: side),
                contentMode: fill ? .aspectFill : .aspectFit,
                options: options,
            ) { image, info in
                // A degraded result means a better one is still coming, so it is not the
                // answer — and the continuation may only be resumed once either way.
                guard !answered, (info?[PHImageResultIsDegradedKey] as? Bool) != true else { return }
                answered = true
                c.resume(returning: image)
            }
        }
    }
}

/// The camera, which SwiftUI has no view for. Nothing to configure — one picture, taken
/// and handed back.
struct Camera: UIViewControllerRepresentable {
    let onShot: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onShot: onShot, onDone: { dismiss() }) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onShot: (UIImage) -> Void
        private let onDone: () -> Void

        init(onShot: @escaping (UIImage) -> Void, onDone: @escaping () -> Void) {
            self.onShot = onShot
            self.onDone = onDone
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { onShot(image) }
            onDone()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onDone() }
    }
}
