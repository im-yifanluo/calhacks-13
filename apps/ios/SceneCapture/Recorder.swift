import AVFoundation
import Foundation

/// All writer state lives on one serial queue. No encoding on the UI thread.
final class Recorder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "scene.video.writer")
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var includeAudio = false
    private var origin: CMTime?
    private var destination: URL?
    private var failure: Error?
    private var frames = 0

    func begin(at url: URL, includeAudio: Bool = false) {
        queue.sync {
            destination = url
            writer = nil
            input = nil
            audioInput = nil
            self.includeAudio = includeAudio
            origin = nil
            failure = nil
            frames = 0
        }
    }

    func append(_ buffer: CMSampleBuffer) {
        queue.async { [self] in
            guard let destination, failure == nil else { return }
            do {
                if writer == nil {
                    guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
                    let newWriter = try AVAssetWriter(outputURL: destination, fileType: .mp4)
                    let newInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
                        AVVideoCodecKey: AVVideoCodecType.h264,
                        AVVideoWidthKey: CVPixelBufferGetWidth(pixels),
                        AVVideoHeightKey: CVPixelBufferGetHeight(pixels)
                    ])
                    newInput.expectsMediaDataInRealTime = true
                    guard newWriter.canAdd(newInput) else { throw CaptureFailure.message("Cannot encode this video format") }
                    newWriter.add(newInput)
                    if includeAudio {
                        let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100,
                            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000
                        ])
                        audio.expectsMediaDataInRealTime = true
                        guard newWriter.canAdd(audio) else { throw CaptureFailure.message("Cannot encode audio") }
                        newWriter.add(audio)
                        audioInput = audio
                    }
                    guard newWriter.startWriting() else { throw newWriter.error ?? CaptureFailure.message("Writer failed") }
                    origin = CMSampleBufferGetPresentationTimeStamp(buffer)
                    newWriter.startSession(atSourceTime: origin!)
                    writer = newWriter
                    input = newInput
                }
                if input?.isReadyForMoreMediaData == true {
                    guard input?.append(buffer) == true else {
                        throw writer?.error ?? CaptureFailure.message("Video frame encoding failed")
                    }
                    frames += 1
                }
            } catch { failure = error }
        }
    }

    /// Copy PCM data while the SDK callback owns it, preserving its video-clock timestamp.
    func appendAudio(_ pcm: AVAudioPCMBuffer, at timestamp: CMTime) {
        guard pcm.frameLength > 0, timestamp.isValid else { return }
        var sample: CMSampleBuffer?
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(pcm.format.sampleRate)),
                                       presentationTimeStamp: timestamp, decodeTimeStamp: .invalid)
        let status = CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: pcm.format.formatDescription,
            sampleCount: Int(pcm.frameLength), sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
        guard status == noErr, let sample,
              CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault,
                blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList) == noErr else {
            queue.async { self.failure = CaptureFailure.message("Could not prepare glasses audio") }
            return
        }
        CMSampleBufferSetDataReady(sample)
        queue.async { [self] in
            guard destination != nil, failure == nil, includeAudio, let origin,
                  CMTimeCompare(timestamp, origin) >= 0, audioInput?.isReadyForMoreMediaData == true else { return }
            if audioInput?.append(sample) != true { failure = writer?.error ?? CaptureFailure.message("Audio encoding failed") }
        }
    }

    func finish() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                let url = destination
                destination = nil
                guard failure == nil, frames > 0, let writer, let input, let url else {
                    writer?.cancelWriting()
                    if let url { try? FileManager.default.removeItem(at: url) }
                    continuation.resume(throwing: failure ?? CaptureFailure.message("No video frames received. Start Preview before recording."))
                    return
                }
                input.markAsFinished()
                audioInput?.markAsFinished()
                writer.finishWriting {
                    if writer.status == .completed {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: writer.error ?? CaptureFailure.message("Could not finish recording"))
                    }
                }
            }
        }
    }
}

enum CaptureFailure: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}
