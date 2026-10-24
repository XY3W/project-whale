"""P0: 从 v7 母版提取参考姿态快照 + 骨骼清单，并做无约束回读验证。

输出到 public/models/dev/v7-provisional/：
  manifest.json       临时资产标记、源 hash、坐标信息、验证结果
  pose-reference.json 每根骨的 rest / evaluated(pose) 矩阵
  rig-inventory.json  骨骼约束、网格、材质、形态键、权重统计
"""
import bpy, sys, json, hashlib, os, math, random
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
src, outdir = argv[0], argv[1]
os.makedirs(outdir, exist_ok=True)

bpy.ops.wm.open_mainfile(filepath=src)
arm = bpy.data.objects["rig"]
bpy.context.view_layer.update()

def m16(m):
    return [round(v, 8) for row in m for v in row]

# ---------- 1. 求值后的参考姿态 ----------
bones = {}
for pb in arm.pose.bones:
    b = pb.bone
    bones[pb.name] = {
        "parent": b.parent.name if b.parent else None,
        "deform": bool(b.use_deform),
        "constraints": [c.type for c in pb.constraints],
        "rest": m16(b.matrix_local),
        "pose": m16(pb.matrix),
    }

# ---------- 2. 采样顶点（约束开启时）----------
def sample_verts(obj, idxs):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    out = [tuple(round(c, 7) for c in me.vertices[i].co) for i in idxs]
    ev.to_mesh_clear()
    return out

body = bpy.data.objects["SK_Character_Master"]
tail = bpy.data.objects["WhaleTail"]
random.seed(11)
body_idx = sorted(random.sample(range(len(body.data.vertices)), 300))
tail_idx = sorted(random.sample(range(len(tail.data.vertices)), 200))
ref_body = sample_verts(body, body_idx)
ref_tail = sample_verts(tail, tail_idx)

# ---------- 3. 关掉约束，按 rest/pose 反算 basis，回读 ----------
for pb in arm.pose.bones:
    for c in pb.constraints:
        c.mute = True

I = Matrix.Identity(4)
for pb in arm.pose.bones:
    b = pb.bone
    parent = b.parent
    parent_rest = parent.matrix_local if parent else I
    parent_pose = Matrix([row for row in bones[parent.name]["pose"]]) if False else None
    if parent:
        parent_pose = Matrix([bones[parent.name]["pose"][i*4:(i+1)*4] for i in range(4)])
    else:
        parent_pose = I
    pose = Matrix([bones[pb.name]["pose"][i*4:(i+1)*4] for i in range(4)])
    # 用 Blender 自带换算，覆盖 connected / 继承模式差异
    pb.matrix_basis = b.convert_local_to_pose(
        pose, b.matrix_local,
        parent_matrix=parent_pose, parent_matrix_local=parent_rest,
        invert=True)

bpy.context.view_layer.update()

got_body = sample_verts(body, body_idx)
got_tail = sample_verts(tail, tail_idx)

def maxdiff(a, b):
    return max(max(abs(x - y) for x, y in zip(p, q)) for p, q in zip(a, b))

db, dt = maxdiff(ref_body, got_body), maxdiff(ref_tail, got_tail)

# ---------- 4. 统计与清单 ----------
def vg_stats(obj):
    over4 = 0
    total = len(obj.data.vertices)
    mx = 0
    for v in obj.data.vertices:
        n = sum(1 for g in v.groups if g.weight > 1e-6)
        mx = max(mx, n)
        if n > 4:
            over4 += 1
    return {"vertices": total, "over4": over4, "over4_ratio": round(over4 / total, 4), "max_influences": mx}

sha = hashlib.sha256(open(src, "rb").read()).hexdigest()

inventory = {
    "source": src,
    "source_sha256": sha,
    "blender": bpy.app.version_string,
    "armature": {"name": arm.name, "bones": len(arm.data.bones),
                 "deform_bones": sum(1 for b in arm.data.bones if b.use_deform),
                 "constraints": sum(len(pb.constraints) for pb in arm.pose.bones)},
    "coordinate": {"armature_world_scale": [round(v, 6) for v in arm.matrix_world.to_scale()],
                   "armature_world_rot_euler_deg": [round(math.degrees(a), 3) for a in arm.matrix_world.to_euler()],
                   "unit": "meter", "up_axis_source": "Z", "forward_axis_source": "Y"},
    "meshes": [
        {"name": body.name, "type": "body", "materials": [m.name for m in body.data.materials if m],
         "shape_keys": [k.name for k in body.data.shape_keys.key_blocks] if body.data.shape_keys else [],
         "modifiers": [m.type for m in body.modifiers], "weights": vg_stats(body)},
        {"name": tail.name, "type": "tail", "materials": [m.name for m in tail.data.materials if m],
         "shape_keys": [], "modifiers": [m.type for m in tail.modifiers], "weights": vg_stats(tail)},
    ],
    "actions": [a.name for a in bpy.data.actions],
}

manifest = {
    "provisional": True,
    "verified": False,
    "note": "P0 临时基线，仅用于静态加载与对照；不得作为正式交付，未通过动态变形验收。",
    "source": src,
    "source_sha256": sha,
    "generated_by": "scripts/v7_pose_snapshot.py",
    "reference_frame": "v7 文件保存时的姿态（c_arm_fk 48°, c_forearm_fk 12°，其余继承约束结果）",
    "units": "meter",
    "up_axis": "Z(Blender) → Y(glTF)",
    "roundtrip": {
        "method": "关闭全部约束后，用 rest/pose 反算 matrix_basis 并回读",
        "body_max_vertex_delta_m": db,
        "tail_max_vertex_delta_m": dt,
        "passed": db < 1e-5 and dt < 1e-5,
    },
}

with open(os.path.join(outdir, "rig-inventory.json"), "w") as f:
    json.dump(inventory, f, ensure_ascii=False, indent=1)
with open(os.path.join(outdir, "pose-reference.json"), "w") as f:
    json.dump({"armature": arm.name, "bones": bones}, f, indent=1)
with open(os.path.join(outdir, "manifest.json"), "w") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

print("ROUNDTRIP body=%.9f tail=%.9f passed=%s" % (db, dt, manifest["roundtrip"]["passed"]))
print("OUT", outdir)
