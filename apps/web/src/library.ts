import { Multiplayer, type Memory } from "./net";
import { uploadPanel } from "./upload";
import { httpURL, memoryPresentation, viewerLink } from "./library-state";
import "./library.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const net = new Multiplayer(true);
const grid = $("memory-grid"), search = $<HTMLInputElement>("search"), filter = $<HTMLSelectElement>("filter");
const dialog = $<HTMLDialogElement>("video-dialog"), video = $<HTMLVideoElement>("source-video");
let focusedRequest = new URLSearchParams(location.search).get("request") || "";
let signature = "";
const cards = new Map<string, HTMLElement>();
const testRecording = (memory: Memory) => Boolean(memory.sourceUrl) && memory.owner.isEqual(memory.pipelineIdentity);

function notice(text: string) { $("notice").textContent = text; $("notice").hidden = false; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

function memoryCard(memory: Memory) {
  const presentation = memoryPresentation(memory, testRecording(memory), location.origin);
  const card = element("article", `memory-card ${presentation.tone}`);
  card.dataset.request = memory.requestId;
  card.classList.toggle("selected", memory.requestId === focusedRequest);
  const art = element("div", "memory-art");
  art.append(element("span", "orbit", "◌"), element("span", "status-badge", presentation.label));
  const content = element("div", "memory-content");
  content.append(element("p", "memory-meta", `MEMORY ${memory.id} · ${Math.round(Number(memory.durationUs) / 1e6)} SEC`), element("h3", "", memory.title));
  const owner = net.connection?.db.profile.identity.find(memory.owner);
  content.append(element("p", "memory-meta", `By ${owner?.displayName || "Guest"} · ${memory.owner.toHexString().slice(0, 8)}`));
  const detail = element("p", "memory-detail", presentation.detail);
  content.append(detail);
  if (memory.status === "processing") {
    const label = element("label", "progress-label", `${presentation.progress}% reconstructed`);
    const progress = element("progress"); progress.max = 100; progress.value = presentation.progress;
    progress.setAttribute("aria-label", `${memory.title} reconstruction progress`);
    label.append(progress); content.append(label);
  }
  const actions = element("div", "card-actions");
  const scene = viewerLink(memory, location.origin);
  if (scene) {
    const open = element("a", "primary", "Open in 3D ↗"); open.href = scene; actions.append(open);
    const copy = element("button", "secondary", "Copy scene link");
    copy.onclick = () => copyLink(scene, "Scene link copied. Open it in Quest Browser to enter VR."); actions.append(copy);
  }
  const source = httpURL(memory.sourceUrl, location.origin);
  if (source) {
    const play = element("button", "text-button", "Watch original");
    play.onclick = () => { $("video-title").textContent = memory.title; video.src = source.href; dialog.showModal(); };
    actions.append(play);
  }
  content.append(actions); card.append(art, content); return card;
}

async function copyLink(url: string, message: string) {
  try { await navigator.clipboard.writeText(url); notice(message); }
  catch { notice(`Copy this link: ${url}`); }
}

let profileBusy = false;
let lastProfileKey = "";
function renderProfile() {
  const profile = net.identity && net.connection?.db.profile.identity.find(net.identity);
  const name = profile?.displayName || "";
  const profileKey = `${net.identity?.toHexString()}:${name}`;
  if (profileKey !== lastProfileKey) {
    lastProfileKey = profileKey;
    $("profile-summary").textContent = name ? `Welcome, ${name}. Your uploads belong to your unique user ID.` : "Enter your name to start uploading.";
    $("profile-id").textContent = net.identity ? `User ID: ${net.identity.toHexString()}` : "";
    $<HTMLInputElement>("display-name").value = name;
    $("save-profile").textContent = name ? "Save name" : "Continue";
  }
  $<HTMLButtonElement>("save-profile").disabled = !net.ready || profileBusy;
  const fields = document.getElementById("upload-fields") as HTMLFieldSetElement | null;
  if (fields) fields.disabled = !net.ready || !name;
  $("upload-gate").hidden = !!name;
}
function render() {
  renderProfile();
  $("connection").textContent = net.status;
  $("connection").classList.toggle("connected", net.ready);
  $("live-note").textContent = net.ready ? "● Live updates" : "Reconnecting · last known status";
  $("error").textContent = net.error; $("error").hidden = !net.error;
  const memories = [...net.memories].reverse();
  $("memory-count").textContent = String(memories.length);
  const key = JSON.stringify(memories.map(m => [String(m.id), m.requestId, m.title, m.status, m.progress, m.error, m.manifestUrl, m.sourceUrl, String(m.durationUs), testRecording(m), net.connection?.db.profile.identity.find(m.owner)?.displayName]));
  if (key !== signature) {
    signature = key;
    const liveIDs = new Set(memories.map(m => String(m.id)));
    for (const [id, card] of cards) if (!liveIDs.has(id)) { card.remove(); cards.delete(id); }
    for (const memory of memories) {
      const id = String(memory.id), old = cards.get(id), next = memoryCard(memory);
      if (old) {
        // Avoid interrupting a keyboard user's current card as other rows update.
        const actionIndex = old.contains(document.activeElement) ? Array.from(old.querySelectorAll("a,button")).indexOf(document.activeElement as HTMLAnchorElement) : -1;
        old.replaceWith(next);
        if (actionIndex >= 0) next.querySelectorAll<HTMLElement>("a,button")[actionIndex]?.focus();
      }
      cards.set(id, next);
    }
    for (const memory of memories) grid.append(cards.get(String(memory.id))!);
  }
  let count = 0;
  for (const memory of memories) {
    const isTest = testRecording(memory);
    const state = memoryPresentation(memory, isTest, location.origin);
    const matches = filter.value === "all" || (filter.value === "ready" && !!viewerLink(memory, location.origin)) ||
      (filter.value === "pending" && !isTest && ["uploaded", "processing"].includes(memory.status)) ||
      (filter.value === "failed" && state.tone === "failed") || (filter.value === "test" && isTest);
    const visible = matches && memory.title.toLowerCase().includes(search.value.toLowerCase().trim());
    cards.get(String(memory.id))!.hidden = !visible;
    if (visible) count++;
  }
  $("empty").hidden = count > 0;
  $("empty").querySelector("h3")!.textContent = memories.length ? "No matching memories." : "Your next memory starts here.";
}

uploadPanel(net, $("upload-panel"), request => {
  focusedRequest = request; signature = ""; search.value = ""; filter.value = "all";
  history.replaceState(null, "", `/library.html?request=${encodeURIComponent(request)}`);
  notice("Video received. Its processing status will update here automatically."); render();
  [...cards.values()].find(card => card.dataset.request === request)?.scrollIntoView({ behavior: "smooth", block: "center" });
});
// The existing uploader still uses the authenticated identity/token from this connection.
const fields = document.createElement("fieldset"); fields.id = "upload-fields";
while ($("upload-panel").firstChild) fields.append($("upload-panel").firstChild!);
$("upload-panel").append(fields);
const gate = element("p", "upload-gate", "Enter your name above to upload a video."); gate.id = "upload-gate";
$("upload-panel").prepend(gate);
$("profile-form").onsubmit = async event => {
  event.preventDefault();
  if (!net.ready || !net.identity || profileBusy) return;
  const displayName = $<HTMLInputElement>("display-name").value.trim();
  if (!displayName || displayName.length > 40) { $("profile-message").textContent = "Use a name of 1–40 characters."; return; }
  profileBusy = true; renderProfile();
  try {
    const response = await fetch(`${import.meta.env.VITE_UPLOAD_API || ""}/api/profile`, {
      method: "POST", headers: { Authorization: `Bearer ${net.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: net.identity.toHexString(), displayName }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save your name");
    $("profile-message").textContent = "Name saved. Your user ID stays the same when you rename it.";
  } catch (error) { $("profile-message").textContent = error instanceof Error ? error.message : "Could not save your name"; }
  finally { profileBusy = false; renderProfile(); }
};
search.oninput = render; filter.onchange = render;
$("copy-library").onclick = () => copyLink(new URL("/library.html", location.origin).href, "Library link copied.");
$("close-video").onclick = () => dialog.close();
dialog.onclose = () => { video.pause(); video.removeAttribute("src"); video.load(); };
net.addEventListener("change", render);
addEventListener("pagehide", () => net.dispose(), { once: true });
net.connect(); render();
fetch(`${import.meta.env.VITE_UPLOAD_API || ""}/api/health`, { signal: AbortSignal.timeout(5000) })
  .then(async response => { if (!response.ok || (await response.json()).status !== "ok") throw new Error(); $("upload-health").textContent = "Upload service connected."; })
  .catch(() => { $("upload-health").textContent = "Upload service is unavailable. Viewing existing memories still works; connect the upload API before sending new clips."; });
