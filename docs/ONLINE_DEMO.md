# Online phone party demo

The hosted demo is at **https://jerry-memory-replay-phone.alightdell64.chatgpt.site/**. It serves the built viewer from Sites and connects directly to SpacetimeDB Maincloud. The Mac and phone both act as clients; neither a laptop server nor a tunnel is required.

## Test on a Mac and iPhone

1. Open the hosted address on the Mac. Enter `Mac leader`, keep **Synthetic demo · ready to play** selected, and choose **Create party**.
2. Open that party's invite link in iPhone Safari. Join the existing party; do not create another party on the phone.
3. Both participants should appear in the party list. Collapse **PARTY** if it covers the scene or timeline.
4. Play, pause, seek, and change playback speed on the Mac. The phone should follow; its playback controls should be disabled while the Mac is leader.
5. Keep the leader tab open. Closing or reloading it can transfer leadership to another connected member. The hosted app itself remains available when the Mac sleeps or shuts down.

Each device still needs working internet. A slow first download or a disconnected client is possible, but the phone no longer depends on the Mac's outbound tunnel. This is a public synthetic demo. Google sign-in is not configured, and the hosted copy hides capture/upload controls because no hosted upload service is connected. Existing local recordings were not copied to the cloud.

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

The production frontend build and the live four-client party suite passed against Maincloud:

```bash
STDB_DATABASE=jerry-memory-replay-phone-20261024 \
STDB_WS_URL=wss://maincloud.spacetimedb.com npm run test:party
```

This checks presence, shared time/speed, late joins, rejection of guest playback changes, leader transfer, disconnect election, and synthetic worker-status handoff. Two browser clients also showed the same paused time of 2.4 seconds at 0.5×, with guest playback controls disabled.

On 24 October 2026, the user confirmed that physical iPhone Safari loaded the hosted scene and displayed **Connected** on the original network. Its `Guest (phone)` participant appeared in the party after the old Mac-hosted tunnel services were stopped. Real glasses recording, Google consent, GPU reconstruction, and physical phone interaction beyond loading/joining remain unverified.
