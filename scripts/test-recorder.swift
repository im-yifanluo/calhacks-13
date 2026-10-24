// Compile with apps/ios/SceneCapture/Recorder.swift on macOS. Produces a synthetic MP4.
import AVFoundation
import CoreVideo
import Foundation

@main struct RecorderSmokeTest {
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { throw CaptureFailure.message("Pass a new output .mp4 path") }
        let url=URL(fileURLWithPath:CommandLine.arguments[1]);let recorder=Recorder();recorder.begin(at:url)
        for frame in 0..<60 {
            var pixel:CVPixelBuffer?
            guard CVPixelBufferCreate(kCFAllocatorDefault,320,240,kCVPixelFormatType_32ARGB,nil,&pixel)==kCVReturnSuccess,let pixel else { throw CaptureFailure.message("Pixel buffer creation failed") }
            CVPixelBufferLockBaseAddress(pixel,[])
            let data=CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to:UInt8.self),stride=CVPixelBufferGetBytesPerRow(pixel)
            for y in 0..<240 { for x in 0..<320 { let i=y*stride+x*4;data[i]=255;data[i+1]=UInt8(frame*4);data[i+2]=UInt8(x%256);data[i+3]=UInt8(y%256) } }
            CVPixelBufferUnlockBaseAddress(pixel,[])
            var format:CMVideoFormatDescription?;CMVideoFormatDescriptionCreateForImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:pixel,formatDescriptionOut:&format)
            var timing=CMSampleTimingInfo(duration:CMTime(value:1,timescale:30),presentationTimeStamp:CMTime(value:Int64(frame),timescale:30),decodeTimeStamp:.invalid)
            var sample:CMSampleBuffer?;CMSampleBufferCreateReadyWithImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:pixel,formatDescription:format!,sampleTiming:&timing,sampleBufferOut:&sample)
            recorder.append(sample!)
            try await Task.sleep(nanoseconds:34_000_000)
        }
        let saved=try await recorder.finish(),asset=AVURLAsset(url:saved)
        let duration=try await asset.load(.duration).seconds
        guard duration>1.8 else { throw CaptureFailure.message("Too few frames saved") }
        print("PASS: Recorder produced a playable \(duration)-second synthetic MP4 at \(saved.path)")
    }
}
