import bpy, json, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
path = argv[0]
out = argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=path)

info = {"file": os.path.basename(path), "armatures": [], "meshes": [], "actions": []}

for ob in bpy.data.objects:
    if ob.type == "ARMATURE":
        bones = [b.name for b in ob.data.bones]
        info["armatures"].append({
            "name": ob.name,
            "bone_count": len(bones),
            "bones": bones,
            "has_action": bool(ob.animation_data and ob.animation_data.action),
            "action": ob.animation_data.action.name if ob.animation_data and ob.animation_data.action else None,
        })
    elif ob.type == "MESH":
        keys = []
        if ob.data.shape_keys:
            keys = [k.name for k in ob.data.shape_keys.key_blocks]
        info["meshes"].append({
            "name": ob.name,
            "verts": len(ob.data.vertices),
            "polys": len(ob.data.polygons),
            "shape_keys": keys,
            "materials": [m.name for m in ob.data.materials if m],
            "parent": ob.parent.name if ob.parent else None,
            "modifiers": [m.type for m in ob.modifiers],
            "uv_layers": [l.name for l in ob.data.uv_layers],
        })

for act in bpy.data.actions:
    fr = act.frame_range
    info["actions"].append({"name": act.name, "frame_range": [fr[0], fr[1]], "fcurves": len(act.fcurves)})

for img in bpy.data.images:
    info.setdefault("images", []).append({"name": img.name, "size": list(img.size), "path": img.filepath})

with open(out, "w") as f:
    json.dump(info, f, ensure_ascii=False, indent=1)

print("OK", out, len(info["armatures"]), "armatures,", len(info["meshes"]), "meshes")
