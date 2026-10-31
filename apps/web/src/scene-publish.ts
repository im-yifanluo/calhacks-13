import type { Multiplayer } from "./net";
import { inspectScene, filePath, type ScenePackage } from "./scene-bundle";

/** Publish each scene independently, retaining its request ID for safe retries. */
export function mountScenePublish(net: Multiplayer) {
  const input = document.getElementById("publish-folder") as HTMLInputElement;
  const button = document.getElementById("publish-scenes") as HTMLButtonElement;
  const status = document.getElementById("publish-status")!;
  let busy = false;
  let jobs: { pkg: ScenePackage; manifest: string; requestId: string; done: boolean }[] = [];
  const signedIn = () =>
    net.ready && net.identity && net.connection?.db.profile.identity.find(net.identity)?.provider === "key";
  const gate = () => {
    input.disabled = busy || !signedIn();
    button.disabled = busy || !signedIn() || !jobs.length;
  };
  input.onchange = () => {
    try {
      const files: Record<string, Blob> = Object.create(null);
      for (const f of Array.from(input.files || [])) files[filePath(f.webkitRelativePath || f.name)] = f;
      jobs = Object.keys(files)
        .filter((p) => /(^|\/)memory\.json$/.test(p))
        .sort()
        .map((manifest) => {
          const base = manifest.slice(0, -"memory.json".length);
          const subset = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(base)));
          return {
            pkg: { files: subset, manifests: [manifest] },
            manifest,
            requestId: crypto.randomUUID(),
            done: false,
          };
        });
      status.textContent = jobs.length
        ? `${jobs.length} scenes selected. Publish to share them.`
        : "Choose a folder with memory.json.";
    } catch (e) {
      jobs = [];
      status.textContent = String(e);
    }
    gate();
  };
  button.onclick = async () => {
    if (!signedIn() || busy) return;
    const identity = net.identity!.toHexString(),
      token = net.token;
    busy = true;
    gate();
    const post = async (path: string, data: Record<string, unknown>) => {
      if (net.identity?.toHexString() !== identity) throw new Error("Account changed. Sign back in to resume.");
      const response = await fetch(`/api/scenes/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...data, identity }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
      return result;
    };
    try {
      // Validate every selected scene before publishing any of them.
      const prepared = await Promise.all(
        jobs.map(async (job) => {
          const scene = await inspectScene(job.pkg, job.manifest);
          const assets = { ...scene.files, [job.manifest]: job.pkg.files[job.manifest] };
          const alternate = job.manifest.replace(/memory.json$/, "memory.static.json");
          if (job.pkg.files[alternate])
            Object.assign(assets, (await inspectScene(job.pkg, alternate)).files, {
              [alternate]: job.pkg.files[alternate],
            });
          for (const file of Object.values(assets))
            if (file.size > 64 * 1024 ** 2) throw new Error("Each asset must be at most 64 MiB.");
          return { job, scene, assets };
        }),
      );
      for (const { job, scene, assets } of prepared) {
        if (job.done) continue;
        const { receipt } = await post("start", { requestId: job.requestId, title: scene.title });
        const entries = Object.entries(assets),
          base = job.manifest.slice(0, -"memory.json".length);
        for (let i = 0; i < entries.length; i++) {
          const [path, file] = entries[i];
          status.textContent = `${scene.title}: uploading file ${i + 1}/${entries.length} · ${jobs.filter((j) => j.done).length}/${jobs.length} scenes published`;
          const signed = await post("presign", { receipt, path: path.slice(base.length), size: file.size });
          if (!signed.stored) {
            const response = await fetch(signed.putUrl, { method: "PUT", headers: signed.headers, body: file });
            if (!response.ok && response.status !== 409)
              throw new Error(`Asset upload failed (${response.status}). Press Publish to resume.`);
          }
        }
        await post("complete", { receipt });
        job.done = true;
      }
      status.textContent = `${jobs.length} scenes published. Find them under Memories.`;
    } catch (e) {
      status.textContent = `${e instanceof Error ? e.message : e} Press Publish to resume.`;
    } finally {
      busy = false;
      gate();
    }
  };
  net.addEventListener("change", gate);
  gate();
}
