"""Fit the similarity (scale, R, t) that maps the training cameras (data/<clip>/cams.json) onto the main pipeline
world frame as it is now (work/world/frames.npz). Writes <data>/to_world.json {T_train_to_world (4x4 row-major),
scale, residual_m}. The 4D model is trained in the old frame; post.py --to_world applies this at export.
usage: python fit_world.py <data dir> <work dir>"""

import json
import sys

import numpy as np

data, work = sys.argv[1], sys.argv[2]
cj = json.load(open(f"{data}/cams.json"))
A = np.array([np.array(c["c2w"]).reshape(4, 4) for c in cj["cams"]])
z = np.load(f"{work}/world/frames.npz")
row = {int(i): k for k, i in enumerate(z["inds"])}
B = np.array([z["c2w"][row[c["idx"]]] for c in cj["cams"]])
X, Y = A[:, :3, 3], B[:, :3, 3]
mx, my = X.mean(0), Y.mean(0)
U, S, Vt = np.linalg.svd((Y - my).T @ (X - mx) / len(X))
D = np.eye(3)
D[2, 2] = np.sign(np.linalg.det(U @ Vt))
R = U @ D @ Vt
s = np.trace(np.diag(S) @ D) / ((X - mx) ** 2).sum(1).mean()
t = my - s * R @ mx
res = np.linalg.norm((s * X @ R.T + t) - Y, axis=1)
cosang = (np.einsum("nij,nij->n", R @ A[:, :3, :3], B[:, :3, :3]) - 1) / 2
rot_err = np.degrees(np.arccos(np.clip(cosang, -1, 1)))
T = np.eye(4)
T[:3, :3] = s * R
T[:3, 3] = t
out = {
    "T_train_to_world": T.flatten().tolist(),
    "scale": float(s),
    "residual_m": {"max": float(res.max()), "median": float(np.median(res))},
    "rot_err_deg": {"max": float(rot_err.max()), "median": float(np.median(rot_err))},
    "world_json_scale": json.load(open(f"{work}/world/world.json"))["scale"],
}
json.dump(out, open(f"{data}/to_world.json", "w"), indent=1)
print(json.dumps({k: v for k, v in out.items() if k != "T_train_to_world"}))
