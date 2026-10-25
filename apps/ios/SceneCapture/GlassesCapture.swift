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
    @Published var deviceReady = false
    @Published var sessionStarted = false
    @Published var sessionExists = false
    @Published var startingSession = false
    @Published var streaming = false
    @Published var previewActive = false
    @Published var recording = false
    @Published var finishing = false
    @Published var startingRecording = false
    @Published var openingGlassesUpdate = false
    @Published var glassesUpdateRequired = false
    private var recordingRequested = false
    private var session: DeviceSession?
    private var deviceSelector: AutoDeviceSelector?
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
        // Selection follows asynchronous SDK discovery. Keep it alive before a session
        // is requested; a newly constructed selector can still have activeDevice == nil.
        let selector = AutoDeviceSelector(wearables: Wearables.shared)
        deviceSelector = selector
        watchTasks.append(Task { [weak self] in
            for await device in selector.activeDeviceStream() {
                guard let self else { return }
                self.deviceReady = device != nil
                if self.session == nil, !self.startingSession {
                    self.state = device == nil ? "Waiting for eligible glasses" : "Ready to start"
                }
            }
        })
        watchTasks.append(Task { [weak self] in
            for await value in Wearables.shared.registrationStateStream() {
                guard let self else { return }
                let wasRegistered = self.registered
                self.registered = value == .registered
                if self.registered && !wasRegistered { self.error = "" }
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
        error = ""
        do { try await Wearables.shared.startRegistration() }
        catch { self.error = error.localizedDescription }
    }

    func openGlassesUpdate() async {
        guard registered, !openingGlassesUpdate, !startingSession, !sessionExists,
              !recording, !startingRecording, !finishing else { return }
        openingGlassesUpdate = true
        defer { openingGlassesUpdate = false }
        do {
            try await Wearables.shared.openDATGlassesAppUpdate()
        } catch { self.error = "Could not open Meta's glasses-app update: \(error.localizedDescription)" }
    }

    private func reportSessionError(_ error: DeviceSessionError) {
        if case .datAppOnTheGlassesUpdateRequired = error { glassesUpdateRequired = true }
        self.error = error.localizedDescription
    }

    func handleURL(_ url: URL) async {
        guard URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
        do { _ = try await Wearables.shared.handleUrl(url) }
        catch { self.error = error.localizedDescription }
    }

    func startSession() async {
        guard session == nil, !startingSession else { return }
        guard registered, let selector = deviceSelector, selector.activeDevice != nil else {
            error = "Waiting for eligible glasses. Wear them with the arms open and check that Meta AI shows them connected."
            return
        }
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
            if try await Wearables.shared.checkPermissionStatus(.microphone) != .granted {
                guard try await Wearables.shared.requestPermission(.microphone) == .granted else {
                    throw CaptureFailure.message("Allow glasses microphone access in Meta AI to record with audio.")
                }
            }
            // The permission handoff may change availability; recheck on return.
            guard selector.activeDevice != nil else {
                throw CaptureFailure.message("Glasses became unavailable during permission setup. Wait for Ready to start, then retry.")
            }
            let created = try Wearables.shared.createSession(deviceSelector: selector)
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
                        if value == .started { self.error = ""; self.glassesUpdateRequired = false }
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
                        self.reportSessionError(value)
                    }
                }
            ]
            try created.start()
        } catch {
            if let sessionError = error as? DeviceSessionError { reportSessionError(sessionError) }
            else { self.error = error.localizedDescription }
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
            guard let added = try session.addCamera(config: StreamConfiguration(videoCodec: .raw, audioCodec: .pcm(sampleRate: .rate44100, numberOfChannels: 1), resolution: .high, frameRate: 30)) else {
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
                added.stream.audioFramePublisher.listen { frame in
                    recorder.appendAudio(frame.pcmBuffer, at: frame.presentationTimeStamp)
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
        guard sessionStarted, !recording, !startingRecording, !finishing, !library.savingProfile else { return }
        guard !library.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error = "Enter a title before recording."; return
        }
        recordingRequested = true
        library.proof = ""
        startingRecording = true
        library.captureActive = true
        defer { startingRecording = false; if !recording { library.captureActive = false } }
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
        recorder.begin(at: library.directory.appendingPathComponent(item.filename), includeAudio: true)
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
        defer { finishing = false; current = nil; library.captureActive = false }
        do {
            _ = try await recorder.finish()
            try library.saveRecording(item)
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
