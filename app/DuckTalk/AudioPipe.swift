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

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()

    private let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private let speakerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else {
            throw AudioError.microphoneDenied
        }

        // .voiceChat turns on the system's echo cancellation; without it the mic
        // hears the model's own voice and Gemini interrupts itself.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)

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
        player.scheduleBuffer(buffer)
        if !player.isPlaying { player.play() }
    }

    func flush() {
        player.stop()
        player.play()
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
        let target = min(1, max(0, (db - Self.floorDb) / (Self.ceilingDb - Self.floorDb)))
        level += (target - level) * (target > level ? Self.attack : Self.release)
        return level
    }

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

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
