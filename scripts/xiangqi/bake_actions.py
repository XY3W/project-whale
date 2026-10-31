"""Bake evaluated constrained rig onto existing v9's 83-bone skeleton."""
import bpy,math,json,numpy as np
from pathlib import Path
from mathutils import Matrix
P=Path.cwd();A=P/'assets/xiangqi-v1';bpy.ops.wm.open_mainfile(filepath=str(A/'authoring/Whale_Chess_EDITABLE.blend'),use_scripts=False)
s=bpy.context.scene;src=bpy.data.objects['rig'];spec=json.loads((A/'reports/spec.json').read_text());info=json.loads((P/'assets/playful-interaction-v2/reports/bake_validation.json').read_text());parents=info['parents'];names=list(parents);rest={n:src.data.bones[n].matrix_local.copy()for n in names}
(A/'reports/skeleton_rest.json').write_text(json.dumps({n:[list(v)for v in src.matrix_world@rest[n]]for n in names}))
bpy.ops.object.select_all(action='DESELECT');arm=bpy.data.armatures.new('WhaleChessRuntime_v9');out=bpy.data.objects.new('WhaleRig_Chess',arm);s.collection.objects.link(out);out.matrix_world=src.matrix_world.copy();out.select_set(True);bpy.context.view_layer.objects.active=out;bpy.ops.object.mode_set(mode='EDIT')
for n in names:b=arm.edit_bones.new(n);b.length=max(.005,src.data.bones[n].length);b.matrix=rest[n]
for n,pa in parents.items():
 if pa:arm.edit_bones[n].parent=arm.edit_bones[pa]
bpy.ops.object.mode_set(mode='OBJECT')
for p in out.pose.bones:p.rotation_mode='QUATERNION'
meshes=[bpy.data.objects[n]for n in ['SK_Character_Master','WhaleTail']];copies=[]
for m in meshes:
 cp=m.copy();cp.data=m.data.copy();cp.name=m.name+'_ChessBake';s.collection.objects.link(cp);cp.parent=None;cp.matrix_world=m.matrix_world.copy()
 for mod in cp.modifiers:
  if mod.type=='ARMATURE':mod.object=out;mod.use_deform_preserve_volume=False
  if mod.type=='SUBSURF':mod.show_viewport=False;mod.show_render=False
 for mod in m.modifiers:
  if mod.type=='SUBSURF':mod.show_viewport=False;mod.show_render=False
 copies.append(cp)
def coords(obj):
 ev=obj.evaluated_get(bpy.context.evaluated_depsgraph_get());a=np.empty(len(ev.data.vertices)*3,dtype=np.float32);ev.data.vertices.foreach_get('co',a);a=a.reshape(-1,3);m=np.array(ev.matrix_world);return a@m[:3,:3].T+m[:3,3]
report={};snapshots={}
for name,sp in spec.items():
 src.animation_data.action=bpy.data.actions[name];out.animation_data_create();out.animation_data.action=None;last={};errors=[];rows=[];times=sorted(set([i/30 for i in range(round(sp['duration']*30)+1)]+[e['time']for e in sp['events']]+[sp['duration']]))
 for ii,t in enumerate(times):
  f=1+t*30;s.frame_set(int(f),subframe=f%1);bpy.context.view_layer.update();ev=src.evaluated_get(bpy.context.evaluated_depsgraph_get());mats={n:ev.pose.bones[n].matrix.copy()for n in names}
  for n in names:
   pa=parents[n];local=out.pose.bones[n].bone.convert_local_to_pose(mats[n],rest[n],parent_matrix=mats[pa]if pa else Matrix.Identity(4),parent_matrix_local=rest[pa]if pa else Matrix.Identity(4),invert=True);loc,q,sc=local.decompose()
   if n in last and q.dot(last[n])<0:q.negate()
   last[n]=q.copy();p=out.pose.bones[n];p.location=loc;p.rotation_quaternion=q;p.scale=sc
   for ch in ['location','rotation_quaternion','scale']:p.keyframe_insert(data_path=ch,frame=f,group=n)
  if ii in [0,len(times)//4,len(times)//2,len(times)*3//4,len(times)-1]:
   bpy.context.view_layer.update();error={}
   for m,cp in zip(meshes,copies):
    diff=np.linalg.norm(coords(m)-coords(cp),axis=1);error[m.name]={'maxM':float(diff.max()),'rmsM':float(np.sqrt((diff*diff).mean()))}
   errors.append({'time':t,'meshes':error})
  rows.append({'time':t,'matrices':{n:[float(x)for row in (src.matrix_world@mats[n])for x in row]for n in names}})
 action=out.animation_data.action;action.name=name+'_CHESSBAKED';action.use_fake_user=True
 for l in action.layers:
  for st in l.strips:
   for cb in st.channelbags:
    for fc in cb.fcurves:
     for kp in fc.keyframe_points:kp.interpolation='LINEAR'
 worst=max(v['maxM']for e in errors for v in e['meshes'].values());report[name]={'vertexChecks':errors,'maxM':worst};snapshots[name]=rows;print('BAKED',name,worst,json.dumps(errors),flush=True);assert worst<.0005
# Derivative file only: keep runtime skeleton/meshes, drop source rig and unrelated scenes.
for ob in list(bpy.data.objects):
 if ob not in [out]+copies:bpy.data.objects.remove(ob,do_unlink=True)
for action in list(bpy.data.actions):
 if not action.name.endswith('_CHESSBAKED'):bpy.data.actions.remove(action)
 else:action.name=action.name.removesuffix('_CHESSBAKED')
out.animation_data.action=bpy.data.actions['chess_hold'];s.frame_set(1)
bpy.ops.object.select_all(action='SELECT');bpy.context.view_layer.objects.active=out
bpy.ops.wm.save_as_mainfile(filepath=str(A/'authoring/Whale_Chess_BAKED.blend'))
bpy.ops.export_scene.gltf(filepath=str(A/'authoring/chess_baked_source.glb'),export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='ACTIONS',export_skins=True,export_morph=True,export_yup=True,export_force_sampling=True,export_optimize_animation_size=False,export_bake_animation=True,export_all_influences=True,export_anim_slide_to_zero=True)
(A/'reports/bake_validation.json').write_text(json.dumps(report,indent=2));(A/'reports/source_matrices.json').write_text(json.dumps(snapshots))
print('BAKE_OK')
