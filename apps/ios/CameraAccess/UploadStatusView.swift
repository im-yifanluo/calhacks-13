import SwiftUI

enum CaptureBackend {
  static var address: String {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
      return ProcessInfo.processInfo.environment["MEMREPLAY_UI_TEST_BACKEND"] ?? "http://127.0.0.1:9"
    }
    #endif
    return UserDefaults.standard.string(forKey: "memoryReplayBackend") ??
      (Bundle.main.object(forInfoDictionaryKey: "MemoryReplayBackendURL") as? String ?? "")
  }
}

struct UploadStatusView: View {
  @State private var queue = UploadQueue.shared
  @State private var showSettings = false
  @State private var address = CaptureBackend.address
  @State private var validationError: String?
  @Environment(\.scenePhase) private var phase

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        if queue.isUploading { ProgressView() }
        Text("Memory Replay · Auto-upload").font(.headline)
        Spacer()
        Button("Settings") { showSettings = true }
      }
      Text(queue.status).font(.caption).lineLimit(3)
      Text("\(queue.recordings.count) recordings saved on phone")
        .font(.caption2).accessibilityIdentifier("upload_queue_count")
      if let error = queue.storageError { Text(error).foregroundStyle(.red).font(.caption) }
    }
    .padding(12)
    .background(.regularMaterial)
    .onAppear {
      queue.setActive(phase == .active)
      if CaptureBackend.address.isEmpty { showSettings = true }
    }
    .onChange(of: phase) { _, value in queue.setActive(value == .active) }
    .sheet(isPresented: $showSettings) {
      NavigationStack {
        Form {
          Section("Upload server") {
            TextField("https://your-server.example", text: $address)
              .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            Text("For local testing, keep this iPhone and your Mac on the same Wi-Fi. Keep the app open while recording and uploading.")
              .font(.caption)
            if let validationError { Text(validationError).foregroundStyle(.red) }
            Button("Save server") {
              do {
                let url = try UploadQueue.backendURL(address)
                UserDefaults.standard.set(url.absoluteString, forKey: "memoryReplayBackend")
                validationError = nil
                showSettings = false
              } catch { validationError = error.localizedDescription }
            }
          }
          Section("Recordings") {
            Text("Stopping a recording saves it on this phone and starts uploading. Failed uploads retry automatically while the app is open and resume when you reopen it. Changing the server affects new recordings only.").font(.caption)
            Button("Retry pending uploads now") { queue.retry() }
              .disabled(queue.isUploading)
            ForEach(queue.recordings.reversed()) { recording in
              VStack(alignment: .leading, spacing: 4) {
                Text(recording.title)
                if let memory = recording.memoryID {
                  Text("Uploaded · memory #\(memory)").foregroundStyle(.green)
                  if let url = recording.sourceURL { Link("Open stored video", destination: url) }
                } else {
                  Text(recording.error ?? "Saved on phone · waiting to upload").font(.caption)
                }
              }
            }
          }
        }
        .navigationTitle("Memory Replay")
        .toolbar { Button("Done") { showSettings = false } }
      }
    }
  }
}
