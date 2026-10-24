"""P0: 四权重截断误差实验。

固定同一组求值骨矩阵，只改变权重数量（全量 vs 最大的 4 个并归一化），
量出线性混合蒙皮下的顶点偏差。
"""
import bpy, sys, json, math, os
import numpy as np
from mathutils import Quaternion

argv = sys.argv[sys.argv.index("--") + 1:]
src, outpath = argv[0], argv[1]

bpy.ops.wm.open_mainfile(filepath=src)
arm = bpy.data.objects["rig"]
meshes = [bpy.data.objects["SK_Character_Master"], bpy.data.objects["WhaleTail"]]
bpy.context.view_layer.update()

deform = [b.name for b in arm.data.bones if b.use_deform]
name_to_idx = {n: i for i, n in enumerate(deform)}

def collect(ob):
    vi, gi, w = [], [], []
    gname = {g.index: g.name for g in ob.vertex_groups}
    for v in ob.data.vertices:
        for g in v.groups:
            nm = gname[g.group]
            if nm in name_to_idx and g.weight > 0.0:
                vi.append(v.index); gi.append(name_to_idx[nm]); w.append(g.weight)
    return (np.array(vi, dtype=np.int64), np.array(gi, dtype=np.int64),
            np.array(w, dtype=np.float64), len(ob.data.vertices))

def top_k(vi, gi, w, n, k):
    order = np.lexsort((-w, vi))
    vi, gi, w = vi[order], gi[order], w[order]
    counts = np.bincount(vi, minlength=n)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    rank = np.arange(len(vi)) - np.repeat(starts, counts)
    keep = rank < k
    vi, gi, w = vi[keep], gi[keep], w[keep]
    s = np.bincount(vi, weights=w, minlength=n)
    return vi, gi, w / s[vi]

def bone_matrices():
    D = np.zeros((len(deform), 4, 4))
    for i, n in enumerate(deform):
        pb = arm.pose.bones[n]
        g = np.array(pb.matrix)
        r = np.array(pb.bone.matrix_local)
        D[i] = g @ np.linalg.inv(r)
    return D

def skin(vh, vi, gi, w, D):
    acc = np.zeros((len(vh), 3))
    for b in range(len(D)):
        sel = gi == b
        if not sel.any(): continue
        out = vh[vi[sel]] @ D[b].T
        np.add.at(acc, vi[sel], w[sel, None] * out[:, :3])
    return acc

def delta(bone, axis, deg):
    pb = arm.pose.bones[bone]
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = Quaternion(axis, math.radians(deg)) @ pb.rotation_quaternion

datasets = {}
for ob in meshes:
    vi, gi, w, n = collect(ob)
    # 顶点必须变换到骨架空间：v8 身体 mesh.matrix_world 含约 90° X 旋转，
    # 而骨架矩阵是骨架空间的。直接混用会引入厘米级假误差。
    M = arm.matrix_world.inverted() @ ob.matrix_world
    coords = np.array([tuple(M @ v.co) for v in ob.data.vertices], dtype=np.float64)
    vh = np.concatenate([coords, np.ones((n, 1))], axis=1)
    datasets[ob.name] = dict(vi=vi, gi=gi, w=w, n=n, vh=vh, coord=coords,
                             top4=top_k(vi, gi, w, n, 4),
                             top8=top_k(vi, gi, w, n, 8))

poses = {
    "reference": lambda: None,
    "arm_lift_25": lambda: delta("c_shoulder.l", (1, 0, 0), 25),
    "head_turn_20": lambda: delta("c_neck.x", (0, 0, 1), 20),
    "combo": lambda: (delta("c_shoulder.l", (1, 0, 0), 25),
                      delta("c_neck.x", (0, 0, 1), 20),
                      delta("WhaleTail_03", (1, 0, 0), 25)),
}

saved_basis = {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}

def reset_pose():
    for pb in arm.pose.bones:
        pb.matrix_basis = saved_basis[pb.name].copy()
    bpy.context.view_layer.update()

report = {"source": src, "method": "固定求值骨矩阵，仅比较权重数量（全量 vs 前四并归一化）",
          "poses": {}}

for pname, fn in poses.items():
    reset_pose()
    fn()
    bpy.context.view_layer.update()
    D = bone_matrices()
    per = {}
    for name, d in datasets.items():
        ob = bpy.data.objects[name]
        full = skin(d["vh"], d["vi"], d["gi"], d["w"], D)
        gname = {g.index: g.name for g in ob.vertex_groups}
        entry = {"vertices": int(d["n"]), "modes": {}}
        for mode, key in (("top4", "top4"), ("top8", "top8")):
            t_vi, t_gi, t_w = d[key]
            cut = skin(d["vh"], t_vi, t_gi, t_w, D)
            err = np.linalg.norm(full - cut, axis=1)
            worst = int(np.argmax(err))
            doms = {gname[g.group]: round(g.weight, 3) for g in ob.data.vertices[worst].groups}
            entry["modes"][mode] = {
                "max_mm": round(float(err.max()) * 1000, 3),
                "rms_mm": round(float(np.sqrt((err ** 2).mean())) * 1000, 3),
                "p95_mm": round(float(np.percentile(err, 95)) * 1000, 3),
                "p99_mm": round(float(np.percentile(err, 99)) * 1000, 3),
                "over_1mm": int((err > 0.001).sum()),
                "worst_vertex": worst,
                "worst_pos": [round(float(x), 3) for x in d["coord"][worst]],
                "worst_weights": dict(sorted(doms.items(), key=lambda kv: -kv[1])[:5]),
            }
        per[name] = entry
    report["poses"][pname] = per
    print("POSE", pname, json.dumps({k: {m: {kk: e["modes"][m][kk] for kk in ("max_mm", "rms_mm", "p99_mm", "over_1mm")} for m in e["modes"]} for k, e in per.items()}))

with open(outpath, "w") as f:
    json.dump(report, f, ensure_ascii=False, indent=1)
print("WROTE", outpath)
