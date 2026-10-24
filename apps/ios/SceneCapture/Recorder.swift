import AVFoundation
import Foundation

/// All writer state lives on one serial queue. No encoding on the UI thread.
final class Recorder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "scene.video.writer")
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var destination: URL?
    private var failure: Error?
    private var frames = 0

    func begin(at url: URL) {
        queue.sync {
            destination = url
            writer = nil
            input = nil
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
                    guard newWriter.startWriting() else { throw newWriter.error ?? CaptureFailure.message("Writer failed") }
                    newWriter.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(buffer))
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
