import AVFoundation
import Foundation
import Security
import SwiftUI
import CryptoKit

struct SavedScene: Codable, Identifiable {
    let id: String
    let title: String
    let sourceUrl: String
    let status: String
    let durationUs: String
    let requestId: String
    let pipelineIdentity: String?
    let manifestUrl: String?
    let progress: Double?
    let error: String?

    var progressFraction: Double { min(1, max(0, progress?.isFinite == true ? progress! : 0)) }
    var processingLabel: String {
        switch status {
        case "ready": return "Ready to explore"
        case "processing": return "Building your scene · \(Int(progressFraction * 100))%"
        case "failed": return "Processing failed"
        default: return "Video received · waiting for processing"
        }
    }
}
struct Playback: Identifiable { let id = UUID(); let url: URL }
struct PreparedUpload: Codable {
    let putUrl: String
    let receipt: String
    let requestId: String
    let receiptExpiresAt: Double
    let headers: [String: String]
    let pipeline: Bool?
}
struct PendingCapture: Codable, Identifiable {
    let id: UUID
    let title: String
    var isSimulation: Bool? = nil
    var server: String? = nil
    var prepared: PreparedUpload? = nil
    var uploaded = false
    var filename: String { "\(id.uuidString).mp4" }
}
struct ServerIdentity: Codable { let identity: String; let token: String }
private struct UserProfile: Decodable { let identity: String; let displayName: String }
private struct MemoryList: Decodable { let memories: [SavedScene] }
private struct CompletedUpload: Decodable { let memory: SavedScene }

private enum IdentityVault {
    static func key(_ endpoint: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "MemoryReplay",
         kSecAttrAccount as String: endpoint]
    }
    static func read(_ endpoint: String) -> ServerIdentity? {
        var query = key(endpoint); query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(ServerIdentity.self, from: data)
    }
    static func save(_ identity: ServerIdentity, for endpoint: String) throws {
        let data = try JSONEncoder().encode(identity)
        let status = SecItemUpdate(key(endpoint) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw CaptureFailure.message("Cannot update identity in Keychain") }
        var query = key(endpoint); query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw CaptureFailure.message("Cannot save identity in Keychain") }
    }
}

@MainActor
final class SceneLibrary: ObservableObject {
    @Published var endpoint = UserDefaults.standard.string(forKey: "memreplay.endpoint") ?? ""
    @Published var viewerEndpoint = UserDefaults.standard.string(forKey: "memreplay.viewerEndpoint") ?? ""
    @Published var displayName = ""
    @Published var userID = ""
    @Published var profileReady = false
    @Published var savingProfile = false
    @Published var profileMessage = "Enter your name to get started."
    @Published var title = "Wayfarer capture test"
    @Published var scenes: [SavedScene] = []
    @Published var pending: [PendingCapture] = []
    @Published var localCaptures: [PendingCapture] = []
    @Published var uploading = false
    @Published var checking = false
    @Published var playback: Playback?
    @Published var message = "Enter the web app's server address in Settings."
    @Published var proof = ""
    @Published var sceneConnectionError = ""
    let directory: URL
    private var savedEndpoint = UserDefaults.standard.string(forKey: "memreplay.endpoint") ?? ""
    private var savedViewerEndpoint = UserDefaults.standard.string(forKey: "memreplay.viewerEndpoint") ?? ""
    var partyURL: URL? {
        guard let url = URL(string: savedViewerEndpoint.isEmpty ? savedEndpoint : savedViewerEndpoint), ["http", "https"].contains(url.scheme ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    var libraryURL: URL? { partyURL?.appendingPathComponent("library.html") }
    func sceneURL(_ scene: SavedScene) -> URL? {
        guard let origin = partyURL else { return nil }
        return Self.viewerURL(scene, origin: origin)
    }
    static func viewerURL(_ scene: SavedScene, origin: URL) -> URL? {
        guard scene.status == "ready", let value = scene.manifestUrl, !value.isEmpty,
              let manifest = URL(string: value, relativeTo: origin)?.absoluteURL,
              ["https", "http"].contains(manifest.scheme ?? ""), manifest.host != nil,
              manifest.user == nil, manifest.password == nil,
              ["https", "http"].contains(origin.scheme ?? ""), origin.host != nil,
              origin.user == nil, origin.password == nil,
              var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = "/"; parts.fragment = nil
        parts.queryItems = [URLQueryItem(name: "memory", value: manifest.absoluteString)]
        return parts.url
    }
    private var queueURL: URL { directory.appendingPathComponent("queue.json") }
    private var catalogURL: URL { directory.appendingPathComponent("captures.json") }
    init() {
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Captures")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: queueURL.path) {
                pending = try JSONDecoder().decode([PendingCapture].self, from: Data(contentsOf: queueURL))
            }
            if FileManager.default.fileExists(atPath: catalogURL.path) {
                localCaptures = try JSONDecoder().decode([PendingCapture].self, from: Data(contentsOf: catalogURL))
            }
            for item in pending where !localCaptures.contains(where: { $0.id == item.id }) { localCaptures.insert(item, at: 0) }
        } catch { message = "Cannot restore upload queue: \(error.localizedDescription)" }
        #if DEMO_APP
        title = "Phone demo"
        #if targetEnvironment(simulator)
        if endpoint.isEmpty {
            endpoint = "http://127.0.0.1:5173"
            savedEndpoint = endpoint
            message = "Simulator ready. On records; Off saves and uploads to the local server."
        }
        #endif
        #endif
    }
    func saveSettings() {
        guard !uploading, !checking, !savingProfile else { return }
        let value = endpoint.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
              url.query == nil, url.fragment == nil, url.user == nil, url.password == nil, url.path.isEmpty else {
            message = "Enter an HTTP(S) app origin, for example http://your-mac.local:5173"; return
        }
        let viewer = viewerEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !viewer.isEmpty {
            guard let url = URL(string: viewer), ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
                  url.query == nil, url.fragment == nil, url.user == nil, url.password == nil, url.path.isEmpty else {
                message = "Use an HTTP(S) web viewer origin, or leave it blank to use the upload server."; return
            }
        }
        endpoint = value; savedEndpoint = value
        viewerEndpoint = viewer; savedViewerEndpoint = viewer
        UserDefaults.standard.set(value, forKey: "memreplay.endpoint")
        UserDefaults.standard.set(viewer, forKey: "memreplay.viewerEndpoint")
        scenes = []; profileReady = false; userID = ""; displayName = ""
        message = "Server saved. Enter your name, then continue."
    }
    private func persist() throws { try JSONEncoder().encode(pending).write(to: queueURL, options: .atomic) }
    func enqueue(_ capture: PendingCapture) throws {
        pending.append(capture)
        do { try persist() } catch { pending.removeLast(); throw error }
        localCaptures.insert(capture, at: 0)
        // The queue is already durable; a catalog failure must not lose an upload.
        do { try JSONEncoder().encode(localCaptures).write(to: catalogURL, options: .atomic) }
        catch { message = "Clip queued, but its local library index could not be saved." }
    }
    func file(for capture: PendingCapture) -> URL { directory.appendingPathComponent(capture.filename) }
    func playLocal(_ capture: PendingCapture) { playback = Playback(url: file(for: capture)) }
    func resume() async {
        if !pending.isEmpty { await uploadPending() }
        else if !savedEndpoint.isEmpty { await refresh() }
    }
    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, identity: ServerIdentity? = nil) throws -> URLRequest {
        guard let url = URL(string: savedEndpoint + path), url.host != nil else { throw CaptureFailure.message("Save the server address in Settings first") }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 30
        if let identity { request.setValue("Bearer \(identity.token)", forHTTPHeaderField: "Authorization") }
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        return request
    }
    private func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw CaptureFailure.message(detail ?? (code >= 500 ? "Upload service unavailable. Check the server address and start npm run upload:local" : "Server rejected request (\(code))"))
        }
    }
    private func identity() async throws -> ServerIdentity {
        if let saved = IdentityVault.read(savedEndpoint) { return saved }
        let (data,response) = try await URLSession.shared.data(for: request("/api/identity", method: "POST"))
        try check(data,response)
        let identity = try JSONDecoder().decode(ServerIdentity.self, from: data)
        try IdentityVault.save(identity,for:savedEndpoint)
        return identity
    }
    private func loadProfile(_ auth: ServerIdentity) async throws {
        let hex = auth.identity.replacingOccurrences(of: "0x", with: "")
        let (data, response) = try await URLSession.shared.data(for: request("/api/profile?identity=\(hex)", identity: auth))
        try check(data, response)
        let profile = try JSONDecoder().decode(UserProfile.self, from: data)
        userID = profile.identity
        profileReady = !profile.displayName.isEmpty
        if profileReady { displayName = profile.displayName }
    }
    func saveProfile() async {
        guard !uploading, !checking, !savingProfile else { return }
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 40 else { profileMessage = "Use a name of 1–40 characters."; return }
        savingProfile = true
        defer { savingProfile = false }
        do {
            let auth = try await identity()
            let hex = auth.identity.replacingOccurrences(of: "0x", with: "")
            let (data, response) = try await URLSession.shared.data(for: request("/api/profile", method: "POST", body: ["identity": hex, "displayName": name], identity: auth))
            try check(data, response)
            let profile = try JSONDecoder().decode(UserProfile.self, from: data)
            userID = profile.identity; displayName = profile.displayName; profileReady = true
            profileMessage = "Welcome, \(profile.displayName). Your ID is saved on this iPhone."
            await uploadPending()
        } catch { profileMessage = error.localizedDescription }
    }
    func refresh(silent: Bool = false) async {
        guard !uploading, !checking, !savingProfile else { return }
        checking = true
        defer {
            checking = false
            if !pending.isEmpty { Task { await uploadPending() } }
        }
        do {
            let auth = try await identity()
            if !profileReady { try await loadProfile(auth) }
            let hex = auth.identity.replacingOccurrences(of: "0x", with: "")
            let (data,response) = try await URLSession.shared.data(for: request("/api/memories?identity=\(hex)",identity:auth))
            try check(data,response); scenes = try JSONDecoder().decode(MemoryList.self,from:data).memories
            sceneConnectionError = ""
            if !silent { message = "Database connected. \(scenes.count) recordings registered for this app." }
        } catch {
            sceneConnectionError = error.localizedDescription
            if !silent { message = error.localizedDescription }
        }
    }
    func uploadPending() async {
        guard !uploading, !checking, !pending.isEmpty else { return }
        proof = ""
        uploading = true; defer { uploading = false }
        do {
            let auth = try await identity()
            if !profileReady { try await loadProfile(auth) }
            guard profileReady else { message = "Enter your name before uploading. Your clips are saved locally."; return }
            let hex = auth.identity.replacingOccurrences(of: "0x",with: "")
            while !pending.isEmpty {
                var item = pending[0]
                guard item.server == nil || item.server == savedEndpoint else { throw CaptureFailure.message("This upload belongs to another server. Restore its address in Settings to retry.") }
                let file = directory.appendingPathComponent(item.filename)
                if item.prepared == nil || item.prepared!.receiptExpiresAt < Date().timeIntervalSince1970 * 1000 {
                    let duration = try await AVURLAsset(url:file).load(.duration).seconds
                    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard duration.isFinite, duration > 0 else { throw CaptureFailure.message("Recording has no readable duration") }
                    let (data,response) = try await URLSession.shared.data(for: request("/api/uploads/presign",method:"POST",body:["identity":hex,"name":item.filename,"type":"video/mp4","size":size,"title":item.title,"durationSec":duration,"pipeline":item.isSimulation != true],identity:auth))
                    try check(data,response)
                    let ticket = try JSONDecoder().decode(PreparedUpload.self,from:data)
                    guard item.isSimulation != true || ticket.pipeline == false else {
                        throw CaptureFailure.message("Restart the upload service from this build: it must support test uploads")
                    }
                    item.prepared = ticket
                    item.server = savedEndpoint;item.uploaded = false;pending[0] = item;try persist()
                }
                let prepared = item.prepared!
                if !item.uploaded {
                    guard let url = URL(string:prepared.putUrl) else { throw CaptureFailure.message("Invalid upload URL") }
                    message = "Uploading \(item.title)…"
                    var put = URLRequest(url:url);put.httpMethod = "PUT";put.timeoutInterval = 900
                    for (key,value) in prepared.headers { put.setValue(value,forHTTPHeaderField:key) }
                    do {
                        let (data,response) = try await URLSession.shared.upload(for:put,fromFile:file)
                        try check(data,response)
                    } catch {
                        // A retry obtains a fresh signed PUT; never reuse an expired URL.
                        item.prepared = nil;pending[0] = item;try persist();throw error
                    }
                    item.uploaded = true;pending[0] = item;try persist()
                }
                let (data,response) = try await URLSession.shared.data(for:request("/api/uploads/complete",method:"POST",body:["identity":hex,"receipt":prepared.receipt],identity:auth))
                try check(data,response)
                let confirmed = try JSONDecoder().decode(CompletedUpload.self,from:data).memory
                message = "Checking database row and downloading the stored video…"
                let (listed, listResponse) = try await URLSession.shared.data(for: request("/api/memories?identity=\(hex)", identity: auth))
                try check(listed, listResponse)
                let memories = try JSONDecoder().decode(MemoryList.self, from: listed).memories
                guard let row = memories.first(where: { $0.requestId == prepared.requestId }), row.id == confirmed.id else {
                    throw CaptureFailure.message("Independent database lookup did not confirm the recording")
                }
                guard item.isSimulation != true || row.pipelineIdentity?.lowercased() == hex.lowercased() else {
                    throw CaptureFailure.message("Demo clip was assigned to a reconstruction worker")
                }
                guard let storedURL = URL(string: row.sourceUrl) else { throw CaptureFailure.message("Invalid stored video URL") }
                var get = URLRequest(url: storedURL); get.cachePolicy = .reloadIgnoringLocalCacheData; get.timeoutInterval = 120
                let (download, storedResponse) = try await URLSession.shared.download(for: get)
                defer { try? FileManager.default.removeItem(at: download) }
                try check(Data(), storedResponse)
                let digest = try await Task.detached {
                    let original = try fileSHA256(file)
                    guard original == (try fileSHA256(download)) else { throw CaptureFailure.message("Stored video bytes differ from the recording") }
                    return original
                }.value
                proof = "PASS · Database row #\(row.id) · Download matches recording\nSHA-256 \(digest)"
                scenes.removeAll { $0.id == confirmed.id };scenes.insert(confirmed,at:0)
                pending.removeFirst();try persist()
                message = "Verified database row #\(confirmed.id). The stored video matches this phone's MP4."
            }
        } catch { message = "Upload pending: \(error.localizedDescription). Recording remains in Files → Memory Replay → Captures." }
    }
    func importVideo(_ url: URL) async {
        let accessed = url.startAccessingSecurityScopedResource();defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
            let clean = title.trimmingCharacters(in:.whitespacesAndNewlines)
            guard !clean.isEmpty,clean.count <= 120 else { throw CaptureFailure.message("Enter a title up to 120 characters") }
            let item = PendingCapture(id:UUID(),title:clean)
            try FileManager.default.copyItem(at:url,to:directory.appendingPathComponent(item.filename))
            try enqueue(item);await uploadPending()
        } catch { message = error.localizedDescription }
    }
    func play(_ scene: SavedScene) { if let url = URL(string:scene.sourceUrl) { playback = Playback(url:url) } }
}

/// Stream hashes so checking a long glasses clip doesn't load two full videos into RAM.
private func fileSHA256(_ url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
    var digest = SHA256()
    while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty { digest.update(data: chunk) }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
}
