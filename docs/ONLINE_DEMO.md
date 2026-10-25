# Online phone party demo

The hosted demo is at **https://jerry-memory-replay-phone.alightdell64.chatgpt.site/**. It serves the built viewer from Sites and connects directly to SpacetimeDB Maincloud. The Mac and phone both act as clients; neither a laptop server nor a tunnel is required.

## Server and room addresses

- **Fresh visit / solo:** open the server address with no room path: `https://jerry-memory-replay-phone.alightdell64.chatgpt.site/`. **Explore solo** closes the party panel; it does not create or join a shared room.
- **Shared party:** creating a party or entering its code changes the address to `/ROOMCODE`, for example `https://jerry-memory-replay-phone.alightdell64.chatgpt.site/031HHRP`. Copying the invite link uses this address.
- **Direct entry:** opening or refreshing `/ROOMCODE` rejoins that room and loads its current scene. The database owns the scene selection; a per-tab scene hint avoids putting asset URLs in the invite link.
- **Leave / home:** **Leave** or the **MEMORY REPLAY** home link returns to `/` and solo playback. A fresh visit to `/` never silently rejoins the previous party.
- Existing `/?room=ROOMCODE` links still join, then become `/ROOMCODE`. Codes are unchanged and still contain seven letters/numbers.

Production hosting must serve `index.html` for room paths, including refreshes. In the Sites hosting manifest, use `"static": {"directory": "dist", "not_found_handling": "single-page-application"}`. Vite's development server already supports this fallback. Static assets retain their root-relative `/assets/` URLs.

## Test on a Mac and iPhone

1. Open the hosted address on the Mac. Enter `Mac leader`, keep **Synthetic demo · ready to play** selected, and choose **Create party**.
2. Copy the **Your party code** value from the Mac. Open the hosted address in iPhone Safari, enter that code in the blank **Party code** field, and tap **Join party**. Lowercase codes and surrounding spaces are accepted. The panel closes after joining on a phone so the scene is visible. Opening the full invite link also joins directly.
3. Both participants should appear in the party list. Collapse **PARTY** if it covers the scene or timeline.
4. Play, pause, seek, and change playback speed on the Mac. The phone should follow; its playback controls should be disabled while the Mac is leader.
5. Keep the leader tab open. Closing or reloading it can transfer leadership to another connected member. The hosted app itself remains available when the Mac sleeps or shuts down.

Each device still needs working internet. A slow first download or a disconnected client is possible, but the phone no longer depends on the Mac's outbound tunnel. This is a public synthetic demo. Google sign-in is not configured, and the hosted copy hides capture/upload controls because no hosted upload service is connected. Existing local recordings were not copied to the cloud.

### Party-code checks

- The code field starts blank and appears at the top of the party panel, including a fresh phone visit. **Join party** or the keyboard's Enter/Go submits it. Guests do not need Google sign-in.
- The host sees a large **Your party code** with **Copy code**. Creating another party produces a different code; any existing party in this database can be joined through the same field.
- Try an empty/short code: the app should explain the 7-character format. Try a nonexistent 7-character code: it should show an error without removing you from your current party. Enter a valid code afterward: it should join and clear the error.
- While joined, open **PARTY** and enter another host's code to switch parties. The target party's scene and leader-controlled timeline load together.
- Codes belong to the configured SpacetimeDB database. Both devices should use the hosted address above. Codes from the older `localhost`/LAN demo use a separate database and cannot be joined from this hosted demo. A code is not a universal identifier for an unrelated website.

## Deployment details

- Application source: branch `stdb/jerry-p4` in `im-yifanluo/calhacks-13`.
- Database endpoint: `wss://maincloud.spacetimedb.com`.
- Database name: `jerry-memory-replay-phone-20261024`.
- Database dashboard: https://spacetimedb.com/jerry-memory-replay-phone-20261024
- Sites project: `appgprj_6add41439d048191bfcbe636389b9f24`.
- Hosting checkout: `data/hosted-phone-site/` (ignored in this repository; its static distribution is saved separately through Sites source control).

The database uses the existing module, schema, and leader permissions. To update it using its owning SpacetimeDB login, run from the repository root:

```bash
spacetime publish -s https://maincloud.spacetimedb.com \
  --module-path server/spacetime --delete-data=never \
  jerry-memory-replay-phone-20261024
```

Build the frontend with these public settings before packaging it for Sites:

```bash
VITE_STDB_URL=wss://maincloud.spacetimedb.com \
VITE_STDB_DATABASE=jerry-memory-replay-phone-20261024 \
npm run build -w apps/web -- --outDir ../../data/hosted-phone-site/dist
```

Preserve `.openai/hosting.json` in the hosting checkout. Its README describes the synthetic-demo presentation changes: omit `capture.html`, hide the upload controls, and explain that uploads are available in the local capture app. Do not copy `.env` files, tokens, database directories, or recordings into the static distribution. Use the Sites workflow to save and deploy the matching source/build; rebuilding alone does not update the live site.

## Verification

The clean-address update passed TypeScript checking, all 24 session/party unit tests, and a production build. Local browser checks covered root/solo, party creation, a scene change with no asset query in the address, direct entry from a fresh tab, refresh/rejoin, legacy invite conversion, and returning to `/` through both Leave and the home link.

The party-code update passed TypeScript checking, the 22 session/party unit tests, and a production build. Two local browser instances verified blank-code validation, joining with lowercase and padded input via Enter, preserving the current party after an unknown code, switching to a second party, clearing the field/error after success, and copying a host code. Guest playback controls remained disabled after switching.

The production frontend build and the live four-client party suite passed against Maincloud:

```bash
STDB_DATABASE=jerry-memory-replay-phone-20261024 \
STDB_WS_URL=wss://maincloud.spacetimedb.com npm run test:party
```

This checks presence, shared time/speed, late joins, rejection of guest playback changes, leader transfer, disconnect election, and synthetic worker-status handoff. Two browser clients also showed the same paused time of 2.4 seconds at 0.5×, with guest playback controls disabled.

On 24 October 2026, the user confirmed that physical iPhone Safari loaded the hosted scene and displayed **Connected** on the original network. Its `Guest (phone)` participant appeared in the party after the old Mac-hosted tunnel services were stopped. Real glasses recording, Google consent, GPU reconstruction, and physical phone interaction beyond loading/joining remain unverified.
