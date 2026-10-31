type Prepared = {
  putUrl: string;
  receipt: string;
  requestId: string;
  receiptExpiresAt: number;
  headers: Record<string, string>;
  pipeline?: boolean;
};
export type VerifiedRecording = {
  id: string;
  requestId: string;
  sourceUrl: string;
  sha256: string;
  size: number;
};

/** Retain one attempt so a failed confirmation retries the same database write. */
export class RecordedUpload {
  private prepared?: Prepared;
  private uploaded = false;
  constructor(
    readonly file: File,
    private readonly durationSec: number,
    private readonly title: string,
    private readonly identity: string,
    private readonly token: string,
    private readonly base = "",
    /** false for a test clip: its row is assigned to the uploader, never to the pipeline worker. */
    private readonly pipeline = true,
  ) {}

  private async api(path: string, body?: unknown) {
    const response = await fetch(`${this.base}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify({ identity: this.identity, ...(body as object) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => {
      throw new Error("Upload service unavailable. Start npm run upload:local.");
    });
    if (!response.ok) throw new Error(data.error || `Upload service returned ${response.status}`);
    return data;
  }

  async run(progress: (message: string) => void): Promise<VerifiedRecording> {
    if (!this.prepared || this.prepared.receiptExpiresAt <= Date.now()) {
      progress("Preparing automatic upload…");
      const prepared: Prepared = await this.api("uploads/presign", {
        name: this.file.name,
        size: this.file.size,
        type: this.file.type,
        title: this.title,
        durationSec: this.durationSec,
        pipeline: this.pipeline,
      });
      // An upload service without the flag would queue this test clip for the worker.
      if (!this.pipeline && prepared.pipeline !== false)
        throw new Error("The upload service does not support test uploads. Restart it from this build.");
      this.prepared = prepared;
      this.uploaded = false;
    }
    const prepared = this.prepared!;
    if (!this.uploaded) {
      progress(`Uploading ${this.file.size.toLocaleString()} bytes…`);
      try {
        const response = await fetch(prepared.putUrl, {
          method: "PUT",
          headers: prepared.headers,
          body: this.file,
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`Video storage returned ${response.status}`);
        this.uploaded = true;
      } catch (error) {
        this.prepared = undefined; // Obtain a new signed PUT after transfer failure.
        throw error;
      }
    }
    progress("Video uploaded. Confirming its database record…");
    const completed = await this.api("uploads/complete", {
      receipt: prepared.receipt,
    });
    const { memories } = await this.api(`memories?identity=${this.identity}`);
    const row = memories.find((m: { requestId: string }) => m.requestId === prepared.requestId);
    if (!row?.id || row.id !== completed.memory?.id)
      throw new Error("Database lookup did not confirm this recording. Retry verification.");
    if (!this.pipeline && row.pipelineIdentity?.toLowerCase() !== this.identity.toLowerCase())
      throw new Error(
        `Database row #${row.id} is assigned to the pipeline worker, so this test clip may be processed.`,
      );
    progress(`Database row #${row.id} found. Downloading the stored video to compare bytes…`);
    const response = await fetch(row.sourceUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Stored video returned ${response.status}`);
    const downloaded = await response.arrayBuffer();
    const digest = async (bytes: ArrayBuffer) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
    const originalHash = await digest(await this.file.arrayBuffer());
    if (downloaded.byteLength !== this.file.size || (await digest(downloaded)) !== originalHash)
      throw new Error("Stored video does not match the recording. Verification failed.");
    return {
      id: row.id,
      requestId: row.requestId,
      sourceUrl: row.sourceUrl,
      sha256: originalHash,
      size: this.file.size,
    };
  }
}
