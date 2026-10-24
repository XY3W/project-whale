"""生成一个姿态变体（用于权重/姿态验证）。用法: -- <blend> <out.json> <bone> <axisX,axisY,axisZ> <deg>"""
import bpy, sys, json, math
from mathutils import Quaternion, Matrix
argv = sys.argv[sys.argv.index("--") + 1:]
src, out, bone, axis, deg = argv[0], argv[1], argv[2], [float(x) for x in argv[3].split(",")], float(argv[4])
bpy.ops.wm.open_mainfile(filepath=src)
arm = bpy.data.objects["rig"]
bpy.context.view_layer.update()
pb = arm.pose.bones[bone]
pb.rotation_mode = "QUATERNION"
pb.rotation_quaternion = Quaternion(axis, math.radians(deg)) @ pb.rotation_quaternion
bpy.context.view_layer.update()
def m16(m): return [round(v, 8) for row in m for v in row]
bones = {b.name: {"parent": b.bone.parent.name if b.bone.parent else None, "rest": m16(b.bone.matrix_local), "pose": m16(b.matrix)} for b in arm.pose.bones}
json.dump({"armature": arm.name, "bones": bones}, open(out, "w"), indent=1)
print("WROTE", out)
