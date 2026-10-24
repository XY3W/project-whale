"""把 v8 身体的每顶点影响压到 <=8 并归一化，测量截断误差后导出。

不保存 .blend，只在内存里操作后导出新 GLB。
"""
import bpy, sys, os, json, math
import numpy as np
import bmesh

argv = sys.argv[sys.argv.index("--") + 1:]
src, out = argv[0], argv[1]
bpy.ops.wm.open_mainfile(filepath=src)
arm = bpy.data.objects["rig"]
body = bpy.data.objects["SK_Character_Master"]
bpy.context.view_layer.update()

DEFORM = [b.name for b in arm.data.bones if b.use_deform]
idx = {n: i for i, n in enumerate(DEFORM)}

def skin(coords, infl, D):
    acc = np.zeros((len(coords), 3))
    vi_all = infl[:, 0].astype(int)
    gi_all = infl[:, 1].astype(int)
    w_all = infl[:, 2]
    for b in range(len(D)):
        sel = gi_all == b
        if not sel.any(): continue
        out4 = np.concatenate([coords[vi_all[sel]], np.ones((sel.sum(), 1))], 1) @ D[b].T
        np.add.at(acc, vi_all[sel], w_all[sel][:, None] * out4[:, :3])
    return acc

def bone_matrices():
    D = np.zeros((len(DEFORM), 4, 4))
    for i, n in enumerate(DEFORM):
        pb = arm.pose.bones[n]
        D[i] = np.array(pb.matrix) @ np.linalg.inv(np.array(pb.bone.matrix_local))
    return D

M = arm.matrix_world.inverted() @ body.matrix_world
coords = np.array([tuple(M @ v.co) for v in body.data.vertices], dtype=np.float64)

def collect(full):
    rows = []
    gname = {g.index: g.name for g in body.vertex_groups}
    for v in bm.verts:
        d = v[dl]
        for gi, w in list(d.items()):
            n = gname.get(gi)
            if n in idx and w > 0:
                rows.append((v.index, idx[n], w))
    return np.array(rows, dtype=np.float64)

bm = bmesh.new(); bm.from_mesh(body.data)
dl = bm.verts.layers.deform.active

full_infl = collect(True)
D = bone_matrices()
pos_full = skin(coords, full_infl, D)

# 压到 top-8 并归一化
removed = 0
for v in bm.verts:
    d = v[dl]
    items = sorted(d.items(), key=lambda kv: -kv[1])
    keep, drop = items[:8], items[8:]
    s = sum(w for _, w in keep)
    if not s: continue
    removed += len(drop)
    for gi, _ in drop: del d[gi]
    for gi, w in keep: d[gi] = w / s

bm.to_mesh(body.data)
bm.free()
bpy.context.view_layer.update()

bm2 = bmesh.new(); bm2.from_mesh(body.data)
dl2 = bm2.verts.layers.deform.active
gname = {g.index: g.name for g in body.vertex_groups}
rows = []
for v in bm2.verts:
    for gi, w in v[dl2].items():
        n = gname.get(gi)
        if n in idx and w > 0: rows.append((v.index, idx[n], w))
bm2.free()
clamped_infl = np.array(rows, dtype=np.float64)
pos_clamped = skin(coords, clamped_infl, D)
err = np.linalg.norm(pos_full - pos_clamped, axis=1)
report = {
    "removed_weights": int(removed),
    "max_mm": round(float(err.max()) * 1000, 4),
    "rms_mm": round(float(np.sqrt((err ** 2).mean())) * 1000, 4),
    "p99_mm": round(float(np.percentile(err, 99)) * 1000, 4),
    "over_1mm": int((err > 0.001).sum()),
}
print("CLAMP", json.dumps(report))

bpy.ops.object.select_all(action='DESELECT')
for n in ["rig", "SK_Character_Master", "WhaleTail"]:
    ob = bpy.data.objects.get(n)
    if ob: ob.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(
    filepath=os.path.abspath(out), export_format="GLB", use_selection=True,
    export_apply=False, export_yup=True, export_animations=False, export_skins=True,
    export_morph=False, export_def_bones=False, export_influence_nb=8,
    export_all_influences=True, export_rest_position_armature=True, export_image_format="AUTO",
)
print("EXPORTED", out, os.path.getsize(out))
