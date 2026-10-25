"""Patches to a copy of hustvl/4DGaussians (commit 843d5ac) for our setup. Run once on the copy:
  python patch_4dgaussians.py /workspace/4dgs/A/4DGaussians
- mmcv 1.x does not build on torch 2.9: use mmengine's Config (same fromfile API)
- scene/__init__.py: HexPlane bounds from <data>/aabb.json (robust box of the near points; convert.py writes it),
  optional FOURD_EXTENT env override of the camera extent (sets position/deformation lr scale)
- depth-diff-gaussian-rasterization needs #include <cstdint> (gcc 14), simple-knn needs #include <cfloat>"""
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
for f in ["train.py", "render.py", "export_perframe_3DGS.py"]:
    p = root / f
    s = p.read_text()
    s = re.sub(r"^(\s*)import mmcv\s*$", r"\1import mmengine as mmcv", s, flags=re.M)
    p.write_text(s)
p = root / "scene" / "__init__.py"
s = p.read_text()
old = "        self.gaussians._deformation.deformation_net.set_aabb(xyz_max,xyz_min)"
new = """        _ab = os.path.join(args.source_path, "aabb.json")   # [fourd] robust HexPlane box written by convert.py
        if os.path.exists(_ab):
            import numpy as _np
            _j = json.load(open(_ab)); xyz_max, xyz_min = _np.array(_j["max"]), _np.array(_j["min"])
        if os.environ.get("FOURD_EXTENT"):
            print("cameras_extent", self.cameras_extent, "-> FOURD_EXTENT", os.environ["FOURD_EXTENT"])
            self.cameras_extent = float(os.environ["FOURD_EXTENT"])
        self.gaussians._deformation.deformation_net.set_aabb(xyz_max,xyz_min)"""
if "[fourd]" not in s:
    assert old in s
    p.write_text(s.replace(old, new))
r = root / "submodules/depth-diff-gaussian-rasterization/cuda_rasterizer/rasterizer_impl.h"
s = r.read_text()
if "<cstdint>" not in s:
    r.write_text(s.replace("#include <iostream>", "#include <iostream>\n#include <cstdint>", 1))
k = root / "submodules/simple-knn/simple_knn.cu"
s = k.read_text()
if "<cfloat>" not in s:
    k.write_text("#include <cfloat>\n" + s)
print("patched", root)

# --- static/dynamic split (run "d"): only Gaussians flagged dynamic go through the deformation field -------------
# The flag comes from the init cloud (convert.py --dyn-flag writes nx=1 on points seen on ViPE 'person' pixels) and is
# carried through densification/pruning/saving by 4DGaussians' own _deformation_table (which upstream never uses).
g = root / "scene" / "gaussian_model.py"
s = g.read_text()
old = '        self._deformation_table = torch.gt(torch.ones((self.get_xyz.shape[0]),device="cuda"),0)\n    def training_setup'
new = ('        self._deformation_table = torch.gt(torch.ones((self.get_xyz.shape[0]),device="cuda"),0)\n'
       '        if os.environ.get("FOURD_DYN_FLAG"):   # [fourd] dynamic = init points flagged nx>0.5\n'
       '            self._deformation_table = torch.tensor(np.asarray(pcd.normals)[:, 0] > 0.5, device="cuda")\n'
       '            print("[fourd] dynamic init points:", int(self._deformation_table.sum()), "of", self._deformation_table.numel())\n'
       '    def training_setup')
if "[fourd] dynamic" not in s:
    assert old in s, "gaussian_model.create_from_pcd changed"
    g.write_text(s.replace(old, new))
r = root / "gaussian_renderer" / "__init__.py"
s = r.read_text()
old = """        means3D_final, scales_final, rotations_final, opacity_final, shs_final = pc._deformation(means3D, scales, 
                                                                 rotations, opacity, shs,
                                                                 time)"""
new = """        m = pc._deformation_table
        if m.numel() == means3D.shape[0] and not bool(m.all()):   # [fourd] static Gaussians skip the deformation
            means3D_final, scales_final, rotations_final = means3D.clone(), scales.clone(), rotations.clone()
            opacity_final, shs_final = opacity.clone(), shs.clone()
            dm, ds, dr, do, dsh = pc._deformation(means3D[m], scales[m], rotations[m], opacity[m], shs[m], time[m])
            means3D_final[m], scales_final[m], rotations_final[m], opacity_final[m], shs_final[m] = dm, ds, dr, do, dsh
        else:
            means3D_final, scales_final, rotations_final, opacity_final, shs_final = pc._deformation(means3D, scales,
                                                                 rotations, opacity, shs,
                                                                 time)"""
if "[fourd] static" not in s:
    assert old in s, "renderer changed"
    r.write_text(s.replace(old, new))
print("patched dyn split", root)

# --- random background per training view (FOURD_RANDBG=1) -----------------------------------------------------
# 4DGaussians trains on a constant white background, so bright walls/ceilings are learned as "transparent over
# white": exported splats then show holes over the viewer's own background (PSNR 30.4 on white -> 21.3 on black).
# A random background per view forces opaque geometry everywhere.
t = root / "train.py"
s = t.read_text()
old = "            render_pkg = render(viewpoint_cam, gaussians, pipe, background, stage=stage,cam_type=scene.dataset_type)"
new = ("            render_pkg = render(viewpoint_cam, gaussians, pipe, (torch.rand(3, device=\"cuda\") if os.environ.get(\"FOURD_RANDBG\")"
       " else background), stage=stage,cam_type=scene.dataset_type)   # [fourd] random bg")
if "[fourd] random bg" not in s:
    assert old in s, "train.py render call changed"
    t.write_text(s.replace(old, new))
print("patched random bg", root)
