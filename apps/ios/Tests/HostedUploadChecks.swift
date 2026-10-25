import AVFoundation
import CryptoKit
import Foundation

/// Explicit live integration check: creates a test account and a tiny synthetic clip.
/// Never reads a user's password or footage. Never requests GPU processing.
@main struct HostedUploadChecks {
    static func main() async throws {
        guard CommandLine.arguments.contains("--live") else {
            print("Pass --live to create a synthetic upload test account and clip.")
            return
        }
        let origin = "https://memos.alightdell64.chatgpt.site"
        func send(_ path: String, method: String = "GET", body: [String: Any]? = nil, key: String? = nil) async throws -> Data {
            var request = URLRequest(url: URL(string: origin + path)!)
            request.httpMethod = method
            request.timeoutInterval = 45
            if let body {
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw CaptureFailure.message("Hosted check failed at \(path), HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            return data
        }
        let decoder = JSONDecoder()
        let config = try decoder.decode(AccountDestination.self, from: await send("/api/account/config"))
        precondition(config.pipelineAvailable == false && config.maxUploadBytes == 90 * 1024 * 1024)
        let account = try decoder.decode(HostedAccount.self, from: await send("/api/account", method: "POST", body: ["displayName": "iOS upload check " + String(UUID().uuidString.prefix(6))]))
        let key = try account.validatedKey(expected: config)
        let restored = try decoder.decode(HostedAccount.self, from: await send("/api/account", method: "POST", body: ["personalKey": account.personalKey]))
        let restoredKey = try restored.validatedKey(expected: config)
        precondition(restoredKey == key)
        let profile = try JSONSerialization.jsonObject(with: await send("/api/account", key: account.personalKey)) as! [String: Any]
        precondition(profile["identity"] as? String == account.identity && profile["provider"] as? String == "key")
        print("PASS hosted account creation, password restore, authenticated profile")

        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { try? FileManager.default.removeItem(at: file) }
        let recorder = Recorder()
        recorder.begin(at: file)
        for frame in 0..<15 {
            var pixels: CVPixelBuffer?
            precondition(CVPixelBufferCreate(kCFAllocatorDefault, 640, 360, kCVPixelFormatType_32BGRA, nil, &pixels) == noErr)
            CVPixelBufferLockBaseAddress(pixels!, [])
            memset(CVPixelBufferGetBaseAddress(pixels!), Int32(64 + frame * 8), CVPixelBufferGetBytesPerRow(pixels!) * 360)
            CVPixelBufferUnlockBaseAddress(pixels!, [])
            var format: CMVideoFormatDescription?
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels!, formatDescriptionOut: &format)
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 15), presentationTimeStamp: CMTime(value: Int64(frame), timescale: 15), decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample)
            recorder.append(sample!)
        }
        _ = try await recorder.finish()
        let bytes = try Data(contentsOf: file)
        let duration = try await AVURLAsset(url: file).load(.duration).seconds
        let ticketData = try await send("/api/uploads/presign", method: "POST", body: ["name": "ios-synthetic-check.mp4", "type": "video/mp4", "size": bytes.count, "title": "[TEST] iOS hosted upload contract", "durationSec": duration, "pipeline": false], key: account.personalKey)
        let ticket = try JSONSerialization.jsonObject(with: ticketData) as! [String: Any]
        precondition(ticket["pipeline"] as? Bool == false)
        precondition((ticket["expiresIn"] as? Double ?? 0) > 0)
        var put = URLRequest(url: URL(string: ticket["putUrl"] as! String)!)
        put.httpMethod = "PUT"
        for (name, value) in ticket["headers"] as! [String: String] { put.setValue(value, forHTTPHeaderField: name) }
        put.setValue(nil, forHTTPHeaderField: "Authorization")
        put.setValue(String(bytes.count), forHTTPHeaderField: "Content-Length")
        let (_, putResponse) = try await URLSession.shared.upload(for: put, fromFile: file)
        precondition((200..<300).contains((putResponse as! HTTPURLResponse).statusCode))
        let complete = try JSONSerialization.jsonObject(with: await send("/api/uploads/complete", method: "POST", body: ["receipt": ticket["receipt"]!], key: account.personalKey)) as! [String: Any]
        precondition(complete["pipeline"] as? Bool == false)
        let memory = complete["memory"] as! [String: Any]
        let listed = try JSONSerialization.jsonObject(with: await send("/api/memories", key: account.personalKey)) as! [String: Any]
        let matches = (listed["memories"] as! [[String: Any]]).filter { $0["requestId"] as? String == ticket["requestId"] as? String }
        precondition(matches.count == 1)
        let (download, response) = try await URLSession.shared.data(from: URL(string: memory["sourceUrl"] as! String)!)
        precondition((response as! HTTPURLResponse).statusCode == 200)
        precondition(SHA256.hash(data: download) == SHA256.hash(data: bytes))
        print("PASS presign, unauthenticated PUT, completion, account-scoped listing, byte-identical download; pipeline=false")
        print("Memory field types: " + memory.keys.sorted().map { "\($0):\(type(of: memory[$0]!))" }.joined(separator: ", "))
    }
}
