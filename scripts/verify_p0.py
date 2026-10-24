"""独立校验 P0 临时资产，不复用生成脚本的内存状态。

用法: blender -b --python scripts/verify_p0.py -- <源.blend> <资产目录>
检查项:
  BONE_SET / PARENT   骨骼集合与父子关系
  REST / POSE         矩阵与 Blender 求值结果逐项比对
  RIGID               旋转部分正交、无剪切、行列式≈1
  WEIGHTS             权重和、组名合法性
  LANDMARKS           关键骨骼位置落在物理合理区间
  ROUNDTRIP           关约束后回读网格，与源求值对照
"""
import bpy, sys, json, os, random
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
src, adir = argv[0], argv[1]
pose = json.load(open(os.path.join(adir, "pose-reference.json")))
inv = json.load(open(os.path.join(adir, "rig-inventory.json")))

bpy.ops.wm.open_mainfile(filepath=src)
arm = bpy.data.objects["rig"]
bpy.context.view_layer.update()

def mat(v):
    return Matrix([v[i * 4:(i + 1) * 4] for i in range(4)])

def mdiff(a, b):
    return max(abs(a[i][j] - b[i][j]) for i in range(4) for j in range(4))

results = []
def check(name, ok, detail):
    results.append((name, bool(ok), detail))

# 1. 骨骼集合与父子
arm_names = {b.name for b in arm.data.bones}
json_names = set(pose["bones"])
check("BONE_SET", arm_names == json_names, f"armature={len(arm_names)} json={len(json_names)} 差集={list(arm_names ^ json_names)[:5]}")
bad_parent = [n for n, b in pose["bones"].items()
              if (arm.data.bones[n].parent.name if arm.data.bones[n].parent else None) != b["parent"]]
check("PARENT", not bad_parent, f"不匹配 {len(bad_parent)} 根: {bad_parent[:5]}")

# 2. REST / POSE 与 Blender 重新求值比对
rest_max, rest_worst = 0.0, None
pose_max, pose_worst = 0.0, None
for pb in arm.pose.bones:
    d1 = mdiff(mat(pose["bones"][pb.name]["rest"]), pb.bone.matrix_local)
    if d1 > rest_max: rest_max, rest_worst = d1, pb.name
    d2 = mdiff(mat(pose["bones"][pb.name]["pose"]), pb.matrix)
    if d2 > pose_max: pose_max, pose_worst = d2, pb.name
check("REST", rest_max < 1e-6, f"max={rest_max:.2e} worst={rest_worst}")
check("POSE", pose_max < 1e-6, f"max={pose_max:.2e} worst={pose_worst}")

# 3. 刚体性：解算后的姿态不应含剪切/非均匀缩放
bad_rigid = []
helper_rigid = []
for pb in arm.pose.bones:
    m = mat(pose["bones"][pb.name]["pose"])
    cols = [m.col[i].to_3d() for i in range(3)]
    lens = [c.length for c in cols]
    dots = [abs(cols[i].normalized().dot(cols[j].normalized())) for i in range(3) for j in range(i + 1, 3)]
    det = m.to_3x3().determinant()
    odd = max(abs(l - 1) for l in lens) > 2e-3 or max(dots) > 2e-3 or abs(det - 1) > 4e-3
    if odd:
        item = (pb.name, round(max(lens) - min(lens), 5), round(max(dots), 5), round(det, 5))
        (bad_rigid if pb.bone.use_deform else helper_rigid).append(item)
check("RIGID(deform)", not bad_rigid, f"异常 {len(bad_rigid)} 根: {bad_rigid[:5]}")
results.append(("INFO(helper)", True, f"非变形骨非均匀缩放 {len(helper_rigid)} 根（不应导出为关节）: {[h[0] for h in helper_rigid][:6]}"))

# 4. 权重合法性
HELPER_GROUPS = {"_Face_Region"}   # Blender 侧辅助选择组，导出时应剔除，不是骨骼
bad_w_sum, bad_groups, helper_groups, no_inf = 0, set(), set(), 0
for name in ("SK_Character_Master", "WhaleTail"):
    ob = bpy.data.objects[name]
    index_to_name = {g.index: g.name for g in ob.vertex_groups}
    non_bone = {g.name for g in ob.vertex_groups} - arm_names
    helper_groups |= (non_bone & HELPER_GROUPS)
    bad_groups |= (non_bone - HELPER_GROUPS)
    for v in ob.data.vertices:
        s = sum(g.weight for g in v.groups if index_to_name[g.group] in arm_names)
        if abs(s - 1.0) > 1e-3: bad_w_sum += 1
        if s <= 1e-6: no_inf += 1
check("WEIGHTS", bad_w_sum == 0 and not bad_groups and no_inf == 0,
      f"骨骼权重和异常={bad_w_sum} 无骨骼影响={no_inf} 非法组={sorted(bad_groups)[:5]}")
results.append(("INFO(helper)", True, f"辅助选择组（导出时剔除）={sorted(helper_groups)}"))

# 5. 地标位置（armature 空间）
EXPECT = {"head.x": (0.0, 0.064, 0.569), "hand.l": (0.184, 0.015, 0.323),
          "hand.r": (-0.184, 0.015, 0.323)}
bad_lm = []
for n, exp in EXPECT.items():
    got = pose["bones"][n]["pose"]
    pos = (got[3], got[7], got[11])   # 行主序第 4 列
    d = max(abs(pos[i] - exp[i]) for i in range(3))
    if d > 3e-3:
        bad_lm.append((n, [round(x, 3) for x in pos], [round(x, 3) for x in exp]))
check("LANDMARKS", not bad_lm, f"偏差项={bad_lm}")

# 6. 关约束回读
def sample(ob, idx):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg); me = ev.to_mesh()
    out = [tuple(me.vertices[i].co) for i in idx]
    ev.to_mesh_clear(); return out

body, tail = bpy.data.objects["SK_Character_Master"], bpy.data.objects["WhaleTail"]
random.seed(11)
bi = sorted(random.sample(range(len(body.data.vertices)), 300))
ti = sorted(random.sample(range(len(tail.data.vertices)), 200))
ref_b, ref_t = sample(body, bi), sample(tail, ti)

for pb in arm.pose.bones:
    for c in pb.constraints: c.mute = True
I = Matrix.Identity(4)
for pb in arm.pose.bones:
    b = pb.bone
    pr = b.parent.matrix_local if b.parent else I
    pp = mat(pose["bones"][b.parent.name]["pose"]) if b.parent else I
    pb.matrix_basis = b.convert_local_to_pose(mat(pose["bones"][pb.name]["pose"]), b.matrix_local,
                                              parent_matrix=pp, parent_matrix_local=pr, invert=True)
bpy.context.view_layer.update()
got_b, got_t = sample(body, bi), sample(tail, ti)
db = max(max(abs(a - b) for a, b in zip(p, q)) for p, q in zip(ref_b, got_b))
dt = max(max(abs(a - b) for a, b in zip(p, q)) for p, q in zip(ref_t, got_t))
check("ROUNDTRIP", db < 1e-5 and dt < 1e-5, f"body={db:.2e} tail={dt:.2e}")

print("\n=== P0 VERIFY ===")
for name, ok, detail in results:
    print(f"{'PASS' if ok else 'FAIL'}  {name:10s} {detail}")
print("RESULT", "ALL PASS" if all(r[1] for r in results) else "FAILED")
