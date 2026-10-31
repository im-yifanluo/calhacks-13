import { Multiplayer, type Memory } from "../net";
import { uploadPanel } from "../upload/panel";
import { captureSimulation } from "./simulation";
import "../styles/capture.css";
import { byId as $ } from "../lib/dom";
const net = new Multiplayer();
/** A test upload (presign with pipeline:false) is assigned to its uploader, not the worker. */
const testUpload = (m: Memory) => m.pipelineIdentity.isEqual(m.owner);
const select = $<HTMLSelectElement>("recordings"),
  video = $<HTMLVideoElement>("stored-video");
let selected = new URLSearchParams(location.search).get("request") || "",
  signature = "",
  proofGeneration = 0;
function show() {
  proofGeneration++;
  const memory = net.memories.find((m) => m.requestId === selected);
  $("row-id").textContent = memory ? `#${memory.id} · confirmed in SpacetimeDB` : "—";
  $("row-status").textContent = memory
    ? memory.status + (testUpload(memory) ? " · test upload, not queued for the 3D pipeline" : "")
    : "—";
  const link = $<HTMLAnchorElement>("source-link");
  link.textContent = memory?.sourceUrl || "—";
  if (memory) {
    link.href = memory.sourceUrl;
    video.src = memory.sourceUrl;
  } else {
    link.removeAttribute("href");
    video.removeAttribute("src");
    video.load();
  }
  $<HTMLButtonElement>("check-storage").disabled = !memory;
  $("storage-proof").textContent = memory
    ? "Database row found. Click Verify stored file, then press Play."
    : "Select a recording to check its file.";
  $("playback-proof").textContent = "";
}
select.onchange = () => {
  selected = select.value;
  show();
};
$("check-storage").onclick = async () => {
  const memory = net.memories.find((m) => m.requestId === selected);
  if (!memory) return;
  const generation = ++proofGeneration;
  $("storage-proof").textContent = "Checking the stored URL…";
  try {
    const response = await fetch(memory.sourceUrl, {
      method: "HEAD",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Storage returned ${response.status}`);
    const size = response.headers.get("Content-Length"),
      hash = response.headers.get("X-Content-SHA256");
    if (generation !== proofGeneration) return;
    $("storage-proof").textContent =
      `Storage reachable · ${size ? Number(size).toLocaleString() + " bytes" : "size not exposed by server"}${hash ? " · SHA-256 " + hash : ""}. Press Play to verify the content.`;
  } catch (error) {
    if (generation === proofGeneration)
      $("storage-proof").textContent =
        `Could not verify storage: ${error instanceof Error ? error.message : String(error)}. Check the service and storage CORS.`;
  }
};
video.onplaying = () => {
  $("playback-proof").textContent =
    "Playing the video fetched from the database source URL. Check that it shows your recorded scene.";
};
video.onerror = () => {
  $("playback-proof").textContent =
    "Video could not be played. Check that storage is running and the browser supports its codec.";
};
function selectRecording(requestId: string) {
  selected = requestId;
  const url = new URL(location.href);
  url.searchParams.set("request", requestId);
  history.replaceState(null, "", url);
  signature = "";
  render();
}
uploadPanel(net, $("upload-panel"), selectRecording);
captureSimulation(net, selectRecording);
function render() {
  $("connection").textContent = net.status;
  $("connection").classList.toggle("connected", net.ready);
  $("error").textContent = net.error;
  const memories = net.memories.filter((m) => m.sourceUrl).sort((a, b) => Number(b.id - a.id));
  const next = memories.map((m) => `${m.id}:${m.status}:${m.title}`).join("|");
  if (next === signature) return;
  signature = next;
  select.replaceChildren();
  for (const m of memories)
    select.add(new Option(`#${m.id} · ${m.title} · ${m.status}${testUpload(m) ? " · test" : ""}`, m.requestId));
  if (!selected) selected = memories[0]?.requestId || "";
  select.value = selected;
  if (!memories.length) select.add(new Option("No uploaded videos yet", ""));
  show();
}
net.addEventListener("change", render);
net.connect();
