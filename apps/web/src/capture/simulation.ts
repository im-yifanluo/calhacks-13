import type { Multiplayer } from "../net";
import { RecordedUpload } from "../upload/recorded";

export function captureSimulation(net: Multiplayer, onComplete: (requestId: string) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const canvas = $<HTMLCanvasElement>("sim-canvas"),
    context = canvas.getContext("2d")!;
  const on = $<HTMLButtonElement>("sim-on"),
    off = $<HTMLButtonElement>("sim-off");
  const retry = $<HTMLButtonElement>("sim-retry"),
    reset = $<HTMLButtonElement>("sim-reset");
  const title = $<HTMLInputElement>("sim-title"),
    download = $<HTMLAnchorElement>("sim-download");
  const status = $("sim-status"),
    badge = $("sim-state"),
    proof = $("sim-proof");
  type Phase = "idle" | "recording" | "saving" | "uploading" | "failed" | "passed";
  let phase: Phase = "idle",
    recorder: MediaRecorder | undefined,
    stream: MediaStream | undefined;
  let timer: ReturnType<typeof setInterval> | undefined,
    started = 0,
    duration = 0,
    recordingTitle = "",
    objectURL = "";
  let attempt: RecordedUpload | undefined,
    recorderError = "";
  const mime =
    typeof MediaRecorder !== "undefined"
      ? ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp8", "video/webm"].find((type) =>
          MediaRecorder.isTypeSupported(type),
        )
      : undefined;
  const supported = Boolean(mime && typeof canvas.captureStream === "function" && globalThis.crypto?.subtle);

  function controls() {
    on.disabled = !supported || !net.ready || !["idle", "passed"].includes(phase);
    off.disabled = phase !== "recording";
    title.disabled = !["idle", "passed"].includes(phase);
    retry.hidden = phase !== "failed" || !attempt;
    reset.hidden = phase !== "failed";
    badge.textContent = {
      idle: "OFF",
      recording: "● RECORDING",
      saving: "SAVING",
      uploading: "UPLOADING",
      failed: "NEEDS RETRY",
      passed: "PASS · OFF",
    }[phase];
    badge.dataset.phase = phase;
  }
  function draw(seconds: number, active: boolean) {
    context.fillStyle = "#101e2d";
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "#203d4e";
    context.fillRect(0, 235, 640, 125);
    context.strokeStyle = "#3d5d6a";
    context.lineWidth = 1;
    for (let x = 0; x <= 640; x += 80) {
      context.beginPath();
      context.moveTo(320, 180);
      context.lineTo(x, 360);
      context.stroke();
    }
    for (let y = 250; y < 360; y += 30) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(640, y);
      context.stroke();
    }
    context.fillStyle = "#f4bd71";
    context.beginPath();
    context.arc(320 + Math.sin(seconds * 1.8) * 180, 190 + Math.cos(seconds * 2.4) * 28, 35, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#a8f0d4";
    context.fillRect(82, 150, 70, 85);
    context.fillStyle = "#e7f2f1";
    context.font = "600 19px system-ui";
    context.fillText("SIMULATED CAMERA · NO GLASSES", 24, 38);
    context.font = "15px system-ui";
    context.fillText(active ? recordingTitle.slice(0, 55) : "Tap On to record this animated scene", 24, 66);
    context.font = "600 24px monospace";
    context.fillText(`${active ? "REC" : "OFF"}  ${seconds.toFixed(1)}s`, 24, 326);
    $("sim-timer").textContent = `${seconds.toFixed(1)} s / 30 s`;
  }
  function release() {
    if (timer) clearInterval(timer);
    timer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }
  async function upload() {
    if (!attempt || phase === "uploading") return;
    phase = "uploading";
    controls();
    try {
      const result = await attempt.run((message) => {
        status.textContent = message;
      });
      phase = "passed";
      status.textContent = `PASS — database row #${result.id}; ${result.size.toLocaleString()} bytes downloaded and identical to your recording. Test row, not queued for the 3D pipeline. Press Play in Stored recordings.`;
      proof.textContent = `SHA-256: ${result.sha256}`;
      onComplete(result.requestId);
    } catch (error) {
      phase = "failed";
      status.textContent = `${error instanceof Error ? error.message : String(error)} Your clip is retained in this tab. Keep it open and use Retry upload / verify, or download the clip.`;
    }
    controls();
  }
  function stop() {
    if (phase !== "recording" || !recorder) return;
    duration = Math.max(0.05, (performance.now() - started) / 1000);
    phase = "saving";
    controls();
    status.textContent = "Off received. Finishing the video; upload starts automatically…";
    if (timer) clearInterval(timer);
    timer = undefined;
    if (recorder.state !== "inactive") recorder.stop(); // Final data arrives before onstop.
  }
  function start() {
    if (on.disabled || !net.identity) return;
    const cleanTitle = title.value.trim();
    if (!cleanTitle) {
      status.textContent = "Enter a test title first.";
      title.focus();
      return;
    }
    if (objectURL) URL.revokeObjectURL(objectURL);
    download.hidden = true;
    proof.textContent = "";
    attempt = undefined;
    recorderError = "";
    const identity = net.identity.toHexString(),
      token = net.token;
    recordingTitle = `[SIMULATION] ${cleanTitle.slice(0, 75)} ${new Date().toLocaleTimeString()}`;
    const chunks: Blob[] = [];
    try {
      stream = canvas.captureStream(24);
      const active = new MediaRecorder(stream, {
        mimeType: mime!,
        videoBitsPerSecond: 800_000,
      });
      recorder = active;
      active.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      active.onerror = () => {
        recorderError = "The browser could not encode the recording.";
        stop();
      };
      active.onstop = () => {
        release();
        draw(duration, false);
        const type = active.mimeType.split(";")[0],
          extension = type === "video/mp4" ? "mp4" : "webm";
        const file = new File(chunks, `of-simulation-${Date.now()}.${extension}`, { type });
        if (recorderError || file.size === 0 || duration < 0.25) {
          phase = "failed";
          status.textContent =
            recorderError || "Clip too short. Choose New test, tap On, wait at least one second, then tap Off.";
          controls();
          return;
        }
        objectURL = URL.createObjectURL(file);
        download.href = objectURL;
        download.download = file.name;
        download.hidden = false;
        attempt = new RecordedUpload(
          file,
          duration,
          recordingTitle,
          identity,
          token,
          import.meta.env.VITE_UPLOAD_API || "",
          false, // A synthetic test pattern: keep it off the GPU worker's queue.
        );
        void upload();
      };
      phase = "recording";
      started = performance.now();
      duration = 0;
      draw(0, true);
      active.start(250);
      controls();
      status.textContent = "Recording the animated test scene. Wait 3–5 seconds, then tap Off. Keep this tab visible.";
      timer = setInterval(() => {
        const seconds = (performance.now() - started) / 1000;
        draw(seconds, true);
        if (seconds >= 30) stop();
      }, 1000 / 24);
    } catch (error) {
      release();
      phase = "failed";
      controls();
      status.textContent = `Cannot start recording: ${error instanceof Error ? error.message : String(error)}. Try current Chrome or Safari.`;
    }
  }
  on.onclick = start;
  off.onclick = stop;
  retry.onclick = () => {
    void upload();
  };
  reset.onclick = () => {
    attempt = undefined;
    phase = "idle";
    status.textContent = "Ready for a new test. The previous clip's download remains available until On is pressed.";
    controls();
    draw(0, false);
  };
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))
    )
      return;
    if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      start();
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      stop();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
  });
  window.addEventListener("beforeunload", (event) => {
    if (["recording", "saving", "uploading", "failed"].includes(phase)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  net.addEventListener("change", controls);
  if (!supported)
    status.textContent =
      "This browser cannot record the test scene. Open this page on localhost or HTTPS in current Chrome or Safari.";
  controls();
  draw(0, false);
}
