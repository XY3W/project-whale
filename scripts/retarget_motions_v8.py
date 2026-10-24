"""把 Motion_Samples 的四组动作从 V4/refined 绑定重定向到 V8 绑定。

方法：在源绑定上按帧求值得到每根骨的【世界旋转】，减去源 rest 得到世界增量，
再叠加到 V8 的 rest 上，最后换算成 V8 的局部旋转并打关键帧。
只迁移旋转，不迁移平移（这些动作都是原地动作）。
"""
import bpy, sys, os
from mathutils import Quaternion, Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
v8_path, src_path, out_glb = argv[0], argv[1], argv[2]
WANTED = ["01_Idle", "02_Nod", "03_Look", "04_Greet"]

# ---- 目标：V8 ----
bpy.ops.wm.open_mainfile(filepath=v8_path)
target = bpy.data.objects["rig"]
TQ = {b.name: b.matrix_local.to_quaternion() for b in target.data.bones}
TPARENT = {b.name: (b.parent.name if b.parent else None) for b in target.data.bones}

# ---- 源：追加骨架与动作 ----
with bpy.data.libraries.load(src_path, link=False) as (df, dt):
    dt.objects = ["rig"]
    dt.actions = [n for n in df.actions if n in WANTED]
source = [o for o in bpy.data.objects if o.type == "ARMATURE" and o is not target][0]
bpy.context.scene.collection.objects.link(source)
SQ = {b.name: b.matrix_local.to_quaternion() for b in source.data.bones}
COMMON = [n for n in TQ if n in SQ]
# 只写没有被约束驱动的骨（控制骨）；变形骨由 V8 自己的约束跟随，
# 否则会和约束叠加，手臂会扭。
KEYABLE = [n for n in COMMON if target.data.bones[n].use_deform]
print("KEYABLE", len(KEYABLE), "of", len(COMMON))
print("SOURCE", source.name, "COMMON", len(COMMON))

actions = {a.name: a for a in bpy.data.actions if a.name in WANTED}
source.animation_data_create()

for name in WANTED:
    act = actions[name]
    source.animation_data.action = act
    if getattr(act, "slots", None):
        source.animation_data.action_slot = act.slots[0]
    f0, f1 = act.frame_range
    frames = list(range(int(f0), int(f1) + 1))

    # 目标动作
    tgt_act = bpy.data.actions.new(name=f"V8_{name}")
    tgt_act.use_fake_user = True
    target.animation_data_create()
    target.animation_data.action = tgt_act
    if getattr(tgt_act, "slots", None):
        target.animation_data.action_slot = tgt_act.slots[0]

    SREST = {n: source.pose.bones[n].bone.matrix_local.copy() for n in COMMON}
    TREST = {n: target.pose.bones[n].bone.matrix_local.copy() for n in COMMON}

    for f in frames:
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        delta = {}
        for b in KEYABLE:
            delta[b] = source.pose.bones[b].matrix @ SREST[b].inverted()
        pt = {b: delta[b] @ TREST[b] for b in KEYABLE}
        # 父级世界矩阵（用目标当前求值结果；父不在集合时用其 rest）
        for b in KEYABLE:
            parent = TPARENT.get(b)
            if parent is None:
                parent_pose = Matrix.Identity(4)
                parent_rest = Matrix.Identity(4)
            else:
                parent_pose = pt.get(parent) if parent in pt else TREST.get(parent, Matrix.Identity(4))
                parent_rest = TREST.get(parent, Matrix.Identity(4))
            tb = target.pose.bones[b]
            basis = tb.bone.convert_local_to_pose(
                pt[b], TREST[b],
                parent_matrix=parent_pose, parent_matrix_local=parent_rest,
                invert=True)
            tb.rotation_mode = "QUATERNION"
            tb.rotation_quaternion = basis.to_quaternion()
            tb.keyframe_insert("rotation_quaternion", frame=f)
    print("RETARGET", name, len(frames), "frames")

# 关键：运行时没有约束，导出前必须静音，否则约束会覆盖烘焙的变形骨关键帧
for pb in target.pose.bones:
    for c in pb.constraints:
        c.mute = True

# ---- 导出（只导骨架 + 动画，供运行时取 clip）----
bpy.ops.object.select_all(action='DESELECT')
target.select_set(True)
bpy.context.view_layer.objects.active = target
bpy.ops.export_scene.gltf(
    filepath=os.path.abspath(out_glb), export_format="GLB", use_selection=True,
    export_animations=True, export_animation_mode="ACTIONS",
    export_anim_slide_to_zero=True, export_apply=False,
    export_yup=True, export_skins=False, export_morph=False,
)
print("EXPORTED", out_glb, os.path.getsize(out_glb))
