import AVFoundation

enum CaptureRequirements {
    /// Inspect actual output. DAT may deliver ~25 fps despite requesting 30;
    /// the pipeline normalizes 23.976/24/25/30 fps video to a 30 fps timeline.
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
              fps.isFinite, fps >= 23.5, hasAudio else {
            throw CaptureFailure.message("Clip is \(Int(abs(size.width)))×\(Int(abs(size.height))), \(String(format: "%.1f", fps)) fps, \(hasAudio ? "with audio" : "without audio"). Processing needs ≥1280 px on the long edge, approximately 24 fps or higher, and audio. Export a matching recording from Meta AI if the live stream cannot provide this.")
        }
        let normalization = fps < 29 ? " · normalized to 30 fps during processing" : ""
        return "\(Int(abs(size.width)))×\(Int(abs(size.height))) · \(String(format: "%.1f", fps)) fps · audio\(normalization)"
    }
}
