# View a finished scene in memos

The downloaded `memories` folder contains finished scene bundles, not source video clips. Keep each scene's directory intact: the manifest refers to files below `world/`, `objects/`, and `input/` using relative paths.

## Inspecting this export

| Folder | Scene | Interactive export |
| --- | --- | --- |
| img8013 | Hotel room | All referenced files present |
| img8014 | Hotel room corner | All referenced files present |
| img8015 | Hotel corridor | All referenced files present |
| img8016 | Hotel lobby | Missing `world/ghosts/person-0.bin` |
| img8017 | Night walk downtown | Missing `world/ghosts/person-0.bin` and `person-1.bin` |

Every folder also has a complete `memory.static.json`: a background splat, recorded camera path and audio, with no separate interactive objects or animated people. Use this version for an unobstructed recorded-view demo, particularly for the two incomplete interactive exports. The export metadata identifies the source device as an iPhone 14 Pro Max.

## Import directly on memos

Open https://memos.alightdell64.chatgpt.site/library#import-scene. Choose **Scene ZIP** (`.memos.zip` or a normal ZIP) or **Or scene folder**, then **Import and open in 3D**. A complete scene is saved in IndexedDB on that browser and reopens after refresh; find it under **Imported on this device**. It opens in **Camera: Free look** at the first recorded viewpoint. Drag empty space to explore, scroll or pinch to zoom, and use WASD (desktop) or WALK (phone) to move. Click the **Camera** button to follow the recorded wearer's view; click it again to return to free look. Play, pause, scrub the timeline, and use Hide UI as usual. No SpacetimeDB connection or sign-in is needed for local imports.

**The interchange contract remains version-1 `memory.json`.** It contains timestamps, camera/object tracks, physics metadata, and relative asset references. A `.memos.zip` is an ordinary ZIP transport package containing that JSON plus its `.spz` splats, `.glb` colliders/meshes, `.bin` animated people, and `.m4a` audio. A `.spz` alone is one 3D appearance; an MP4 alone is a video. Neither contains the entire reconstructed timeline. Import does not reconstruct new motion or repair the model.

Keep the folder structure intact (a single enclosing folder in a ZIP is supported). The importer checks scene structure, track timestamps, and all referenced files before storing. ZIPs are limited to 250 MB expanded and 4,000 files. Assets must be inside the ZIP/folder, with relative paths. External-URL manifests use the existing **Add a memory → memory.json link** instead. The viewer retains its 1-million-splat limit. Self-contained GLB assets are expected.

Prepared packages are in the Git-ignored `data/scene-packages/` directory. `img8013`, `img8014`, and `img8015` support `memory.json`. In the `img8016` and `img8017` packages, choose **memory.static.json — static alternative**: their full manifests reference missing animated-person BIN files. Static mode keeps camera playback and audio but has no separate moving/grabbable objects. The importer never silently substitutes this mode.

To make another package, run from the repository root:

```sh
python3 scripts/package-scene.py /path/to/scene-folder data/scene-packages/my-scene.memos.zip
```

On iPhone, send the ZIP to Files (for example using AirDrop), open the library in Safari, and choose it with **Scene ZIP**. A local import URL does not carry the files to another device. Local imports are browser-wide, not attached to a memos account; clearing website data removes them, and private browsing may not retain them. Keep the ZIP as your original. No private assets are sent to SpacetimeDB or the public site by importing.

For parties, use the hosted-file flow below. SpacetimeDB stores `manifest_url`, `duration_us`, status and identity; its websocket synchronizes the party clock and edits. The website fetches `memory.json` and the referenced assets from object storage. Local-only scene IDs/blob URLs must never be registered as shared memories.

## Preview privately on this Mac

From the repository root, with Node 22.12 or newer:

```sh
mkdir -p apps/web/public/memories
cp -R ~/Downloads/memories/. apps/web/public/memories/
LOCAL_HTTP=1 npm run dev -w apps/web -- --port 5190 --strictPort
```

The files were copied there during setup. Repeat the copy only after changing the source folder. This directory is ignored by Git. Keep the terminal running to view locally; the private scene itself does not require a database connection.

- Interactive hotel corner: <http://127.0.0.1:5190/?memory=/memories/img8014/memory.json>
- Static hotel room: <http://127.0.0.1:5190/?memory=/memories/img8013/memory.static.json>
- Static corridor: <http://127.0.0.1:5190/?memory=/memories/img8015/memory.static.json>
- Static lobby: <http://127.0.0.1:5190/?memory=/memories/img8016/memory.static.json>
- Static night walk: <http://127.0.0.1:5190/?memory=/memories/img8017/memory.static.json>

Choose **View options (···) → Wearer's view**, then **Play** and **Hide UI** at the top. A faint **Show UI** button stays visible; tap it to restore controls. Double-tapping/clicking the scene or pressing **H** / **Escape** also works. Mouse movement and party updates do not exit this mode. Camera selection and playback remain unchanged. Object grabbing is disabled while controls are hidden, so the restore gesture cannot edit the scene. In immersive Quest VR, the existing B/Y controller buttons toggle the in-world panel.

## Add a scene to the public memos library

Use **Import a 3D memory** above for local scene files. **Upload a video** accepts original clips for a reconstruction worker. For a scene everyone in a party can access, use **Add a memory → memory.json link**:

1. Put a complete scene folder in your R2/S3 asset hosting, preserving its relative directory structure. For example, a manifest at `https://YOUR-ASSET-HOST/memories/img8014/memory.json` must have its background at `https://YOUR-ASSET-HOST/memories/img8014/world/bg_room.spz`.
2. Make the manifest and all referenced files accessible to the people viewing the scene. Allow browser GET/HEAD requests from `https://memos.alightdell64.chatgpt.site` in the bucket's CORS policy. Serve JSON as `application/json`, SPZ/BIN as `application/octet-stream`, GLB as `model/gltf-binary`, and M4A as `audio/mp4`. Support range requests for audio playback.
3. On <https://memos.alightdell64.chatgpt.site/>, open **Solo** (or the current party button), expand **Add a memory**, paste the full HTTPS manifest link and click **Add to library**. Wait for the database connection if the button is disabled.
4. Select the new entry under **Scene or video**, then **Create a party**. If already leading a party, choose **Use selected scene / video**. Share the party code or invite link.
5. For the lobby or night walk, use the `memory.static.json` URL until the missing person-animation files are restored.

SpacetimeDB stores the scene's metadata and manifest URL; object storage holds the splat/audio files. Uploading only the JSON, or supplying a Finder path, cannot make the assets accessible on a phone. The hosted demo currently has no video upload service, and these local recordings have not been published by this setup.

Vite copies all files under `public/` into production builds even when Git ignores them. Exclude private `public/memories/` and `public/local/` data when packaging a public website; Git ignore alone does not prevent publication.

## Publish an existing reconstruction for all devices

In the hosted memos **Memory library**, sign in with your existing personal key.
Choose **Publish scene folder** under **Publish rendered scenes**. Select either
one complete scene folder or a parent folder containing several scene folders.
Each scene needs `memory.json` and every referenced asset. `memory.static.json`,
when present, is validated and uploaded alongside the animated version.
Click **Publish scenes** and keep the tab open until it reports completion.
An interrupted transfer can be resumed with the same button while the tab remains open.

The uploader validates scene contents before starting. Files go to object storage;
SpacetimeDB receives an owned `ready` memory record only after the upload service
verifies all referenced assets exist. Individual files are limited to 64 MiB.
Personal keys are never included in asset URLs. Anyone with a scene URL can read
its assets, so only share scenes intended for that audience.

Open a ready memory in 3D, choose that memory in **Watch together**, and click
**Create party**. Open the resulting `/PARTYCODE` URL on the phone and Quest Browser.
Use separate guest identities or separate accounts on each device. The leader
controls pause, seek, and playback speed. Clients load scene assets over HTTPS;
SpacetimeDB carries room membership, timeline anchors, grabs, and player poses.
On Quest, enter immersive VR with the VR button. A desktop rendering check does
not establish headset performance or controller compatibility.
