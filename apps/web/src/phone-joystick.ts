import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Walking speed at full stick deflection, in meters per second. */
export const WALK_SPEED = 1.5;
const UP = new THREE.Vector3(0, 1, 0);

/** Phones and tablets (the pad is shown only there, via body.touch). */
export const isTouchDevice = () => matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

/**
 * The phone WALK pad (from jerry's input-touch.ts). Dragging inside the pad moves the orbit camera
 * and its target together across the floor, in the direction the camera faces. It listens only to
 * its own element: grabbing and throwing on the canvas stay with input-desktop.ts, which already
 * handles touch.
 */
export class PhoneJoystick {
  /** Stick deflection: x right, y down (screen axes), length at most 1. */
  readonly stick = new THREE.Vector2();
  private pointerId: number | undefined;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private delta = new THREE.Vector3();
  private knob: HTMLElement | null;

  constructor(
    private element: HTMLElement,
    private camera: THREE.Camera,
    private controls: OrbitControls,
  ) {
    this.knob = element.querySelector(".knob");
    element.addEventListener("pointerdown", this.down);
    element.addEventListener("pointermove", this.move);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      element.addEventListener(name, this.up as EventListener);
    window.addEventListener("blur", this.reset);
  }

  private point(event: PointerEvent) {
    const r = this.element.getBoundingClientRect();
    this.stick
      .set(
        (event.clientX - r.left - r.width / 2) / (r.width / 2),
        (event.clientY - r.top - r.height / 2) / (r.height / 2),
      )
      .clampLength(0, 1);
    this.drawKnob();
  }
  private down = (event: PointerEvent) => {
    if (this.pointerId !== undefined) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.element.setPointerCapture?.(event.pointerId);
    this.point(event);
  };
  private move = (event: PointerEvent) => {
    if (event.pointerId === this.pointerId) this.point(event);
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId === this.pointerId) this.reset();
  };
  private reset = () => {
    this.pointerId = undefined;
    this.stick.set(0, 0);
    this.drawKnob();
  };
  private drawKnob() {
    if (!this.knob) return;
    const r = this.element.clientWidth / 2;
    this.knob.style.transform = `translate(${this.stick.x * r * 0.6}px, ${this.stick.y * r * 0.6}px)`;
  }

  /** Call once per frame outside XR, before controls.update(). */
  update(dt: number): void {
    if (this.stick.lengthSq() === 0 || !(dt > 0)) return;
    this.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-8) return; // looking straight down: no floor direction
    this.forward.normalize();
    this.right.crossVectors(this.forward, UP);
    this.delta
      .copy(this.forward)
      .multiplyScalar(-this.stick.y * dt * WALK_SPEED)
      .addScaledVector(this.right, this.stick.x * dt * WALK_SPEED);
    this.camera.position.add(this.delta);
    this.controls.target.add(this.delta);
  }

  dispose(): void {
    this.element.removeEventListener("pointerdown", this.down);
    this.element.removeEventListener("pointermove", this.move);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      this.element.removeEventListener(name, this.up as EventListener);
    window.removeEventListener("blur", this.reset);
    this.reset();
  }
}
