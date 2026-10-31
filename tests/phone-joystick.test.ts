import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { PhoneJoystick, WALK_SPEED } from "../apps/web/src/phone-joystick";

describe("phone WALK pad", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("walks the camera and orbit target together along the view, then stops on release", () => {
    vi.stubGlobal("window", {
      addEventListener() {},
      removeEventListener() {},
    });
    const handlers = new Map<string, (event: unknown) => void>();
    const element = {
      clientWidth: 88,
      querySelector: () => null,
      addEventListener: (name: string, fn: (event: unknown) => void) => handlers.set(name, fn),
      removeEventListener: (name: string) => handlers.delete(name),
      setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 88, height: 88 }),
    } as unknown as HTMLElement;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 2, 5);
    camera.lookAt(0, 2, 0); // facing -Z
    const controls = { target: new THREE.Vector3(0, 1, 0) };
    const pad = new PhoneJoystick(element, camera, controls as never);
    const event = (x: number, y: number, pointerId = 7) => ({
      pointerId,
      clientX: x,
      clientY: y,
      preventDefault() {},
    });
    handlers.get("pointerdown")!(event(44, 0)); // stick pushed fully up = forward
    expect(pad.stick.y).toBeCloseTo(-1);
    pad.update(0.5);
    expect(camera.position.z).toBeCloseTo(5 - 0.5 * WALK_SPEED);
    expect(camera.position.y).toBeCloseTo(2); // stays on its height
    expect(controls.target.z).toBeCloseTo(-0.5 * WALK_SPEED);
    handlers.get("pointermove")!(event(88, 44, 8)); // another finger: ignored
    expect(pad.stick.y).toBeCloseTo(-1);
    handlers.get("pointermove")!(event(200, 44)); // far right: clamped to length 1
    expect(pad.stick.length()).toBeCloseTo(1);
    pad.update(1);
    expect(camera.position.x).toBeCloseTo(WALK_SPEED); // right of a -Z view is +X
    handlers.get("pointerup")!(event(0, 0));
    const before = camera.position.clone();
    pad.update(1);
    expect(camera.position.equals(before)).toBe(true);
    pad.dispose();
    expect(handlers.size).toBe(0);
  });
});
