import json
import shutil

import cv2
import numpy as np
import pytest

from memreplay import background, layers
from memreplay.handoff import CameraFrame, Cameras, WorldInfo
from memreplay.l0 import write_splat_ply


@pytest.fixture
def scene(tmp_path, monkeypatch):
    for folder in ("world", "objects", "gsplat_static/ply", "input"):
        (tmp_path / folder).mkdir(parents=True)
    c2w = np.eye(4)
    c2w[1, 3] = 1
    cameras = Cameras(frames=[CameraFrame(
        idx=i, t=i / 30, w=100, h=100,
        K=[100, 0, 50, 0, 100, 50, 0, 0, 1], c2w=c2w.ravel().tolist(),
    ) for i in (0, 3, 6)])
    (tmp_path / "world/cameras.json").write_text(cameras.model_dump_json())
    info = WorldInfo(T_vipe_to_world=np.eye(4).ravel().tolist(), median_camera_height_m=1,
                     boundsMin=(-1, 0, 0), boundsMax=(1, 2, 3))
    (tmp_path / "world/world.json").write_text(info.model_dump_json())
    np.savez(tmp_path / "world/frames.npz", inds=[0, 3, 6], c2w=[c2w] * 3, good=[True] * 3)
    obj = dict(id="ball-0", label="ball", grabbable=True, mass=0.1,
               visibleFrom=0, visibleTo=1,
               visual=dict(kind="primitive", shape="sphere", size=[0.4] * 3, color="#ff0000"),
               collider=dict(kind="sphere", radius=0.2),
               track=[dict(t=0, p=[0, 1, 2], q=[0, 0, 0, 1]),
                      dict(t=1, p=[0, 1, 2], q=[0, 0, 0, 1])])
    (tmp_path / "objects/objects.json").write_text(json.dumps({"objects": [obj]}))
    (tmp_path / "objects/objects.base.json").write_text(json.dumps({"objects": [obj]}))
    selection = [dict(id="ball-0", keep=True, ids=[1], spec=dict(size_m=[0.4] * 3),
                      obs=[dict(idx=i, touches_border=False, area=400) for i in (0, 3, 6)])]
    (tmp_path / "objects/selection.json").write_text(json.dumps(selection))
    (tmp_path / "objects/report.json").write_text(json.dumps([
        dict(id="ball-0", kept=True, motion="stationary", static=True, mask_ids=[1])]))
    (tmp_path / "world/background_policy.json").write_text(json.dumps(
        dict(version=1, moving_ids=[])))
    rng = np.random.default_rng(0)
    xyz = rng.uniform(-0.03, 0.03, (100, 3)) + [0, 1, 2]
    xyz = np.vstack([xyz, [1, 1, 3]])
    write_splat_ply(tmp_path / "gsplat_static/ply/point_cloud_9.ply", xyz,
                    np.full(xyz.shape, 128, np.uint8))
    write_splat_ply(tmp_path / "world/bg_points.ply", xyz, np.full(xyz.shape, 128, np.uint8))
    mask = np.zeros((100, 100), np.uint8)
    mask[40:60, 40:60] = 1
    mask[5:20, 5:20] = 2

    class VipeFixture:
        phrases = {0: "background", 1: "ball", 2: "person"}
        sky_ids = []

        def __init__(self, _): pass
        def mask(self, _): return mask.copy()
        def ids_with(self, phrases):
            return [i for i, phrase in self.phrases.items() if phrase in phrases]

        from memreplay.vipe_io import Vipe
        static_mask = Vipe.static_mask

    class FramesFixture:
        def __init__(self, _): pass
        def get(self, _): return np.full((100, 100, 3), 128, np.uint8)

    monkeypatch.setattr(layers, "Vipe", VipeFixture)
    monkeypatch.setattr(background, "Vipe", VipeFixture)
    monkeypatch.setattr(background, "Frames", FramesFixture)
    # Test the actual PLY partition; only the external SPZ encoder is substituted.
    monkeypatch.setattr(layers, "to_spz", shutil.copyfile)
    return tmp_path, mask


def set_motion(work, motion):
    (work / "objects/report.json").write_text(json.dumps([
        dict(id="ball-0", kept=True, motion=motion, static=motion == "stationary", mask_ids=[1])]))
    (work / "world/background_policy.json").write_text(json.dumps(
        dict(version=1, moving_ids=[1] if motion == "moving" else [])))


def test_training_excludes_moving_props_and_people(scene):
    work, mask = scene
    set_motion(work, "moving")
    col = background.prepare(work, static=True)
    training_mask = cv2.imread(str(col / "masks/00000.png"), cv2.IMREAD_GRAYSCALE)
    assert not training_mask[mask == 1].any()
    assert not training_mask[mask == 2].any()
    assert training_mask[80, 80] == 255


def test_training_keeps_stationary_props(scene):
    work, _ = scene
    col = background.prepare(work, static=True)
    assert cv2.imread(str(col / "masks/00000.png"), cv2.IMREAD_GRAYSCALE)[50, 50] == 255


def test_failed_extraction_keeps_room_without_duplicate_object(scene, monkeypatch):
    work, _ = scene
    monkeypatch.setattr(layers, "MIN_GAUSSIANS", 200)
    layers.run(work)
    assert json.loads((work / "objects/objects.json").read_text())["objects"] == []
    assert len(layers.read_ply(work / "world/bg_room.spz")) == 101


def test_stationary_extraction_moves_visual_out_of_room(scene):
    work, _ = scene
    layers.run(work)
    obj, = json.loads((work / "objects/objects.json").read_text())["objects"]
    assert obj["visual"]["kind"] == "splat" and obj["grabbable"]
    assert len(layers.read_ply(work / "world/bg_room.spz")) == 1
    assert len(layers.read_ply(work / obj["visual"]["url"])) == 100


def test_moving_prop_keeps_primitive_without_carving_room(scene):
    work, _ = scene
    set_motion(work, "moving")
    layers.run(work)
    obj, = json.loads((work / "objects/objects.json").read_text())["objects"]
    assert obj["visual"]["kind"] == "primitive"
    assert len(layers.read_ply(work / "world/bg_room.spz")) == 101


def test_layers_reject_background_from_before_motion_masking(scene):
    work, _ = scene
    (work / "world/background_policy.json").unlink()
    with pytest.raises(ValueError, match="background"):
        layers.run(work)


def test_failed_extraction_can_be_retried_from_base_objects(scene, monkeypatch):
    work, _ = scene
    monkeypatch.setattr(layers, "MIN_GAUSSIANS", 200)
    layers.run(work)
    monkeypatch.setattr(layers, "MIN_GAUSSIANS", 50)
    layers.run(work)
    obj, = json.loads((work / "objects/objects.json").read_text())["objects"]
    assert obj["visual"]["kind"] == "splat"


def test_legacy_cache_reruns_objects_training_and_extraction(scene, monkeypatch):
    from argparse import Namespace
    from memreplay import cli

    work, _ = scene
    for marker in cli.DONE_MARKER.values():
        path = work / marker
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    calls = []
    monkeypatch.setattr(cli, "run_stage", lambda name, *_: calls.append(name))
    monkeypatch.setattr(cli, "merge", lambda *_a, **_kw: work / "memory.json")
    args = Namespace(skip=[], redo=[], force=False, memory_id=None, device="test")
    cli.run_all(work, "Test", args)
    assert calls == ["objects", "background", "layers"]


def test_changed_motion_requires_retraining(scene):
    work, _ = scene
    set_motion(work, "moving")
    (work / "world/background_policy.json").write_text(json.dumps(dict(version=1, moving_ids=[])))
    with pytest.raises(ValueError, match="background"):
        layers.run(work)


def test_box_proximity_alone_does_not_extract_a_prop(scene):
    work, mask = scene
    mask[mask == 1] = 0
    layers.run(work)
    assert json.loads((work / "objects/objects.json").read_text())["objects"] == []
    assert len(layers.read_ply(work / "world/bg_room.spz")) == 101


def test_missing_masks_cannot_bake_a_moving_prop_into_room(scene, monkeypatch):
    work, _ = scene
    set_motion(work, "moving")
    monkeypatch.setattr(background.Vipe, "mask", lambda *_: None)
    with pytest.raises(ValueError, match="Missing masks"):
        background.prepare(work, static=True)
