import bpy,math,json,sys
from pathlib import Path
from mathutils import Vector
P=Path.cwd();A=P/'assets/xiangqi-v1';bpy.ops.wm.open_mainfile(filepath=str(A/'authoring/Whale_Chess_EDITABLE.blend'),use_scripts=False);s=bpy.context.scene;r=bpy.data.objects['rig'];piece=bpy.data.objects['Xiangqi_PieceBody'];scoop=bpy.data.objects['RiceScoop']
for ob in bpy.data.objects:
 if ob.type=='LIGHT':ob.hide_render=True
 if ob.type=='MESH'and ob.name not in ['SK_Character_Master','WhaleTail','RiceScoop','Xiangqi_PieceBody','Xiangqi_FineEdgeRing','Xiangqi_red_帅']:ob.hide_render=True
s.world.use_nodes=True;bg=next(n for n in s.world.node_tree.nodes if n.type=='BACKGROUND');bg.inputs[0].default_value=(.22,.27,.35,1);bg.inputs[1].default_value=.6
for name,loc,power,size in [('XKey',(-2,-3,3),230,2),('XFill',(2,-1,2),140,2),('XRim',(0,2,3),260,2)]:
 li=bpy.data.lights.new(name,'AREA');li.energy=power;li.size=size;o=bpy.data.objects.new(name,li);s.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,.6))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.001));floor=bpy.context.object;ma=bpy.data.materials.new('ChessFloor');ma.diffuse_color=(.12,.16,.21,1);floor.data.materials.append(ma)
s.render.engine='CYCLES';s.cycles.samples=8;s.cycles.use_denoising=True;s.render.resolution_x=640;s.render.resolution_y=640;s.render.resolution_percentage=100;s.view_settings.view_transform='AgX';cam=s.camera;cam.data.type='ORTHO';cam.data.ortho_scale=1.6
for name,t,label in [('chess_pickup',1.2,'contact'),('chess_hold',0,'carry'),('stow_scoop',1.35,'waist')]:
 r.animation_data.action=bpy.data.actions[name];piece.animation_data.action=bpy.data.actions[name+'_chess_GUIDE'];scoop.animation_data.action=bpy.data.actions[name+'_scoop_GUIDE'];f=1+t*30;s.frame_set(int(f),subframe=f%1);piece.hide_render=name=='stow_scoop'
 for child in piece.children:child.hide_render=piece.hide_render or child.name not in ['Xiangqi_FineEdgeRing','Xiangqi_red_帅']
 for view,off in [('front',(0,-4,.35)),('side',(-4,-.2,.35))]:
  center=Vector((0,-.05,.54));cam.location=center+Vector(off);cam.rotation_euler=(center-cam.location).to_track_quat('-Z','Y').to_euler();s.render.filepath=str(A/'previews'/f'{label}_{view}.png');bpy.ops.render.render(write_still=True)
print('RENDER_OK')
