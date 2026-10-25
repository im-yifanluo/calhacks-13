import AVFoundation

enum CaptureRequirements {
    /// Inspect the actual output, not the requested SDK settings. 29.97 fps counts as 30.
    static func validate(_ url: URL) async throws -> String {
        let asset = AVURLAsset(url: url)
        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw CaptureFailure.message("No video track found")
        }
        let size = try await video.load(.naturalSize)
        let fps = try await video.load(.nominalFrameRate)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        let duration = try await asset.load(.duration).seconds
        let hasAudio: Bool
        if let track = audio.first {
            hasAudio = try await track.load(.timeRange).duration.seconds > 0
        } else { hasAudio = false }
        guard duration.isFinite, duration > 0, max(abs(size.width), abs(size.height)) >= 1280,
              fps >= 29, hasAudio else {
            throw CaptureFailure.message("Clip is \(Int(abs(size.width)))×\(Int(abs(size.height))), \(String(format: "%.1f", fps)) fps, \(hasAudio ? "with audio" : "without audio"). Processing needs ≥1280 px on the long edge, 30 fps and audio. Export a matching recording from Meta AI if the live stream cannot provide this.")
        }
        return "\(Int(abs(size.width)))×\(Int(abs(size.height))) · \(String(format: "%.1f", fps)) fps · audio"
    }
}
