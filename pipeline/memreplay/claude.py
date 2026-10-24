"""The two Claude calls in the pipeline. Both have a no-network fallback so the pipeline never blocks on them.

  propose_nouns(sheet.jpg)        S1: which small movable things to ask ViPE to segment (single words)
  describe(crop.jpg, label, ...)  S5: simple physics shape, size, density, colour for one object
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from .handoff import ObjectSpec

MODEL = "claude-opus-5-5"
ALWAYS = ["person", "hand"]          # ViPE replaces its default list with ours, so keep these
NOT_PROPS = {"person", "people", "man", "woman", "hand", "hands", "arm", "face", "wall", "floor", "ceiling", "window",
             "door", "table", "desk", "couch", "sofa", "bed", "chair", "tv", "television", "screen", "monitor", "lamp",
             "carpet", "rug", "curtain", "cabinet", "shelf", "counter", "sky", "background", "room", "building"}


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _image_block(path: Path) -> dict:
    data = base64.standard_b64encode(Path(path).read_bytes()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}


def _ask_json(content: list[dict], schema: dict, max_tokens: int = 4000) -> dict:
    import anthropic

    resp = anthropic.Anthropic().messages.create(
        model=MODEL, max_tokens=max_tokens,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": content}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined the request")
    return json.loads(next(b.text for b in resp.content if b.type == "text"))


def propose_nouns(sheet: Path, max_props: int = 6) -> list[str]:
    """Single-word prompts for the props in the clip, plus person and hand."""
    schema = {"type": "object", "additionalProperties": False, "required": ["props"],
              "properties": {"props": {"type": "array", "items": {"type": "string"}}}}
    prompt = (
        "These frames come from one first-person video, left to right in time. List the small, movable, everyday "
        "objects in them that a person could pick up, hold or throw (for example ball, bottle, cup, can, pillow, "
        "book, box, phone, shoe). Use one lowercase English word per object, the plain everyday name a detector "
        f"would recognise. At most {max_props}, most prominent first. Leave out furniture, fixtures, appliances, "
        "screens, lamps, walls, floors, windows, doors, people and body parts. Return an empty list if there are none."
    )
    out = _ask_json([_image_block(sheet), {"type": "text", "text": prompt}], schema)
    props = []
    for w in out.get("props", []):
        w = w.strip().lower().split()[-1] if w.strip() else ""
        if w.isalpha() and w not in NOT_PROPS and w not in props:
            props.append(w)
    return ALWAYS + props[:max_props]


SPEC_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["label", "shape", "size_m", "density_kg_m3", "color", "grabbable"],
    "properties": {"label": {"type": "string"},
                   "shape": {"type": "string", "enum": ["sphere", "box", "cylinder"]},
                   "size_m": {"type": "array", "items": {"type": "number"}},
                   "density_kg_m3": {"type": "number"},
                   "color": {"type": "string"},
                   "grabbable": {"type": "boolean"}},
}


def describe(crop: Path, label: str, observed_size_m: tuple[float, float, float]) -> ObjectSpec:
    ox, oy, oz = observed_size_m
    prompt = (
        f"This crop shows a '{label}' from a first-person video. Our depth measurement says its visible extent is "
        f"roughly {ox:.2f} x {oy:.2f} x {oz:.2f} m (x, y up, z), which can be off by 30% or more. Choose the simple "
        "shape that best approximates it for a physics engine (sphere, box, or cylinder with a vertical axis), its "
        "full size in meters as [x, y, z] with y up (for a sphere all three equal the diameter; for a cylinder x = z "
        "= diameter), a realistic average density in kg/m3 for the whole object (hollow things like balls, boxes or "
        "empty bottles are light), its main colour as #rrggbb, and whether one person could pick it up with one or "
        "two hands. Also give a short, specific lowercase label (one or two words)."
    )
    out = _ask_json([_image_block(crop), {"type": "text", "text": prompt}], SPEC_SCHEMA)
    size = out["size_m"] + [out["size_m"][-1]] * (3 - len(out["size_m"]))
    out["size_m"] = tuple(abs(float(s)) for s in size[:3])
    return ObjectSpec.model_validate(out)


# --- offline fallback ---------------------------------------------------------------------------------
_TYPICAL = {   # label -> (shape, density kg/m3)
    "ball": ("sphere", 120), "balloon": ("sphere", 2), "orange": ("sphere", 900), "apple": ("sphere", 800),
    "bottle": ("cylinder", 300), "can": ("cylinder", 400), "cup": ("cylinder", 250), "mug": ("cylinder", 500),
    "glass": ("cylinder", 400), "candle": ("cylinder", 900), "box": ("box", 150), "book": ("box", 700),
    "pillow": ("box", 60), "cushion": ("box", 60), "phone": ("box", 1200), "remote": ("box", 600),
    "shoe": ("box", 300), "bag": ("box", 150), "paper": ("box", 700), "towel": ("box", 200), "toy": ("box", 300),
}


def fallback_spec(label: str, observed_size_m: tuple[float, float, float], color: str) -> ObjectSpec:
    shape, density = _TYPICAL.get(label, ("box", 400))
    x, y, z = (max(0.03, s) for s in observed_size_m)
    if shape == "sphere":
        x = y = z = max(x, y, z)
    elif shape == "cylinder":
        x = z = max(x, z)
    return ObjectSpec(label=label, shape=shape, size_m=(x, y, z), density_kg_m3=density, color=color,
                      grabbable=max(x, y, z) < 1.0)
