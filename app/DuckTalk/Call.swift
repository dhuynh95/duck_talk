import AVFoundation
import CallKit
import UIKit

/// The session as the system sees it: a call. That framing is what buys the AirPods
/// stem — presses travel over Bluetooth HFP, which no app API can read directly, so
/// the system reads them and hands them back as call actions: a single press is
/// `CXSetMutedCallAction`, a double press is `CXEndCallAction`. It also buys the
/// call UI on the lock screen, which is why the Live Activity card retired.
///
/// Everything round-trips through the system, our own buttons included: a request
/// goes up through `CXCallController`, and the act comes back down through the
/// provider delegate — so the stem, the lock screen and the in-app button all land
/// in the same `perform` method, one handler per verb. The same shape as the
/// `claude` frame on the relay: one path, however the choice was made.
///
/// The audio session is the one thing that changes hands. Under CallKit the system
/// grants it — configure the category in `perform(CXStartCallAction)`, never call
/// `setActive`, and start the engine only after `didActivate`. `begin()` hides that
/// handshake behind one await, so `VoiceSession.run()` stays a straight line.
///
/// The simulator has no CallKit, so there the same class is a stub with the same
/// API: `begin` configures and activates the session itself, `setMuted` invokes the
/// callback directly. One code path above, two below, chosen at compile time.
final class Call: NSObject {
    /// The system decided the mute state — from the stem, the call UI, or our own
    /// `setMuted` coming back around. The one place the bit actually flips.
    var onMute: ((Bool) -> Void)?
    /// The call is over: a stem double press, the call UI's red button, our own
    /// `end()`, or a provider reset. Idempotent on the caller's side, because it
    /// arrives however the call died.
    var onEnded: (() -> Void)?
    /// The system took the audio session away (a real call, hold) or gave it back.
    /// Only fired after the first activation — that one is `begin()` returning.
    var onAudioSession: ((Bool) -> Void)?

    #if targetEnvironment(simulator)

    // CallKit does not run in the simulator, so the stub does by hand exactly what
    // the system would have done: configure, activate, and answer its own requests.
    private var live = false

    func begin() async throws {
        try AudioPipe.configure()
        try AVAudioSession.sharedInstance().setActive(true)
        live = true
    }

    func reportConnected() {}

    func end() {
        guard live else { return }
        live = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onEnded?()
    }

    func setMuted(_ on: Bool) {
        guard live else { return }
        onMute?(on)
    }

    #else

    private let provider: CXProvider
    private let controller = CXCallController()
    /// The one call there can be, while there is one — the same invariant as
    /// `VoiceSession.shared`.
    private var uuid: UUID?
    /// `begin()` waiting for the system to activate the audio session.
    private var starting: CheckedContinuation<Void, Error>?
    private var connected = false

    override init() {
        let config = CXProviderConfiguration()
        config.maximumCallsPerCallGroup = 1
        config.supportsVideo = false
        config.supportedHandleTypes = [.generic]
        // A conversation with Claude is not something to redial from the phone app,
        // and fifty of them would bury the calls that are calls.
        config.includesCallsInRecents = false
        // The mark on the call UI. The same drawing everything else uses.
        config.iconTemplateImageData = UIImage(named: "Logo")?.pngData()
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil) // nil is the main queue, where the rest of the app lives
    }

    /// Place the call, and return once the system has granted the audio session —
    /// after which the engine may start. Throws if the system refuses (another call
    /// in progress, or the action timed out), and the session simply does not start,
    /// reported the same way any other start failure is.
    func begin() async throws {
        guard uuid == nil else { return }
        let id = UUID()
        uuid = id
        connected = false
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: "Duck Talk"))
        do {
            try await controller.requestTransaction(with: [action])
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                self.starting = c
            }
        } catch {
            uuid = nil
            starting = nil
            throw error
        }
    }

    /// The relay answered: the call is no longer "connecting" on the lock screen.
    /// Safe to repeat — the reconnect loop calls it on every socket it opens.
    func reportConnected() {
        guard let uuid, !connected else { return }
        connected = true
        provider.reportOutgoingCall(with: uuid, connectedAt: nil)
    }

    /// Hang up. A no-op without a call, so `stop()` may always say it.
    func end() {
        guard let uuid else { return }
        controller.requestTransaction(with: [CXEndCallAction(call: uuid)]) { _ in }
    }

    /// Ask for the mute state — the answer arrives through `onMute`, exactly as a
    /// stem press does, so the in-app button and the stem are one path.
    func setMuted(_ on: Bool) {
        guard let uuid else { return }
        controller.requestTransaction(with: [CXSetMutedCallAction(call: uuid, muted: on)]) { _ in }
    }

    #endif
}

#if !targetEnvironment(simulator)
extension Call: CXProviderDelegate {
    /// The system granting our own request to start. Configure the audio session
    /// here and no further — activation is the system's, and comes as `didActivate`.
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        do {
            try AudioPipe.configure()
        } catch {
            action.fail()
            starting?.resume(throwing: error)
            starting = nil
            uuid = nil
            return
        }
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // The first activation is begin() returning; a later one is the session
        // coming back after a hold, and the pipe needs telling.
        if let starting {
            self.starting = nil
            starting.resume()
        } else {
            onAudioSession?(true)
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        onAudioSession?(false)
    }

    /// A stem press, the call UI's mute button, or our own `setMuted` coming back.
    /// No call lookup on purpose: the system fires a cleanup mute as a call ends
    /// (observed by Signal), and failing it buys nothing.
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        if uuid != nil { onMute?(action.isMuted) }
        action.fulfill()
    }

    /// A stem double press, the red button, or our own `end()` coming back.
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        uuid = nil
        action.fulfill()
        starting?.resume(throwing: CancellationError()) // ended before it ever activated
        starting = nil
        onEnded?()
    }

    /// A real phone call taking precedence. Nothing to do: the system deactivates
    /// our audio session around it (`didDeactivate`/`didActivate`), the socket
    /// stays up, and the relay reads the quiet as the phone not sending — the same
    /// self-healing a locked phone already exercises.
    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        action.fulfill()
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        if action is CXStartCallAction {
            uuid = nil
            starting?.resume(throwing: CancellationError())
            starting = nil
        }
    }

    func providerDidReset(_ provider: CXProvider) {
        uuid = nil
        starting?.resume(throwing: CancellationError())
        starting = nil
        onEnded?()
    }
}
#endif
