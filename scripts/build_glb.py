import bpy, sys, os

out = sys.argv[sys.argv.index("--") + 1]
BASE = "assets/raw/动作步骤/慢走/Character_SlowWalk.fbx"
CLIPS = {
    "walk": "assets/raw/动作步骤/慢走/Character_SlowWalk.fbx",
    "run":  "assets/raw/动作步骤/慢跑/Character_SlowRun.fbx",
    "jump": "assets/raw/动作步骤/跳跃/Character_Jump.fbx",
}

def fcs(a):
    if hasattr(a, "fcurves"):
        return list(a.fcurves)
    out = []
    for l in a.layers:
        for s in l.strips:
            for cb in getattr(s, "channelbags", []):
                out.extend(cb.fcurves)
    return out

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=BASE)
base_arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
base_mesh = [o for o in bpy.data.objects if o.type == "MESH"][0]
base_arm.name = "Character"
base_mesh.name = "CharacterMesh"
base_rest = {b.name: b.matrix_local.copy() for b in base_arm.data.bones}

# drop imported shape-key actions; expressions are driven procedurally at runtime
for a in list(bpy.data.actions):
    if a.name.startswith("Key|"):
        bpy.data.actions.remove(a)

# rename the walk action
for a in bpy.data.actions:
    if a.name.startswith("SK_"):
        a.name = "walk"
        a.use_fake_user = True

for clip, path in CLIPS.items():
    if clip == "walk":
        continue
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    new_objs = [o for o in bpy.data.objects if o not in before]
    src_arm = [o for o in new_objs if o.type == "ARMATURE"][0]

    dmax = 0.0
    for b in src_arm.data.bones:
        if b.name in base_rest:
            m1, m2 = base_rest[b.name], b.matrix_local
            dmax = max(dmax, max(abs(m1[i][j] - m2[i][j]) for i in range(4) for j in range(4)))
    print(f"[{clip}] rest pose max diff vs base: {dmax:.2e}, bones {len(src_arm.data.bones)}")

    acts = [a for a in bpy.data.actions if a.name.startswith("SK_") and a.name != clip]
    for a in list(bpy.data.actions):
        if a.name.startswith("Key|"):
            bpy.data.actions.remove(a)
    for a in acts:
        a.name = clip
        a.use_fake_user = True

    for o in new_objs:
        bpy.data.objects.remove(o, do_unlink=True)

# assign all clips to base armature is not needed for ACTIONS export mode
bpy.context.view_layer.objects.active = base_arm
for a in bpy.data.actions:
    a.use_fake_user = True
    print("ACTION", a.name, a.frame_range[:], len(fcs(a)))

for o in bpy.data.objects:
    o.select_set(o in (base_arm, base_mesh))

bpy.ops.export_scene.gltf(
    filepath=os.path.abspath(out),
    export_format="GLB",
    use_selection=True,
    export_apply=False,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_nla_strips=False,
    export_bake_animation=False,
    export_skins=True,
    export_morph=True,
    export_yup=True,
    export_image_format="AUTO",
    export_optimize_animation_size=True,
)
print("EXPORTED", out)
