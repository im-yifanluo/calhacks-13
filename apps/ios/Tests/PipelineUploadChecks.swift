import AVFoundation
import CryptoKit
import Foundation

// The real SceneLibrary/Recorder/AccountKey code runs here. Only Keychain and preferences
// use isolated stores so this test cannot replace the person's app account.
final class TestIdentityStore: CaptureIdentityStore {
    var values: [String: ServerIdentity] = [:]
    func read(_ endpoint: String) -> ServerIdentity? { values[endpoint] }
    func save(_ identity: ServerIdentity, for endpoint: String) throws { values[endpoint] = identity }
}

@main struct PipelineUploadChecks {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        func option(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        guard let origin = option("--api"), let output = option("--output"), let work = option("--directory"),
              let url = URL(string: origin), ["http", "https"].contains(url.scheme ?? ""), url.host != nil else {
            throw CaptureFailure.message("Usage: pipeline-upload --api ORIGIN --directory DIR --output JSON [--clip MP4] [--live] [--expect-lost-confirmation]")
        }
        guard ["localhost", "127.0.0.1"].contains(url.host!) || args.contains("--live") else {
            throw CaptureFailure.message("A public upload requires --live and an explicit real --clip")
        }
        if args.contains("--live") && option("--clip") == nil {
            throw CaptureFailure.message("Live GPU acceptance requires a real --clip; never reconstruct the synthetic transport fixture")
        }
        let suite = "memos.pipeline-test." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(origin, forKey: "memreplay.endpoint")
        let directory = URL(fileURLWithPath: work)
        let identities = TestIdentityStore()
        let library = SceneLibrary(directory: directory, defaults: defaults, identities: identities)
        library.displayName = "Pipeline acceptance " + String(UUID().uuidString.prefix(6))
        await library.saveProfile()
        guard library.profileReady else { throw CaptureFailure.message(library.profileMessage) }
        let clip: URL
        if let path = option("--clip") { clip = URL(fileURLWithPath: path) }
        else {
            clip = directory.appendingPathComponent("synthetic-transport.mp4")
            try await recordFixture(clip)
        }
        _ = try await CaptureRequirements.validate(clip)
        library.title = args.contains("--live") ? "[Acceptance] glasses reconstruction" : "[TEST] synthetic transport, no GPU"
        await library.importVideo(clip)
        var final = library
        if args.contains("--expect-lost-confirmation") {
            guard library.pending.count == 1, library.pending[0].uploaded else {
                throw CaptureFailure.message("Expected a retained completion receipt: " + library.message)
            }
            let queue = directory.appendingPathComponent("queue.json")
            var jobs = try JSONDecoder().decode([PendingCapture].self, from: Data(contentsOf: queue))
            jobs[0].prepared?.receiptExpiresAt = 0 // app returns after its ticket expires
            try JSONEncoder().encode(jobs).write(to: queue, options: .atomic)
            final = SceneLibrary(directory: directory, defaults: defaults, identities: identities)
            await final.uploadPending()
        }
        guard final.pending.isEmpty, let scene = final.scenes.first else {
            throw CaptureFailure.message(final.message)
        }
        guard scene.pipelineIdentity != final.userID, scene.pipeline != false else {
            throw CaptureFailure.message("Video was only stored, not queued for reconstruction")
        }
        let digest = SHA256.hash(data: try Data(contentsOf: clip)).map { String(format: "%02x", $0) }.joined()
        let report: [String: Any] = ["memoryId": scene.id, "requestId": scene.requestId, "identity": final.userID,
            "sourceUrl": scene.sourceUrl, "sourceSHA256": digest, "pipelineIdentity": scene.pipelineIdentity ?? "",
            "personalKey": identities.read(origin)!.personalKey!, "server": origin]
        // Contains the test account's credential; never print this JSON or commit it.
        let destination = URL(fileURLWithPath: output)
        guard FileManager.default.createFile(atPath: destination.path, contents: nil,
            attributes: [.posixPermissions: 0o600]) else { throw CaptureFailure.message("Cannot create private report") }
        try JSONSerialization.data(withJSONObject: report, options: .sortedKeys).write(to: destination)
        print("PASS actual SceneLibrary: account, video validation, upload, database row #\(scene.id), byte verification, worker assignment")
        if args.contains("--expect-lost-confirmation") { print("PASS lost completion + expired receipt: same memory recovered after app restart") }
    }

    static func recordFixture(_ url: URL) async throws {
        let recorder = Recorder(); recorder.begin(at: url, includeAudio: true)
        for frame in 0..<30 {
            var pixels: CVPixelBuffer?
            precondition(CVPixelBufferCreate(kCFAllocatorDefault, 1280, 720, kCVPixelFormatType_32BGRA, nil, &pixels) == noErr)
            CVPixelBufferLockBaseAddress(pixels!, [])
            memset(CVPixelBufferGetBaseAddress(pixels!), 80 + Int32(frame), CVPixelBufferGetBytesPerRow(pixels!) * 720)
            CVPixelBufferUnlockBaseAddress(pixels!, [])
            var format: CMVideoFormatDescription?
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels!, formatDescriptionOut: &format)
            let time = CMTime(value: Int64(frame), timescale: 30)
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: time, decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample)
            recorder.append(sample!)
            let audio = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
            let pcm = AVAudioPCMBuffer(pcmFormat: audio, frameCapacity: 1470)!; pcm.frameLength = 1470
            for i in 0..<1470 { pcm.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / 44100)) * 0.1 }
            recorder.appendAudio(pcm, at: time)
            try await Task.sleep(for: .milliseconds(40))
        }
        _ = try await recorder.finish()
    }
}
