// Compile with the actual app's UploadQueue.swift. Uses the real local upload API.
import Foundation
import CryptoKit

@main struct NativeUploadTest {
  @MainActor static func main() async throws {
    guard CommandLine.arguments.count == 4 else {
      fatalError("Usage: test-ios-upload FILE BACKEND_URL QUEUE_DIRECTORY")
    }
    let source = URL(fileURLWithPath: CommandLine.arguments[1])
    let backend = try UploadQueue.backendURL(CommandLine.arguments[2])
    let directory = URL(fileURLWithPath: CommandLine.arguments[3])
    let queue = UploadQueue(directory: directory)
    precondition(queue.recordings.isEmpty, "Use a new test directory")
    try queue.enqueue(file: source, duration: 1, backend: backend,
      title: "[NATIVE UPLOAD TEST] confirmation lost", pipeline: true)
    await queue.processNext()
    precondition(queue.recordings[0].memoryID == nil, "Proxy must drop the first confirmation")
    precondition(queue.recordings[0].transferred, "File should already be stored")
    let requestID = queue.recordings[0].ticket!.requestId
    print("PASS: lost confirmation retains video, identity, ticket and transferred state")

    let resumed = UploadQueue(directory: directory)
    resumed.retry()
    await resumed.processNext()
    guard let memoryID = resumed.recordings[0].memoryID, let url = resumed.recordings[0].sourceURL else {
      fatalError(resumed.status)
    }
    precondition(resumed.recordings[0].ticket!.requestId == requestID)
    print("PASS: restarted native uploader retries the same receipt; memory #\(memoryID)")
    let (download, response) = try await URLSession.shared.data(from: url)
    precondition((response as! HTTPURLResponse).statusCode == 200)
    let original = try Data(contentsOf: source)
    precondition(SHA256.hash(data: original) == SHA256.hash(data: download))
    print("PASS: downloaded bytes match the source recording")

    // Recreate the persisted state of an app killed after remote confirmation,
    // then returning after the receipt expired. Lookup must avoid a new upload.
    let index = directory.appendingPathComponent("queue.json")
    var jobs = try JSONDecoder().decode([PendingRecording].self, from: Data(contentsOf: index))
    jobs[0].memoryID = nil
    jobs[0].sourceURL = nil
    jobs[0].ticket!.receiptExpiresAt = 0
    try JSONEncoder().encode(jobs).write(to: index, options: .atomic)
    let expired = UploadQueue(directory: directory)
    expired.retry()
    await expired.processNext()
    precondition(expired.recordings[0].memoryID == memoryID)
    precondition(expired.recordings[0].ticket!.requestId == requestID)
    print("PASS: expired receipt recovers the existing memory without another PUT")
    print("Synthetic transport test only; no glasses or iPhone build verified.")
  }
}
