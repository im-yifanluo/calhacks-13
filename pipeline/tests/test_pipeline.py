"""S3-S7 on a synthetic ViPE output with known ground truth (memreplay.synthetic). No GPU, no network."""
from __future__ import annotations

import json
import struct

import numpy as np
import pytest

from memreplay import l0, objects, synthetic, world
from memreplay.cli import merge
from memreplay.handoff import Cameras, read_points_sequence
from memreplay.normalize import hlg_to_sdr


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    w = tmp_path_factory.mktemp("synthetic")
    synthetic.make(w)
    world.run(w)
    objects.observe(w)
    objects.select(w, use_claude=False)
    l0.run(w)
    objects.run(w)
    merge(w, "Synthetic", "synthetic", "synthetic")
    return w


def test_world_frame_recovers_floor_and_heading(work):
    info = json.loads((work / "world/world.json").read_text())
    assert info["diagnostics"]["floor_found"]
    assert abs(info["median_camera_height_m"] - synthetic.CAM_H) < 0.05
    assert info["scale"] == 1.0                                # metric input: no rescale
    cams = Cameras.model_validate_json((work / "world/cameras.json").read_text()).frames
    for c in cams[::10]:                                       # recovered cameras == ground truth cameras
        true = synthetic.camera(c.t)
        got = np.array(c.c2w).reshape(4, 4)
        assert np.linalg.norm(got[:3, 3] - true[:3, 3]) < 0.05
        assert np.degrees(np.arccos(np.clip((np.trace(got[:3, :3].T @ true[:3, :3]) - 1) / 2, -1, 1))) < 2.0


def test_room_points_and_collider(work):
    xyz, _ = l0.read_splat_ply_xyz_rgb(work / "world/bg_points.ply")
    floor = xyz[np.abs(xyz[:, 1]) < 0.05]
    assert len(floor) > 1000 and np.sqrt(np.mean(floor[:, 1] ** 2)) < 0.02
    lo, hi = synthetic.TABLE
    top = xyz[(xyz[:, 0] > lo[0] + 0.1) & (xyz[:, 0] < hi[0] - 0.1) & (xyz[:, 2] > lo[2] + 0.1) & (xyz[:, 2] < hi[2] - 0.1)]
    assert abs(np.median(top[:, 1]) - hi[1]) < 0.04           # table top found at 0.75 m
    sup = objects.Support(work)
    assert abs(sup(0.6, -1.7) - hi[1]) < 0.08                 # collider: table under the ball
    assert sup(-1.5, -1.0) < 0.05                             # collider: open floor


def test_person_ghost(work):
    frag = json.loads((work / "world/ghosts.json").read_text())["objects"]
    assert len(frag) == 1 and frag[0]["label"] == "person" and not frag[0]["grabbable"]
    hz, frames = read_points_sequence(work / frag[0]["visual"]["url"])
    k = next(i for i, (p, _) in enumerate(frames) if len(p) > 100)
    lo, hi = synthetic.person_box(k / hz)
    p = frames[k][0].astype(float)
    inside = np.all((p > lo - 0.1) & (p < hi + 0.1), axis=1)
    assert inside.mean() > 0.9


def test_ball_track_follows_the_throw(work):
    objs = json.loads((work / "objects/objects.json").read_text())["objects"]
    balls = [o for o in objs if o["label"] == "ball"]
    assert len(balls) == 1
    b = balls[0]
    assert b["grabbable"] and b["visual"]["kind"] == "primitive" and b["visual"]["shape"] == "sphere"
    errs = [np.linalg.norm(np.array(k["p"]) - synthetic.ball_pos(k["t"])) for k in b["track"]]
    assert np.median(errs) < 0.06, np.median(errs)
    # at rest on the table before the throw: zero velocity
    before = [k for k in b["track"] if k["t"] < synthetic.THROW_T - 0.4]
    assert before and all(np.linalg.norm(k["v"]) < 0.05 for k in before)
    # in flight: the velocity points the way it was thrown
    flying = [k for k in b["track"] if synthetic.THROW_T + 0.1 < k["t"] < synthetic.THROW_T + 0.3]
    if flying:
        v = np.mean([k["v"] for k in flying], 0)
        assert v[0] < -0.5


def test_memory_json_is_complete(work):
    m = json.loads((work / "memory.json").read_text())
    assert m["background"]["url"] == "world/bg_points.ply" and m["background"]["colliderUrl"] == "world/room_collider.glb"
    assert {o["label"] for o in m["objects"]} == {"person", "ball"}
    assert len(m["camera"]["track"]) == synthetic.FPS * 6 // 3
    assert (work / "world/room_collider.glb").read_bytes()[:4] == b"glTF"


def test_hlg_lut_is_monotonic_and_white_is_white():
    g = np.linspace(0, 1, 50)
    grey = hlg_to_sdr(np.stack([g, g, g], 1))
    assert np.all(np.diff(grey[:, 0]) >= -1e-9)
    assert np.allclose(grey[:, 0], grey[:, 1], atol=1e-3) and np.allclose(grey[:, 1], grey[:, 2], atol=1e-3)
    assert 0.85 < hlg_to_sdr(np.array([[0.75, 0.75, 0.75]]))[0, 0] < 0.97   # HLG reference white -> near SDR white


def test_points_sequence_roundtrip(tmp_path):
    from memreplay.handoff import write_points_sequence

    frames = [(np.random.rand(n, 3).astype(np.float32), np.random.randint(0, 255, (n, 3), np.uint8)) for n in (5, 0, 7)]
    write_points_sequence(tmp_path / "g.bin", frames, 10.0)
    raw = (tmp_path / "g.bin").read_bytes()
    assert raw[:4] == b"MRPS" and struct.unpack_from("<I", raw, 8)[0] == 3
    hz, back = read_points_sequence(tmp_path / "g.bin")
    assert hz == 10.0 and [len(p) for p, _ in back] == [5, 0, 7]
