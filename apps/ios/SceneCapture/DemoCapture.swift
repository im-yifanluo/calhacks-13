import AVFoundation
import SwiftUI

/// A deterministic camera substitute. Encoding, persistence and uploads use the real app path.
@MainActor
final class DemoCapture: ObservableObject {
    @Published var preview: UIImage? = DemoScene.image(at: 0)
    @Published var recording = false
    @Published var finishing = false
    @Published var startingRecording = false
    @Published var error = ""
    @Published var elapsed: Double = 0
    let library: SceneLibrary
    private let recorder = Recorder()
    private var frames: Task<Void, Never>?
    private var current: PendingCapture?
    var canStart: Bool { !recording && !finishing }
    var canStop: Bool { recording && !finishing }

    init(library: SceneLibrary) { self.library = library }

    func recordOn() async {
        guard canStart, !library.savingProfile else { return }
        let title = library.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 100 else { error = "Enter a title up to 100 characters."; return }
        error = ""; elapsed = 0; library.proof = ""
        let item = PendingCapture(id: UUID(), title: "[SIMULATION] \(title)", isSimulation: true)
        current = item
        recorder.begin(at: library.file(for: item))
        recording = true
        library.captureActive = true
        UIApplication.shared.isIdleTimerDisabled = true
        library.message = "Recording a simulated scene. Stop & save finishes the MP4."
        let start = ContinuousClock.now
        frames = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.recording else { return }
                let duration = start.duration(to: .now)
                self.elapsed = Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
                do {
                    let image = DemoScene.image(at: self.elapsed)
                    self.preview = image
                    self.recorder.append(try DemoScene.sample(image: image, seconds: self.elapsed))
                } catch {
                    self.error = error.localizedDescription
                    await self.recordOff(); return
                }
                if self.elapsed >= 30 { await self.recordOff(); return }
                do { try await Task.sleep(for: .milliseconds(42)) } catch { return }
            }
        }
    }

    func recordOff() async {
        guard recording, !finishing, let item = current else { return }
        recording = false; finishing = true
        frames?.cancel(); frames = nil
        UIApplication.shared.isIdleTimerDisabled = false
        defer { finishing = false; current = nil; library.captureActive = false }
        do {
            _ = try await recorder.finish()
            try library.saveRecording(item)
        } catch { self.error = error.localizedDescription }
    }

    func handleURL(_ url: URL) async {}
    func backgrounded() async {
        let token = UIApplication.shared.beginBackgroundTask(withName: "Finish demo clip")
        await recordOff()
        if token != .invalid { UIApplication.shared.endBackgroundTask(token) }
    }
}

enum DemoScene {
    static let size = CGSize(width: 640, height: 360)

    static func image(at seconds: Double) -> UIImage {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { renderer in
            let c = renderer.cgContext
            UIColor(red: 0.06, green: 0.12, blue: 0.17, alpha: 1).setFill()
            c.fill(CGRect(origin: .zero, size: size))
            UIColor(red: 0.10, green: 0.23, blue: 0.26, alpha: 1).setFill()
            c.fill(CGRect(x: 0, y: 205, width: 640, height: 155))
            c.setStrokeColor(UIColor.white.withAlphaComponent(0.10).cgColor); c.setLineWidth(1)
            for x in stride(from: -320, through: 960, by: 80) {
                c.move(to: CGPoint(x: 320, y: 140)); c.addLine(to: CGPoint(x: x, y: 360)); c.strokePath()
            }
            for y in [205, 231, 267, 313, 358] {
                c.move(to: CGPoint(x: 0, y: y)); c.addLine(to: CGPoint(x: 640, y: y)); c.strokePath()
            }
            func polygon(_ points: [CGPoint], _ color: UIColor) {
                c.beginPath(); c.addLines(between: points); c.closePath(); c.setFillColor(color.cgColor); c.fillPath()
            }
            polygon([.init(x: 160, y: 150), .init(x: 245, y: 130), .init(x: 292, y: 167), .init(x: 204, y: 190)], .systemTeal)
            polygon([.init(x: 160, y: 150), .init(x: 204, y: 190), .init(x: 204, y: 265), .init(x: 160, y: 223)], UIColor(red: 0.12, green: 0.48, blue: 0.49, alpha: 1))
            polygon([.init(x: 204, y: 190), .init(x: 292, y: 167), .init(x: 292, y: 242), .init(x: 204, y: 265)], UIColor(red: 0.18, green: 0.64, blue: 0.62, alpha: 1))
            let x = 430 + sin(seconds * 1.4) * 75
            let lift = abs(sin(seconds * 2.1)) * 100
            c.setFillColor(UIColor.black.withAlphaComponent(0.25).cgColor)
            c.fillEllipse(in: CGRect(x: x - 36, y: 265, width: 72, height: 14))
            c.setFillColor(UIColor(red: 1, green: 0.72, blue: 0.39, alpha: 1).cgColor)
            c.fillEllipse(in: CGRect(x: x - 30, y: 215 - lift, width: 60, height: 60))
            c.setFillColor(UIColor.white.withAlphaComponent(0.5).cgColor)
            c.fillEllipse(in: CGRect(x: x - 16, y: 224 - lift, width: 12, height: 12))
            let caption: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedSystemFont(ofSize: 15, weight: .medium), .foregroundColor: UIColor.white]
            ("SIMULATED CAMERA · NO GLASSES" as NSString).draw(at: CGPoint(x: 24, y: 24), withAttributes: caption)
            (String(format: "MEMORY REPLAY  /  %05.1f s", seconds) as NSString).draw(at: CGPoint(x: 24, y: 322), withAttributes: caption)
        }
    }

    static func sample(image: UIImage, seconds: Double) throws -> CMSampleBuffer {
        var pixel: CVPixelBuffer?
        let attrs = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, 640, 360, kCVPixelFormatType_32ARGB, attrs, &pixel) == kCVReturnSuccess,
              let pixel, let cgImage = image.cgImage else { throw CaptureFailure.message("Cannot create demo camera frame") }
        CVPixelBufferLockBaseAddress(pixel, []); defer { CVPixelBufferUnlockBaseAddress(pixel, []) }
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: 640, height: 360, bitsPerComponent: 8,
                                      bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { throw CaptureFailure.message("Cannot render demo frame") }
        context.draw(cgImage, in: CGRect(origin: .zero, size: size))
        var format: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixel, formatDescriptionOut: &format) == noErr,
              let format else { throw CaptureFailure.message("Cannot describe demo frame") }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 24), presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 60000), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixel, formatDescription: format,
                                                     sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
              let sample else { throw CaptureFailure.message("Cannot encode demo frame") }
        return sample
    }
}
