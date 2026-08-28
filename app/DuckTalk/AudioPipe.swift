import AVFoundation

/// Mic in, speaker out. Knows nothing about the network.
///
/// Mic:     hardware format → AVAudioConverter → 16 kHz Int16 mono → `onChunk`
/// Speaker: 24 kHz Int16 mono `Data` → Float32 buffers → AVAudioPlayerNode
///
/// `flush()` drops whatever is queued for playback — that is barge-in.
final class AudioPipe {
    var onChunk: ((Data) -> Void)?
    /// A 0…1 loudness of whatever audio just moved — mic while you talk, speaker
    /// while Claude talks. The one signal a live waveform needs to look alive.
    var onLevel: ((Float) -> Void)?

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

            guard out.frameLength > 0, let samples = out.int16ChannelData else { return }
            let n = Int(out.frameLength)
            var sum: Float = 0
            for i in 0..<n { let s = Float(samples[0][i]) / 32768; sum += s * s }
            self?.onLevel?(AudioPipe.norm(sum / Float(n)))
            self?.onChunk?(Data(bytes: samples[0], count: n * 2))
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
        var sum: Float = 0
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<Int(frames) { let v = Float(samples[i]) / 32768; out[i] = v; sum += v * v }
        }
        onLevel?(AudioPipe.norm(sum / Float(Int(frames))))
        player.scheduleBuffer(buffer)
        if !player.isPlaying { player.play() }
    }

    func flush() {
        player.stop()
        player.play()
    }

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

    /// RMS (mean-square in) → a 0…1 level with speech-range gain, so ordinary talking
    /// fills most of the bar rather than a sliver.
    private static func norm(_ meanSquare: Float) -> Float {
        min(1, sqrtf(meanSquare) * 8)
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
