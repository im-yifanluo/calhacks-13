"""Run gsplat's examples/simple_trainer.py with per-image masks.

gsplat's training loop already drops masked pixels from the loss (data["mask"]), but its COLMAP loader only
knows per-camera masks. We add <data_dir>/masks/<image stem>.png (white = static) per image, then hand over to
simple_trainer.py unchanged. Usage: python -m memreplay.train_splat mcmc --data_dir ... (simple_trainer flags).
"""
from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path


def main() -> None:
    examples = Path(os.environ.get("SRC", "/workspace/src")) / "gsplat" / "examples"
    sys.path.insert(0, str(examples))
    import imageio.v2 as imageio
    import numpy as np
    import torch
    import datasets.colmap as colmap  # gsplat's examples package

    original = colmap.Dataset.__getitem__

    def getitem(self, item):
        data = original(self, item)
        path = Path(self.parser.image_paths[self.indices[item]])
        mpath = path.parent.parent / "masks" / f"{path.stem}.png"
        if mpath.exists() and self.patch_size is None:
            m = imageio.imread(mpath)
            m = (m[..., 0] if m.ndim == 3 else m) > 127
            old = data.get("mask")
            data["mask"] = torch.from_numpy(m if old is None else (m & old.numpy())).bool()
        return data

    colmap.Dataset.__getitem__ = getitem
    np.random.seed(0)
    sys.argv = [str(examples / "simple_trainer.py")] + sys.argv[1:]
    os.chdir(examples)
    runpy.run_path(str(examples / "simple_trainer.py"), run_name="__main__")


if __name__ == "__main__":
    main()
