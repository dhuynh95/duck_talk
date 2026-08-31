import AVFoundation
import Accelerate

/// Mic in, speaker out. Knows nothing about the network.
///
/// Mic:     hardware format → AVAudioConverter → 16 kHz Int16 mono → `onChunk`
/// Speaker: 24 kHz Int16 mono `Data` → Float32 buffers → AVAudioPlayerNode
///
/// `flush()` drops whatever is queued for playback — that is barge-in.
final class AudioPipe {
    var onChunk: ((Data) -> Void)?
    /// A 0…1 loudness of the mic — how loud you're speaking. Drives the waveform.
    var onLevel: ((Float) -> Void)?
    /// Send silence instead of the room. Silence, not nothing: the relay reads a gap
    /// in the bytes as the phone going away, and Gemini's endpointing watches a
    /// continuous stream — so the frames keep coming at the same rate, zeroed. The
    /// ears stay open and hear a quiet room; the speaker is untouched.
    var muted = false

    /// A reply is owed: a turn is provably running and not yet over. VoiceSession
    /// flips this for the life of the turn — one bit, the same shape as `muted` —
    /// and this file decides what the wait *sounds* like: the chime loop, but only
    /// while the speaker is dry. The speaker is the one thing that truly knows
    /// whether anything is playing, so the chimes cover the head of the turn, fall
    /// silent the instant reply audio exists, and come back when the voice runs out
    /// mid-turn because Claude went back to its tools — the long quiet the filler
    /// exists for. The same echo cancellation that keeps the reply's voice out of
    /// the microphone keeps the chimes out of it.
    var waiting = false {
        didSet { settle() }
    }

    /// Reply buffers scheduled and not yet heard — the speaker is dry at zero.
    /// `.dataPlayedBack` in `play` is the native event for "this buffer has been
    /// played to the speaker", so dryness is the hardware's own bookkeeping, never
    /// an inference from timing.
    private var queued = 0
    /// When the speaker last ran dry. A lull has to last before it chimes: the
    /// serial voice can starve for tens of milliseconds between sentences, and a
    /// chime in a seam that short would sound inside the reply's own breath.
    private var dryAt = Date.distantPast
    private static let lull: TimeInterval = 2

    /// Chime if the wait is on and the speaker has been dry long enough; otherwise
    /// stop. Re-checked, not scheduled once: every path that changes the answer —
    /// the bit flipping, a buffer arriving, a buffer playing out — lands here, and a
    /// timer that fires into a changed world just falls through the same guards.
    private func settle() {
        guard waiting, queued == 0 else { return chime(false) }
        let dry = Date().timeIntervalSince(dryAt)
        if dry >= Self.lull { return chime(true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.lull - dry) { [weak self] in self?.settle() }
    }

    /// The loop itself, faded at both edges so neither is a click.
    private var chiming = false
    private func chime(_ on: Bool) {
        guard on != chiming, let chimes else { return }
        chiming = on
        if on {
            chimes.currentTime = 0
            chimes.volume = 0
            chimes.play()
            chimes.setVolume(Self.chimeVolume, fadeDuration: 0.4)
        } else {
            chimes.setVolume(0, fadeDuration: 0.15)
            // Paused only once the fade has played out — and not at all if a new
            // lull began during it, which the volume ramp then serves.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                if self?.chiming != true { chimes.pause() }
            }
        }
    }

    /// Quiet on purpose: the chimes sit under a voice about to speak, never in place
    /// of one. The file itself peaks well below full scale for the same reason.
    private static let chimeVolume: Float = 0.5

    /// The loop, from the bundle — written by scripts/filler-sound.py, never by hand.
    /// Nil only if the resource is missing, and then a wait is simply silent.
    private lazy var chimes: AVAudioPlayer? = {
        guard let url = Bundle.main.url(forResource: "chimes", withExtension: "wav"),
              let player = try? AVAudioPlayer(contentsOf: url) else { return nil }
        player.numberOfLoops = -1
        return player
    }()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()

    private let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private let speakerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

    /// The microphone, or a thrown refusal — asked before the call is placed, so the
    /// call UI never appears for a mic that was denied.
    static func requestMic() async throws {
        guard await AVAudioApplication.requestRecordPermission() else {
            throw AudioError.microphoneDenied
        }
    }

    /// What the session is, without taking it. Called by `Call` inside the CallKit
    /// handshake — activation is the system's under CallKit, and the stub's in the
    /// simulator — so this file never says `setActive` in either direction.
    ///
    /// .voiceChat turns on the system's echo cancellation; without it the mic
    /// hears the model's own voice and Gemini interrupts itself.
    static func configure() throws {
        try AVAudioSession.sharedInstance()
            .setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
    }

    /// Engine only. The audio session is already configured and active — `Call.begin`
    /// returned, which is what says so.
    func start() throws {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: speakerFormat)

        let input = engine.inputNode
        let hardwareFormat = input.outputFormat(forBus: 0)
        // installTap throws an ObjC exception on a 0 Hz / 0 channel format, which Swift
        // cannot catch — the app would die instead of reporting. Some inputs report
        // exactly that: no microphone, a virtual device with no clock, a Bluetooth
        // device that dropped. Check first and fail like anything else.
        guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
            throw AudioError.unsupportedFormat
        }
        guard let converter = AVAudioConverter(from: hardwareFormat, to: micFormat) else {
            throw AudioError.unsupportedFormat
        }
        let ratio = micFormat.sampleRate / hardwareFormat.sampleRate

        input.installTap(onBus: 0, bufferSize: 2048, format: hardwareFormat) { [weak self] buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
            guard let out = AVAudioPCMBuffer(pcmFormat: self?.micFormat ?? buffer.format, frameCapacity: capacity) else { return }

            var consumed = false
            converter.convert(to: out, error: nil) { _, status in
                if consumed { status.pointee = .noDataNow; return nil }
                consumed = true
                status.pointee = .haveData
                return buffer
            }

            guard out.frameLength > 0, let samples = out.int16ChannelData, let self else { return }
            let n = Int(out.frameLength)
            if self.muted {
                // Zeroed after conversion, so the frame is exactly the shape a heard one
                // would be. The meter is skipped rather than fed zeros, so it drops to
                // the floor at once instead of decaying — the waveform going flat is how
                // the screen says muted.
                memset(samples[0], 0, n * 2)
                self.onLevel?(0)
            } else {
                self.onLevel?(self.meter(samples[0], n))
            }
            self.onChunk?(Data(bytes: samples[0], count: n * 2))
        }

        engine.prepare()
        try engine.start()
        player.play()
    }

    /// Queue one chunk of 24 kHz Int16 PCM. The player node plays chunks back to back.
    func play(_ pcm: Data) {
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: speakerFormat, frameCapacity: frames) else { return }
        buffer.frameLength = frames
        let out = buffer.floatChannelData![0]
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<Int(frames) { out[i] = Float(samples[i]) / 32768 }
        }
        queued += 1
        settle() // the reply owns the speaker from the moment audio exists to play
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.queued = max(0, self.queued - 1) // clamped: flush also zeroes it
                if self.queued == 0 { self.dryAt = Date() }
                self.settle()
            }
        }
        if !player.isPlaying { player.play() }
    }

    func flush() {
        player.stop()
        player.play()
        // Stopping fires the completion of every unplayed buffer, but the flush is
        // the truth right now: the speaker is dry because the turn was taken away.
        queued = 0
        dryAt = Date()
        settle()
    }

    /// How loud this buffer was, 0…1 — the same thing the input level meter in macOS
    /// System Settings shows.
    ///
    /// Peak sample, in decibels below full scale. Full scale itself is not the top of
    /// the meter: a phone held at talking distance peaks around -30 dB, so the range
    /// stops at -10 and leaves the last of the headroom to shouting.
    /// It has to be decibels because loudness is logarithmic: on a raw amplitude
    /// scale nearly everything audible sits in the top of the range and the meter
    /// pins at full for anything above a whisper.
    ///
    /// Then the level jumps up at once and falls back slowly, the way every level
    /// meter has since analogue ones. Without that it flickers out in the gaps
    /// between syllables, which reads as broken rather than quiet.
    private func meter(_ samples: UnsafeMutablePointer<Int16>, _ n: Int) -> Float {
        let count = min(n, scratch.count)
        // The C entry points take the length explicitly; the Swift `vDSP.convertElements`
        // overlay instead requires the destination to be exactly as long as the source,
        // and traps on the audio thread when it is not.
        vDSP_vflt16(samples, 1, &scratch, 1, vDSP_Length(count))
        var peak: Float = 0
        vDSP_maxmgv(scratch, 1, &peak, vDSP_Length(count))
        let db = 20 * log10f(max(peak / 32768, 1e-7))
        if db > Self.floorDb { lastLoudAt = Date().timeIntervalSince1970 * 1000 }
        let target = min(1, max(0, (db - Self.floorDb) / (Self.ceilingDb - Self.floorDb)))
        level += (target - level) * (target > level ? Self.attack : Self.release)
        return level
    }

    /// When the microphone last heard anything the meter would draw. The same floor on
    /// purpose: one definition of audible, so this and the waveform cannot disagree —
    /// a room noisy enough to confuse the mark is a room whose bars visibly never rest.
    /// Deciding that speech *ended* stays Gemini's job; this only says when the sound
    /// stopped, read once a finished transcript proves there was an utterance to time.
    /// Milliseconds since 1970, 0 until anything has been heard. Written on the audio
    /// thread and read on the main one — the crossing `muted` already makes, in the
    /// other direction. The meter is skipped while muted, so silence sent on purpose
    /// never counts as sound.
    private(set) var lastLoudAt: Double = 0

    private static let floorDb: Float = -60   // below this the meter is empty
    private static let ceilingDb: Float = -16 // at this it is full
    private static let attack: Float = 0.6    // a new peak shows up now
    private static let release: Float = 0.12  // ~350 ms to fall, so syllables join up

    private var level: Float = 0
    private var scratch = [Float](repeating: 0, count: 8192)

    /// What the system actually gave us: route in → out, and the rate we capture at.
    /// iOS chooses the route; an app can only ask (`setPreferredInput`) among the
    /// inputs the system exposes, and cannot pick an output at all. In the simulator
    /// the route mirrors whatever the Mac's default devices are.
    static var route: String {
        let session = AVAudioSession.sharedInstance()
        let name = { (ports: [AVAudioSessionPortDescription]) in
            ports.map(\.portName).joined(separator: "+")
        }
        let inputs = name(session.currentRoute.inputs)
        let outputs = name(session.currentRoute.outputs)
        let choices = session.availableInputs?.count ?? 0
        return "\(inputs.isEmpty ? "—" : inputs) → \(outputs.isEmpty ? "—" : outputs)"
            + "  \(Int(session.sampleRate)) Hz, \(choices) input\(choices == 1 ? "" : "s")"
    }

    /// The system took the audio session for a real call. The engine pauses; the
    /// socket above stays up, and the relay reads the quiet as the phone not sending.
    func suspend() {
        engine.pause()
    }

    /// The session came back. The engine picks up where it paused, and the next
    /// microphone buffer reopens the ears on the relay by itself.
    func resume() {
        try? engine.start()
        if !player.isPlaying { player.play() }
    }

    func stop() {
        waiting = false // fades the chimes out with the session, if they were playing
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        // No setActive(false): deactivation belongs to whoever activated — the
        // system on a device (as the call ends), the Call stub in the simulator.
    }

    enum AudioError: LocalizedError {
        case microphoneDenied, unsupportedFormat
        var errorDescription: String? {
            switch self {
            case .microphoneDenied: return "Microphone access was denied. Enable it in Settings."
            case .unsupportedFormat: return "This device's microphone format can't be converted to 16 kHz."
            }
        }
    }
}
