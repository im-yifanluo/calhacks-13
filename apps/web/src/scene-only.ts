/** Hide overlays while leaving a faint restore button, without changing camera, playback, or party state. */
export function mountSceneOnly(stage: HTMLElement, button: HTMLButtonElement, onShow: () => void) {
  let hidden = false;
  const previousInert = new Map<HTMLElement, boolean>();
  const listeners = new AbortController();
  // Observe before object grabbing can stop a pointer event at the canvas.
  const options = { signal: listeners.signal, capture: true };
  type Tap = { id: number; x: number; y: number; time: number };
  let down: Tap | undefined, last: Tap | undefined;
  const pointers = new Set<number>();
  const hideTitle = button.title;
  // The label sits in a span next to the icons; without one (older markup), the whole button text.
  const setLabel = (text: string) => { const label = button.querySelector(".label"); if (label) label.textContent = text; else button.textContent = text; };

  // Keep the toggle and its ancestors interactive; hide every other overlay from keyboard navigation.
  const makeInert = (element: HTMLElement) => {
    if (element === stage || element === button) return;
    if (element.contains(button)) {
      for (const child of Array.from(element.children)) if (child instanceof HTMLElement) makeInert(child);
    } else {
      previousInert.set(element, element.inert); element.inert = true;
    }
  };

  const show = () => {
    if (!hidden) return;
    hidden = false; down = last = undefined; pointers.clear();
    document.body.classList.remove("scene-only");
    setLabel("Hide UI"); button.title = hideTitle;
    for (const [element, inert] of previousInert) element.inert = inert;
    previousInert.clear();
    stage.removeAttribute("tabindex");
    onShow(); button.focus({ preventScroll: true });
  };
  const hide = () => {
    if (hidden || button.disabled) return;
    document.getElementById("room-close")?.click();
    const more = document.getElementById("more-sheet");
    if (more) more.hidden = true;
    document.getElementById("more-toggle")?.setAttribute("aria-expanded", "false");
    hidden = true; down = last = undefined; pointers.clear();
    for (const element of Array.from(document.body.children)) {
      if (element instanceof HTMLElement) makeInert(element);
    }
    setLabel("Show UI"); button.title = "Show controls";
    document.body.classList.add("scene-only");
    stage.tabIndex = 0; stage.focus({ preventScroll: true });
  };
  button.addEventListener("click", () => { if (hidden) show(); else hide(); }, options);
  document.addEventListener("keydown", event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if ((event.target as Element)?.closest("input, textarea, select, [contenteditable=true]")) return;
    if (event.key.toLowerCase() === "h" || (hidden && event.key === "Escape")) {
      event.preventDefault(); if (hidden) show(); else hide();
    }
  }, options);
  // Two short taps restore controls on phones too. Drags and pinches never count as taps.
  stage.addEventListener("pointerdown", event => {
    if (!hidden || event.button !== 0) return;
    pointers.add(event.pointerId);
    if (pointers.size !== 1) { down = last = undefined; return; }
    down = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
  }, options);
  stage.addEventListener("pointermove", event => {
    if (down?.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) down = last = undefined;
  }, options);
  stage.addEventListener("pointerup", event => {
    pointers.delete(event.pointerId);
    if (down?.id !== event.pointerId) return;
    const tap = down; down = undefined;
    const now = performance.now();
    if (now - tap.time > 250 || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 6) { last = undefined; return; }
    if (last && now - last.time < 400 && Math.hypot(tap.x - last.x, tap.y - last.y) < 30) show();
    else last = { ...tap, time: now };
  }, options);
  stage.addEventListener("pointercancel", event => { pointers.delete(event.pointerId); down = last = undefined; }, options);
  return { show, dispose() { show(); listeners.abort(); } };
}
