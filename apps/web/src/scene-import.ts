import { getImportedScene, listImportedScenes, localSceneLink, saveImportedScene } from './scene-store';
import type { ScenePackage } from './scene-bundle';
import type { Multiplayer } from './net';
import { savedAccount } from './account-key';

export function mountSceneImport(net: Multiplayer) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const zip = $<HTMLInputElement>('scene-zip'), folder = $<HTMLInputElement>('scene-folder');
  const choice = $<HTMLSelectElement>('scene-manifest'), open = $<HTMLButtonElement>('scene-import-open');
  const status = $('scene-import-status'), details = $('scene-import-details');
  let pkg: ScenePackage | undefined, revision = 0, busy = false;
  const show = (message: string, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
  const signedIn = () => !!savedAccount() && net.ready && net.identity?.toHexString() === savedAccount()?.identity && net.connection?.db.profile.identity.find(net.identity!)?.provider === 'key';
  const gate = () => {
    zip.disabled = folder.disabled = choice.disabled = busy || !signedIn();
    if (!signedIn()) { open.disabled = true; show('Sign in above to import and view your memories. Older imports without an account must be imported again.'); }
    else if (!busy && !pkg) show('Choose a scene package to add it to your account on this browser.');
  };
  const lock = (value: boolean) => { busy = value; gate(); };
  const list = async () => {
    const scenes = signedIn() ? await listImportedScenes() : [];
    const host = $('local-scenes'); host.replaceChildren();
    for (const scene of scenes.sort((a,b) => b.importedAt-a.importedAt)) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = localSceneLink(scene.id); link.textContent = scene.title;
      const meta = document.createElement('span');
      meta.textContent = `${scene.manifest.timeline.durationSec.toFixed(1)} sec · ${scene.manifest.objects.length} objects · ${(scene.bytes / 1048576).toFixed(1)} MB · this browser`;
      item.append(link, meta); host.append(item);
    }
    $('local-scenes-section').hidden = scenes.length === 0;
  };
  const inspect = async () => {
    const current = ++revision; open.disabled = true;
    if (!pkg) return;
    show('Checking assets and timeline…');
    try {
      const { inspectScene } = await import('./scene-bundle');
      const scene = await inspectScene(pkg, choice.value);
      if (current !== revision) return;
      const cameraCount = Array.isArray(scene.manifest.camera.track) ? scene.manifest.camera.track.length : 'External';
      show(`${scene.title} · ${scene.manifest.timeline.durationSec.toFixed(1)} seconds · ${cameraCount} camera samples · ${scene.manifest.objects.length} objects. ${scene.manifest.objects.length ? 'Recorded motion and object tracks are included.' : 'Static geometry with recorded camera playback; no separate moving objects.'}`);
      open.disabled = false;
    } catch (error) { if (current === revision) show(error instanceof Error ? error.message : 'Cannot read this scene.', true); }
  };
  const read = async (kind: 'zip' | 'folder') => {
    if (busy || !signedIn()) return;
    const files = Array.from((kind === 'zip' ? zip : folder).files ?? []);
    if (!files.length) return;
    lock(true); open.disabled = true; details.hidden = true; pkg = undefined; revision++;
    show('Opening scene package…');
    try {
      const reader = await import('./scene-bundle');
      pkg = kind === 'zip' ? await reader.readSceneZip(files[0]) : reader.readSceneFolder(files);
      choice.replaceChildren(...pkg.manifests.map(path => new Option(path.endsWith('memory.static.json') ? `${path} — static alternative` : path, path)));
      details.hidden = false;
      await inspect();
    } catch (error) { show(error instanceof Error ? error.message : 'Could not read this package.', true); }
    finally { lock(false); }
  };
  zip.onchange = () => void read('zip'); folder.onchange = () => void read('folder');
  choice.onchange = () => void inspect();
  open.onclick = () => {
    if (busy || !pkg || !signedIn()) return;
    lock(true); open.disabled = true; show('Saving scene in this browser…');
    void (async () => {
      try {
        const { inspectScene } = await import('./scene-bundle');
        const scene = { ...await inspectScene(pkg!, choice.value), id: crypto.randomUUID(), importedAt: Date.now() };
        await saveImportedScene(scene);
        if (!await getImportedScene(scene.id)) throw new Error('Scene could not be saved.');
        location.href = localSceneLink(scene.id);
      } catch (error) { show(error instanceof Error ? error.message : 'Import failed.', true); lock(false); open.disabled = false; }
    })();
  };
  let lastAccount = '';
  const refresh = () => {
    const current = `${signedIn()}:${savedAccount()?.identity ?? ''}`;
    if (current === lastAccount) return;
    lastAccount = current; gate();
    if (signedIn() && pkg && !busy) void inspect();
    void list().catch(error => show(error.message, true));
  };
  net.addEventListener('change', refresh);
  window.addEventListener('memos-account-changed', refresh);
  refresh();
}
