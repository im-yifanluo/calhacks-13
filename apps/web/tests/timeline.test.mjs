// Take inheritance: the canonical rule in Timeline.track() (see its doc comment).
import test from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../.test-dist/timeline.js";

const frame = (t, x, y = 1, z = 0) => ({ t, p: [x, y, z], q: [0, 0, 0, 1] });
const original = [frame(0, 0), frame(10, 0)];
const times = (track) => track.map((f) => f.t);

/** Branch rows as the network adapter imports them, parents first: [id, parentId, forkTime]. */
function tree(rows) {
  const timeline = new Timeline(10);
  for (const [id, parentId, forkTime] of rows) timeline.upsertBranch({ id, parentId, name: id, forkTime });
  return timeline;
}

test("a parent edited after the child exists: the edit never leaks into the child", () => {
  const timeline = tree([
    ["P", "original", 1],
    ["C", "P", 2],
  ]);
  timeline.setRecording("C", "ball", [frame(2, 9), frame(3, 9)]);
  timeline.select("C");
  assert.equal(timeline.track("cube", original, 5.5), original);
  // Later someone edits the cube on the parent, in place, at t = 5 (after the child's fork at 2).
  timeline.setRecording("P", "cube", [frame(5, 4), frame(6, 4)]);
  assert.equal(timeline.track("cube", original, 5.5), original, "the child keeps the take it was forked from");
  timeline.select("P");
  assert.deepEqual(times(timeline.track("cube", original, 5.5)), [5, 6], "the parent sees its own edit");
});

test("a parent throw straddling the fork, in flight at the fork time, keeps flying in the child past the fork", () => {
  const timeline = tree([
    ["P", "original", 1],
    ["C", "P", 2],
  ]);
  timeline.setRecording("P", "ball", [frame(1.5, 0), frame(2, 1), frame(3, 2), frame(4, 3)]);
  timeline.select("C");
  for (const t of [1.5, 1.75, 2, 3.5, 9])
    assert.deepEqual(times(timeline.track("ball", original, t)), [1.5, 2, 3, 4], `t=${t}`);
  assert.equal(timeline.track("ball", original, 1.2), original, "before the throw the original applies");
});

test("an object thrown at the same instant as the fork continues in the child", () => {
  // In one pause at t = 2: throw the can on P, then pick the ball up again, which forks C at 2 (the server's "Edit ball").
  const timeline = tree([
    ["P", "original", 1],
    ["C", "P", 2],
  ]);
  timeline.setRecording("P", "can", [frame(2, 0), frame(3, 1)]);
  timeline.select("C");
  assert.deepEqual(times(timeline.track("can", original, 2)), [2, 3]);
  assert.deepEqual(times(timeline.track("can", original, 2.5)), [2, 3]);
  // Server fork times are whole microseconds, so the recording may start a fraction of a microsecond later.
  timeline.setRecording("P", "can", [frame(2.0000004, 0), frame(3, 1)]);
  assert.deepEqual(times(timeline.track("can", original, 2.5)), [2.0000004, 3], "the same instant within rounding");
  timeline.setRecording("P", "can", [frame(2.01, 0), frame(3, 1)]);
  assert.equal(timeline.track("can", original, 2.5), original, "10 ms after the fork is the parent's own future");
});

test("a take's own edit before its fork time replays from its first frame", () => {
  // Seek back on a take and grab: the server edits the take in place, before the take's forkTime.
  const timeline = tree([["B", "original", 3]]);
  timeline.setRecording("B", "can", [frame(1, 5), frame(2, 6)]);
  timeline.select("B");
  assert.equal(timeline.track("can", original, 0.5), original);
  assert.deepEqual(times(timeline.track("can", original, 1.5)), [1, 2]);
  assert.deepEqual(times(timeline.track("can", original, 4)), [1, 2], "and holds its last pose after it");
  // A child forked at 3 inherits it: its first frame 1 is before the child's fork time.
  timeline.upsertBranch({ id: "C", parentId: "B", name: "C", forkTime: 3 });
  timeline.select("C");
  assert.deepEqual(times(timeline.track("can", original, 5)), [1, 2]);
});

test("grandparent chain: the limit is the smallest fork time on the path", () => {
  const timeline = tree([
    ["G", "original", 1],
    ["P", "G", 3],
    ["C", "P", 5],
  ]);
  timeline.setRecording("G", "ball", [frame(4, 1), frame(4.5, 2)]); // made after P was forked at 3
  timeline.setRecording("G", "cube", [frame(2, 1), frame(2.5, 2)]); // before P's fork: P's history, so C's too
  timeline.select("C");
  assert.equal(timeline.track("ball", original, 4.5), original, "4 > min(5, 3): it does not leak through P");
  assert.deepEqual(times(timeline.track("cube", original, 4.5)), [2, 2.5]);
  timeline.select("P");
  assert.equal(timeline.track("ball", original, 4.5), original);
  assert.deepEqual(times(timeline.track("cube", original, 4.5)), [2, 2.5]);
  timeline.select("G");
  assert.deepEqual(times(timeline.track("ball", original, 4.5)), [4, 4.5]);
});

test("grandparent chain: a skipped ancestor still lowers the limit, and the nearest applicable recording wins", () => {
  const timeline = tree([
    ["G", "original", 1],
    ["P", "G", 2],
    ["C", "P", 6],
  ]);
  timeline.setRecording("G", "ball", [frame(1.5, 1), frame(2, 1)]);
  timeline.setRecording("P", "ball", [frame(7, 3), frame(8, 3)]); // after C's fork at 6: skipped in C
  timeline.setRecording("G", "cube", [frame(2.5, 1), frame(3, 1)]); // after P's fork at 2, though before C's at 6
  timeline.select("C");
  assert.deepEqual(times(timeline.track("ball", original, 7.5)), [1.5, 2], "falls through to G: 1.5 ≤ min(6, 2)");
  assert.equal(timeline.track("cube", original, 7.5), original, "2.5 > min(6, 2): G's later edit is not P's history");
  timeline.select("P");
  assert.deepEqual(times(timeline.track("ball", original, 7.5)), [7, 8]);
  assert.deepEqual(times(timeline.track("ball", original, 1.8)), [1.5, 2], "before P's own edit, P shows G's");
});

test("before an inherited recording's first frame, older ancestors are tried", () => {
  const timeline = tree([
    ["G", "original", 1],
    ["P", "G", 3],
    ["C", "P", 4],
  ]);
  timeline.setRecording("G", "ball", [frame(1, 1), frame(1.5, 1)]);
  timeline.setRecording("P", "ball", [frame(2.5, 2), frame(3.5, 2)]); // P's own edit before its fork time
  timeline.select("C");
  assert.deepEqual(times(timeline.track("ball", original, 2)), [1, 1.5], "P's edit has not started: G's applies");
  assert.deepEqual(times(timeline.track("ball", original, 3)), [2.5, 3.5]);
  assert.equal(timeline.track("ball", original, 0.5), original);
});

// From jerry-p4's tests/client.test.ts ("child branch ignores parent edits from after the fork"): branches 1 (fork 0 on
// Original) and 2 (fork 2 s on 1). jerry's branchFrames froze inherited objects at the fork time; the canonical rule
// plays an inherited recording in full, so the frames are compared instead.
test("ported from jerry: a child ignores parent edits that start after its fork", () => {
  const timeline = tree([
    ["1", "original", 0],
    ["2", "1", 2],
  ]);
  timeline.select("2");
  timeline.setRecording("1", "ball", [{ t: 3, p: [3, 0, 0], q: [0, 0, 0, 1] }]);
  assert.equal(timeline.track("ball", original, 4), original);
  timeline.setRecording("1", "ball", [
    { t: 1, p: [1, 0, 0], q: [0, 0, 0, 1] },
    { t: 3, p: [3, 0, 0], q: [0, 0, 0, 1] },
  ]);
  assert.deepEqual(times(timeline.track("ball", original, 4)), [1, 3]);
});

test("corrupt branch rows with a parent loop cannot hang track()", () => {
  const timeline = tree([
    ["A", "original", 1],
    ["B", "A", 2],
  ]);
  timeline.branches.find((b) => b.id === "A").parentId = "B"; // upsertBranch refuses cycles; corrupt the rows directly
  timeline.select("B");
  assert.equal(timeline.track("ball", original, 3), original);
});
