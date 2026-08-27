import AVFoundation

/// Mic in, speaker out. Knows nothing about the network.
///
/// Mic:     hardware format → AVAudioConverter → 16 kHz Int16 mono → `onChunk`
/// Speaker: 24 kHz Int16 mono `Data` → Float32 buffers → AVAudioPlayerNode
///
/// `flush()` drops whatever is queued for playback — that is barge-in.
final class AudioPipe {
    var onChunk: ((Data) -> Void)?

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
            self?.onChunk?(Data(bytes: samples[0], count: Int(out.frameLength) * 2))
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
