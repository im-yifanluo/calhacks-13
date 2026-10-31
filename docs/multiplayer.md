# Multiplayer

A party lets several people relive one memory together, each on their own device. Every device downloads the scene and renders it locally; SpacetimeDB carries only the small shared state: who is in the party, the shared clock, the takes, who holds which object, recorded throws and head poses. The server module is [server/spacetime](../server/spacetime) (SpacetimeDB 2.13, TypeScript), the browser client is [apps/web/src/net](../apps/web/src/net), and the party panel is [apps/web/src/party](../apps/web/src/party). How the viewer plays, grabs and records on one device is in [Viewer](./viewer.md).

## Concepts

- **Party**: a shared room with a leader. The leader controls time: play, pause, seek, the playback speed (0.25× to 2×), which take is showing, and the party's scene. Everyone else follows the shared clock. Their playback controls are disabled; a Space press or a headset button press only puts them back on the shared clock ("The party leader controls time. You can look around and interact while paused."), and the server rejects time changes from anyone but the leader.
- **Exploring**: every member walks and looks around freely and, while the party is paused, grabs and throws objects. The thrower's device simulates the throw; everyone else sees the object move live, then replays the saved flight.
- **Takes** are alternate timelines kept on the server. Everyone in a party sees the same take, and the leader picks which one plays.
- **Late joiners** start at the current shared time on the current take, and rebuild every take from the saved throws.
- **Leadership**: the party's creator leads, and can hand over with **Make leader**. When the leader's last connection closes, another connected member becomes leader, and a returning leader doesn't take it back, so reloading the leader's page can hand leadership to someone else. When nobody is connected, the party pauses and its next visitor leads.
- **Scene**: the database holds the party's memory. With nothing else chosen, a party plays the built-in synthetic demo (the practice room), which is added to your library the first time.
- **Rooms without a leader**: the module also has `createRoom`, a collaborative room where anyone controls time. The app always creates parties (`createParty`); the integration tests use both.

## The party panel

The party button at the top right ("Solo", or "CODE · N people") opens **Watch together**. On a fresh visit it opens by itself; on a phone, an invite link keeps it closed so the scene shows.

- **Party code** and **Join party**: join with the host's seven-character code. Lowercase and surrounding spaces are fine; anything that isn't seven letters or digits gets an explanation, and an unknown code shows an error and keeps you where you are. Entering another code while in a party switches parties. On a phone the panel closes after joining.
- **Explore solo** closes the panel.
- **Create party**: creates a party and makes you its leader. Its scene is the memory card selected under **Your memories** (tap a card to select it, tap it again to deselect); the memory on screen counts as selected when it is in your library, otherwise the synthetic demo is used. **Add a memory** → **memory.json link** → **Add to library** registers a finished scene as one of your memories.
- **Your party code** with **Copy code**, **Copy invite link**, and the invite address under "Anyone with this link can join".
- The people list: name and device (`desktop`, `phone` or `quest`), marked "· you", "· leader", and "· saved identity" for password accounts.
- For the leader: **Playback speed**, **Make leader** next to each member, **Use the selected memory** and **Cancel pending scene**.
- **Leave** returns to a solo session.
- The connection line under the title ("Connected", "Connection lost — reconnecting in N s…") and, while disconnected, **Reconnect**.

While in a party, the viewer's status line rests on "In party CODE. The leader controls time; everyone sees the same take."

Other players appear as a head with a visor showing where they look and a name tag ("name · device"); Quest players also show their hands. Each page sends its head's world pose (including the VR rig) and, in VR, its controller positions at most 12.5 times a second, and re-sends an unchanged pose once a second. Avatars within 0.6 m of your own camera are hidden, since everyone starts at the same spot. The device label is sent again on entering and leaving VR.

### Changing the scene

1. The leader selects a memory card and presses **Use the selected memory**.
2. A ready memory is installed at once: every member's page reloads into it, on the original recording, paused at 0.
3. A memory still uploaded or processing becomes the party's pending scene. The party keeps its current scene and shows the pending one's status and progress ("Waiting for a worker" while it is only uploaded). **Cancel pending scene** detaches it without deleting anything. When the worker marks it ready, the server installs it in every party waiting for it, in the same transaction, and every page reloads into it. A failed job leaves the current scene in place.

Creating a party with a memory that isn't ready yet starts the party on the synthetic demo, with that memory pending. Takes belong to the memory they were made on, and the server refuses to select them in another scene.

## Room addresses

- `/` is a solo session. A fresh visit to `/` never rejoins an earlier party: if the server puts this identity back in its old room on connect, the page leaves it.
- `/CODE` is a party. Creating or joining one changes the address to `/CODE`, the invite link is that address, and opening or reloading it rejoins the party and loads its current scene.
- `/?room=CODE`, the older invite format, still joins, then becomes `/CODE`. Lowercase codes and a trailing slash are fixed up the same way.
- **Leave** returns to `/`.
- The scene's URL never goes in the address. The database selects the party's memory; a page whose loaded manifest differs reloads into the party's memory, remembering it for that tab only, and tries that at most once per address so a manifest that never matches can't loop.
- Joining from a page with solo takes, or in the middle of a grab, reloads it first: solo takes are never mixed with or sent to the party.
- Codes belong to one database: a code from a local server doesn't work on the hosted site, and the other way round.
- Hosting must answer `/CODE` with the viewer page, including on reload (single-page-app fallback). The Vite dev server does this for every unknown path, and the hosted site's worker does it for party paths (`server/upload/deploy/sites/worker.ts`); see [Deployment](./deployment.md).

## Signing in

Party members are guests by default, and each guest browser tab has its own SpacetimeDB identity, so two guest tabs are two players. To keep a name across devices, enter it under **Sign-in name** and press **Sign in**: the upload API registers the name and returns a generated six-digit password (**Copy password**, **Save password file**). On another device, **I have a six-digit password** → **Sign in with password** restores the same identity and name. **Restore an older saved account** takes an old `memos1.` credential, and **Sign out** forgets the saved password in this browser and starts a new guest. The password API, how passwords are stored and their limits are in [Upload API](./upload-api.md).

What matters for parties:

- Every tab and device signed in with one password is one participant, a single player row. For a multi-person test, use separate guests or separate accounts.
- A registered name is fixed: joining a party can't change it, and the panel's name field becomes read-only. Names are labels, not authentication.
- Signing in with a name keeps this tab's identity, so you stay in the party. Signing in with a password, or signing out, leaves the current party and reloads the page at the same address.
- A password belongs to the server and database where it was made, so a local password doesn't work on the hosted site.

## Server rules

Reducers fail with a `SenderError` that carries a readable reason, which the client shows.

### Memories

- `createMemory` registers a memory. With a `manifestUrl` (**Add to library**, the synthetic demo, published scenes) it starts `ready` with progress 1; with only a `sourceUrl` (an upload) it starts `uploaded`. URLs must be http(s), at most 2048 characters, and the duration must be above 0 and at most 3600 s. The unique `requestId` makes registration idempotent: repeating a request is a no-op, and reusing its id for anything else is rejected.
- `setMemoryStatus` may only be called by the memory's `pipelineIdentity`: the worker for an upload, the uploader for a test upload. Allowed transitions: `uploaded` → `processing` or `failed`; `processing` → `processing`, `ready` or `failed`; `failed` → `processing` (a retry); `ready` → `ready`. Progress is between 0 and 1 and can't go backwards while processing, and an error is at most 2000 characters. `ready` needs an http(s) `manifestUrl` and progress exactly 1, and installs the memory in every party waiting for it.
- `createParty` and `createRoom` need a `ready` memory.
- `createMemory` accepts any http(s) `sourceUrl`, so the worker checks a source before downloading it (`allowed_source` in `pipeline/memreplay/source_check.py`); see [Upload API](./upload-api.md).

### Time

- In a party only the leader may change time (`setPaused`, `seek`, `setPlaybackSpeed`, `setBranch`, `forkBranch`), hand over leadership (`transferLeadership`) or change the scene (`attachPartyMemory`). In a room without a party, anyone may change time.
- A room's `timeline` row holds the current take, whether it is paused, the speed, and an anchor: media time `anchorMediaUs` at server time `anchorServerTs`. Every change writes a new anchor, and media time never passes the memory's `durationUs`.
- Speed must be between 0.25 and 2, and a seek must stay within the memory.
- `setBranch` moves the room to a take, paused at the moment it was made (Original at 0).
- A new room starts playing Original from 0.

### Takes and grabbing

- Edits need a paused timeline: `grab` and `forkBranch` are rejected while it plays. The viewer pauses first when it may: the leader's grab pauses the party, while a member grabbing during playback is told "Ask the party leader to pause before grabbing".
- Grabbing on Original forks a take named "First edit" at the paused time. Grabbing a different object on a take edits that take in place. Grabbing an object that already rests on the current take forks a new take, "Edit <object id>" (cut to 100 characters), so a recorded take never changes.
- The grab forks and moves the room to the new take in the same transaction, so the paused clock arrives before the grant.
- Catching an object another player holds or is still simulating is rejected ("Object is owned by another player").
- Re-grabbing your own held or still-simulating object keeps the take open and drops your own saved frames from the new grab time on, so the next throw's chunks fit.
- Child takes copy nothing on the server; every client resolves what a take inherits from its parents with the same rule ([Viewer](./viewer.md#timeline-and-take-inheritance)). Take rows are never deleted.
- An object on a take is an `objectState` row keyed `"<branchId>:<objectId>"`. `heldBy` is the player holding it and `simOwner` the player whose device simulates it. Its mode is `held` (in a hand), `physics` (thrown: the thrower's device simulates it and streams `moveObject` at about 15 Hz until it rests) or `rest`. `release(rest: false)` turns a hold into a throw; `release(rest: true)` ends it. `fromMediaUs` is the grab's media time.

### Recorded throws

- The simulation owner saves a throw's flight with `saveBranchKeyframes`, before `release(rest: true)`; after that nobody can add to it.
- A chunk holds 1 to 120 keyframes `{t, p, q}` as JSON (at most 60,000 characters). `t` is in absolute media seconds and strictly increasing, `q` is a normalized quaternion, and every number is finite. Malformed input, such as `[null]`, fails with a clean error.
- `startMediaUs` must equal `round(frames[0].t × 1e6)` and be at or after the grab time, the last frame must lie within the memory, and chunks of one object on one take may not overlap. Saving the exact same chunk again is a no-op.

### Simulation lock and abandoned throws

- `seek`, `setBranch` and every fork, including one a grab makes, are rejected while any object on the current take is held or still simulated ("Wait for objects to settle or release them first"). Pausing and playing are not.
- A throw nobody has updated for 15 s is abandoned: the next seek, fork or take switch settles it at its last reported pose, and grabbing it forks a new take that keeps its saved chunks. Moves, chunk saves and the release all keep a live throw fresh. A held object never expires; the page turns a hold into a throw when its tab is hidden.

### Leaving, disconnecting and reconnecting

- Leaving (`leaveRoom`), switching rooms (`joinRoom`, `createParty`) or closing your last connection settles everything you hold or simulate at its last reported pose.
- If the room's current take was forked by your grab and nobody has saved a chunk on it, the room goes back to the parent take, paused at the moment the take was made, unless someone else still holds or simulates something there. Only takes a grab made ("First edit", "Edit <id>") are given up; a take made with `forkBranch` stays.
- `leaveRoom` sets the player's room to 0, so a later reconnect doesn't put them back. A dropped connection does: on reconnect the player is online again in the same room.
- The private `connection` table tracks each identity's live connections, so ownership is cleared only when the last one closes (for example the last tab of a signed-in account).

### Clock sampling

- `sampleClock(clientSentUs)` writes the caller's `clockSample` row with the server's timestamp. The client keeps the sample with the shortest round trip and sets its offset to `serverTs − (sent + received) / 2`.
- `net.time()`, the shared media time, is `anchorMediaUs + (now + offset − anchorServerTs) × speed` while playing, clamped to the memory's duration.
- Clients sample after connecting, every 30 s, and when the page becomes visible or comes back online. A sample unanswered after 8 s replaces the connection: a suspended phone can leave a socket that only looks open.

### Players

- `joinRoom` and `createParty` take a name (1 to 40 characters) and a device (`phone`, `quest` or `desktop`); a password account's registered name replaces the given one. A player's colour comes from their identity.
- Join codes are seven characters of upper-case base 36. Room creation discards its first random draw, which is biased.
- `setPose` updates the caller's head pose and hand positions.

## Tables

All tables are public, readable by any subscriber, except `connection`.

- `memory`: an uploaded clip or a finished scene: owner, assigned worker (`pipelineIdentity`), title, `sourceUrl`, `manifestUrl`, status, progress, error, `durationUs`, `requestId` and creation time.
- `room`: a shared session: its memory, join code and `host`, the leader of a party.
- `party`: marks a room as a leader-controlled party: `pendingMemoryId` (a scene waiting to become ready) and `sceneRevision` (bumped whenever the scene changes, which makes every page reload).
- `profile`: an identity's provider (`guest`, or `key` for a password account) and display name.
- `player`: one row per identity: room (0 for none), name, device, colour, online, head pose and hand positions.
- `connection` (private): the identity behind each live connection.
- `clockSample`: each identity's latest clock sample.
- `timeline`: one per room: the current take, paused, speed and the clock anchor.
- `branch`: a take: room, memory, parent (0 for Original), the media time it was made at, name and creator.
- `objectState`: one object on one take: holder, simulation owner, mode, grab time, last pose and velocity.
- `branchKeyframes`: one saved chunk of a recorded throw, keyed `"<branchId>:<objectId>:<startMediaUs>"`.

Wire and SQL names are snake_case (`object_state`, `create_party`) and TypeScript names camelCase (`conn.reducers.createParty({...})`). Module code must be deterministic: use `ctx.random` and `ctx.timestamp`, never `Math.random()` or `Date.now()`. After changing the schema or a reducer, run `npm run stdb:generate` (SpacetimeDB CLI 2.13.0) to regenerate `apps/web/src/module_bindings/`, which is never edited by hand, then run `npm run typecheck` yourself: the CLI's bundler can succeed without finding the workspace's TypeScript compiler.

## The client

### Connection

`Multiplayer` ([net/index.ts](../apps/web/src/net/index.ts)) is the page's one connection. It connects to `VITE_STDB_URL` (by default this origin's `/stdb/`, which the Vite dev server proxies to SpacetimeDB) and the database `VITE_STDB_DATABASE` (default `memory-replay`), and subscribes to every public table.

- **Reconnecting**: the SDK's automatic reconnect waits at most 5 s between attempts (`withAutomaticReconnect({ maxDelayMs: 5000 })`), and a failed first connection is retried after 1, 2, 4 and then every 5 s, so pages are back within about 5 s of a SpacetimeDB restart. A connection that hasn't finished subscribing after 20 s is replaced, and so is one whose clock sample goes unanswered for 8 s. Returning to the page or coming back online checks the connection again.
- **Calls**: user actions (**Create party**, **Join party**, sign-in) wait up to 15 s for a usable connection, then fail with "Still reconnecting. Check your internet connection, then try again."; the party buttons read "Connecting…" meanwhile. A call is retried only when the SDK guarantees it was never sent; a call whose result is unknown is never replayed, so a party is never created twice.
- **Errors**: `attempt(action, kind)` resolves to the failure's reason and `run(action, kind)` to a boolean. `failure` holds the newest failure with its kind, and a later success clears only a failure of its own kind; `kind: null` means the caller shows its own errors, as the adapter does.
- **One identity per tab**: a guest tab keeps its token in `sessionStorage` (`memreplay-token:<database>`), so a reload keeps the player and a new tab is a new player. A duplicated tab starts with a copy of that storage, so every page holds a Web Lock named after a hash of its token ([net/identity-lock.ts](../apps/web/src/net/identity-lock.ts)); a page that finds the lock taken drops the copy and connects as a new guest ("This identity is open in another tab — connecting as a new guest…"). A reload waits up to 1 s for the previous page to let go. Without Web Locks, as on plain-HTTP LAN addresses, the check is off.
- **Rejected tokens**: a saved guest token the server rejects is dropped, and the tab connects as a new guest. A signed-in account is never silently replaced: "Password rejected — sign out and use a valid saved password".
- Signed-in tabs connect with the account's token and so share one identity. The library page keeps one guest identity per browser, in `localStorage`. The player name is remembered per browser.
- `Multiplayer.connect()` needs a browser (`import.meta.env`, `location`); Node scripts attach a `DbConnection` by hand, as [tests/integration/adapter.ts](../tests/integration/adapter.ts) does.

### The network adapter

`NetAdapter` ([net/adapter.ts](../apps/web/src/net/adapter.ts)) implements the viewer's `InteractionAuthority` on top of `Multiplayer` and keeps the viewer in step with the room. The party panel installs it only while the page is in a room; outside a room the viewer works on its own. How each viewer action maps to the server:

- **Grab** (`acquire`): if the room is playing, the leader's adapter pauses it, and a member's grab is refused. If the room's paused time differs at all from the grab's (catching a throw preview in mid-flight), the leader's adapter seeks first, so the take's first keyframe lands exactly on the grab time. Then `grab`. The adapter waits for the server's rows and hands the viewer the take the server chose; the viewer never invents one. If the room switched takes meanwhile, the grab is refused.
- **Holding**: each pose goes out as `moveObject`, at most 15 times a second per object.
- **Throw**: `release(rest: false)`.
- **Recorded flight**: the frames from the grab's `fromMediaUs` on, downsampled to about 30 Hz (keeping the first and last), in disjoint chunks of at most 120 frames; each `saveBranchKeyframes` is awaited, then `release(rest: true)`.
- **Play, pause, seek, choosing a take**: for the leader, `setBranch`, `setPaused` and `seek` as needed, in that order (a take change first, a pause before a seek, a play after it); a scrub sends one seek per turn of the queue, always the latest. For a member, the viewer goes back to the room's clock. A take made only on this device ("That take exists only on this device") is never sent.
- **Timeline row changed**: `applyClock`, only when the row really changed. Rows wait while your own grab or clock change is in flight, so neither echoes back. A check once a second resynchronizes a playing clock that drifted more than 100 ms.
- **New take row**: `upsertBranch`, parents first.
- **Chunk inserted, updated or deleted**: the object's recording on that take is rebuilt from all its chunks with `Timeline.setRecording`, each chunk parsed once.
- **Someone else holds or simulates an object**: `applyRemotePose`, on the active take only. A throw you watched come to rest keeps its landing pose while the room stays paused.
- **Your ownership cleared** (you left, or the connection dropped): `revokeOwnership`; the viewer stops writing and says "You no longer hold the <object>: the room released it."
- **Leftovers**: rows of your own identity still held or simulated from an earlier page are released when the adapter starts.

Server take ids are u64, with 0 for Original; the viewer's are `"original"` and decimal strings. Microseconds and u64 ids are converted only at this boundary.

### Call queue and timeouts

- Every server call goes through one queue, so a throw's chunks and its `release(rest: true)` always land before the next seek or grab. A grab keeps the queue until the viewer takes the grant or gives it back (2 s at most), because a play, seek or take change queued meanwhile would be refused while the object is held.
- Two exceptions: giving back a grant the viewer couldn't use (or one that arrived after the 8 s grab timeout) jumps the queue, and moves are sent in order without waiting for each reply, to keep up 15 Hz.
- Other calls time out after 5 s ("the server did not answer in time"); a grab the server confirms after its timeout is released at once. The rows confirming a grab must arrive within 2 s.
- `dispose()` sends nothing. On a reload the disconnect clears your holds, and the server reverts a take you hadn't recorded anything on.

### Wiring

The party panel ([party/session.ts](../apps/web/src/party/session.ts)) creates one adapter per room, once the player is in the room and the connection is ready:

```ts
const adapter = new NetAdapter(net, viewer, report, resolved);
viewer.setAuthority(adapter);
adapter.start();
```

`report(message, { kind, error })` carries the kind of action (`clock`, `grab`, `throw`, `release`, `hold`, `take`, `data` or `internal`), and `resolved(kind)` runs when an action of that kind next succeeds, so a stale error clears. The adapter's messages appear only in the viewer's status line, never in the party panel. Every room change other than a fresh page's first join reloads the page, so an adapter is never removed from a live viewer; dispose it before the viewer.

## Run and test parties locally

The local setup needs the SpacetimeDB CLI 2.13.x; installation and the rest of the stack are in [Development](./development.md).

The default stack, with the module published as `memory-replay`:

```bash
npm run stdb:start           # terminal 1: SpacetimeDB on 127.0.0.1:3055 (STDB_PORT overrides)
npm run stdb:publish:local   # terminal 2: build and publish the module
npm run upload:local         # terminal 2: upload API on 127.0.0.1:8788, local-disk storage
LOCAL_HTTP=1 npm run dev     # terminal 3: the app on http://127.0.0.1:5173
```

Or the party launcher, which uses its own database, `memory-replay-party`:

```bash
npm run stdb:start
spacetime publish -s http://127.0.0.1:3055 --module-path server/spacetime --delete-data=never memory-replay-party
npm run party:dev
```

`party:dev` ([scripts/dev/party-dev.mjs](../scripts/dev/party-dev.mjs)) starts the upload API (local-disk storage under `data/uploads`) and the web app with matching database and origin settings, on plain HTTP at 127.0.0.1 (web 5173, upload 8788), and stops both if either exits. Vite runs with `--strictPort`, so stop any other web and upload pair first, or choose ports: `VITE_PORT=5180 UPLOAD_PORT=8790 npm run party:dev`. `STDB_DATABASE`, `STDB_PORT` and `PUBLIC_ORIGIN` override the defaults; publish and launch with the same database and port. `PARTY_HTTPS=1` serves Vite's self-signed HTTPS instead; set `PUBLIC_ORIGIN` to the HTTPS address the devices use, and make them trust the certificate.

`npm run party:lan` (or `PARTY_LAN=1`) does the same over plain HTTP on the local network. It prints this machine's private address; open that exact address on every device, and create the party from it too. With several network interfaces, set `PUBLIC_ORIGIN=http://<Wi-Fi address>:<port>`. Plain HTTP on the LAN is fine for guest parties and 3D viewing; passwords, camera capture and immersive VR need trusted HTTPS. Some guest Wi-Fi networks isolate devices from each other, where a phone hotspot helps. A scene registered with a 127.0.0.1 URL opens only on the machine that registered it.

Publishing uses your `spacetime login`. For a throwaway database without a login, publish with `--anonymous` under a fresh name: an anonymous publish can't be updated later, so publish the next version under a new name and point `VITE_STDB_DATABASE` and `STDB_DATABASE` at it. If a publish is refused with 403, use the identity that owns the database or a new name; never delete a database to get around it.

### A two-minute party test

1. Open the app and **Watch together**, leave every memory card unselected and press **Create party**. Expect a seven-character code, "You are the leader · control playback below." and an invite link.
2. Open the invite link in another tab or device, or type the code and press **Join party**, with a different name. Both players must appear in both lists.
3. As the leader, press **Back to the start**, scrub, and choose **0.5×** under **Playback speed**. The other tab shows the same time, take and speed, and its playback controls are disabled.
4. Play, then pause. Either player drags an object and lets go; the leader presses Play, and everyone sees the new take.
5. Open the invite in a third tab: it starts at the current shared time, not at 0.
6. Press **Make leader** next to another player: the controls move at once. Close the leader's tab: a connected member becomes leader.

### Test suites

- `npm test` includes `tests/adapter.test.ts`, which runs the adapter on [tests/room-harness.ts](../tests/room-harness.ts): an in-process room that runs the real module reducers through SpacetimeDB's test harness, with per-client latency, and is reusable for other client tests. It also runs the module's own suites in `server/spacetime/tests/`.
- `npm run test:integration` ([tests/integration/multiplayer.ts](../tests/integration/multiplayer.ts)): real WebSockets: presence, the shared clock, competing grabs, sync after a release, late-join trajectories, disconnect and reconnect, automatic transport recovery, and the upload handler's authenticated upload and status updates (in process, with fixture bytes).
- `npm run test:party` ([tests/integration/party.ts](../tests/integration/party.ts)): leader permissions (members' clock and scene calls rejected), presence, a late join, a pending video and the worker's ready handoff with a synthetic manifest, an explicit leader transfer and the election on disconnect.
- `npm run test:adapter` ([tests/integration/adapter.ts](../tests/integration/adapter.ts)): two viewers with adapters pause, grab, throw and re-grab into a new take, then a late third player rebuilds every take; all three end on identical tracks.

These three need a running SpacetimeDB with the current module published. They read `STDB_DATABASE` (default `memory-replay`) and `STDB_WS_URL` (default `ws://127.0.0.1:${STDB_PORT:-3055}`), for example `STDB_DATABASE=memory-replay-party npm run test:party`, and leave labelled test rows behind, so point them at a throwaway database.

`npm run test:connections -- --full` needs no running server: it starts an isolated in-memory SpacetimeDB on a free port, publishes the module, runs the connection checks and then the multiplayer and party suites against it, and cleans up (set `SPACETIME_BIN` if the CLI isn't on the `PATH`).

In dev builds, `window.__memreplay` exposes the viewer, the session and the adapter; `__memreplay.positionsAt(t)` and `__memreplay.takes()` compare object positions and takes across the tabs of a party.

## Privacy

Parties are public demo spaces: codes and invite links help people join and are not access control. Every client subscribes to all public tables, so anyone connected can read every memory row, including titles, owners, `sourceUrl`s and `manifestUrl`s, every profile and every player's position. There is no private library, room password, moderation or retention policy. Private memories would need scoped subscriptions or views, authorization for assets, quotas and a trusted worker registry.

## Known issues

- Another player pressing play while you throw finishes your throw's preview at once; the throw is still saved.
- Right after a throw, the other players' copy of the new take has no frames until the throw has come to rest and its chunks are saved, a round trip per chunk. They see the throw live meanwhile, and the room's seeks and take switches are refused until it settles.
- When a take is given up because its grabber left before saving anything, the room pauses at the moment the take was made, even if someone had pressed play meanwhile. The given-up take stays in everyone's take list, since take rows are never deleted, and selecting it shows the parent's history.
- A reload in the middle of a throw, after some of its chunks were saved, keeps that partial take.
- Edits a parent take gains after a child was made still reach the child if they start at or before the child's fork time: for example, seeking a take back to 0.5 s and throwing an object it never edited, after a child was made at 1 s. Chunks carry media times, not creation times; telling the two apart needs a creation order on `branchKeyframes`, which is a schema change.
- Late joiners see a just-finished throw at the paused time's pose, not its landing pose. The players who watched it hold the landing pose until someone plays or seeks.
- One player per tab relies on Web Locks, which plain-HTTP LAN addresses don't have: there, a duplicated tab shares its opener's identity.
- A memory row's `durationUs` must equal the manifest's `timeline.durationSec`, or the clip ends at different times on the server and in the viewer. The app registers both from the manifest; anything else that registers memories must do the same.
- Reconnection after a phone sleeps, and a party spread over a Quest 3S and phones on one venue network, have not been tested on physical devices.
