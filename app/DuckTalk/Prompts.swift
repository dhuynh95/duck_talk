import SwiftUI

/// One thing the relay says to a model, as the relay describes it.
///
/// Everything here comes down the socket, including `title`, `detail` and `live` —
/// so this file knows there are prompts but not which ones, and a prompt added on the
/// Mac appears here with nothing to change.
struct Prompt: Identifiable, Codable, Hashable {
    let name: String
    let title: String
    /// What it does and when it takes effect, in the relay's own words.
    let detail: String
    /// Whether an edit reaches the session already running. The voice style is re-read
    /// per sentence, so it does; Claude's is fixed when its session opens, so it does
    /// not — and a row that cannot do what it says is better closed than explained.
    let live: Bool
    let text: String

    var id: String { name }
}

/// What the relay says to each model. Tap one to edit it.
struct PromptsView: View {
    let serverURL: String
    @State private var store = RelayStore()
    @State private var path: [Prompt] = []
    @Environment(\.dismiss) private var dismiss

    /// A session is running, so a prompt that binds at connect is not yours to change.
    private var live: Bool { VoiceSession.shared.status != .idle }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    ForEach(store.prompts) { prompt in
                        NavigationLink(value: prompt) { row(prompt) }
                            .disabled(!prompt.live && live)
                            // On the link, not on the row inside it, or the identifier
                            // lands on both and matches twice.
                            .accessibilityIdentifier("prompt-\(prompt.name)")
                            .accessibilityLabel(prompt.title)
                    }
                } footer: {
                    if live {
                        Text("A prompt that is fixed when a session starts can be changed once you stop this one.")
                    }
                }
                if let error = store.error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle("Prompts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .navigationDestination(for: Prompt.self) { prompt in
                PromptDetail(prompt: prompt, draft: prompt.text) { edited in
                    store.savePrompt(prompt.name, edited)
                    path.removeLast()
                }
            }
        }
        .onAppear { store.connect(to: serverURL) }
        .onDisappear { store.disconnect() }
    }

    /// The name, then the prompt's own first line — enough to tell two apart without
    /// opening either.
    private func row(_ prompt: Prompt) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(prompt.title).font(.body)
            Text(prompt.text.isEmpty ? "Not set" : prompt.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// One prompt, being written. A full screen, because Claude's is a page of prose and
/// the voice's is a sentence, and the same editor has to suit both.
///
/// The draft is seeded once from the row and never from the socket, so the relay's
/// answer to your own save cannot overwrite what you are typing.
private struct PromptDetail: View {
    let prompt: Prompt
    @State var draft: String
    let onSave: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            TextEditor(text: $draft)
                .font(.callout)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 12)
                .autocorrectionDisabled()
                .accessibilityIdentifier("prompt-text")
                .accessibilityLabel(prompt.title)

            Text(prompt.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color(.secondarySystemBackground))
        }
        .navigationTitle(prompt.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { onSave(draft) }.disabled(draft == prompt.text)
            }
        }
    }
}
