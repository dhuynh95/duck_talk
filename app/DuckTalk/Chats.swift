import SwiftUI

/// One conversation Claude Code has in this project — including the ones you started
/// in a terminal, since it is the same store either way.
struct Chat: Identifiable, Codable, Hashable {
    let id: String
    /// When it was last written to, in milliseconds.
    let at: Double
    let title: String
}

/// One exchange from a past chat, as it would have been spoken. `uuid` is where a
/// fork can cut the conversation — which is why only lines that came from a stored
/// chat can be forked from, and lines just spoken cannot.
struct ChatMessage: Codable, Hashable {
    let uuid: String
    let role: String  // "user" or "model"
    let text: String
}

/// The chats, over the drawer's left edge.
///
/// Tapping a row does not start anything. It loads the conversation onto the home
/// screen and points the next session at it, so the listen button becomes the resume
/// button — there is no second word for the same act.
struct ChatsDrawer: View {
    let serverURL: String
    @Binding var open: Bool
    let current: Chat?
    let onOpen: (Chat, [ChatMessage]) -> Void
    let onNew: () -> Void

    @State private var store = RelayStore()
    @State private var opening: Chat?

    private let width: CGFloat = 300

    var body: some View {
        ZStack(alignment: .leading) {
            if open {
                // Tap anywhere else to put it away, the way the drag would.
                Color.black.opacity(0.45)
                    .ignoresSafeArea()
                    .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { open = false } }
                    .transition(.opacity)

                panel
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    // Only the colour reaches under the status bar; the content stays
                    // inside it, or the title sits beneath the clock.
                    .background(Color(.systemBackground).ignoresSafeArea())
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.easeOut(duration: 0.2), value: open)
        .onChange(of: open) { if open { store.connect(to: serverURL) } else { store.disconnect() } }
        // The messages arrive after the row is tapped, so the chat opens when they do.
        .onChange(of: store.loaded) {
            guard let chat = opening, store.loaded == chat.id else { return }
            opening = nil
            onOpen(chat, store.messages)
            open = false
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Duck Talk")
                .font(.title2.weight(.semibold))
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 12)

            if store.chats.isEmpty {
                empty
            } else {
                List {
                    ForEach(sections, id: \.name) { section in
                        Section(section.name) {
                            ForEach(section.chats) { chat in
                                Button { openChat(chat) } label: { row(chat) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .listStyle(.plain)
            }

            Button {
                onNew()
                open = false
            } label: {
                Label("New chat", systemImage: "plus")
                    .font(.callout.weight(.medium))
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(Color(.secondarySystemBackground), in: Capsule())
            }
            .buttonStyle(.plain)
            .padding(16)
            .accessibilityIdentifier("new-chat")
        }
    }

    private func row(_ chat: Chat) -> some View {
        HStack(spacing: 8) {
            Text(chat.title)
                .lineLimit(1)
                .foregroundStyle(chat.id == current?.id ? .primary : .secondary)
            Spacer()
            if opening?.id == chat.id {
                ProgressView().controlSize(.mini)
            } else {
                Text(ago(chat.at)).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityLabel(chat.title)
    }

    private func openChat(_ chat: Chat) {
        opening = chat
        store.openChat(chat.id)
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Text("No chats yet.").font(.headline)
            Text("Every conversation with Claude Code in this project shows up here — including the ones you start in a terminal.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let error = store.error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(24)
        .frame(maxHeight: .infinity)
    }

    /// Today, Yesterday, then the rest — the only grouping worth the width.
    private var sections: [(name: String, chats: [Chat])] {
        let calendar = Calendar.current
        var today: [Chat] = [], yesterday: [Chat] = [], earlier: [Chat] = []
        for chat in store.chats {
            let date = Date(timeIntervalSince1970: chat.at / 1000)
            if calendar.isDateInToday(date) { today.append(chat) }
            else if calendar.isDateInYesterday(date) { yesterday.append(chat) }
            else { earlier.append(chat) }
        }
        return [("Today", today), ("Yesterday", yesterday), ("Earlier", earlier)]
            .filter { !$0.1.isEmpty }
            .map { (name: $0.0, chats: $0.1) }
    }

    private func ago(_ at: Double) -> String {
        let seconds = Date().timeIntervalSince1970 - at / 1000
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86_400))d"
    }
}
