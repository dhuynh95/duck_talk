import Foundation

/// How to reach the relay: the address, and the one-shot question.
///
/// The address is typed by hand, so "not an address" is an ordinary state and has to
/// arrive as a message on the screen. It could not: `URLSession.webSocketTask(with:)`
/// raises an Objective-C exception on any scheme but `ws`/`wss`, which Swift cannot
/// catch, so a saved `https://` address killed the app on launch — the home screen opens
/// its data socket in a `task`, which runs before there is a screen to say anything on.
/// `URL(string:)` is no guard at all: it parses `https://`, a bare hostname and `mailto:`
/// alike. So no socket in this app is opened from a string anywhere else, and a wrong
/// address is a message rather than a crash.
///
/// `ask` is the other half, and it is here for the same reason: a clip and a thumbnail
/// are one question with one frame back, and written twice they were two places that
/// could each open a socket their own way.
enum Relay {
    /// A socket URL for this relay, or nil when the address is not one. `query` says
    /// which kind of connection it is — `?data=1`, `?mode=direct` — appended here so the
    /// check and the appending cannot happen in the wrong order.
    static func url(_ address: String, query: String = "") -> URL? {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespaces) + query),
              let scheme = url.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
              url.host?.isEmpty == false else { return nil }
        return url
    }

    /// What to show when it refuses. One sentence in one place, because every screen that
    /// can report it should word it the same way.
    static let badAddress = "Needs a ws:// or wss:// address"

    /// One socket, one question, one frame back — a clip, or a picture.
    ///
    /// The relay answers media ahead of the state frames every message is answered with,
    /// so the first frame *is* the whole answer: binary is the thing, text means there was
    /// none. Nothing is counted and nothing is waited out. A blob asked for on demand is
    /// not state to be kept in step, which is why this is a function and not a store — a
    /// thumbnail nobody scrolls to costs nothing.
    static func ask(_ address: String, _ question: [String: Any]) async -> Data? {
        guard let url = url(address, query: "?data=1"),
              let json = try? JSONSerialization.data(withJSONObject: question),
              let text = String(data: json, encoding: .utf8) else { return nil }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        guard (try? await task.send(.string(text))) != nil else { return nil }
        guard case .data(let bytes) = try? await task.receive() else { return nil }
        return bytes
    }
}
