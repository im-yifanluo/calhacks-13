import Foundation
import Observation

struct UploadIdentity: Codable, Sendable {
  var identity: String
  var token: String
}

struct UploadTicket: Codable, Sendable {
  var putUrl: URL
  var receipt: String
  var requestId: String
  var receiptExpiresAt: Double
  var headers: [String: String]
  enum CodingKeys: String, CodingKey {
    case putUrl, receipt, requestId, receiptExpiresAt, headers
  }
}

struct PendingRecording: Codable, Identifiable, Sendable {
  var id: UUID
  var fileName: String
  var title: String
  var durationSec: Double
  var backend: URL
  var size: Int
  var pipeline = true
  var identity: UploadIdentity?
  var ticket: UploadTicket?
  var transferred = false
  var memoryID: String?
  var sourceURL: URL?
  var error: String?
  var attempts = 0
  var nextAttempt = Date.distantPast
}

struct UploadFailure: LocalizedError {
  var message: String
  var errorDescription: String? { message }
}

/// Durable foreground queue. A recording and its receipt survive app restarts.
/// Upload completion is retried with the same receipt before starting another PUT.
@Observable @MainActor
final class UploadQueue {
  static let shared = UploadQueue()
  private(set) var recordings: [PendingRecording] = []
  private(set) var status = "Record a video; it uploads automatically when you stop."
  private(set) var isUploading = false
  private(set) var storageError: String?
  private let directory: URL
  private let session: URLSession
  private var runner: Task<Void, Never>?
  private var active = false

  init(directory: URL? = nil, session: URLSession = .shared) {
    self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("MemoryReplayUploads", isDirectory: true)
    self.session = session
    do {
      try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
      let index = self.directory.appendingPathComponent("queue.json")
      if FileManager.default.fileExists(atPath: index.path) {
        recordings = try JSONDecoder().decode([PendingRecording].self, from: Data(contentsOf: index))
      }
    } catch {
      storageError = "Could not open saved uploads: \(error.localizedDescription)"
      status = storageError!
    }
  }

  static func backendURL(_ value: String) throws -> URL {
    guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
          let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
          url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
          url.scheme == "https" || (url.scheme == "http" &&
            (host.hasSuffix(".local") || host == "localhost" || host == "127.0.0.1")) else {
      throw UploadFailure(message: "Use an HTTPS server URL or http://your-mac.local:5173 for same-Wi-Fi testing.")
    }
    return url
  }

  func enqueue(file: URL, duration: Double, backend: URL, title: String? = nil, pipeline: Bool = true) throws {
    guard storageError == nil else { throw UploadFailure(message: storageError!) }
    guard duration.isFinite, duration > 0, duration <= 3600 else {
      throw UploadFailure(message: "Recording must be between 0 and 3600 seconds.")
    }
    _ = try Self.backendURL(backend.absoluteString)
    let id = UUID(), fileName = UUID().uuidString + ".mov"
    let target = directory.appendingPathComponent(fileName)
    try FileManager.default.copyItem(at: file, to: target)
    #if os(iOS)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
    #endif
    let size = try target.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size > 0, size <= 2 * 1024 * 1024 * 1024 else {
      throw UploadFailure(message: "Recording must be nonempty and at most 2 GiB. Original file is preserved.")
    }
    recordings.append(PendingRecording(id: id, fileName: fileName,
      title: String((title ?? "Glasses \(Date().formatted(date: .abbreviated, time: .standard))").prefix(120)),
      durationSec: duration, backend: backend, size: size, pipeline: pipeline))
    do { try save() } catch { recordings.removeLast(); throw error }
    status = "Saved on this phone. Waiting to upload…"
    startIfNeeded()
  }

  func setActive(_ value: Bool) {
    active = value
    // Let the current request finish when possible. iOS may suspend the app;
    // persisted state is resumed on activation, never discarded on backgrounding.
    if value { startIfNeeded() }
  }

  func retry() {
    for index in recordings.indices where recordings[index].memoryID == nil {
      recordings[index].nextAttempt = .distantPast
    }
    do { try save(); startIfNeeded() }
    catch { status = error.localizedDescription }
  }

  private func startIfNeeded() {
    guard active, runner == nil, storageError == nil else { return }
    runner = Task { [weak self] in
      guard let self else { return }
      defer { self.runner = nil }
      while self.active && !Task.isCancelled {
        await self.processNext()
        if !self.recordings.contains(where: { $0.memoryID == nil }) { return }
        try? await Task.sleep(for: .seconds(2))
      }
    }
  }

  /// Also callable by the native integration test without starting the retry loop.
  func processNext() async {
    guard !isUploading, storageError == nil,
          let index = recordings.firstIndex(where: { $0.memoryID == nil && $0.nextAttempt <= Date() }) else { return }
    isUploading = true
    defer { isUploading = false }
    do {
      try await upload(index)
      status = "Uploaded · memory #\(recordings[index].memoryID!)"
    } catch {
      recordings[index].attempts += 1
      recordings[index].error = error.localizedDescription
      recordings[index].nextAttempt = Date().addingTimeInterval(min(300, pow(2, Double(min(recordings[index].attempts, 6))) * 5))
      status = "Saved on phone · upload will retry. \(error.localizedDescription)"
      do { try save() } catch { storageError = "Could not save retry state: \(error.localizedDescription)"; status = storageError! }
    }
  }

  private func save() throws {
    let data = try JSONEncoder().encode(recordings)
    #if os(iOS)
    try data.write(to: directory.appendingPathComponent("queue.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: directory.appendingPathComponent("queue.json"), options: .atomic)
    #endif
  }

  private func request(_ backend: URL, _ path: String, body: [String: Any]? = nil,
                       identity: UploadIdentity? = nil) async throws -> Data {
    var request = URLRequest(url: backend.appendingPathComponent(path))
    request.timeoutInterval = 30
    request.httpMethod = "POST"
    if let identity { request.setValue("Bearer \(identity.token)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await session.data(for: request)
    try check(response, data)
    return data
  }

  private func check(_ response: URLResponse, _ data: Data) throws {
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
      let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw UploadFailure(message: message ?? "Server could not complete the upload. Check the backend and Wi-Fi.")
    }
  }

  private func upload(_ index: Int) async throws {
    let backend = recordings[index].backend
    if recordings[index].identity == nil {
      status = "Connecting to upload server…"
      var identity = try JSONDecoder().decode(UploadIdentity.self, from: await request(backend, "api/identity"))
      if identity.identity.hasPrefix("0x") { identity.identity.removeFirst(2) }
      recordings[index].identity = identity
      try save()
    }
    let identity = recordings[index].identity!
    if let ticket = recordings[index].ticket {
      // Never discard an expired receipt after a PUT: completion may already have
      // registered a memory. Look up its request ID before re-uploading anything.
      if recordings[index].transferred && ticket.receiptExpiresAt <= Date().timeIntervalSince1970 * 1000 {
        if try await confirmExisting(index) { return }
        recordings[index].ticket = nil
        recordings[index].transferred = false
        try save()
      } else if !recordings[index].transferred && ticket.receiptExpiresAt - 46 * 60 * 1000 <= Date().timeIntervalSince1970 * 1000 {
        if try await confirmExisting(index) { return }
        recordings[index].ticket = nil
        try save()
      }
    }
    if recordings[index].ticket == nil {
      let job = recordings[index]
      status = "Preparing upload…"
      let (configData, configResponse) = try await session.data(from: backend.appendingPathComponent("api/account/config"))
      try check(configResponse, configData)
      let config = try JSONSerialization.jsonObject(with: configData) as? [String: Any]
      if let maximum = config?["maxUploadBytes"] as? Int, job.size > maximum {
        throw UploadFailure(message: "Recording exceeds this server's upload limit. Record a shorter clip; your original remains saved.")
      }
      let reconstruct = job.pipeline && config?["pipelineAvailable"] as? Bool == true
      let data = try await request(backend, "api/uploads/presign", body: [
        "identity": identity.identity, "name": job.fileName, "type": "video/quicktime",
        "size": job.size, "title": job.title, "durationSec": job.durationSec, "pipeline": reconstruct,
      ], identity: identity)
      recordings[index].ticket = try JSONDecoder().decode(UploadTicket.self, from: data)
      try save()
    }
    let ticket = recordings[index].ticket!
    if !recordings[index].transferred {
      status = "Uploading \(recordings[index].size / 1_000_000) MB…"
      var put = URLRequest(url: ticket.putUrl)
      put.httpMethod = "PUT"
      put.timeoutInterval = 15 * 60
      for (key, value) in ticket.headers { put.setValue(value, forHTTPHeaderField: key) }
      let (data, response) = try await session.upload(for: put, fromFile: directory.appendingPathComponent(recordings[index].fileName))
      try check(response, data)
      recordings[index].transferred = true
      try save()
    }
    status = "Confirming database record…"
    _ = try await request(backend, "api/uploads/complete", body: [
      "identity": identity.identity, "receipt": ticket.receipt,
    ], identity: identity)
    guard try await confirmExisting(index) else { throw UploadFailure(message: "Upload received but database verification is pending.") }
  }

  private func confirmExisting(_ index: Int) async throws -> Bool {
    let job = recordings[index]
    guard let ticket = job.ticket, let identity = job.identity else { return false }
    var components = URLComponents(url: job.backend.appendingPathComponent("api/memories"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "identity", value: identity.identity)]
    var get = URLRequest(url: components.url!)
    get.timeoutInterval = 30
    get.setValue("Bearer \(identity.token)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await session.data(for: get)
    try check(response, data)
    struct Memory: Decodable { var id: String; var requestId: String; var sourceUrl: URL }
    struct Listing: Decodable { var memories: [Memory] }
    guard let memory = try JSONDecoder().decode(Listing.self, from: data).memories.first(where: { $0.requestId == ticket.requestId }) else { return false }
    recordings[index].memoryID = memory.id
    recordings[index].sourceURL = memory.sourceUrl
    recordings[index].error = nil
    try save()
    return true
  }
}
