import { mountScenePublish } from "./scene-publish";
import { Multiplayer, type Memory } from "./net";
import { uploadPanel } from "./upload";
import { httpURL, memoryPresentation, previewMissing, previewUrl, viewerLink } from "./library-state";
import { mountAuth } from "./auth";
import "./library.css";
import { localMemoryUrls, seedLocalMemories, seedSummary } from "./dev-seed";
import { mountSceneImport } from "./scene-import";

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
  // A snapshot of the rendered splat scene, when the memory has one; otherwise the plain art stays.
  const preview = previewUrl(memory, location.origin);
  if (preview) {
    const shot = element("img", "memory-shot");
    shot.alt = ""; shot.loading = "lazy"; shot.decoding = "async";
    shot.onload = () => card.classList.add("has-shot");
    shot.onerror = () => { previewMissing(preview); shot.remove(); };
    shot.src = preview;
    art.prepend(shot);
  }
  const content = element("div", "memory-content");
  // Title and length; the status badge says the rest, and a sentence only when something needs attention.
  const seconds = Math.max(0, Math.floor(Number(memory.durationUs) / 1e6));
  content.append(element("h3", "", memory.title), element("p", "memory-meta", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`));
  if (presentation.tone !== "ready") content.append(element("p", "memory-detail", presentation.detail));
  if (memory.status === "processing") {
    const label = element("label", "progress-label", `${presentation.progress}% reconstructed`);
    const progress = element("progress"); progress.max = 100; progress.value = presentation.progress;
    progress.setAttribute("aria-label", `${memory.title} reconstruction progress`);
    label.append(progress); content.append(label);
  }
  const actions = element("div", "card-actions");
  const scene = viewerLink(memory, location.origin);
  if (scene) {
    const open = element("a", "primary", "Explore in 3D"); open.href = scene; actions.append(open);
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

function renderUploadGate() {
  const profile = net.identity && net.connection?.db.profile.identity.find(net.identity);
  const registered = net.ready && profile?.provider === "key" && !!profile.displayName;
  const fields = document.getElementById("upload-fields") as HTMLFieldSetElement | null;
  if (fields) fields.disabled = !registered;
  $("upload-gate").hidden = registered;
}
function render() {
  renderUploadGate();
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
  $("empty").querySelector("h3")!.textContent = memories.length ? "Nothing matches." : "No memories yet.";
  $("empty").querySelector("p")!.hidden = memories.length > 0;
  // Dev only (dataset.count is set when local scenes exist): offered only while the library is empty.
  const seed = document.getElementById("seed-local");
  if (seed) seed.hidden = memories.length > 0 || !Number(seed.dataset.count);
}

uploadPanel(net, $("upload-panel"), request => {
  focusedRequest = request; signature = ""; search.value = ""; filter.value = "all"; syncChips();
  history.replaceState(null, "", `/library.html?request=${encodeURIComponent(request)}`);
  notice("Video saved. Use Watch original to play the stored recording. A 3D scene appears when reconstruction is available."); render();
  [...cards.values()].find(card => card.dataset.request === request)?.scrollIntoView({ behavior: "smooth", block: "center" });
});
// The existing uploader still uses the authenticated identity/token from this connection.
const fields = document.createElement("fieldset"); fields.id = "upload-fields";
while ($("upload-panel").firstChild) fields.append($("upload-panel").firstChild!);
$("upload-panel").append(fields);
const gate = element("p", "upload-gate", "Sign in first."); gate.id = "upload-gate";
$("upload-panel").prepend(gate);
mountAuth(net);
mountSceneImport(net);
mountScenePublish(net);
search.oninput = render; filter.onchange = render;
// Filter chips (they replaced a dropdown) drive the hidden select; arrow keys move between them, as in a radio group.
const chips = Array.from(document.querySelectorAll<HTMLButtonElement>("#filter-chips [data-filter]"));
function syncChips() { for (const chip of chips) { const on = chip.dataset.filter === filter.value; chip.setAttribute("aria-checked", String(on)); chip.tabIndex = on ? 0 : -1; } }
chips.forEach((chip, i) => {
  chip.onclick = () => { filter.value = chip.dataset.filter ?? "all"; syncChips(); render(); };
  chip.onkeydown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = chips[(i + step + chips.length) % chips.length]; next.focus(); next.click();
  };
});
syncChips();
$("copy-library").onclick = () => copyLink(new URL("/library.html", location.origin).href, "Library link copied.");
$("close-video").onclick = () => dialog.close();
dialog.onclose = () => { video.pause(); video.removeAttribute("src"); video.load(); };
net.addEventListener("change", render);
// Dev only: fill this account's library with every scene in public/memories (also ?seed=local).
const seedButton = $<HTMLButtonElement>("seed-local");
let localCount = 0, seedPending = new URL(location.href).searchParams.get("seed") === "local";
async function seedLocal() {
  seedButton.disabled = true;
  try {
    const result = await seedLocalMemories(net, (done, total) => { seedButton.textContent = `Loading ${done} of ${total}…`; });
    notice(seedSummary(result));
  } catch (error) {
    notice(`Could not load local memories: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    seedButton.disabled = false; seedButton.textContent = `Load local memories (${localCount})`;
    render();
  }
}
function runPendingSeed() {
  if (!seedPending || !net.ready || !localCount) return;
  // Once is enough: a reload should not run it again.
  seedPending = false;
  const url = new URL(location.href); url.searchParams.delete("seed"); history.replaceState(history.state, "", url);
  void seedLocal();
}
seedButton.onclick = () => void seedLocal();
void localMemoryUrls().then(urls => {
  localCount = urls.length; seedButton.dataset.count = String(urls.length); seedButton.textContent = `Load local memories (${urls.length})`;
  render(); runPendingSeed();
});
net.addEventListener("change", runPendingSeed);
addEventListener("pagehide", () => net.dispose(), { once: true });
net.connect(); render();
fetch(`${import.meta.env.VITE_UPLOAD_API || ""}/api/health`, { signal: AbortSignal.timeout(5000) })
  .then(async response => { if (!response.ok || (await response.json()).status !== "ok") throw new Error(); $("upload-health").textContent = "Upload service connected."; })
  .catch(() => { $("upload-health").textContent = "Upload service is offline. Your memories still open."; });
