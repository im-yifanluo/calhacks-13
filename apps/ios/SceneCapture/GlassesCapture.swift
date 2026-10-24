import SwiftUI
import MWDATCore
import MWDATCamera

@MainActor
final class GlassesCapture: ObservableObject {
    @Published var state = "Not connected"
    @Published var error = ""
    @Published var preview: UIImage?
    @Published var registered = false
    @Published var deviceCount = 0
    @Published var sessionStarted = false
    @Published var sessionExists = false
    @Published var startingSession = false
    @Published var streaming = false
    @Published var previewActive = false
    @Published var recording = false
    @Published var finishing = false
    @Published var startingRecording = false
    private var recordingRequested = false
    private var session: DeviceSession?
    private var sessionGeneration: UUID?
    private var cameraGeneration: UUID?
    private var camera: MWDATCamera.Camera?
    private var sessionTokens: [AnyListenerToken] = []
    private var cameraTokens: [AnyListenerToken] = []
    private var watchTasks: [Task<Void, Never>] = []
    private var recordingTimer: Task<Void, Never>?
    private let recorder = Recorder()
    private var current: PendingCapture?
    let library: SceneLibrary
    var canStart: Bool { sessionStarted && !recording && !startingRecording && !finishing }
    var canStop: Bool { (previewActive || recording || startingRecording) && !finishing }

    init(library: SceneLibrary) {
        self.library = library
        do { try Wearables.configure() }
        catch { self.error = error.localizedDescription; return }
        watchTasks.append(Task { [weak self] in
            for await value in Wearables.shared.registrationStateStream() {
                guard let self else { return }
                self.registered = value == .registered
            }
        })
        watchTasks.append(Task { [weak self] in
            for await devices in Wearables.shared.devicesStream() {
                guard let self else { return }
                self.deviceCount = devices.count
            }
        })
    }

    func connect() async {
        do { try await Wearables.shared.startRegistration() }
        catch { self.error = error.localizedDescription }
    }

    func handleURL(_ url: URL) async {
        guard URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
        do { _ = try await Wearables.shared.handleUrl(url) }
        catch { self.error = error.localizedDescription }
    }

    func startSession() async {
        guard session == nil, !startingSession else { return }
        startingSession = true
        defer { startingSession = false }
        do {
            error = ""
            // Permission handoff backgrounds this app. Do it before owning a session.
            if try await Wearables.shared.checkPermissionStatus(.camera) != .granted {
                guard try await Wearables.shared.requestPermission(.camera) == .granted else {
                    throw CaptureFailure.message("Camera permission denied. Allow it in Meta AI and retry.")
                }
            }
            let created = try Wearables.shared.createSession(deviceSelector: AutoDeviceSelector(wearables: Wearables.shared))
            let generation = UUID()
            sessionGeneration = generation
            session = created
            sessionExists = true
            sessionTokens = [
                created.statePublisher.listen { [weak self] value in
                    Task { @MainActor [weak self] in
                        guard let self, self.sessionGeneration == generation else { return }
                        self.state = String(describing: value)
                        self.sessionStarted = value == .started
                        if value == .paused { await self.finishRecording() }
                        if value == .stopped {
                            await self.finishRecording()
                            self.cameraGeneration = nil
                            self.camera = nil
                            self.cameraTokens = []
                            self.previewActive = false
                            self.streaming = false
                            self.preview = nil
                            self.sessionGeneration = nil
                            self.session = nil
                            self.sessionExists = false
                            self.sessionTokens = []
                        }
                    }
                },
                created.errorPublisher.listen { [weak self] value in
                    Task { @MainActor [weak self] in
                        guard let self, self.sessionGeneration == generation else { return }
                        self.error = value.localizedDescription
                    }
                }
            ]
            try created.start()
        } catch {
            self.error = error.localizedDescription
            sessionGeneration = nil
            session?.stop()
            session = nil
            sessionExists = false
            sessionTokens = []
        }
    }

    func startPreview() async {
        guard let session, sessionStarted, camera == nil else { return }
        do {
            guard let added = try session.addCamera(config: StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 24)) else {
                throw CaptureFailure.message("Session is not ready for the camera")
            }
            let generation = UUID()
            cameraGeneration = generation
            camera = added
            previewActive = true
            let recorder = self.recorder
            cameraTokens = [
                added.stream.videoFramePublisher.listen { [weak self] frame in
                    let image = frame.makeUIImage()
                    Task { @MainActor [weak self] in
                        guard let self, self.cameraGeneration == generation else { return }
                        recorder.append(frame.sampleBuffer)
                        self.preview = image
                    }
                },
                added.stream.statePublisher.listen { [weak self] value in
                    Task { @MainActor [weak self] in
                        guard let self, self.cameraGeneration == generation else { return }
                        self.streaming = value == .streaming
                        if value == .stopped || value == .paused {
                            await self.finishRecording()
                        }
                    }
                },
                added.stream.errorPublisher.listen { [weak self] value in
                    Task { @MainActor [weak self] in
                        guard let self, self.cameraGeneration == generation else { return }
                        self.error = value.localizedDescription
                        await self.finishRecording()
                    }
                }
            ]
            added.stream.start()
        } catch { self.error = error.localizedDescription }
    }

    /// O starts saving the live glasses stream; it does not power on the hardware.
    func recordOn() async {
        guard sessionStarted, !recording, !startingRecording, !finishing else { return }
        guard !library.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error = "Enter a title before recording."; return
        }
        recordingRequested = true
        library.proof = ""
        startingRecording = true
        defer { startingRecording = false }
        if !previewActive { await startPreview() }
        for _ in 0..<150 {
            guard recordingRequested, sessionStarted else { return }
            if streaming, preview != nil { startRecording(); return }
            try? await Task.sleep(for: .milliseconds(100))
        }
        error = "No live frames received. Check glasses connection and camera permission."
        await recordOff()
    }

    /// F finalizes the MP4 and releases the camera preview, then queues upload.
    func recordOff() async {
        recordingRequested = false
        await stopPreview()
    }

    func startRecording() {
        guard streaming, !recording, !finishing else { return }
        let title = library.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 120 else {
            error = "Enter a scene title (up to 120 characters)."
            return
        }
        let item = PendingCapture(id: UUID(), title: title)
        current = item
        recorder.begin(at: library.directory.appendingPathComponent(item.filename))
        recording = true
        UIApplication.shared.isIdleTimerDisabled = true
        recordingTimer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(90)) }
            catch { return }
            await self?.recordOff()
        }
    }

    func finishRecording() async {
        guard recording, !finishing, let item = current else { return }
        recording = false
        finishing = true
        recordingTimer?.cancel()
        UIApplication.shared.isIdleTimerDisabled = false
        defer { finishing = false; current = nil }
        do {
            _ = try await recorder.finish()
            try library.enqueue(item)
            library.message = "Recording saved; uploading automatically."
            Task { await library.uploadPending() }
        } catch { self.error = "Recording could not be queued: \(error.localizedDescription). Check Files → Memory Replay → Captures." }
    }

    func stopPreview() async {
        recordingRequested = false
        await finishRecording()
        cameraGeneration = nil
        camera?.stop()
        camera = nil
        cameraTokens = []
        previewActive = false
        streaming = false
        preview = nil
    }

    func endSession() async {
        await stopPreview()
        session?.stop()
    }

    func backgrounded() async {
        // Request enough time to finalize the MP4; queued uploads can be retried on return.
        let task = UIApplication.shared.beginBackgroundTask(withName: "Finish scene recording")
        await endSession()
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }
}
