// The clip's audio (source.audioUrl) following the timeline: AudioSync against a fake media element.
import test from "node:test";
import assert from "node:assert/strict";
import { AudioSync } from "../.test-dist/audio.js";

/** A media element whose clock only moves when the test advances it. */
class FakeMedia {
  currentTime = 0; playbackRate = 1; paused = true; duration = 20; plays = 0; seeks = 0;
  allow = true; failWith = null;
  play() {
    this.plays++;
    if (this.failWith) return Promise.reject(Object.assign(new Error("failed"), { name: this.failWith }));
    if (!this.allow) return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  advance(seconds) { if (!this.paused) this.currentTime += seconds * this.playbackRate; }
}
function rig(media = new FakeMedia()) {
  let now = 0; const changes = [];
  const sync = new AudioSync(new Proxy(media, {
    set(target, key, value) { if (key === "currentTime") target.seeks++; target[key] = value; return true; },
  }), blocked => changes.push(blocked), () => now);
  return { media, sync, changes, tick: ms => { now += ms; } };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test("audio follows the timeline: plays with it, pauses with it, and follows seeks while paused", async () => {
  const { media, sync } = rig();
  sync.update(0, true); await flush();
  assert.equal(media.paused, false); assert.equal(media.plays, 1);
  sync.update(2, false); assert.equal(media.paused, true); assert.equal(media.currentTime, 2, "seeked to the paused time");
  sync.update(2.05, false); assert.equal(media.currentTime, 2, "within 100 ms: left alone");
  sync.update(4, false); assert.equal(media.currentTime, 4, "scrubbing while paused moves the audio");
  sync.update(4, true); await flush(); assert.equal(media.paused, false); assert.equal(media.plays, 2);
});

test("audio resyncs past 100 ms of drift, after a settle window, and at once for a real jump", async () => {
  const { media, sync, tick } = rig();
  sync.update(0, true); await flush();
  tick(1000); media.advance(1); sync.update(1.05, true); assert.equal(media.seeks, 0, "50 ms drift is fine");
  media.advance(0.1); sync.update(1.3, true); assert.equal(media.currentTime, 1.3, "200 ms drift resyncs");
  const seeks = media.seeks;
  tick(100); sync.update(1.5, true); assert.equal(media.seeks, seeks, "a fresh seek settles before it is chased again");
  tick(300); sync.update(1.6, true); assert.equal(media.currentTime, 1.6, "then it is");
  tick(10); sync.update(5, true); assert.equal(media.currentTime, 5, "a jump of more than a second resyncs at once");
});

test("speed maps to playbackRate, clamped to what browsers accept", () => {
  const { media, sync } = rig();
  sync.update(0, false, 0.5); assert.equal(media.playbackRate, 0.5);
  sync.update(0, false, 100); assert.equal(media.playbackRate, 16);
});

test("autoplay refusal waits for a gesture; unlock() inside the gesture starts the audio at the timeline time", async () => {
  const { media, sync, changes } = rig(); media.allow = false;
  sync.update(3, true); await flush();
  assert.equal(sync.blocked, true); assert.deepEqual(changes, [true]);
  const plays = media.plays;
  sync.update(3.5, true); sync.update(4, true); await flush();
  assert.equal(media.plays, plays, "no retry storm while blocked");
  media.allow = true; sync.unlock(); await flush();
  assert.equal(media.paused, false); assert.equal(media.currentTime, 4); assert.equal(sync.blocked, false);
  assert.equal(sync.isUnlocked, true); assert.deepEqual(changes, [true, false]);
  sync.unlock(); assert.equal(media.plays, plays + 1, "unlock is a no-op once unlocked");
});

test("a gesture while the timeline is paused unlocks the element without playing it", async () => {
  const { media, sync } = rig(); media.allow = false;
  sync.update(1, true); await flush(); sync.update(1, false);
  media.allow = true;
  // Browsers reject the unlocking play() with AbortError when the pause() right after it interrupts it.
  media.play = function () { this.plays++; this.paused = false; return Promise.reject(Object.assign(new Error("interrupted"), { name: "AbortError" })); };
  sync.unlock(); await flush();
  assert.equal(media.paused, true); assert.equal(sync.isUnlocked, true); assert.equal(sync.blocked, false);
});

test("audio stops at its own end and does not restart there, and a broken source stops retrying", async () => {
  const { media, sync } = rig(); media.duration = 2;
  sync.update(1.95, true); await flush(); assert.equal(media.plays, 0, "too close to the end to start");
  sync.update(2.5, true); assert.equal(media.paused, true);
  const broken = rig(); broken.media.failWith = "NotSupportedError";
  broken.sync.update(0, true); await flush(); broken.sync.update(0.1, true); await flush();
  assert.equal(broken.media.plays, 1); assert.equal(broken.sync.failed, true);
});
