const errorName = (error: unknown) => (error as { name?: unknown } | null)?.name;

/** The parts of HTMLMediaElement that AudioSync uses, so tests can pass a fake. */
export interface MediaLike {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly duration: number;
  play(): Promise<void> | void;
  pause(): void;
}

/**
 * Keeps the memory's audio (`source.audioUrl`) on the timeline. The timeline is the clock: it already follows play,
 * pause, seek, take changes and the room's shared clock, so the audio only has to follow the timeline. Call update()
 * every frame with the timeline's state. The audio is re-seeked when it drifts more than 100 ms. Browsers refuse
 * play() before a user gesture; a refused play() waits for unlock(), which must run inside a gesture handler (iOS
 * lets only a gesture start an element).
 */
export class AudioSync {
  static readonly maxDrift = 0.1;
  /** After a seek or play() the element needs a moment before currentTime advances; it is not chased meanwhile. */
  static readonly settleMs = 300;
  /** play() was refused (autoplay policy) and the audio waits for a user gesture. */
  blocked = false;
  /** The source failed (for example a missing or unsupported file); the audio stays silent. */
  failed = false;
  private unlocked = false;
  private starting = false;
  private settleUntil = -Infinity;
  private time = 0;
  private playing = false;

  constructor(
    readonly media: MediaLike,
    private readonly onBlockedChange: (blocked: boolean) => void = () => {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  update(time: number, playing: boolean, speed = 1): void {
    const media = this.media;
    this.time = time;
    this.playing = playing;
    if (this.failed) return;
    const end = Number.isFinite(media.duration) ? media.duration : Infinity;
    const rate = Math.max(0.0625, Math.min(16, speed));
    if (media.playbackRate !== rate) media.playbackRate = rate;
    const drift = Math.abs(media.currentTime - time);
    if (!playing || time >= end) {
      if (!media.paused) media.pause();
      if (drift > AudioSync.maxDrift && time <= end) this.seek(time);
      return;
    }
    if (media.paused) {
      // Not within its last 100 ms either: play() on an ended element restarts it from 0.
      if (this.blocked || this.starting || time >= end - AudioSync.maxDrift) return;
      if (drift > AudioSync.maxDrift) this.seek(time);
      this.start();
      return;
    }
    // Playing: resync past 100 ms, but let a fresh seek or start settle first, unless the gap is a real jump.
    if (drift > 1 || (drift > AudioSync.maxDrift && this.now() >= this.settleUntil)) this.seek(time);
  }

  /** Call from a user-gesture handler. Starts the audio, or, while the timeline is paused, just unlocks the element. */
  unlock(): void {
    if (this.unlocked || this.failed) return;
    const media = this.media;
    if (Math.abs(media.currentTime - this.time) > AudioSync.maxDrift) this.seek(this.time);
    const request = media.play();
    if (!this.playing)
      media.pause(); // play() then pause() inside the gesture unlocks the element for later
    else this.settleUntil = this.now() + AudioSync.settleMs;
    void Promise.resolve(request).then(
      () => this.settle(true),
      (error: unknown) => {
        // AbortError: our own pause() interrupted the unlocking play(), so the gesture was accepted.
        if (errorName(error) === "AbortError") this.settle(true);
        else if (errorName(error) === "NotAllowedError") this.settle(false);
        else this.failed = true;
      },
    );
  }

  private seek(time: number): void {
    this.media.currentTime = time;
    this.settleUntil = this.now() + AudioSync.settleMs;
  }

  private start(): void {
    this.starting = true;
    this.settleUntil = this.now() + AudioSync.settleMs;
    void Promise.resolve(this.media.play()).then(
      () => {
        this.starting = false;
        this.settle(true);
      },
      (error: unknown) => {
        this.starting = false;
        // AbortError: a pause() from a later update interrupted this start, which is fine.
        if (errorName(error) === "NotAllowedError") this.settle(false);
        else if (errorName(error) !== "AbortError") this.failed = true;
      },
    );
  }

  private settle(allowed: boolean): void {
    if (allowed) this.unlocked = true;
    const blocked = !this.unlocked;
    if (blocked !== this.blocked) {
      this.blocked = blocked;
      this.onBlockedChange(blocked);
    }
  }
}

const GESTURES = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

/**
 * The memory's audio in the page: a hidden <audio> element on `url` (already resolved against the manifest), a
 * "Sound" toggle in `toolbar`, and the first-gesture unlock. Call update() every frame with the timeline's state.
 */
export function mountAudio(url: string, toolbar: Element | null, warn: (message: string) => void) {
  const media = document.createElement("audio");
  media.preload = "auto";
  media.src = url;
  document.body.append(media);
  const toggle = document.createElement("label"),
    box = document.createElement("input"),
    text = document.createElement("span");
  toggle.className = "toggle";
  box.type = "checkbox";
  box.checked = true;
  text.textContent = "Sound";
  toggle.append(box, " ", text);
  toolbar?.append(toggle);
  box.onchange = () => {
    media.muted = !box.checked;
  };
  const sync = new AudioSync(media, (blocked) => {
    text.textContent = blocked ? "Sound (tap to start)" : "Sound";
  });
  const gesture = () => {
    if (!sync.isUnlocked && !sync.failed) sync.unlock();
    if (sync.isUnlocked || sync.failed)
      for (const type of GESTURES) removeEventListener(type, gesture, { capture: true });
  };
  for (const type of GESTURES) addEventListener(type, gesture, { capture: true });
  media.addEventListener(
    "error",
    () => {
      sync.failed = true;
      toggle.remove();
      warn(
        `The memory's audio could not be played (${media.error?.message || `error ${media.error?.code}`}): ${media.src}`,
      );
    },
    { once: true },
  );
  // A hidden tab stops the animation loop, and with it the timeline, but not an <audio> element. update() restarts it.
  const hidden = () => {
    if (document.hidden) media.pause();
  };
  document.addEventListener("visibilitychange", hidden);
  return {
    sync,
    media,
    update: (time: number, playing: boolean, speed: number) => sync.update(time, playing, speed),
    dispose: () => {
      media.pause();
      media.removeAttribute("src");
      media.load();
      media.remove();
      toggle.remove();
      document.removeEventListener("visibilitychange", hidden);
      for (const type of GESTURES) removeEventListener(type, gesture, { capture: true });
    },
  };
}
