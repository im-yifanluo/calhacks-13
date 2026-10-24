import AVFoundation
import Foundation
import Security
import SwiftUI

struct SavedScene: Codable, Identifiable {
    let id: String
    let title: String
    let sourceUrl: String
    let status: String
    let durationUs: String
    let requestId: String
}
struct Playback: Identifiable { let id = UUID(); let url: URL }
struct PreparedUpload: Codable {
    let putUrl: String
    let receipt: String
    let requestId: String
    let receiptExpiresAt: Double
    let headers: [String: String]
}
struct PendingCapture: Codable, Identifiable {
    let id: UUID
    let title: String
    var server: String? = nil
    var prepared: PreparedUpload? = nil
    var uploaded = false
    var filename: String { "\(id.uuidString).mp4" }
}
struct ServerIdentity: Codable { let identity: String; let token: String }
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
    @Published var title = "Wayfarer capture test"
    @Published var scenes: [SavedScene] = []
    @Published var pending: [PendingCapture] = []
    @Published var uploading = false
    @Published var checking = false
    @Published var playback: Playback?
    @Published var message = "Enter the web app's server address in Settings."
    let directory: URL
    private var savedEndpoint = UserDefaults.standard.string(forKey: "memreplay.endpoint") ?? ""
    private var queueURL: URL { directory.appendingPathComponent("queue.json") }
    init() {
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Captures")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: queueURL.path) {
                pending = try JSONDecoder().decode([PendingCapture].self, from: Data(contentsOf: queueURL))
            }
        } catch { message = "Cannot restore upload queue: \(error.localizedDescription)" }
    }
    func saveSettings() {
        guard !uploading, !checking else { return }
        let value = endpoint.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
              url.query == nil, url.fragment == nil, url.user == nil, url.password == nil else {
            message = "Enter an HTTP(S) app origin, for example http://your-mac.local:5173"; return
        }
        endpoint = value; savedEndpoint = value
        UserDefaults.standard.set(value, forKey: "memreplay.endpoint")
        scenes = []; message = "Server saved. Tap Test connection."
    }
    private func persist() throws { try JSONEncoder().encode(pending).write(to: queueURL, options: .atomic) }
    func enqueue(_ capture: PendingCapture) throws {
        pending.append(capture)
        do { try persist() } catch { pending.removeLast(); throw error }
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
            throw CaptureFailure.message(detail ?? "Server rejected request (\((response as? HTTPURLResponse)?.statusCode ?? 0))")
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
    func refresh() async {
        guard !uploading, !checking else { return }
        checking = true; defer { checking = false }
        do {
            let auth = try await identity()
            let hex = auth.identity.replacingOccurrences(of: "0x", with: "")
            let (data,response) = try await URLSession.shared.data(for: request("/api/memories?identity=\(hex)",identity:auth))
            try check(data,response); scenes = try JSONDecoder().decode(MemoryList.self,from:data).memories
            message = "Database connected. \(scenes.count) recordings registered for this app."
        } catch { message = error.localizedDescription }
    }
    func uploadPending() async {
        guard !uploading, !checking, !pending.isEmpty else { return }
        uploading = true; defer { uploading = false }
        do {
            let auth = try await identity()
            let hex = auth.identity.replacingOccurrences(of: "0x",with: "")
            while !pending.isEmpty {
                var item = pending[0]
                guard item.server == nil || item.server == savedEndpoint else { throw CaptureFailure.message("This upload belongs to another server. Restore its address in Settings to retry.") }
                let file = directory.appendingPathComponent(item.filename)
                if item.prepared == nil || item.prepared!.receiptExpiresAt < Date().timeIntervalSince1970 * 1000 {
                    let duration = try await AVURLAsset(url:file).load(.duration).seconds
                    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard duration.isFinite, duration > 0 else { throw CaptureFailure.message("Recording has no readable duration") }
                    let (data,response) = try await URLSession.shared.data(for: request("/api/uploads/presign",method:"POST",body:["identity":hex,"name":item.filename,"type":"video/mp4","size":size,"title":item.title,"durationSec":duration],identity:auth))
                    try check(data,response);item.prepared = try JSONDecoder().decode(PreparedUpload.self,from:data)
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
                scenes.removeAll { $0.id == confirmed.id };scenes.insert(confirmed,at:0)
                pending.removeFirst();try persist()
                message = "Verified database row #\(confirmed.id). Open Saved videos → Play stored video."
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
