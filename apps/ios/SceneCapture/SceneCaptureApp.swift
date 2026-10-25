import SwiftUI
import AVKit
import UniformTypeIdentifiers

#if DEMO_APP
typealias ActiveCapture = DemoCapture
#else
typealias ActiveCapture = GlassesCapture
#endif

@main @MainActor
struct SceneCaptureApp: App {
    @StateObject private var library: SceneLibrary
    @StateObject private var capture: ActiveCapture
    @Environment(\.scenePhase) private var phase
    init() {
        let library = SceneLibrary()
        _library = StateObject(wrappedValue: library)
        _capture = StateObject(wrappedValue: ActiveCapture(library: library))
    }
    var body: some Scene {
        WindowGroup {
            TabView {
                CaptureView(capture: capture, library: library).tabItem { Label("Capture", systemImage: "record.circle") }
                LibraryView(library: library).tabItem { Label("Memories", systemImage: "square.stack.3d.up") }
                PartyView(library: library).tabItem { Label("Party", systemImage: "person.3") }
                SettingsView(library: library).tabItem { Label("Settings", systemImage: "gearshape") }
            }
            .tint(.mint).preferredColorScheme(.dark)
            .sheet(item: $library.playback) { SourcePlayer(url: $0.url) }
            .task { await library.resume() }
            .task(id: phase) {
                guard phase == .active else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    guard !Task.isCancelled else { return }
                    if !library.endpoint.isEmpty { await library.refresh(silent: true) }
                }
            }
            .onOpenURL { url in Task { await capture.handleURL(url) } }
            .onChange(of: phase) { _, next in
                if next == .background { Task { await capture.backgrounded() } }
                if next == .active { Task { await library.uploadPending() } }
            }
        }
    }
}

struct CaptureView: View {
    @ObservedObject var capture: ActiveCapture
    @ObservedObject var library: SceneLibrary
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 8) {
                        #if DEMO_APP
                        Label("PHONE DEMO", systemImage: "sparkles").font(.caption.weight(.bold)).foregroundStyle(.mint)
                        Text("A moment, captured.").font(.largeTitle.bold())
                        Text("Simulated camera. Real recording, storage and database verification.").foregroundStyle(.secondary)
                        #else
                        Label("RAY-BAN META", systemImage: "eyeglasses").font(.caption.weight(.bold)).foregroundStyle(.mint)
                        Text("Your view, saved.").font(.largeTitle.bold())
                        Text("Record the glasses feed and send it to your memory library.").foregroundStyle(.secondary)
                        connection
                        #endif
                    }
                    if !library.profileReady { UserProfileView(library: library) }
                    else { Text("Capturing as \(library.displayName)").font(.subheadline).foregroundStyle(.mint) }
                    VStack(spacing: 0) {
                        if let image = capture.preview {
                            Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Camera preview")
                        } else {
                            ContentUnavailableView("Camera off", systemImage: "eyeglasses", description: Text("Connect your glasses and start a session, then tap Record."))
                                .frame(minHeight: 190)
                        }
                        HStack {
                            Circle().fill(capture.recording ? Color.red : Color.mint).frame(width: 8, height: 8)
                            Text(capture.recording ? "Recording" : capture.finishing ? "Saving MP4…" : capture.startingRecording ? "Waiting for camera…" : "Ready")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            #if DEMO_APP
                            Text(String(format: "%04.1f / 30 s", capture.elapsed)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            #else
                            Text("TARGET: 30 FPS + AUDIO").font(.caption2).foregroundStyle(.secondary)
                            #endif
                        }.padding(14)
                    }.background(.white.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 20))
                    VStack(alignment: .leading, spacing: 12) {
                        Text("RECORDING TITLE").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        TextField("Give this moment a name", text: $library.title)
                            .textFieldStyle(.roundedBorder).disabled(capture.recording || capture.startingRecording)
                        HStack(spacing: 14) {
                            Button { Task { await capture.recordOn() } } label: {
                                Label("Record", systemImage: "record.circle").frame(maxWidth: .infinity, minHeight: 38)
                            }.tint(.mint).disabled(!capture.canStart || library.savingProfile).keyboardShortcut("o", modifiers: [])
                            Button { Task { await capture.recordOff() } } label: {
                                Label("Stop & save", systemImage: "stop.fill").frame(maxWidth: .infinity, minHeight: 38)
                            }.tint(.orange).disabled(!capture.canStop || (!capture.recording && !capture.startingRecording)).keyboardShortcut("f", modifiers: [])
                        }.buttonStyle(.borderedProminent).font(.headline).foregroundStyle(.black)
                        Text(library.profileReady ? "Record starts saving video. Stop & save finishes it and uploads automatically. Keep the app open." : "Record saves video on this phone without an account. Tap Stop & save, then open Memories to play or export it. Nothing uploads until you sign in and choose Upload.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Label("Your recording", systemImage: "externaldrive.badge.checkmark").font(.headline)
                            Spacer()
                            if library.uploading || capture.finishing { ProgressView() }
                        }
                        Text(library.message).font(.subheadline).accessibilityIdentifier("upload-status")
                        if !library.proof.isEmpty {
                            Text(library.proof).font(.caption.monospaced()).foregroundStyle(.mint).textSelection(.enabled)
                        }
                        if let scene = library.scenes.first {
                            Button("Play stored video") { library.play(scene) }.buttonStyle(.bordered)
                        }
                        if let local = library.localCaptures.first {
                            Button("Play latest local clip") { library.playLocal(local) }.buttonStyle(.bordered)
                        }
                        if !library.pending.isEmpty {
                            Button("Retry uploads (\(library.pending.count))") { Task { await library.uploadPending() } }
                                .disabled(library.uploading || library.checking)
                        }
                    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 20))
                    if !capture.error.isEmpty { Text(capture.error).foregroundStyle(.orange).font(.subheadline) }
                    #if DEMO_APP
                    Text("No glasses or phone camera are connected in this demo. Test clips are kept out of the reconstruction queue.")
                        .font(.caption).foregroundStyle(.secondary)
                    #else
                    Text("These controls record the SDK stream; they do not power the glasses or control their built-in recorder. Maximum 90 seconds.")
                        .font(.caption).foregroundStyle(.secondary)
                    #endif
                }.padding(22)
            }.background(Color(red: 0.035, green: 0.065, blue: 0.085))
                .navigationTitle("Memory Replay").navigationBarTitleDisplayMode(.inline)
        }
    }
    #if !DEMO_APP
    private var connection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(capture.registered ? "Registered" : "Not registered") · \(capture.deviceCount) detected · \(capture.state)").font(.caption)
            if capture.registered && !capture.deviceReady && !capture.sessionExists {
                Text("Waiting for glasses to become eligible. Keep them on with the arms open and confirm they are connected in Meta AI.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Button("Connect with Meta AI") { Task { await capture.connect() } }.disabled(capture.registered)
            if capture.glassesUpdateRequired {
                Text("Meta says its developer software on the glasses needs updating. The button below opens Meta's update flow.")
                    .font(.caption).foregroundStyle(.orange)
            }
            Button("Update glasses developer software") { Task { await capture.openGlassesUpdate() } }
                .disabled(!capture.registered || capture.openingGlassesUpdate || capture.sessionExists || capture.startingSession || capture.startingRecording || capture.finishing)
            Button("Start Session") { Task { await capture.startSession() } }
                .disabled(!capture.registered || !capture.deviceReady || capture.sessionExists || capture.startingSession)
            Button("Preview glasses camera") { Task { await capture.startPreview() } }
                .disabled(!capture.sessionStarted || capture.previewActive || capture.finishing)
            Button("End Session") { Task { await capture.endSession() } }.disabled(!capture.sessionExists)
        }.buttonStyle(.bordered)
    }
    #endif
}

struct LibraryView: View {
    @ObservedObject var library: SceneLibrary
    @State private var importing = false
    var body: some View {
        NavigationStack {
            List {
                Section("From recording to 3D") {
                    Text("Recordings stay on this phone. When signed in, new recordings also upload automatically. Clips saved before sign-in can be uploaded individually below.")
                    if let url = library.libraryURL { Link("Open web memory library", destination: url) }
                    if !library.sceneConnectionError.isEmpty {
                        Text("Live status unavailable: \(library.sceneConnectionError)").font(.caption).foregroundStyle(.orange)
                    }
                }
                Section("Upload status · \(library.pending.count) pending") {
                    Text(library.message)
                    Button("Retry uploads") { Task { await library.uploadPending() } }.disabled(library.uploading || library.checking || library.pending.isEmpty)
                    Button("Import glasses MP4 / MOV") { importing = true }
                }
                Section("On this phone · available offline") {
                    if library.localCaptures.isEmpty { Text("Tap Record, then Stop & save to save your first clip.").foregroundStyle(.secondary) }
                    ForEach(library.localCaptures) { clip in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(clip.title).font(.headline)
                            Text(library.pending.contains(where: { $0.id == clip.id }) ? "Awaiting upload / verification" : "Local video retained").font(.caption).foregroundStyle(.secondary)
                            if clip.owner == nil && !library.pending.contains(where: { $0.id == clip.id }) {
                                if library.profileReady {
                                    Button("Upload as \(library.displayName)") { Task { await library.uploadLocal(clip) } }
                                        .disabled(library.uploading || library.checking || library.savingProfile || library.captureActive)
                                } else {
                                    Text("Saved locally. Sign in to upload later.").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            if library.pending.contains(where: { $0.id == clip.id }) {
                                Button("Keep on phone only · stop upload retries") { library.keepLocalOnly(clip) }
                                    .disabled(library.uploading || library.checking || library.savingProfile)
                            }
                            HStack {
                                Button("Play local clip") { library.playLocal(clip) }.buttonStyle(.bordered)
                                ShareLink(item: library.file(for: clip)) { Label("Export", systemImage: "square.and.arrow.up") }.buttonStyle(.bordered)
                            }
                        }
                    }
                }
                Section("Confirmed SpacetimeDB records") {
                    ForEach(library.scenes) { scene in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(scene.title).font(.headline)
                            Text("Database row #\(scene.id) · \(scene.status)").font(.caption).textSelection(.enabled)
                            Text(scene.processingLabel).font(.subheadline)
                            if scene.status == "processing" { ProgressView(value: scene.progressFraction) }
                            if scene.status == "failed", let error = scene.error, !error.isEmpty {
                                Text(error).font(.caption).foregroundStyle(.orange)
                            }
                            if let url = library.sceneURL(scene) {
                                Link("Open in 3D", destination: url).buttonStyle(.borderedProminent)
                                ShareLink(item: url) { Label("Share scene / open on Quest", systemImage: "square.and.arrow.up") }.buttonStyle(.bordered)
                            } else if scene.status == "ready" {
                                Text("Waiting for a usable scene URL from the backend.").font(.caption).foregroundStyle(.orange)
                            }
                            Button("Play stored video") { library.play(scene) }.buttonStyle(.bordered)
                        }
                    }
                }
            }.navigationTitle("Memories")
                .refreshable { await library.refresh() }
                .toolbar { Button("Refresh") { Task { await library.refresh() } }.disabled(library.uploading || library.checking) }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.mpeg4Movie, .quickTimeMovie]) { result in
                    switch result {
                    case .success(let url): Task { await library.importVideo(url) }
                    case .failure(let error): library.message = error.localizedDescription
                    }
                }
        }
    }
}
struct PartyView: View {
    @ObservedObject var library: SceneLibrary
    @State private var code = ""
    private var invite: URL? {
        let clean = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard clean.range(of: "^[A-Z0-9]{7}$", options: .regularExpression) != nil,
              let origin = library.partyURL,
              var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = [URLQueryItem(name: "room", value: clean)]
        return parts.url
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Enter a shared space") {
                    Text("Create a party in your browser, or join with a friend's code. Everyone sees the same scene; the leader controls time.")
                    if let origin = library.partyURL {
                        Link("Open party lobby", destination: origin)
                        TextField("7-character party code", text: $code)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .accessibilityLabel("Party code")
                        if let invite { Link("Join party", destination: invite) }
                    } else {
                        Text("Save your server address in Settings first.").foregroundStyle(.secondary)
                    }
                }
                Section("From a recording to a scene") {
                    Text("Finish recording with Off and wait for upload verification. Follow processing in Memories, then open the finished scene or choose it in the party lobby. The synthetic demo stays available while reconstruction runs.")
                    Text("The party opens in your browser. Copy your personal key from Settings and paste it into web sign-in to use the same account and recordings. Your party code is separate.")
                    Text("A reconstruction worker is still required to turn video into a 3D scene.").foregroundStyle(.secondary)
                }
            }.navigationTitle("Party")
        }
    }
}
struct UserProfileView: View {
    @ObservedObject var library: SceneLibrary
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if library.profileReady {
                Text("Signed in as \(library.displayName)").font(.headline)
                Button("Copy personal key") { Task { await library.copyPersonalKey() } }
                    .buttonStyle(.bordered)
            } else {
                Text("Create your account").font(.headline)
                TextField("Your name", text: $library.displayName).textFieldStyle(.roundedBorder)
                    .textContentType(.nickname).autocorrectionDisabled().accessibilityLabel("Your name")
                Button(library.savingProfile ? "Signing in…" : "Create personal key") {
                    Task { await library.saveProfile() }
                }.buttonStyle(.borderedProminent)
                Text("Already signed in on the web? Paste that personal key below to keep the same account.").font(.caption)
            }
            SecureField("memos1.… personal key", text: $library.personalKeyInput)
                .textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
            Button("Sign in with saved key") { Task { await library.importAccount() } }
                .disabled(!library.pending.isEmpty || library.personalKeyInput.isEmpty)
            Text(library.profileMessage).font(.caption)
            if !library.userID.isEmpty { Text("User ID: \(library.userID)").font(.caption2.monospaced()).textSelection(.enabled) }
            Text("Your personal key works on phone, web and Quest. Keep it private. A registered name cannot be changed.").font(.caption).foregroundStyle(.secondary)
        }.disabled(library.savingProfile || library.checking || library.uploading || library.captureActive)
    }
}
struct SettingsView: View {
    @ObservedObject var library: SceneLibrary
    var body: some View {
        NavigationStack {
            Form {
                Section("Your profile") { UserProfileView(library: library) }
                Section("Memory Replay server") {
                    TextField("http://your-mac.local:5173", text: $library.endpoint)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityLabel("Server address")
                    TextField("Web viewer URL (optional)", text: $library.viewerEndpoint)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityLabel("Web viewer address")
                    Text("Leave the viewer URL blank when the web app and upload API share one address. For separate hosting, enter the web app's HTTPS origin. Both must use the same SpacetimeDB database.").font(.caption)
                    Button("Save server") { library.saveSettings() }.disabled(library.uploading || library.checking || library.savingProfile)
                    Button("Use memos upload server") {
                        library.endpoint = "https://memos.alightdell64.chatgpt.site"
                        library.viewerEndpoint = "https://memos.alightdell64.chatgpt.site"
                        library.saveSettings()
                    }.disabled(library.uploading || library.checking || library.savingProfile || library.captureActive || !library.pending.isEmpty)
                    Button("Test connection") { Task { await library.refresh() } }.disabled(library.uploading || library.checking)
                    Text(library.message)
                }
                Section("How to test") {
                    Text("1. Choose Use memos upload server, then sign in in Capture with your website personal key.")
                    Text("2. In Memories, choose Upload as your name on a local clip. The hosted server currently accepts clips up to 90 MiB for storage testing, without GPU processing.")
                    Text("3. Wait for PASS: the database record and downloaded video must match your recording.")
                    Text("4. Local clips remain available offline and can be exported. New recordings upload automatically when signed in.")
                }
                Section("About this build") {
                    #if DEMO_APP
                    Text("Memory Replay Demo · simulated camera · real H.264 MP4 and upload. No Meta SDK or camera permission needed.")
                    #else
                    Text("Memory Replay · Meta Wearables DAT 1.0.1. A paired iPhone and compatible glasses are required.")
                    #endif
                    Text("Videos live in storage. SpacetimeDB stores their IDs, URLs and status. Uploaded does not mean reconstructed.")
                    Text("Tokens stay in Keychain. Local recordings remain in Files → On My iPhone → this app → Captures.")
                }
            }.navigationTitle("Settings")
        }
    }
}
struct SourcePlayer: View {
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer
    init(url: URL) { _player = State(initialValue: AVPlayer(url: url)) }
    var body: some View {
        NavigationStack {
            VideoPlayer(player: player).onAppear { player.play() }.onDisappear { player.pause() }
                .navigationTitle("Recording").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
        }
    }
}
