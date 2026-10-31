import type { Multiplayer } from "../net";
export function uploadPanel(net: Multiplayer, root: HTMLElement, onComplete?: (requestId: string) => void) {
  root.innerHTML = `<h2>Upload a video</h2><p>Pick a clip exported from Meta AI.</p>
  <label>Title<input id="upload-title" maxlength="120" required placeholder="Saturday at the park"></label>
  <label>Video<input id="upload-file" type="file" accept="video/mp4,video/quicktime,.mp4,.mov"></label>
  <video id="upload-preview" controls playsinline preload="metadata" hidden aria-label="Selected video preview"></video>
  <button id="upload-start">Upload video</button><button id="upload-cancel" hidden>Cancel</button>
  <progress id="upload-progress" max="100" value="0"></progress><p id="upload-status" role="status"></p>`;
  const status = root.querySelector("#upload-status")!;
  const progress = root.querySelector("progress")!;
  const start = root.querySelector<HTMLButtonElement>("#upload-start")!;
  const cancel = root.querySelector<HTMLButtonElement>("#upload-cancel")!;
  let xhr: XMLHttpRequest | undefined;
  let previewURL = "";
  const fileInput = root.querySelector<HTMLInputElement>("#upload-file")!;
  const preview = root.querySelector<HTMLVideoElement>("#upload-preview")!;
  fileInput.onchange = () => {
    if (previewURL) URL.revokeObjectURL(previewURL);
    const file = fileInput.files?.[0];
    preview.hidden = !file;
    if (file) {
      previewURL = URL.createObjectURL(file);
      preview.src = previewURL;
    } else {
      preview.removeAttribute("src");
      preview.load();
    }
  };
  cancel.onclick = () => xhr?.abort();
  start.onclick = async () => {
    start.disabled = true;
    try {
      if (!net.ready || !net.identity) throw new Error("Connect to SpacetimeDB first");
      const file = root.querySelector<HTMLInputElement>("#upload-file")!.files?.[0];
      const title = root.querySelector<HTMLInputElement>("#upload-title")!.value.trim();
      if (!file || !title) throw new Error("Select a video and enter a title");
      const configuration = await fetch(`${import.meta.env.VITE_UPLOAD_API || ""}/api/account/config`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!configuration.ok) throw new Error("Upload service unavailable. Please retry.");
      const limits = await configuration.json();
      if (file.size > limits.maxUploadBytes)
        throw new Error(`Choose a shorter clip (up to ${Math.floor(limits.maxUploadBytes / 1024 ** 2)} MiB).`);
      const durationSec = await videoDuration(file);
      const identity = net.identity.toHexString();
      const api = async (path: string, body: unknown) => {
        const response = await fetch(`${import.meta.env.VITE_UPLOAD_API || ""}/api/uploads/${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${net.token}`,
          },
          body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => {
          throw new Error("Upload service unavailable. Start the configured upload service.");
        });
        if (!response.ok) throw new Error(data.error || "Upload service unavailable");
        return data;
      };
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${title}`;
      const saved = JSON.parse(sessionStorage.getItem("memreplay-upload") || "null");
      let pending =
        saved?.fingerprint === fingerprint && saved.owner === identity && saved.receiptExpiresAt > Date.now()
          ? saved
          : null;
      if (!pending?.uploaded) {
        status.textContent = "Preparing secure upload…";
        const prepared = await api("presign", {
          identity,
          name: file.name,
          type: file.type || (file.name.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4"),
          size: file.size,
          title,
          durationSec,
          pipeline: limits.pipelineAvailable !== false,
        });
        pending = {
          ...prepared,
          fingerprint,
          owner: identity,
          uploaded: false,
        };
        sessionStorage.setItem("memreplay-upload", JSON.stringify(pending));
        cancel.hidden = false;
        await new Promise<void>((resolve, reject) => {
          xhr = new XMLHttpRequest();
          xhr.open("PUT", prepared.putUrl);
          xhr.timeout = 15 * 60 * 1000;
          for (const [key, value] of Object.entries(prepared.headers)) xhr.setRequestHeader(key, String(value));
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              progress.value = (e.loaded / e.total) * 100;
              status.textContent = `Uploading ${Math.round(progress.value)}%`;
            }
          };
          xhr.onload = () =>
            xhr!.status >= 200 && xhr!.status < 300 ? resolve() : reject(new Error(`Storage returned ${xhr!.status}`));
          xhr.onerror = () => reject(new Error("Storage upload failed. Check bucket CORS and connectivity."));
          xhr.onabort = () => reject(new Error("Upload cancelled"));
          xhr.ontimeout = () => reject(new Error("Upload timed out"));
          xhr.send(file);
        });
        pending.uploaded = true;
        sessionStorage.setItem("memreplay-upload", JSON.stringify(pending));
      }
      cancel.hidden = true;
      status.textContent = "Verifying upload and registering memory…";
      const result = await api("complete", {
        identity,
        receipt: pending.receipt,
      });
      sessionStorage.removeItem("memreplay-upload");
      progress.value = 100;
      status.textContent = result.memory
        ? `Uploaded. Database row #${result.memory.id} verified. Open Capture test to play the stored video.`
        : "Uploaded. Pipeline progress appears in the memory list.";
      onComplete?.(result.requestId);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      start.disabled = false;
      cancel.hidden = true;
    }
  };
}
function videoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file),
      video = document.createElement("video");
    video.preload = "metadata";
    const timer = setTimeout(() => done(new Error("Cannot read video duration")), 15000);
    const done = (value: number | Error) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      value instanceof Error ? reject(value) : resolve(value);
    };
    video.onloadedmetadata = () =>
      Number.isFinite(video.duration) ? done(video.duration) : done(new Error("Invalid video duration"));
    video.onerror = () => done(new Error("This browser cannot read the video. Export an MP4/H.264 copy and retry."));
    video.src = url;
  });
}
