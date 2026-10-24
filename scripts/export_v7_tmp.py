"""P0: 从 v7 导出临时运行资产（仅用于静态加载/对照，非正式交付）。"""
import bpy, sys, os, json
argv = sys.argv[sys.argv.index("--") + 1:]
src, out = argv[0], argv[1]

bpy.ops.wm.open_mainfile(filepath=src)
bpy.ops.object.select_all(action='DESELECT')
keep = ["rig", "SK_Character_Master", "WhaleTail"]
for name in keep:
    ob = bpy.data.objects.get(name)
    if ob:
        ob.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects["rig"]

bpy.ops.export_scene.gltf(
    filepath=os.path.abspath(out),
    export_format="GLB",
    use_selection=True,
    export_apply=False,          # 不应用 SUBSURF，尾巴保持基础密度
    export_yup=True,
    export_animations=False,     # 临时版不含动画
    export_skins=True,
    export_morph=False,          # 坏形态键不导出
    export_def_bones=False,      # 先看全骨架，正式版再裁剪
    export_all_influences=True,  # 导出 JOINTS_1/WEIGHTS_1，用于 8 权重验证
    export_rest_position_armature=True,
    export_image_format="AUTO",
)
print("EXPORTED", out, os.path.getsize(out))
