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
    /// The audio it was heard from, when the relay still has it — a week, unless a
    /// correction was taught from it. Only the id comes down with the chat; the sound
    /// is fetched if someone presses play.
    let clip: Double?
}

/// The chats, over the drawer's left edge.
///
/// Tapping a row does not start anything. It loads the conversation onto the home
/// screen and points the next session at it, so the listen button becomes the resume
/// button — there is no second word for the same act.
///
/// Searching is the same list with fewer rows in it: one filter on the way into the
/// grouping, so Today and Yesterday keep meaning what they mean and there is no second
/// results view to keep in step.
struct ChatsDrawer: View {
    let serverURL: String
    @Binding var open: Bool
    let current: Chat?
    let onOpen: (Chat, [ChatMessage]) -> Void
    let onNew: () -> Void

    @State private var store = RelayStore()
    @State private var opening: Chat?
    /// What is typed in the search field. Cleared when the drawer closes, so it opens
    /// showing everything rather than yesterday's search.
    @State private var query = ""

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
                    .background(Brand.background.ignoresSafeArea())
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.easeOut(duration: 0.2), value: open)
        .onChange(of: open) {
            if open { store.connect(to: serverURL) } else { store.disconnect(); query = "" }
        }
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
            HStack(spacing: 10) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 30)
                    .accessibilityHidden(true)
                Text("Duck Talk").font(.title3.weight(.medium))
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 12)

            if !store.chats.isEmpty { search }

            // The chats run to the bottom of the panel and New chat floats over them —
            // `safeAreaInset` is what makes those two facts one thing: the list scrolls
            // underneath the pill, and stops short of it by exactly its height, so the
            // last chat can always be reached and nothing is walled off in a strip.
            Group {
                if store.chats.isEmpty {
                    empty
                } else if sections.isEmpty {
                    Text("Nothing matches.")
                        .font(.callout)
                        .foregroundStyle(Brand.tertiaryText)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    // A stack rather than a List: the panel is the surface, and a List
                    // insists on painting its own — while the only thing it would buy
                    // here, swipe actions, is not something a chat has.
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(sections, id: \.name) { section in
                                Text(section.name)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Brand.tertiaryText)
                                    .padding(.horizontal, 20)
                                    .padding(.top, 14)
                                    .padding(.bottom, 6)
                                ForEach(section.chats) { chat in
                                    Button { openChat(chat) } label: {
                                        row(chat).padding(.horizontal, 20).padding(.vertical, 11)
                                    }
                                    .buttonStyle(.plain)
                                    Divider().overlay(Brand.fill).padding(.leading, 20)
                                }
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                    .scrollDismissesKeyboard(.immediately)
                }
            }
            .safeAreaInset(edge: .bottom) { newChat }
        }
    }

    /// The one thing in the drawer that is not a chat, so it is the one thing floating
    /// over them.
    private var newChat: some View {
        Button {
            onNew()
            open = false
        } label: {
            Label("New chat", systemImage: "plus")
                .font(.callout.weight(.medium))
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .floating(in: Capsule())
        }
        .buttonStyle(.plain)
        .padding(16)
        .accessibilityIdentifier("new-chat")
    }

    /// Filter the list rather than search it: the same rows, fewer of them. Only shown
    /// once there are chats, because a search box over "no chats yet" is furniture.
    private var search: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(Brand.tertiaryText)
            TextField("Search", text: $query)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .accessibilityIdentifier("chat-search")
                .accessibilityLabel("Search chats")
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.footnote)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Brand.tertiaryText)
                .accessibilityLabel("Clear search")
            }
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func row(_ chat: Chat) -> some View {
        HStack(spacing: 8) {
            Text(chat.title)
                .lineLimit(1)
                .foregroundStyle(chat.id == current?.id ? Brand.text : Brand.secondaryText)
            Spacer()
            if opening?.id == chat.id {
                ProgressView().controlSize(.mini)
            } else {
                Text(ago(chat.at)).font(.caption2).foregroundStyle(Brand.tertiaryText)
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
                .foregroundStyle(Brand.secondaryText)
                .multilineTextAlignment(.center)
            if let error = store.error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(24)
        .frame(maxHeight: .infinity)
    }

    /// Today, Yesterday, then the rest — the only grouping worth the width — of
    /// whatever the search left. Empty sections drop out, so a search that matches only
    /// last week shows only Earlier.
    private var sections: [(name: String, chats: [Chat])] {
        let calendar = Calendar.current
        let asked = query.trimmingCharacters(in: .whitespaces)
        var today: [Chat] = [], yesterday: [Chat] = [], earlier: [Chat] = []
        for chat in store.chats where asked.isEmpty || chat.title.localizedCaseInsensitiveContains(asked) {
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
