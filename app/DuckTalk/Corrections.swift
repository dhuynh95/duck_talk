import SwiftUI

/// One thing the ears keep getting wrong, and what was actually said.
struct Correction: Identifiable, Codable, Hashable {
    let at: Double
    var heard: String
    var meant: String

    var id: Double { at }
}

/// The corrections screen's own connection to the relay.
///
/// The relay owns the file; this holds no list of its own between visits, and every
/// message it sends is answered with the whole list, so what is on screen is what is
/// on disk. `?data=1` opens Gemini and Claude, so this costs nothing to open while a
/// voice session is or is not running.
@Observable
@MainActor
final class CorrectionsStore {
    private(set) var items: [Correction] = []
    private(set) var error: String?

    private var task: URLSessionWebSocketTask?

    func connect(to serverURL: String) {
        guard task == nil, let url = URL(string: serverURL + "?data=1") else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task
        task.resume()
        Task {
            do {
                send(["type": "corrections"])
                while self.task != nil {
                    if case .string(let json) = try await task.receive() { receive(json) }
                }
            } catch let failure {
                if self.task != nil { error = failure.localizedDescription }
            }
        }
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    func save(_ correction: Correction) {
        send(["type": "correction_save", "at": correction.at, "heard": correction.heard, "meant": correction.meant])
    }

    func delete(_ correction: Correction) {
        send(["type": "correction_delete", "at": correction.at])
    }

    private struct List: Decodable { let items: [Correction] }

    private func receive(_ json: String) {
        guard let data = json.data(using: .utf8),
              let list = try? JSONDecoder().decode(List.self, from: data) else { return }
        items = list.items.reversed()  // newest first: the one you just fixed is on top
        error = nil
    }

    private func send(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(json)) { _ in }
    }
}

/// What the ears keep mishearing, and what you actually said. Swipe to delete, tap to
/// edit, `+` to add one by hand.
struct CorrectionsView: View {
    let serverURL: String
    @State private var store = CorrectionsStore()
    @State private var path: [Correction] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if store.items.isEmpty { empty } else { list }
            }
            .navigationTitle("Corrections")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { path.append(blank()) } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add correction")
                }
            }
            .navigationDestination(for: Correction.self) { correction in
                CorrectionDetail(
                    correction: correction,
                    isNew: !store.items.contains { $0.id == correction.id },
                    onSave: { edited in store.save(edited); path.removeLast() },
                    onDelete: { store.delete(correction); path.removeLast() },
                )
            }
        }
        .onAppear { store.connect(to: serverURL) }
        .onDisappear { store.disconnect() }
    }

    private var list: some View {
        List {
            Section {
                ForEach(store.items) { correction in
                    NavigationLink(value: correction) { row(correction) }
                }
                .onDelete { offsets in offsets.map { store.items[$0] }.forEach(store.delete) }
            } footer: {
                Text("Used to bias the recogniser when a session starts, and to auto-correct what you said.")
            }
        }
    }

    private func row(_ correction: Correction) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(correction.heard)
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(.tertiary)
                Text(correction.meant).font(.callout)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Text("Nothing learned yet.")
                .font(.headline)
            Text("Turn on Review, and when the ears mishear you, fix the text before you accept it. That edit lands here.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Add one by hand") { path.append(blank()) }
                .buttonStyle(.bordered)
            if let error = store.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(32)
    }

    /// A correction that does not exist yet. `at` is its id from the moment it is made,
    /// so saving it once creates it and saving it again edits the same row.
    private func blank() -> Correction {
        Correction(at: Date().timeIntervalSince1970 * 1000, heard: "", meant: "")
    }
}

/// One correction, being written. The same screen adds and edits; only an existing
/// one can be deleted. Going back leaves it as it was — Save is what writes.
private struct CorrectionDetail: View {
    @State var correction: Correction
    let isNew: Bool
    let onSave: (Correction) -> Void
    let onDelete: () -> Void

    private var complete: Bool {
        !correction.heard.trimmingCharacters(in: .whitespaces).isEmpty
            && !correction.meant.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        Form {
                // Never "corrected" — iOS autocorrect rewrites the very words you are
                // here to fix.
            Section("What it heard") {
                    TextField("what the ears produced", text: $correction.heard, axis: .vertical)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityLabel("Heard")
                }
                Section("What you meant") {
                    TextField("what you actually said", text: $correction.meant, axis: .vertical)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityLabel("Meant")
                }
            if !isNew {
                Section {
                    Button("Delete", role: .destructive) { onDelete() }
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle(isNew ? "New correction" : "Correction")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { onSave(correction) }.disabled(!complete)
            }
        }
    }
}
