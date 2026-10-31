import type * as THREE from "three";

/** Small pieces of the 2D overlay (phone and desktop): time labels, the status toast, auto-hide, popovers, Enter VR. */

/** Where a time sits along the scrubber, in percent, clamped to the clip. */
export function percentAt(time: number, duration: number): number {
  return duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;
}

/** The status line at the top: each new message shows, then fades after `ms` unless it is held (while holding a throw). */
export class Toast {
  private timer = 0;
  private last = "";
  private held = false;

  constructor(
    private box: HTMLElement,
    private line: HTMLElement,
    private ms = 4000,
  ) {
    new MutationObserver(() => this.changed()).observe(line, { childList: true, characterData: true, subtree: true });
    this.changed();
  }

  private changed(): void {
    const text = this.line.textContent ?? "";
    if (text === this.last) return;
    this.last = text;
    this.box.hidden = text === "";
    this.show();
  }

  private show(): void {
    this.box.classList.remove("quiet");
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      if (!this.held) this.box.classList.add("quiet");
    }, this.ms);
  }

  /** Keep the message up (true), or let it fade again a few seconds from now (false). */
  hold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    if (on) this.box.classList.remove("quiet");
    else this.show();
  }
}

/**
 * Fades the overlay after 3 s without input while allowed (playing, nothing open); any input brings it back. It waits
 * for a first input, so someone who has not touched anything yet always sees the controls.
 */
export class AutoHide {
  private last = 0;

  constructor(
    private body: HTMLElement,
    private ms = 3000,
  ) {
    for (const type of ["pointerdown", "pointermove", "keydown", "wheel"])
      addEventListener(type, () => this.wake(), { capture: true, passive: true });
  }

  wake(): void {
    this.last = performance.now();
    this.body.classList.remove("idle");
  }

  update(allowed: boolean): void {
    this.body.classList.toggle("idle", allowed && this.last > 0 && performance.now() - this.last > this.ms);
  }
}

/** A popover sheet opened by `button`; an outside press or Escape closes it. */
export function popover(button: HTMLButtonElement, sheet: HTMLElement) {
  const set = (open: boolean) => {
    sheet.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", () => set(sheet.hidden));
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Node;
      if (!sheet.hidden && !sheet.contains(target) && !button.contains(target)) set(false);
    },
    { capture: true },
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sheet.hidden) {
      set(false);
      button.focus();
    }
  });
  return {
    close: () => set(false),
    get open() {
      return !sheet.hidden;
    },
  };
}

// A page reloaded inside VR (the dev server reloads on every save) may be granted a session without a click, where the
// browser supports WebXR navigation. The event comes early, so listen as soon as this module loads.
let sessionGranted = false;
navigator.xr?.addEventListener?.("sessiongranted", () => {
  sessionGranted = true;
});

/** "Enter VR", shown only where immersive VR works, with the session features three's VRButton asks for. */
export function mountVRButton(renderer: THREE.WebGLRenderer, button: HTMLButtonElement): void {
  const xr = navigator.xr;
  if (!xr) return;
  const init: XRSessionInit = { optionalFeatures: ["local-floor", "bounded-floor", "layers", "hand-tracking"] };
  const label = button.querySelector("span");
  let current: XRSession | null = null;
  const ended = () => {
    current?.removeEventListener("end", ended);
    current = null;
    if (label) label.textContent = "Enter VR";
  };
  const started = async (session: XRSession) => {
    session.addEventListener("end", ended);
    await renderer.xr.setSession(session);
    current = session;
    if (label) label.textContent = "Exit VR";
  };
  button.onclick = () => {
    if (current) {
      void current.end();
      return;
    }
    xr.requestSession("immersive-vr", init)
      .then(started)
      .catch((error) => console.warn("Could not enter VR:", error));
  };
  xr.isSessionSupported("immersive-vr")
    .then((supported) => {
      button.hidden = !supported;
      if (!supported) return;
      if (sessionGranted) button.click();
      // Browsers with their own "enter VR" control (offerSession) show it too.
      const offer = (xr as XRSystem & { offerSession?: (mode: string, init: XRSessionInit) => Promise<XRSession> })
        .offerSession;
      offer
        ?.call(xr, "immersive-vr", init)
        .then(started)
        .catch(() => {});
    })
    .catch(() => {
      button.hidden = true;
    });
}

/** Drag a sheet down by its head to close it (phones). */
export function dragToClose(sheet: HTMLElement, handle: HTMLElement, close: () => void): void {
  let start: { id: number; y: number } | null = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || (event.target as Element).closest("button")) return;
    start = { id: event.pointerId, y: event.clientY };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (start?.id !== event.pointerId) return;
    const dy = Math.max(0, event.clientY - start.y);
    sheet.style.transform = dy ? `translateY(${dy}px)` : "";
  });
  const end = (event: PointerEvent) => {
    if (start?.id !== event.pointerId) return;
    const dy = event.clientY - start.y;
    start = null;
    sheet.style.transform = "";
    if (dy > 80) close();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
