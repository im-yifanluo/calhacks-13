import AVFoundation
import Foundation

/// Run on macOS against the exact codec/recorder/validation sources used by iPhone.
/// This checks file contents; it does not simulate Meta hardware or Keychain.
@main struct ContractChecks {
    static func main() async throws {
        let expected = AccountDestination(server: "https://app.test/stdb", database: "memos")
        let shortLogin = try AccountKey.signInBody("000007", expected: expected)
        precondition(shortLogin == ["password": "000007"])
        let pastedLogin = try AccountKey.signInBody(" \n000007\n ", expected: expected)
        precondition(pastedLogin == shortLogin)
        precondition(AccountDestination(server: expected.server, database: expected.database, passwordLength: 6).usesPortableAccountAPI)
        precondition(!AccountKey.KeyError.invalid.localizedDescription.contains("memos1"))
        for invalid in ["12345", "1234567", "abcdef", "１２３４５６"] {
            do { _ = try AccountKey.signInBody(invalid, expected: expected); fatalError("Invalid password accepted") }
            catch AccountKey.KeyError.password {}
        }
        let key = AccountKey(server: expected.server, database: expected.database,
                             identity: String(repeating: "a", count: 64), token: "header.payload.signature")
        // Browser encoder: UTF-8 JSON, base64url without padding, memos1 prefix.
        let browserJSON = "{\"server\":\"https://app.test/stdb\",\"database\":\"memos\",\"identity\":\"\(key.identity)\",\"token\":\"header.payload.signature\"}"
        let browserKey = "memos1." + Data(browserJSON.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let decoded = try AccountKey.decode(browserKey, expected: expected)
        let legacyLogin = try AccountKey.signInBody(browserKey, expected: expected)
        precondition(legacyLogin == ["personalKey": browserKey])
        precondition(decoded == key)
        let roundTrip = try AccountKey.decode(key.encoded(), expected: expected)
        precondition(roundTrip == key)
        for invalid in ["PARTY42", "memos1.!", "memos1." + String(repeating: "a", count: 16384)] {
            do { _ = try AccountKey.decode(invalid, expected: expected); fatalError("Invalid key accepted") }
            catch is AccountKey.KeyError {}
        }
        do { _ = try AccountKey.decode(browserKey, expected: .init(server: "https://other.test", database: "memos")); fatalError("Wrong destination accepted") }
        catch AccountKey.KeyError.destination {}

        for (fps, width, audio, accepted) in [(30, 1280, true, true), (25, 1280, true, true), (24, 1280, true, true), (15, 1280, true, false), (30, 640, true, false), (30, 1280, false, false)] {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
            defer { try? FileManager.default.removeItem(at: url) }
            let recorder = Recorder()
            recorder.begin(at: url, includeAudio: audio)
            for frame in 0..<fps {
                var pixels: CVPixelBuffer?
                precondition(CVPixelBufferCreate(kCFAllocatorDefault, width, 720, kCVPixelFormatType_32BGRA, nil, &pixels) == kCVReturnSuccess)
                let image = pixels!
                CVPixelBufferLockBaseAddress(image, [])
                memset(CVPixelBufferGetBaseAddress(image), 80, CVPixelBufferGetBytesPerRow(image) * 720)
                CVPixelBufferUnlockBaseAddress(image, [])
                var format: CMVideoFormatDescription?
                CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format)
                let pts = CMTime(value: Int64(frame), timescale: Int32(fps))
                var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: Int32(fps)), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
                var sample: CMSampleBuffer?
                precondition(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample) == noErr)
                recorder.append(sample!)
                if audio {
                    let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
                    let count = AVAudioFrameCount(44100 / fps)
                    let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count)!
                    pcm.frameLength = count
                    for n in 0..<Int(count) { pcm.floatChannelData![0][n] = Float(sin(Double(n) * 2 * .pi * 440 / 44100)) * 0.1 }
                    recorder.appendAudio(pcm, at: pts)
                }
                // Exercise the real-time writer without artificial backpressure from a tight loop.
                try await Task.sleep(for: .milliseconds(40))
            }
            _ = try await recorder.finish()
            do {
                let description = try await CaptureRequirements.validate(url)
                precondition(accepted, "Invalid capture accepted")
                print("PASS recording: \(description)")
            } catch {
                guard !accepted else { throw error }
                print("PASS rejected \(fps) fps / \(width) px / audio=\(audio)")
            }
        }
        print("PASS portable key interoperability, malformed keys and destination checks")
    }
}
