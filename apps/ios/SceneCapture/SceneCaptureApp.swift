import SwiftUI
import AVKit
import UniformTypeIdentifiers

@main @MainActor
struct SceneCaptureApp: App {
    @StateObject private var library: SceneLibrary
    @StateObject private var capture: GlassesCapture
    @Environment(\.scenePhase) private var phase
    init() {
        let library = SceneLibrary()
        _library = StateObject(wrappedValue:library)
        _capture = StateObject(wrappedValue:GlassesCapture(library:library))
    }
    var body: some Scene {
        WindowGroup {
            TabView {
                CaptureView(capture:capture,library:library).tabItem { Label("Camera",systemImage:"eyeglasses") }
                LibraryView(library:library).tabItem { Label("Saved videos",systemImage:"film") }
                SettingsView(library:library).tabItem { Label("Settings",systemImage:"gearshape") }
            }.tint(.teal)
            .onOpenURL { url in Task { await capture.handleURL(url) } }
            .onChange(of:phase) { _, next in
                if next == .background { Task { await capture.backgrounded() } }
                if next == .active { Task { await library.uploadPending() } }
            }
        }
    }
}
struct CaptureView: View {
    @ObservedObject var capture: GlassesCapture
    @ObservedObject var library: SceneLibrary
    var body: some View {
        NavigationStack {
            Form {
                Section("Ray-Ban Meta connection") {
                    Text("\(capture.registered ? "Registered" : "Not registered") · \(capture.deviceCount) available")
                    Text("Session: \(capture.state)")
                    Button("Connect with Meta AI") { Task { await capture.connect() } }.disabled(capture.registered)
                    Button("Start Session") { Task { await capture.startSession() } }
                        .disabled(!capture.registered || capture.deviceCount == 0 || capture.sessionExists || capture.startingSession)
                    Button("Preview glasses camera") { Task { await capture.startPreview() } }
                        .disabled(!capture.sessionStarted || capture.previewActive || capture.finishing)
                }
                Section("Live glasses camera") {
                    if let image = capture.preview {
                        Image(uiImage:image).resizable().scaledToFit().frame(maxHeight:300)
                    } else {
                        ContentUnavailableView("Camera off",systemImage:"eyeglasses",description:Text("Start a session, then Preview or O. This view uses the glasses camera."))
                    }
                    TextField("Recording title",text:$library.title)
                    HStack {
                        Button { Task { await capture.recordOn() } } label: { Label("O · ON",systemImage:"record.circle") }
                            .keyboardShortcut("o",modifiers:[])
                            .disabled(!capture.sessionStarted || capture.recording || capture.startingRecording || capture.finishing)
                        Button { Task { await capture.recordOff() } } label: { Label("F · OFF",systemImage:"stop.circle") }
                            .keyboardShortcut("f",modifiers:[])
                            .disabled((!capture.previewActive && !capture.recording && !capture.startingRecording) || capture.finishing)
                    }.buttonStyle(.borderedProminent)
                    Text(capture.recording ? "● RECORDING — live glasses feed" : capture.startingRecording ? "Waiting for live glasses frames…" : "Recording off")
                        .foregroundStyle(capture.recording ? .red : .secondary)
                    Text("O records the feed. F stops recording and preview, saves the MP4 and uploads it. These controls do not power off the glasses. Video only · 90-second limit · Keep this app open.").font(.caption)
                    if capture.finishing { ProgressView("Saving MP4…") }
                    Button("End Session") { Task { await capture.endSession() } }.disabled(!capture.sessionExists)
                }
                if !capture.error.isEmpty { Section("Camera status") { Text(capture.error).foregroundStyle(.red) } }
                Section("Database/upload status") { Text(library.message) }
            }.navigationTitle("Memory Replay")
        }
    }
}
struct LibraryView: View {
    @ObservedObject var library: SceneLibrary
    @State private var importing = false
    var body: some View {
        NavigationStack {
            List {
                Section("Pending uploads · \(library.pending.count)") {
                    Text(library.message)
                    Button("Retry uploads") { Task { await library.uploadPending() } }.disabled(library.uploading || library.pending.isEmpty)
                    ForEach(library.pending) { Text($0.title) }
                    Button("Import exported glasses MP4") { importing = true }
                }
                Section("Confirmed SpacetimeDB records") {
                    ForEach(library.scenes) { scene in
                        VStack(alignment:.leading,spacing:8) {
                            Text(scene.title).font(.headline)
                            Text("Database row #\(scene.id) · \(scene.status)").font(.caption).textSelection(.enabled)
                            Text(scene.sourceUrl).font(.caption2).textSelection(.enabled)
                            Button("Play stored video") { library.play(scene) }
                        }
                    }
                }
            }.navigationTitle("Saved videos")
            .refreshable { await library.refresh() }
            .toolbar { Button("Refresh") { Task { await library.refresh() } } }
            .fileImporter(isPresented:$importing,allowedContentTypes:[.mpeg4Movie]) { result in
                switch result {
                case .success(let url):Task { await library.importVideo(url) }
                case .failure(let error):library.message = error.localizedDescription
                }
            }
            .sheet(item:$library.playback) { SourcePlayer(url:$0.url) }
        }
    }
}
struct SettingsView: View {
    @ObservedObject var library: SceneLibrary
    var body: some View {
        NavigationStack {
            Form {
                Section("Memory Replay web app") {
                    TextField("http://your-mac.local:5173",text:$library.endpoint)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("Save server") { library.saveSettings() }.disabled(library.uploading || library.checking)
                    Button("Test connection") { Task { await library.refresh() } }.disabled(library.uploading || library.checking)
                    Text(library.message)
                }
                Section("Testing") {
                    Text("Use your Mac's .local hostname on the same Wi-Fi, or the HTTPS app origin. Localhost on an iPhone refers to the phone.")
                    Text("The app obtains its own SpacetimeDB identity and keeps its token in Keychain. Video files remain in Files → Memory Replay → Captures after upload.")
                }
            }.navigationTitle("Settings")
        }
    }
}
struct SourcePlayer: View {
    @State private var player: AVPlayer
    init(url:URL) { _player = State(initialValue:AVPlayer(url:url)) }
    var body: some View { VideoPlayer(player:player).onAppear { player.play() }.onDisappear { player.pause() } }
}
