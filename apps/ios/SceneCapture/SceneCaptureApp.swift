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
                LibraryView(library: library).tabItem { Label("Saved videos", systemImage: "film.stack") }
                SettingsView(library: library).tabItem { Label("Settings", systemImage: "gearshape") }
            }
            .tint(.mint).preferredColorScheme(.dark)
            .sheet(item: $library.playback) { SourcePlayer(url: $0.url) }
            .task { await library.resume() }
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
                    VStack(spacing: 0) {
                        if let image = capture.preview {
                            Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Camera preview")
                        } else {
                            ContentUnavailableView("Camera off", systemImage: "eyeglasses", description: Text("Connect your glasses and start a session, then tap On."))
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
                            Text("VIDEO ONLY").font(.caption2).foregroundStyle(.secondary)
                            #endif
                        }.padding(14)
                    }.background(.white.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 20))
                    VStack(alignment: .leading, spacing: 12) {
                        Text("RECORDING TITLE").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        TextField("Give this moment a name", text: $library.title)
                            .textFieldStyle(.roundedBorder).disabled(capture.recording || capture.startingRecording)
                        HStack(spacing: 14) {
                            Button { Task { await capture.recordOn() } } label: {
                                Label("On", systemImage: "record.circle").frame(maxWidth: .infinity, minHeight: 38)
                            }.tint(.mint).disabled(!capture.canStart).keyboardShortcut("o", modifiers: [])
                            Button { Task { await capture.recordOff() } } label: {
                                Label("Off", systemImage: "stop.fill").frame(maxWidth: .infinity, minHeight: 38)
                            }.tint(.orange).disabled(!capture.canStop).keyboardShortcut("f", modifiers: [])
                        }.buttonStyle(.borderedProminent).font(.headline).foregroundStyle(.black)
                        Text("On starts recording. Off saves and uploads automatically. Keep the app open.")
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
            Text("\(capture.registered ? "Registered" : "Not registered") · \(capture.deviceCount) available · \(capture.state)").font(.caption)
            Button("Connect with Meta AI") { Task { await capture.connect() } }.disabled(capture.registered)
            Button("Start Session") { Task { await capture.startSession() } }
                .disabled(!capture.registered || capture.deviceCount == 0 || capture.sessionExists || capture.startingSession)
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
                Section("Upload status · \(library.pending.count) pending") {
                    Text(library.message)
                    Button("Retry uploads") { Task { await library.uploadPending() } }.disabled(library.uploading || library.checking || library.pending.isEmpty)
                    Button("Import exported glasses MP4") { importing = true }
                }
                Section("On this phone · available offline") {
                    if library.localCaptures.isEmpty { Text("Tap On, then Off to save your first clip.").foregroundStyle(.secondary) }
                    ForEach(library.localCaptures) { clip in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(clip.title).font(.headline)
                            Text(library.pending.contains(where: { $0.id == clip.id }) ? "Awaiting upload / verification" : "Local MP4 retained").font(.caption).foregroundStyle(.secondary)
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
                            Text(scene.sourceUrl).font(.caption2).textSelection(.enabled)
                            Button("Play stored video") { library.play(scene) }.buttonStyle(.bordered)
                        }
                    }
                }
            }.navigationTitle("Saved videos")
                .refreshable { await library.refresh() }
                .toolbar { Button("Refresh") { Task { await library.refresh() } }.disabled(library.uploading || library.checking) }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.mpeg4Movie]) { result in
                    switch result {
                    case .success(let url): Task { await library.importVideo(url) }
                    case .failure(let error): library.message = error.localizedDescription
                    }
                }
        }
    }
}
struct SettingsView: View {
    @ObservedObject var library: SceneLibrary
    var body: some View {
        NavigationStack {
            Form {
                Section("Memory Replay server") {
                    TextField("http://your-mac.local:5173", text: $library.endpoint)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityLabel("Server address")
                    Button("Save server") { library.saveSettings() }.disabled(library.uploading || library.checking)
                    Button("Test connection") { Task { await library.refresh() } }.disabled(library.uploading || library.checking)
                    Text(library.message)
                }
                Section("How to test") {
                    Text("1. Start the database, upload service and web app on your Mac.")
                    Text("2. On iPhone, use the Mac's .local hostname on the same Wi-Fi. Simulator can use http://127.0.0.1:5173.")
                    Text("3. Tap On, wait 3–5 seconds, then tap Off. Expect a verified database row and matching video bytes.")
                    Text("4. Open Saved videos to play the stored recording. Local clips are also available offline and can be exported.")
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
