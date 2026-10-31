export interface MemoryState {
  status: string;
  progress: number;
  manifestUrl: string;
  error: string;
}

export function httpURL(value: string, base: string): URL | undefined {
  if (!value.trim()) return;
  try {
    const url = new URL(value, base);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url;
  } catch {
    /* Untrusted or incomplete backend URL. */
  }
}

/**
 * A ready memory's preview: a snapshot of its Gaussian-splat scene, preview.jpg next to its memory.json
 * (pipeline/tools/preview.js renders it). Memories without one keep their plain card art.
 */
export function previewUrl(memory: MemoryState, origin: string): string | undefined {
  if (memory.status !== "ready") return;
  const manifest = httpURL(memory.manifestUrl, origin);
  const url = manifest ? new URL("preview.jpg", manifest).href : undefined;
  return url && !missingPreviews.has(url) ? url : undefined;
}

/** Previews that failed to load: re-rendered cards do not ask for them again. */
const missingPreviews = new Set<string>();
export function previewMissing(url: string): void {
  missingPreviews.add(url);
}

export function viewerLink(memory: MemoryState, origin: string): string | undefined {
  if (memory.status !== "ready") return;
  const manifest = httpURL(memory.manifestUrl, origin);
  if (!manifest) return;
  const url = new URL("/", origin);
  url.searchParams.set("memory", manifest.href);
  return url.href;
}

export function memoryPresentation(memory: MemoryState, isTest: boolean, origin: string) {
  const progress = Number.isFinite(memory.progress) ? Math.max(0, Math.min(100, Math.round(memory.progress * 100))) : 0;
  if (memory.status === "ready") {
    return viewerLink(memory, origin)
      ? {
          label: "Ready to explore",
          detail: "Your scene is ready. Open it here or on Quest.",
          progress: 100,
          tone: "ready",
        }
      : {
          label: "Scene unavailable",
          detail: "The backend marked this ready but has not supplied a usable scene URL.",
          progress,
          tone: "failed",
        };
  }
  if (memory.status === "failed")
    return {
      label: "Processing failed",
      detail: memory.error || "Processing stopped. The pipeline team can retry this recording.",
      progress,
      tone: "failed",
    };
  if (isTest)
    return {
      label: "Test recording",
      detail: "Saved for testing; reconstruction was not requested.",
      progress: 0,
      tone: "test",
    };
  if (memory.status === "processing")
    return {
      label: "Building your scene",
      detail: "The backend is reconstructing this recording. Progress updates here automatically.",
      progress,
      tone: "processing",
    };
  if (memory.status === "uploaded")
    return {
      label: "Waiting for processing",
      detail: "Video received. Waiting for the reconstruction worker to pick it up.",
      progress: 0,
      tone: "uploaded",
    };
  return {
    label: "Status unavailable",
    detail: "Waiting for a recognized processing status from the backend.",
    progress,
    tone: "unknown",
  };
}
