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
    var pipeline: Bool? = nil

    var progressFraction: Double { min(1, max(0, progress?.isFinite == true ? progress! : 0)) }
    var processingLabel: String {
        switch status {
        case "ready": return "Ready to explore"
        case "processing": return "Building your scene · \(Int(progressFraction * 100))%"
        case "failed": return "Processing failed"
        default: return pipeline == false ? "Video saved · reconstruction not requested" : "Video received · waiting for processing"
        }
    }
}
struct Playback: Identifiable { let id = UUID(); let url: URL }
struct PreparedUpload: Codable {
    let putUrl: String
    let receipt: String
    let requestId: String
    var receiptExpiresAt: Double? = nil
    let headers: [String: String]
    let pipeline: Bool?
    var expiresIn: Double? = nil
}
struct PendingCapture: Codable, Identifiable {
    let id: UUID
    let title: String
    var isSimulation: Bool? = nil
    var owner: String? = nil
    var fileExtension: String? = nil
    var server: String? = nil
    var prepared: PreparedUpload? = nil
    var uploaded = false
    var pipelineRequested: Bool? = nil
    var filename: String { "\(id.uuidString).\(fileExtension == "mov" ? "mov" : "mp4")" }
    var contentType: String { fileExtension == "mov" ? "video/quicktime" : "video/mp4" }
}
struct ServerIdentity: Codable { let identity: String; let token: String; var personalKey: String? = nil; var password: String? = nil }
private struct UserProfile: Codable { let identity: String; let displayName: String; let provider: String? }
private struct MemoryList: Decodable { let memories: [SavedScene] }
private struct CompletedUpload: Decodable { let memory: SavedScene }

protocol CaptureIdentityStore {
    func read(_ endpoint: String) -> ServerIdentity?
    func save(_ identity: ServerIdentity, for endpoint: String) throws
}

struct IdentityVault: CaptureIdentityStore {
    private func key(_ endpoint: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "MemoryReplay",
         kSecAttrAccount as String: endpoint]
    }
    func read(_ endpoint: String) -> ServerIdentity? {
        var query = key(endpoint); query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(ServerIdentity.self, from: data)
    }
    func save(_ identity: ServerIdentity, for endpoint: String) throws {
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
    @Published var endpoint = ""
    @Published var viewerEndpoint = ""
    @Published var displayName = ""
    @Published var userID = ""
    @Published var profileReady = false
    @Published var savingProfile = false
    @Published var captureActive = false
    @Published var personalKeyInput = ""
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
    private let defaults: UserDefaults
    private let identities: any CaptureIdentityStore
    private var savedEndpoint = ""
    private var savedViewerEndpoint = ""
    private var cachedDestination: AccountDestination?
    private var usesPortableAPI: Bool { cachedDestination?.usesPortableAccountAPI == true }
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
    init(directory: URL? = nil, defaults: UserDefaults = .standard, identities: any CaptureIdentityStore = IdentityVault()) {
        self.defaults = defaults
        self.identities = identities
        self.directory = directory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Captures")
        endpoint = defaults.string(forKey: "memreplay.endpoint") ?? ""
        viewerEndpoint = defaults.string(forKey: "memreplay.viewerEndpoint") ?? ""
        savedEndpoint = endpoint; savedViewerEndpoint = viewerEndpoint
        do {
            try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: queueURL.path) {
                pending = try JSONDecoder().decode([PendingCapture].self, from: Data(contentsOf: queueURL))
            }
            if FileManager.default.fileExists(atPath: catalogURL.path) {
                localCaptures = try JSONDecoder().decode([PendingCapture].self, from: Data(contentsOf: catalogURL))
            }
            for item in pending where !localCaptures.contains(where: { $0.id == item.id }) { localCaptures.insert(item, at: 0) }
        } catch { message = "Cannot restore upload queue: \(error.localizedDescription)" }
        if let auth = identities.read(savedEndpoint),
           let data = defaults.data(forKey: "memos.profile:" + savedEndpoint),
           let profile = try? JSONDecoder().decode(UserProfile.self, from: data),
           profile.identity.lowercased() == auth.identity.replacingOccurrences(of: "0x", with: "").lowercased() {
            applyProfile(profile)
        }
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
        guard !uploading, !checking, !savingProfile, !captureActive else { return }
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
        guard pending.isEmpty || value == savedEndpoint else {
            message = "Finish pending uploads before changing servers."; return
        }
        endpoint = value; savedEndpoint = value
        cachedDestination = nil
        viewerEndpoint = viewer; savedViewerEndpoint = viewer
        defaults.set(value, forKey: "memreplay.endpoint")
        defaults.set(viewer, forKey: "memreplay.viewerEndpoint")
        scenes = []; profileReady = false; userID = ""; displayName = ""
        message = "Server saved. Enter your name, then continue."
    }
    private func persist() throws { try JSONEncoder().encode(pending).write(to: queueURL, options: .atomic) }
    func saveRecording(_ capture: PendingCapture) throws {
        if profileReady {
            try enqueue(capture)
            message = "Recording saved; uploading automatically."
            Task { await uploadPending() }
        } else {
            let updated = [capture] + localCaptures
            try JSONEncoder().encode(updated).write(to: catalogURL, options: .atomic)
            localCaptures = updated
            message = "Saved on this phone. Open Memories to play or export it. Sign in later to upload."
        }
    }
    func uploadLocal(_ capture: PendingCapture) async {
        guard profileReady, !savingProfile, !captureActive, !uploading, !checking,
              capture.owner == nil, !pending.contains(where: { $0.id == capture.id }) else { return }
        do {
            try enqueue(capture)
            await uploadPending()
        } catch { message = "Could not queue upload: \(error.localizedDescription). Your local clip is retained." }
    }
    func enqueue(_ capture: PendingCapture) throws {
        var capture = capture
        guard profileReady, !userID.isEmpty else { throw CaptureFailure.message("Sign in before saving a recording") }
        capture.owner = userID
        capture.server = savedEndpoint
        pending.append(capture)
        do { try persist() } catch { pending.removeLast(); throw error }
        localCaptures.removeAll { $0.id == capture.id }
        localCaptures.insert(capture, at: 0)
        // The queue is already durable; a catalog failure must not lose an upload.
        do { try JSONEncoder().encode(localCaptures).write(to: catalogURL, options: .atomic) }
        catch { message = "Clip queued, but its local library index could not be saved." }
    }
    func keepLocalOnly(_ capture: PendingCapture) {
        guard !uploading, !checking, !savingProfile else { return }
        let previous = pending
        pending.removeAll { $0.id == capture.id }
        do { try persist(); message = "Clip kept on this phone. It will not be retried automatically." }
        catch { pending = previous; message = "Could not update the upload queue." }
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
        if let identity {
            let credential: String
            if usesPortableAPI {
                guard let key = identity.personalKey else { throw CaptureFailure.message("Sign in with your website password first") }
                credential = key
            } else { credential = identity.token }
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        }
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
        let destination = try await accountDestination()
        if var saved = identities.read(savedEndpoint) {
            if destination.usesPortableAccountAPI && saved.personalKey == nil {
                saved.personalKey = try AccountKey(server: destination.server, database: destination.database,
                    identity: saved.identity.replacingOccurrences(of: "0x", with: "").lowercased(), token: saved.token).encoded()
            }
            return saved
        }
        guard !usesPortableAPI else { throw CaptureFailure.message("Paste your website password in Capture to sign in, or create an account.") }
        let (data,response) = try await URLSession.shared.data(for: request("/api/identity", method: "POST"))
        try check(data,response)
        let identity = try JSONDecoder().decode(ServerIdentity.self, from: data)
        try identities.save(identity,for:savedEndpoint)
        return identity
    }
    private func fetchProfile(_ auth: ServerIdentity) async throws -> UserProfile {
        let hex = auth.identity.replacingOccurrences(of: "0x", with: "")
        let (data, response) = try await URLSession.shared.data(for: request(usesPortableAPI ? "/api/account" : "/api/profile?identity=\(hex)", identity: auth))
        try check(data, response)
        let profile = try JSONDecoder().decode(UserProfile.self, from: data)
        guard profile.identity.lowercased() == hex.lowercased() else { throw CaptureFailure.message("Profile identity mismatch") }
        return profile
    }
    private func applyProfile(_ profile: UserProfile) {
        if let data = try? JSONEncoder().encode(profile) {
            defaults.set(data, forKey: "memos.profile:" + savedEndpoint)
        }
        userID = profile.identity.lowercased()
        profileReady = profile.provider == "key" && !profile.displayName.isEmpty
        if profileReady || displayName.isEmpty { displayName = profile.displayName }
        profileMessage = profileReady ? "Signed in. Use your password to open this account on the web or Quest." : "Create a password with your name, or paste your existing password."
    }
    private func loadProfile(_ auth: ServerIdentity) async throws {
        applyProfile(try await fetchProfile(auth))
    }
    private func accountDestination(refresh: Bool = false) async throws -> AccountDestination {
        if !refresh, let cachedDestination { return cachedDestination }
        let (data, response) = try await URLSession.shared.data(for: request("/api/account/config"))
        try check(data, response)
        let destination = try JSONDecoder().decode(AccountDestination.self, from: data)
        cachedDestination = destination
        return destination
    }
    func importAccount() async {
        guard !uploading, !checking, !savingProfile, !captureActive else { return }
        guard pending.isEmpty else { profileMessage = "Finish pending uploads before changing accounts."; return }
        savingProfile = true
        defer { savingProfile = false }
        do {
            // The server may have gained password support while this app was open.
            let destination = try await accountDestination(refresh: true)
            let body = try AccountKey.signInBody(personalKeyInput, expected: destination)
            // A numeric password is never a locally decodable session credential.
            // Reject unsupported servers here instead of sending it to the legacy decoder.
            if body["password"] != nil && destination.passwordLength != 6 {
                throw CaptureFailure.message("This server does not support six-digit passwords yet. In Settings, choose Use memos upload server, then try again.")
            }
            let auth: ServerIdentity
            if usesPortableAPI {
                let (data, response) = try await URLSession.shared.data(for: request("/api/account", method: "POST", body: body))
                try check(data, response)
                let restored = try JSONDecoder().decode(HostedAccount.self, from: data)
                let key = try restored.validatedKey(expected: destination)
                if let legacy = body["personalKey"] {
                    guard try AccountKey.decode(legacy, expected: destination).identity == key.identity else { throw AccountKey.KeyError.invalid }
                }
                auth = ServerIdentity(identity: key.identity, token: key.token, personalKey: restored.personalKey, password: restored.password)
            } else {
                let key = try AccountKey.decode(personalKeyInput, expected: destination)
                auth = ServerIdentity(identity: key.identity, token: key.token, personalKey: try key.encoded())
            }
            // The configured backend verifies the host-signed token before we replace Keychain state.
            let profile = try await fetchProfile(auth)
            guard profile.provider == "key", !profile.displayName.isEmpty else {
                throw CaptureFailure.message("This credential has no registered name. Finish sign-in on the original device first.")
            }
            try identities.save(auth, for: savedEndpoint)
            applyProfile(profile)
            personalKeyInput = ""; scenes = []; proof = ""
            Task { await self.refresh() }
        } catch { profileMessage = error.localizedDescription }
    }
    func copyPersonalKey() async {
        guard profileReady, !uploading, !checking, !savingProfile, !captureActive else { return }
        savingProfile = true
        defer { savingProfile = false }
        do {
            let destination = try await accountDestination(refresh: true)
            guard destination.passwordLength == 6 else { throw CaptureFailure.message("Update the upload service to enable six-digit passwords.") }
            var auth = try await identity()
            if auth.password == nil {
                let (data, response) = try await URLSession.shared.data(for: request("/api/account/password", method: "POST",
                    body: ["identity": auth.identity.replacingOccurrences(of: "0x", with: "")], identity: auth))
                try check(data, response)
                auth.password = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["password"] as? String
            }
            guard let encoded = auth.password, AccountKey.isPassword(encoded) else { throw AccountKey.KeyError.password }
            try identities.save(auth, for: savedEndpoint)
            #if canImport(UIKit)
            UIPasteboard.general.setItems([["public.utf8-plain-text": encoded]],
                options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
            #endif
            profileMessage = "Password copied for 2 minutes. Save it privately; anyone with it can sign in as you."
        } catch { profileMessage = error.localizedDescription }
    }
    func saveProfile() async {
        guard !uploading, !checking, !savingProfile, !captureActive else { return }
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 40 else { profileMessage = "Use a name of 1–40 characters."; return }
        savingProfile = true
        defer { savingProfile = false }
        do {
            let destination = try await accountDestination(refresh: true)
            if usesPortableAPI {
                let (data, response) = try await URLSession.shared.data(for: request("/api/account", method: "POST", body: ["displayName": name]))
                try check(data, response)
                let account = try JSONDecoder().decode(HostedAccount.self, from: data)
                let key = try account.validatedKey(expected: destination)
                try identities.save(ServerIdentity(identity: key.identity, token: key.token, personalKey: account.personalKey, password: account.password), for: savedEndpoint)
                applyProfile(UserProfile(identity: key.identity, displayName: account.displayName, provider: account.provider))
                profileMessage = "Welcome, \(account.displayName). Your ID is saved on this iPhone."
                return
            }
            let auth = try await identity()
            let hex = auth.identity.replacingOccurrences(of: "0x", with: "")
            let (data, response) = try await URLSession.shared.data(for: request("/api/account", method: "POST", body: ["identity": hex, "name": name], identity: auth))
            try check(data, response)
            let profile = try JSONDecoder().decode(UserProfile.self, from: data)
            applyProfile(profile)
            profileMessage = "Welcome, \(profile.displayName). Your ID is saved on this iPhone."
            Task { await self.uploadPending() }
        } catch { profileMessage = error.localizedDescription }
    }
    func refresh(silent: Bool = false) async {
        guard !uploading, !checking, !savingProfile, !captureActive else { return }
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
        guard !uploading, !checking, !savingProfile, !pending.isEmpty else { return }
        proof = ""
        uploading = true; defer { uploading = false }
        do {
            // A worker can be enabled while the app remains open. Refresh capabilities for new receipts.
            _ = try await accountDestination(refresh: true)
            let auth = try await identity()
            if !profileReady { try await loadProfile(auth) }
            guard profileReady else { message = "Enter your name before uploading. Your clips are saved locally."; return }
            let hex = auth.identity.replacingOccurrences(of: "0x",with: "")
            while !pending.isEmpty {
                var item = pending[0]
                guard item.server == nil || item.server == savedEndpoint else { throw CaptureFailure.message("This upload belongs to another server. Restore its address in Settings to retry.") }
                guard item.owner == nil || item.owner == hex else { throw CaptureFailure.message("This clip belongs to another account. Restore its password to retry.") }
                let file = directory.appendingPathComponent(item.filename)
                // Once a receipt exists its assignment is immutable, including across config changes/retries.
                let pipeline = item.prepared?.pipeline ?? (item.isSimulation != true && cachedDestination?.pipelineAvailable != false)
                if pipeline { _ = try await CaptureRequirements.validate(file) }
                if item.owner == nil { item.owner = hex; pending[0] = item; try persist() }
                if let previous = item.prepared {
                    // Completion may have committed even if its response was lost. Recover before issuing a new request ID.
                    let (data, response) = try await URLSession.shared.data(for: request("/api/memories?identity=\(hex)", identity: auth))
                    try check(data, response)
                    let rows = try JSONDecoder().decode(MemoryList.self, from: data).memories
                    if let row = rows.first(where: { $0.requestId == previous.requestId }) {
                        try await verifyStored(row, file: file)
                        scenes.removeAll { $0.id == row.id }; scenes.insert(row, at: 0)
                        pending.removeFirst(); try persist()
                        message = "Recovered database row #\(row.id). \(row.processingLabel)"
                        continue
                    }
                }
                if item.prepared == nil || (item.prepared!.receiptExpiresAt ?? 0) < Date().timeIntervalSince1970 * 1000 {
                    let duration = try await AVURLAsset(url:file).load(.duration).seconds
                    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard duration.isFinite, duration > 0 else { throw CaptureFailure.message("Recording has no readable duration") }
                    guard size > 0, size <= (cachedDestination?.maxUploadBytes ?? Int.max) else { throw CaptureFailure.message("Clip exceeds this server's upload limit. Record a shorter clip; your original stays on this phone.") }
                    var body: [String: Any] = ["name":item.filename,"type":item.contentType,"size":size,"title":item.title,"durationSec":duration,"pipeline":pipeline]
                    if !usesPortableAPI { body["identity"] = hex }
                    let (data,response) = try await URLSession.shared.data(for: request("/api/uploads/presign",method:"POST",body:body,identity:auth))
                    try check(data,response)
                    var ticket = try JSONDecoder().decode(PreparedUpload.self,from:data)
                    if ticket.receiptExpiresAt == nil {
                        guard let seconds = ticket.expiresIn, seconds.isFinite, seconds > 0 else { throw CaptureFailure.message("Upload ticket is missing its expiry") }
                        ticket.receiptExpiresAt = (Date().timeIntervalSince1970 + seconds) * 1000
                    }
                    guard ticket.pipeline == pipeline else {
                        throw CaptureFailure.message("Upload service returned a different reconstruction assignment")
                    }
                    item.prepared = ticket
                    item.pipelineRequested = pipeline
                    item.server = savedEndpoint;item.uploaded = false;pending[0] = item;try persist()
                }
                let prepared = item.prepared!
                if !item.uploaded {
                    guard let url = URL(string:prepared.putUrl) else { throw CaptureFailure.message("Invalid upload URL") }
                    message = "Uploading \(item.title)…"
                    var put = URLRequest(url:url);put.httpMethod = "PUT";put.timeoutInterval = 900
                    for (key,value) in prepared.headers { put.setValue(value,forHTTPHeaderField:key) }
                    put.setValue(nil, forHTTPHeaderField: "Authorization")
                    let bytes = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    put.setValue(String(bytes), forHTTPHeaderField: "Content-Length")
                    do {
                        let (data,response) = try await URLSession.shared.upload(for:put,fromFile:file)
                        try check(data,response)
                    } catch {
                        // A retry obtains a fresh signed PUT; never reuse an expired URL.
                        item.prepared = nil;pending[0] = item;try persist();throw error
                    }
                    item.uploaded = true;pending[0] = item;try persist()
                }
                var completionBody: [String: Any] = ["receipt":prepared.receipt]
                if !usesPortableAPI { completionBody["identity"] = hex }
                let (data,response) = try await URLSession.shared.data(for:request("/api/uploads/complete",method:"POST",body:completionBody,identity:auth))
                try check(data,response)
                let confirmed = try JSONDecoder().decode(CompletedUpload.self,from:data).memory
                message = "Checking database row and downloading the stored video…"
                let (listed, listResponse) = try await URLSession.shared.data(for: request("/api/memories?identity=\(hex)", identity: auth))
                try check(listed, listResponse)
                let memories = try JSONDecoder().decode(MemoryList.self, from: listed).memories
                guard let row = memories.first(where: { $0.requestId == prepared.requestId }), row.id == confirmed.id else {
                    throw CaptureFailure.message("Independent database lookup did not confirm the recording")
                }
                guard usesPortableAPI || item.isSimulation != true || row.pipelineIdentity?.lowercased() == hex.lowercased() else {
                    throw CaptureFailure.message("Demo clip was assigned to a reconstruction worker")
                }
                try await verifyStored(row, file: file)
                scenes.removeAll { $0.id == row.id };scenes.insert(row,at:0)
                pending.removeFirst();try persist()
                message = "Verified database row #\(row.id). \(row.processingLabel)"
            }
        } catch { message = "Upload pending: \(error.localizedDescription). Recording remains in Files → Memory Replay → Captures." }
    }
    private func verifyStored(_ row: SavedScene, file: URL) async throws {
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
    }
    func importVideo(_ url: URL) async {
        let accessed = url.startAccessingSecurityScopedResource();defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
            let clean = title.trimmingCharacters(in:.whitespacesAndNewlines)
            guard !clean.isEmpty,clean.count <= 120 else { throw CaptureFailure.message("Enter a title up to 120 characters") }
            guard profileReady, !savingProfile, !captureActive else { throw CaptureFailure.message("Sign in and finish the current recording before importing") }
            let ext = url.pathExtension.lowercased()
            guard ["mp4", "mov"].contains(ext) else { throw CaptureFailure.message("Choose an exported MP4 or MOV video") }
            let destination = try await accountDestination()
            if destination.pipelineAvailable != false { _ = try await CaptureRequirements.validate(url) }
            let item = PendingCapture(id:UUID(),title:clean,fileExtension:ext)
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
