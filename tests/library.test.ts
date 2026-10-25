import { describe, expect, test } from "vitest";
import { memoryPresentation, viewerLink } from "../apps/web/src/library-state";
const origin = "https://memos.example";
const row = { status: "uploaded", progress: 0, manifestUrl: "", error: "" };
describe("memory library handoff", () => {
  test("a video or an in-progress scene cannot be opened as a finished reconstruction", () => {
    expect(viewerLink({ ...row, manifestUrl: "https://assets.example/memory.json" }, origin)).toBeUndefined();
    expect(memoryPresentation(row, false, origin).label).toBe("Waiting for processing");
    expect(memoryPresentation(row, true, origin).label).toBe("Test recording");
  });
  test("a worker-ready row opens the exact scene using an encoded viewer URL", () => {
    const manifestUrl = "https://assets.example/a/memory.json?version=1&token=example";
    const link = new URL(viewerLink({ ...row, status: "ready", manifestUrl }, origin)!);
    expect(link.origin).toBe(origin);
    expect(link.pathname).toBe("/");
    expect(link.searchParams.get("memory")).toBe(manifestUrl);
  });
  test.each(["", "javascript:alert(1)", "data:text/html,test", "https://user:password@example.test/file"])("rejects missing or unsafe scene URL %s", manifestUrl => {
    const memory = { ...row, status: "ready", manifestUrl };
    expect(viewerLink(memory, origin)).toBeUndefined();
    expect(memoryPresentation(memory, false, origin).tone).toBe("failed");
  });
  test("backend failure remains visible and progress is bounded", () => {
    expect(memoryPresentation({ ...row, status: "failed", error: "Tracking lost" }, false, origin).detail).toBe("Tracking lost");
    expect(memoryPresentation({ ...row, status: "processing", progress: 2 }, false, origin).progress).toBe(100);
    expect(memoryPresentation({ ...row, status: "processing", progress: NaN }, false, origin).progress).toBe(0);
  });
});
