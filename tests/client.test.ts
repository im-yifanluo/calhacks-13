import { expect, test } from "vitest";
import { Vector3 } from "three";
import { flickVelocity } from "../apps/web/src/input-touch";
import { branchFrames } from "../apps/web/src/net/replay";
test("phone flick velocity is capped and handles a stationary touch", () => {
  expect(flickVelocity([{ t: 0, p: new Vector3() }]).length()).toBe(0);
  expect(
    flickVelocity([
      { t: 0, p: new Vector3() },
      { t: 10, p: new Vector3(10, 0, 0) },
    ]).length(),
  ).toBeCloseTo(8);
});
test("child branch ignores parent edits from after the fork", () => {
  const branches: any = [
    { id: 1n, parentId: 0n, forkMediaUs: 0n },
    { id: 2n, parentId: 1n, forkMediaUs: 2_000_000n },
  ];
  const chunks: any = [
    {
      branchId: 1n,
      objectId: "ball",
      keyframesJson: JSON.stringify([{ t: 3, p: [3, 0, 0], q: [0, 0, 0, 1] }]),
    },
  ];
  expect(branchFrames(2n, "ball", 4, branches, chunks)).toBeUndefined();
  chunks[0].keyframesJson = JSON.stringify([
    { t: 1, p: [1, 0, 0], q: [0, 0, 0, 1] },
    { t: 3, p: [3, 0, 0], q: [0, 0, 0, 1] },
  ]);
  const inherited = branchFrames(2n, "ball", 4, branches, chunks)!;
  expect(inherited.time).toBe(2);
  expect(inherited.frames.map((f) => f.t)).toEqual([1, 3]);
});
