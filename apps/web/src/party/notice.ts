/** How long an informational message stays up (ms). */
export const NOTICE_MS = 6000;

export interface NoticeOptions {
  /** What the message is about. A later success of the same kind (resolve) clears an error. */
  kind?: string;
  /** Errors stay until a newer message replaces them or their kind succeeds; other messages expire. */
  error?: boolean;
  /** Information that stays until replaced: a page about to reload, a link to copy by hand. */
  persist?: boolean;
}

/**
 * One message slot. A newer message replaces the older one; information expires after NOTICE_MS; an
 * error stays until a newer message replaces it or an action of its kind succeeds. When a message
 * goes, the slot shows `idle()` instead, unless someone else has written over it (`showing` is false).
 */
export class Notice {
  private current?: { text: string; kind?: string; error: boolean };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly display: (text: string, error: boolean) => void,
    private readonly showing: (text: string) => boolean = () => true,
    private readonly idle: () => string = () => "",
  ) {}

  get text(): string {
    return this.current?.text ?? "";
  }
  get error(): boolean {
    return this.current?.error ?? false;
  }

  show(text: string, options: NoticeOptions = {}): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const notice = { text, kind: options.kind, error: !!options.error };
    this.current = notice;
    this.display(text, notice.error);
    if (!notice.error && !options.persist)
      this.timer = setTimeout(() => {
        if (this.current === notice) this.clear();
      }, NOTICE_MS);
  }

  /** An action of this kind succeeded: an error about it is stale. */
  resolve(kind: string): void {
    if (this.current?.error && this.current.kind === kind) this.clear();
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const shown = this.current;
    this.current = undefined;
    if (shown && this.showing(shown.text)) this.display(this.idle(), false);
  }

  /** Stops the expiry timer without touching the display. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
