import { schema, table, t, type ReducerCtx } from "spacetimedb/server";

// Tables of the memos SpacetimeDB module. Wire and SQL names are snake_case (create_room, object_state); TypeScript
// names are camelCase. Changing a column needs `npm run stdb:generate` for the client bindings.

/** An object pose: position, rotation quaternion and linear velocity (reducer arguments and object rows). */
export const pose = {
  px: t.f32(),
  py: t.f32(),
  pz: t.f32(),
  qx: t.f32(),
  qy: t.f32(),
  qz: t.f32(),
  qw: t.f32(),
  vx: t.f32(),
  vy: t.f32(),
  vz: t.f32(),
};
/** A player's head pose and hand positions, for avatars. */
export const head = {
  hx: t.f32(),
  hy: t.f32(),
  hz: t.f32(),
  hqx: t.f32(),
  hqy: t.f32(),
  hqz: t.f32(),
  hqw: t.f32(),
  lx: t.f32(),
  ly: t.f32(),
  lz: t.f32(),
  rx: t.f32(),
  ry: t.f32(),
  rz: t.f32(),
};
const db = schema({
  memory: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      requestId: t.string().unique(),
      owner: t.identity(),
      pipelineIdentity: t.identity(),
      title: t.string(),
      sourceUrl: t.string(),
      manifestUrl: t.string(),
      status: t.string(),
      progress: t.f32(),
      error: t.string(),
      durationUs: t.u64(),
      createdAt: t.timestamp(),
    },
  ),
  room: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      memoryId: t.u64(),
      joinCode: t.string().unique(),
      host: t.identity(),
    },
  ),
  // Additive policy: existing collaborative rooms keep their behavior; new parties have a leader.
  party: table(
    { public: true },
    {
      roomId: t.u64().primaryKey(),
      pendingMemoryId: t.u64(),
      sceneRevision: t.u32(),
    },
  ),
  profile: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      provider: t.string(),
      displayName: t.string(),
    },
  ),
  player: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      roomId: t.u64().index("btree"),
      name: t.string(),
      device: t.string(),
      color: t.u32(),
      online: t.bool(),
      ...head,
    },
  ),
  connection: table(
    {},
    {
      id: t.connectionId().primaryKey(),
      identity: t.identity().index("btree"),
    },
  ),
  clockSample: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      clientSentUs: t.u64(),
      serverTs: t.timestamp(),
    },
  ),
  timeline: table(
    { public: true },
    {
      roomId: t.u64().primaryKey(),
      branchId: t.u64(),
      paused: t.bool(),
      speed: t.f32(),
      anchorMediaUs: t.u64(),
      anchorServerTs: t.timestamp(),
    },
  ),
  branch: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      roomId: t.u64().index("btree"),
      memoryId: t.u64(),
      parentId: t.u64(),
      forkMediaUs: t.u64(),
      name: t.string(),
      creator: t.identity(),
    },
  ),
  objectState: table(
    { public: true },
    {
      key: t.string().primaryKey(),
      branchId: t.u64().index("btree"),
      objectId: t.string(),
      heldBy: t.identity().optional(),
      simOwner: t.identity().optional(),
      mode: t.string(),
      fromMediaUs: t.u64(),
      updatedAt: t.timestamp(),
      ...pose,
    },
  ),
  branchKeyframes: table(
    { public: true },
    {
      key: t.string().primaryKey(),
      branchId: t.u64().index("btree"),
      objectId: t.string(),
      startMediaUs: t.u64(),
      endMediaUs: t.u64(),
      keyframesJson: t.string(),
      author: t.identity(),
    },
  ),
});
export default db;

export type Ctx = ReducerCtx<typeof db.schemaType>;
export type Timeline = ReturnType<Ctx["db"]["timeline"]["roomId"]["find"]> & {};
export type ObjectRow = ReturnType<Ctx["db"]["objectState"]["key"]["find"]> & {};
