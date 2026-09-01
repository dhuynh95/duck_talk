import SwiftUI

/// The three things you pick rather than type: what happens to what you say, which model
/// answers, and what that model is allowed to do.
///
/// They are one screen because they are one act — each decides something about the turn
/// you are about to take, and each is worth reading once before you commit to it. Two of
/// them the phone knows by heart, because the answers are the same on every Mac. The
/// third, the model list, only the relay can know, so it arrives down the socket and
/// lands in the same component. That is the whole difference between them.

/// One thing to pick. Whether the list was written here or sent by the relay, a row is a
/// row.
struct Choice: Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String
    /// An SF Symbol, for a fixed few worth recognising by shape. A list that arrives
    /// from the relay has none — there is no icon for "Sonnet".
    var icon: String?
}

/// One model this Mac can offer, as Claude Code itself describes it. The list depends on
/// the account, so only the relay can know it — which is why this arrives down the socket
/// and is not written here.
struct ClaudeModel: Codable, Hashable {
    /// What the relay hands to `setModel`: "default", "sonnet", "claude-fable-5[1m]".
    let value: String
    let displayName: String
    let description: String
    /// The model this row actually runs — "default" resolves to "claude-opus-5[1m]".
    /// Absent on a row that is already a real model id.
    var resolvedModel: String?
    /// Whether this model takes an effort level, and which — Claude Code's own
    /// description of the model, like everything else in this row. Absent from a relay
    /// that predates effort, which reads the same as a model that takes none.
    var supportsEffort: Bool?
    var supportedEffortLevels: [String]?

    /// The one word the capsule shows.
    ///
    /// Taken from what the row resolves to rather than from what it is called, because
    /// an alias does not name a model: picking "Default (recommended)" and reading
    /// "Default" in the bar leaves you not knowing whether Opus or Sonnet is answering.
    /// The family out of the id — claude-opus-5[1m] becomes Opus.
    var shortName: String {
        let id = resolvedModel ?? value
        let family = id.replacingOccurrences(of: "claude-", with: "").split(separator: "-").first ?? ""
        guard let initial = family.first else { return displayName }
        return initial.uppercased() + family.dropFirst()
    }

    /// How hard this model can think, as rows to pick from. Built from the levels the
    /// relay says this model takes — never a list written into the app — with "Default"
    /// first, because not choosing is itself the ordinary choice.
    var effortChoices: [Choice] {
        let rows = (supportedEffortLevels ?? []).map {
            Choice(id: $0, title: Self.effortTitle($0), detail: Self.effortDetail($0))
        }
        return [Choice(id: "default", title: "Default", detail: "Let Claude Code decide")] + rows
    }

    /// The word a level wears on screen. The wire says "xhigh"; nobody should read that.
    static func effortTitle(_ raw: String) -> String {
        switch raw {
        case "default": return "Default"
        case "xhigh": return "Extra"
        default: return raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    private static func effortDetail(_ raw: String) -> String {
        switch raw {
        case "low": return "Fastest, minimal thinking"
        case "medium": return "Moderate thinking"
        case "high": return "Deep reasoning \u{2014} what Default usually means"
        case "xhigh": return "Deeper than High, slower"
        case "max": return "The most thorough, and the slowest"
        default: return ""
        }
    }
}

/// One skill the project offers, invoked by sending `/name` as an instruction. Like
/// the model list, only the relay can know which exist, so they arrive down the socket
/// — and the composer's "/" autocomplete is a filter over these rows, never a request.
struct SkillInfo: Codable, Hashable {
    let name: String
    let description: String
    /// What the skill takes after its name (e.g. "<file>"), empty for none.
    let argumentHint: String
}

/// A set of choices the phone decides for itself, and can therefore describe.
protocol Choosable: RawRepresentable, CaseIterable, Identifiable where RawValue == String {
    var title: String { get }
    var detail: String { get }
    var icon: String { get }
    /// What fits on the capsule in the bar, which is narrower than a sheet row.
    var short: String { get }
}

extension Choosable {
    var id: String { rawValue }
    var short: String { title }
    static var choices: [Choice] {
        allCases.map { Choice(id: $0.rawValue, title: $0.title, detail: $0.detail, icon: $0.icon) }
    }
}

/// What happens to what you say. Two answers, and the difference matters enough to spell
/// out — one of them runs your words the moment you stop talking.
enum Mode: String, CaseIterable, Choosable {
    case direct, review

    var title: String {
        switch self {
        case .direct: return "Direct"
        case .review: return "Review"
        }
    }

    var detail: String {
        switch self {
        case .direct: return "Runs as soon as you stop talking"
        case .review: return "Shows you the text first, so you can fix it"
        }
    }

    var icon: String {
        switch self {
        case .direct: return "bolt.circle"
        case .review: return "checkmark.circle"
        }
    }
}

/// What Claude is allowed to do while it answers.
///
/// What Claude is allowed to do while it answers.
///
/// Three rungs, out of the SDK's six. The others — `default`, `dontAsk`, `auto` — wait
/// for someone to answer "can I run this?", and nothing on the phone can, so every
/// action under them is denied. They would read as broken rather than as strict.
///
/// The words say what each one does rather than what it is called, because the middle
/// one's name is misleading: `acceptEdits` deletes files without asking. With no
/// settings files loaded at all it ran `rm` and refused `curl`, so "Edit files" has to
/// say *and deletes*.
///
/// The raw values are the SDK's own, so nothing between here and `q.setPermissionMode`
/// has to translate them.
enum Permission: String, CaseIterable, Choosable {
    case plan
    case acceptEdits
    case bypassPermissions

    var title: String {
        switch self {
        case .plan: return "Plan"
        case .acceptEdits: return "Edit files"
        case .bypassPermissions: return "Full access"
        }
    }

    var detail: String {
        switch self {
        case .plan: return "Reads and thinks. Changes nothing."
        case .acceptEdits: return "Writes and deletes files. No network, no git."
        case .bypassPermissions: return "Anything runs, including git push."
        }
    }

    var icon: String {
        switch self {
        case .plan: return "eye"
        case .acceptEdits: return "pencil"
        case .bypassPermissions: return "bolt"
        }
    }

    var short: String {
        switch self {
        case .plan: return "Plan"
        case .acceptEdits: return "Edits"
        case .bypassPermissions: return "Full"
        }
    }
}

/// Pick one of a few things, each named and explained.
///
/// A sheet rather than a button that cycles, because each of these changes what happens
/// to what you say next, and a name you can read beats an icon nobody can read without
/// being told. Picking closes it — there is nothing else on the screen to do.
struct ChoiceSheet: View {
    let title: String
    let choices: [Choice]
    @Binding var picked: String
    /// The list is still coming down the socket. Only the model list ever is.
    var loading = false
    /// A row under the list that is not one of the choices but belongs with them — the
    /// model sheet's "Effort" row, showing what is set and opening the sheet to change
    /// it. On its own surface, so it cannot be mistaken for a fifth model.
    var trailing: (title: String, value: String, open: () -> Void)?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(title).font(.headline)
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
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 20)

            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(choices.enumerated()), id: \.element.id) { index, choice in
                        Button {
                            picked = choice.id
                            dismiss()
                        } label: {
                            row(choice)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("choice-\(choice.id)")
                        .accessibilityLabel(choice.title)
                        .accessibilityAddTraits(picked == choice.id ? [.isSelected] : [])

                        if index < choices.count - 1 {
                            Divider().padding(.leading, choice.icon == nil ? 0 : 40)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .background(Brand.surface, in: RoundedRectangle(cornerRadius: 16))
                .padding(.horizontal, 16)

                if let trailing {
                    Button(action: trailing.open) {
                        HStack(spacing: 8) {
                            Text(trailing.title).font(.body).foregroundStyle(Brand.text)
                            Spacer()
                            Text(trailing.value).font(.body).foregroundStyle(Brand.secondaryText)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Brand.tertiaryText)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 16)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 16))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .accessibilityIdentifier("choice-trailing")
                    .accessibilityLabel(trailing.title)
                    .accessibilityValue(trailing.value)
                }
            }

            Spacer(minLength: 0)
        }
        .presentationDetents([.height(height), .large])
        .presentationDragIndicator(.hidden)
    }

    private func row(_ choice: Choice) -> some View {
        HStack(spacing: 14) {
            if let icon = choice.icon {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 26)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.title).font(.body).foregroundStyle(Brand.text)
                Text(choice.detail)
                    .font(.subheadline)
                    .foregroundStyle(Brand.secondaryText)
                    // Wrap rather than trail off: a description that explains the choice
                    // is worth the second line, and one row cutting short while its
                    // neighbours do not reads as a glitch.
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            // Drawn on every row and only shown on one, so picking a different choice
            // cannot reflow the text beside it.
            Image(systemName: "checkmark")
                .font(.body.weight(.semibold))
                .foregroundStyle(.tint)
                .opacity(picked == choice.id ? 1 : 0)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    /// Tall enough for the rows it has, and never taller than the screen. Dragging up is
    /// still allowed, for a model whose description runs long.
    private var height: CGFloat {
        min(CGFloat(max(choices.count, 1)) * 74 + 104 + (trailing == nil ? 0 : 66), 620)
    }
}

#Preview {
    ChoiceSheet(title: "What Claude may do", choices: Permission.choices, picked: .constant("plan"))
}
