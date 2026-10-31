import bpy
from pathlib import Path
P=Path.cwd();A=P/'assets/xiangqi-v1';O=P/'public/models/xiangqi-v1';bpy.ops.wm.read_factory_settings(use_empty=True);s=bpy.context.scene
m=bpy.data.materials.new('Xiangqi_BoardPrint');m.use_nodes=True;p=next((n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)or m.node_tree.nodes.new('ShaderNodeBsdfPrincipled');out=next((n for n in m.node_tree.nodes if n.type=='OUTPUT_MATERIAL'),None)or m.node_tree.nodes.new('ShaderNodeOutputMaterial');m.node_tree.links.new(p.outputs[0],out.inputs[0]);p.inputs['Roughness'].default_value=.7;tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(O/'board_atlas.png'));tex.image.pack();m.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
me=bpy.data.meshes.new('Xiangqi_BoardTop');me.from_pydata([(-5.75,-5.75,0),(5.75,-5.75,0),(5.75,5.75,0),(-5.75,5.75,0)],[],[(0,1,2,3)]);me.update();uv=me.uv_layers.new(name='UVMap')
for li,xy in enumerate([(0,0),(1,0),(1,1),(0,1)]):uv.data[li].uv=xy
ob=bpy.data.objects.new('XiangqiBoard',me);s.collection.objects.link(ob);me.materials.append(m);ob.select_set(True);bpy.context.view_layer.objects.active=ob
bpy.ops.wm.save_as_mainfile(filepath=str(A/'authoring/ChessBoard_ASSET.blend'))
bpy.ops.export_scene.gltf(filepath=str(O/'board.glb'),export_format='GLB',use_selection=True,export_animations=False,export_yup=True)
