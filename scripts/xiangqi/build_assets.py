"""Author chess/waist actions on a new source-rig copy. Never run blend texts."""
import bpy,math,json,hashlib,sys
from pathlib import Path
from mathutils import Matrix,Vector,Quaternion
import numpy as np
P=Path.cwd();A=P/'assets/xiangqi-v1';O=P/'public/models/xiangqi-v1';SRC=P/'assets/playful-interaction-v2/authoring/Whale_Playful_EDITABLE.blend'
bpy.ops.wm.open_mainfile(filepath=str(SRC),use_scripts=False)
s=bpy.context.scene;r=bpy.data.objects['rig'];body=bpy.data.objects['SK_Character_Master'];tail=bpy.data.objects['WhaleTail'];basin=bpy.data.objects['Basin_ActionGuide'];scoop=bpy.data.objects['RiceScoop'];s.render.fps=30
# Runtime uses linear blend skinning; match it in this new authoring copy.
for mod in tail.modifiers:
 if mod.type=='ARMATURE':mod.use_deform_preserve_volume=False
for tx in list(bpy.data.texts):bpy.data.texts.remove(tx)
for ob in [basin,scoop]:ob.animation_data_clear();ob.hide_render=True
body.data.shape_keys.animation_data_clear()
for k in body.data.shape_keys.key_blocks:k.value=0
r.animation_data.action=bpy.data.actions['idle_stand'];s.frame_set(1);bpy.context.view_layer.update();base={p.name:p.matrix_basis.copy()for p in r.pose.bones};headBase=r.pose.bones['c_head.x'].matrix.copy();spineBase=r.pose.bones['spine_05.x'].matrix.copy();rootBase=r.pose.bones['c_root_master.x'].head.copy()
controls=[n for n in base if n.startswith('c_')and not n.startswith('c_p_')]+[f'WhaleTail_{i:02d}'for i in range(1,7)]
for p in r.pose.bones:p.rotation_mode='QUATERNION'
# A single shared lathed body; atlas only on the gently domed top.
def material(name,col,rough=.48,img=None):
 m=bpy.data.materials.new(name);m.diffuse_color=(*col,1);m.use_nodes=True;p=next((n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None) or m.node_tree.nodes.new('ShaderNodeBsdfPrincipled');out=next((n for n in m.node_tree.nodes if n.type=='OUTPUT_MATERIAL'),None) or m.node_tree.nodes.new('ShaderNodeOutputMaterial');m.node_tree.links.new(p.outputs[0],out.inputs['Surface']);p.inputs['Base Color'].default_value=(*col,1);p.inputs['Roughness'].default_value=rough
 if img:
  n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=bpy.data.images.load(str(img),check_existing=True);n.image.pack();m.node_tree.links.new(n.outputs['Color'],p.inputs['Base Color'])
 return m
wood=material('Xiangqi_HoneyWood',(.73,.55,.32),img=O/'wood.png');ink=material('Xiangqi_GlyphAtlas',(1,1,1),img=O/'glyph_atlas.png');dark=material('Xiangqi_EdgeRing',(.22,.12,.055))
# Profile excludes top surface. z=0 is ground, outer radius .17m.
profile=[(r,h)for r,h in [(0,0),(.140,0),(.149,.004),(.157,.011),(.164,.020),(.170,.035),(.170,.195),(.168,.206),(.162,.214),(.156,.216)]]
vs=[];fs=[];uv=[];N=64
for rr,z in profile:
 for i in range(N+1):th=2*math.pi*i/N;vs.append((max(rr,1e-7)*math.cos(th),max(rr,1e-7)*math.sin(th),z))
for j in range(len(profile)-1):
 for i in range(N):a=j*(N+1)+i;b=a+1;c=b+N+1;d=a+N+1;fs.append((a,b,c,d));uv.append([(i/N,j/8),((i+1)/N,j/8),((i+1)/N,(j+1)/8),(i/N,(j+1)/8)])
def mesh(name,vs,fs,uv,mat):
 me=bpy.data.meshes.new(name);me.from_pydata(vs,[],fs);me.update();o=bpy.data.objects.new(name,me);s.collection.objects.link(o);o.data.materials.append(mat);l=me.uv_layers.new(name='UVMap')
 for poly,arr in zip(me.polygons,uv):
  for li,xy in zip(poly.loop_indices,arr):l.data[li].uv=xy
  poly.use_smooth=True
 return o
piece=mesh('Xiangqi_PieceBody',vs,fs,uv,wood)
# Narrow dark decorative ring as actual geometry, shared by every piece.
bpy.ops.mesh.primitive_torus_add(major_segments=64,minor_segments=6,major_radius=.1698,minor_radius=.00065,location=(0,0,.035));ring=bpy.context.object;ring.name='Xiangqi_FineEdgeRing';ring.data.materials.append(dark)
# Latest review doubles the prior thin version: total height .222, dome rise .006 before vertical scale. UV tiles shrink .5 pixel to avoid bleed.
glyphs=json.loads((O/'glyphs.json').read_text());tops=[]
for k,it in enumerate(glyphs):
 v=[(0,0,.222)];xy=[(.5,.5)];f=[]
 for j in range(1,9):
  rr=.156*j/8
  for i in range(N):th=2*math.pi*i/N;v.append((rr*math.cos(th),rr*math.sin(th),.216+.006*(1-(rr/.156)**2)));xy.append((.5+.5*rr/.156*math.cos(th),.5+.5*rr/.156*math.sin(th)))
 for i in range(N):f.append((0,1+i,1+(i+1)%N))
 for j in range(7):
  for i in range(N):a=1+j*N+i;b=1+j*N+(i+1)%N;f.append((a,a+N,b+N,b))
 u0,v0,u1,v1=it['uvRect'];pad=.5/2048;uv=[[(u0+pad+(u1-u0-2*pad)*xy[i][0],v0+pad+(v1-v0-2*pad)*xy[i][1])for i in fa]for fa in f]
 top=mesh('Xiangqi_'+it['side']+'_'+it['glyph'],v,f,uv,ink);tops.append(top)
 # Template GLB shares body geometry across all 14 templates; one body material, one atlas.
 top.parent=piece
ring.parent=piece
# User review: radius is 0.4 cell widths; height has been doubled from the previously thinned version.
RADIAL_SCALE=(1.15*.4)/.17
for ob in [piece,ring]+tops:
 for vv in ob.data.vertices:vv.co.x*=RADIAL_SCALE;vv.co.y*=RADIAL_SCALE;vv.co.z*=1.15
 ob.location.x*=RADIAL_SCALE;ob.location.y*=RADIAL_SCALE;ob.location.z*=1.15
profile=[(rr*RADIAL_SCALE,hh*1.15)for rr,hh in profile]
bpy.ops.object.select_all(action='DESELECT');piece.select_set(True);ring.select_set(True)
for top in tops:top.select_set(True)
bpy.context.view_layer.objects.active=piece
# Export each template as a named collection of body+top; one shared mesh data for body.
roots=[]
for k,it in enumerate(glyphs):
 root=bpy.data.objects.new('piece_'+it['side']+'_'+str(k%7),None);s.collection.objects.link(root);roots.append(root)
 for ob in [piece,ring,tops[k]]:
  cp=ob.copy();cp.data=ob.data;cp.parent=root;cp.matrix_parent_inverse=Matrix.Identity(4);cp.matrix_basis=ob.matrix_basis.copy();s.collection.objects.link(cp)
bpy.ops.object.select_all(action='DESELECT')
for root in roots:
 root.select_set(True)
 for ob in root.children:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(O/'pieces.glb'),export_format='GLB',use_selection=True,export_animations=False,export_yup=True)
bpy.data.libraries.write(str(A/'authoring/ChessPieces_ASSET.blend'),set(roots)|{c for root in roots for c in root.children},fake_user=True)
if '--models-only' in sys.argv:sys.exit(0)
for root in roots:
 for ob in list(root.children):bpy.data.objects.remove(ob,do_unlink=True)
 bpy.data.objects.remove(root,do_unlink=True)
for top in tops[1:]:top.hide_render=True;top.hide_set(True)
# User-approved magic pickup; hands cradle the side middle with level forearms.
SCALE=1.15
RADIUS=.4*SCALE
HEIGHT=.222*SCALE
GRIP_X=.14
GRIP_BACK=math.sqrt(RADIUS*RADIUS-GRIP_X*GRIP_X)
PALM=Vector((0,.032,0))
GROUND=Vector((0,-.85,0))
PALM_FORWARD=.325-math.sqrt((.17*SCALE)**2-GRIP_X**2)
CARRY=Vector((0,-(PALM_FORWARD+GRIP_BACK),.45-HEIGHT/2))
G=Vector((GRIP_X,GRIP_BACK,HEIGHT/2))

def smooth(t):
 t=max(0,min(1,t));return t*t*(3-2*t)

def reset():
 for n,M in base.items():r.pose.bones[n].matrix_basis=M
 bpy.context.view_layer.update()

def rotate(n,axis,deg):
 p=r.pose.bones[n];q=p.bone.matrix_local.to_quaternion()
 p.rotation_quaternion=q.inverted()@Quaternion(axis,math.radians(deg))@q

def aim(n,target):
 p=r.pose.bones[n];q=p.matrix.to_quaternion();d=(Vector(target)-p.head).normalized()
 q=(p.tail-p.head).normalized().rotation_difference(d)@q
 p.matrix=Matrix.Translation(p.head)@q.to_matrix().to_4x4()
 bpy.context.view_layer.update()

def neutral_wrist(side,direction):
 p=r.pose.bones['c_hand_fk.'+side];q=p.matrix.to_quaternion()
 q=(p.tail-p.head).normalized().rotation_difference(direction)@q
 p.matrix=Matrix.Translation(p.head)@q.to_matrix().to_4x4()
 bpy.context.view_layer.update()

def level_arm(side,contact):
 # The forearm and hand form one straight horizontal line. Solve the elbow
 # in that plane, then split that line at the real forearm length.
 a=r.pose.bones['c_arm_fk.'+side];b=r.pose.bones['c_forearm_fk.'+side]
 sh=a.head.copy();l1=a.length;l2=b.length;extended=l2+PALM.y
 dz=contact.z-sh.z
 if abs(dz)>=l1:raise RuntimeError('hold height outside upper-arm range')
 projected=math.sqrt(l1*l1-dz*dz)
 dxy=Vector((contact.x-sh.x,contact.y-sh.y,0));distance=dxy.length
 if not abs(projected-extended)<distance<projected+extended:
  raise RuntimeError(f'level cradle unreachable: {side}, shoulder={list(sh)}, contact={list(contact)}, lengths={projected,extended}, distance={distance}')
 direction=dxy.normalized();along=(projected**2-extended**2+distance**2)/(2*distance)
 height=math.sqrt(max(0,projected**2-along**2));perp=Vector((-direction.y,direction.x,0))
 candidates=[Vector((sh.x,sh.y,contact.z))+direction*along+perp*height,
             Vector((sh.x,sh.y,contact.z))+direction*along-perp*height]
 sg=1 if side=='l'else-1
 elbow=max(candidates,key=lambda v:sg*v.x)
 fore_direction=(contact-elbow).normalized();wrist=elbow+fore_direction*l2
 aim(a.name,elbow);aim(b.name,wrist);neutral_wrist(side,fore_direction)
 actual=r.pose.bones['hand.'+side].matrix@PALM
 return {'contactErrorM':(actual-contact).length,
         'forearmTiltDeg':abs(math.degrees(math.asin(max(-1,min(1,fore_direction.z))))),
         'wristDirectionErrorDeg':math.degrees((r.pose.bones['hand.'+side].tail-r.pose.bones['hand.'+side].head).normalized().angle(fore_direction))}

reset();rotate('c_spine_01.x',(1,0,0),8)
# Natural shoulder protraction for a hug; bone lengths and scales are unchanged.
for side,sign in [('l',-1),('r',1)]:rotate('c_shoulder.'+side,(0,0,1),sign*38)
bpy.context.view_layer.update()
delta=r.pose.bones['spine_05.x'].matrix@spineBase.inverted();head_target=delta@headBase
p=r.pose.bones['c_head.x'];p.matrix=Matrix.Translation(head_target.translation)@headBase.to_quaternion().to_matrix().to_4x4()
bpy.context.view_layer.update()
arm_checks={}
for side,sign in [('l',1),('r',-1)]:arm_checks[side]=level_arm(side,CARRY+Vector((sign*G.x,G.y,G.z)))
print('LEVEL_CRADLE',json.dumps(arm_checks),flush=True)
assert max(x['contactErrorM']for x in arm_checks.values())<.0001
assert max(x['forearmTiltDeg']for x in arm_checks.values())<.1
assert max(x['wristDirectionErrorDeg']for x in arm_checks.values())<1
holding={n:r.pose.bones[n].matrix_basis.copy()for n in base}

mounts=json.loads((P/'assets/playful-interaction-v2/reports/mounts_blender.json').read_text())
RM=Matrix(mounts['rightHandMount'])
reset();WAIST=Matrix.Translation((-.184,-.035,.355))@Matrix.Rotation(math.radians(28),4,'Y')@Matrix.Rotation(math.radians(-100),4,'X')
WAIST_BIND=r.pose.bones['root.x'].matrix.inverted()@WAIST
r.animation_data.action=bpy.data.actions['hold_scoop'];s.frame_set(1);bpy.context.view_layer.update()
scoop_hold={n:r.pose.bones[n].matrix_basis.copy()for n in base}
hold_wrist=r.pose.bones['c_hand_fk.r'].matrix.copy()
r.animation_data.action=None
waist_wrist=WAIST@RM.inverted()

def free_arm(side,target,q):
 a=r.pose.bones['c_arm_fk.'+side];b=r.pose.bones['c_forearm_fk.'+side]
 sh=a.head.copy();l1=a.length;l2=b.length;v=target-sh;d=min(v.length,l1+l2-.0003)
 direction=v.normalized();along=(l1*l1-l2*l2+d*d)/(2*d)
 pole=Vector((1 if side=='l'else-1,0,-.22));pole=(pole-direction*pole.dot(direction)).normalized()
 elbow=sh+direction*along+pole*math.sqrt(max(0,l1*l1-along*along))
 aim(a.name,elbow);aim(b.name,sh+direction*d)
 p=r.pose.bones['c_hand_fk.'+side];p.matrix=Matrix.Translation(p.head)@q.to_matrix().to_4x4()
 bpy.context.view_layer.update()
 return max(0,v.length-d)

def blend_pose(u):
 for n in base:
  pa,qa,sa=base[n].decompose();pb,qb,sb=holding[n].decompose()
  r.pose.bones[n].matrix_basis=Matrix.LocRotScale(pa.lerp(pb,u),qa.slerp(qb,u),sa.lerp(sb,u))
 bpy.context.view_layer.update()

def bezier(a,b,c,d,u):return (1-u)**3*a+3*(1-u)**2*u*b+3*(1-u)*u*u*c+u**3*d

def flight(start,end,t):
 u=smooth(t)
 # The path stays in front of the actor and approaches the waiting hands level.
 c1=start.lerp(end,.30);c2=start.lerp(end,.75)
 if end.z>start.z:c1.z=end.z*.90;c2.z=end.z+.035
 else:c1.z=start.z+.02;c2.z=max(end.z+.06,start.z*.35)
 return bezier(start,c1,c2,end,u)

spec={
 'stow_scoop':{'duration':1.4,'layer':'right_arm','loop':False,'events':[{'time':.9,'type':'waist_attach'}]},
 'unstow_scoop':{'duration':1.4,'layer':'right_arm','loop':False,'events':[{'time':.5,'type':'hand_attach'}]},
 'chess_pickup':{'duration':1.8,'layer':'full_body','loop':False,'events':[{'time':.4,'type':'summon_start'},{'time':1.2,'type':'grasp'}]},
 'chess_hold':{'duration':1.6,'layer':'full_body','loop':True,'events':[]},
 'chess_carry_start':{'duration':.8,'layer':'full_body','loop':False,'distanceM':.045,'events':[]},
 'chess_carry_walk':{'duration':1.6,'layer':'full_body','loop':True,'strideM':.18,'speedMps':.1125,'events':[]},
 'chess_carry_stop':{'duration':.8,'layer':'full_body','loop':False,'distanceM':.045,'events':[]},
 'chess_place':{'duration':1.8,'layer':'full_body','loop':False,'events':[{'time':.4,'type':'release'},{'time':1.2,'type':'placement_gate'},{'time':1.3,'type':'land_confirmed'}]},
 'chess_capture_place':{'duration':1.8,'layer':'full_body','loop':False,'events':[{'time':.4,'type':'release'},{'time':1.1,'type':'capture_commit_gate'},{'time':1.5,'type':'land_confirmed'}]},
 'chess_safe_setdown':{'duration':1.6,'layer':'full_body','loop':False,'events':[{'time':.4,'type':'release'},{'time':1.2,'type':'setdown_gate'}]},
 'chess_recover':{'duration':1.8,'layer':'full_body','loop':False,'events':[{'time':.4,'type':'summon_start'},{'time':1.2,'type':'grasp'}]},
}
for cm in [1,2,4,6,8]:spec[f'chess_carry_adjust_{cm:02d}']={'duration':.8,'layer':'full_body','loop':False,'distanceM':cm/100,'events':[]}
walks={}
for dst,src in [('chess_carry_start','walk_start'),('chess_carry_walk','walk'),('chess_carry_stop','walk_stop')]+[(f'chess_carry_adjust_{cm:02d}',f'walk_adjust_{max(2,cm):02d}')for cm in [1,2,4,6,8]]:
 r.animation_data.action=bpy.data.actions[src];rows=[]
 for i in range(round(spec[dst]['duration']*30)+1):
  s.frame_set(1+i);bpy.context.view_layer.update();row={n:r.pose.bones[n].matrix_basis.copy()for n in ['c_foot_ik.l','c_foot_ik.r']}
  if dst=='chess_carry_adjust_01':
   for M in row.values():M.translation*=.5
  rows.append(row)
 walks[dst]=rows
r.animation_data.action=None

def applypose(name,t):
 reset();center=GROUND.copy();phase='ground';clamp=0
 if name in ['stow_scoop','unstow_scoop']:
  tt=t if name=='stow_scoop'else 1.4-t;u=smooth(tt/.9)
  for n,M in scoop_hold.items():r.pose.bones[n].matrix_basis=M
  bpy.context.view_layer.update()
  target=hold_wrist.translation.lerp(waist_wrist.translation,u)
  target.x+=.014*math.sin(math.pi*u);target.y-=.012*math.sin(math.pi*u)
  q=hold_wrist.to_quaternion().slerp(waist_wrist.to_quaternion(),u)
  if tt>.9:
   v=smooth((tt-.9)/.5);target=waist_wrist.translation.lerp(Vector(base_hand_position['r']),v);q=waist_wrist.to_quaternion().slerp(base_hand_q['r'],v)
  clamp=free_arm('r',target,q)
  scM=r.pose.bones['hand.r'].matrix@RM if tt<.9 else WAIST
  return center,scM,clamp,'waist'if tt>=.9 else'hand'
 if name in ['chess_pickup','chess_recover']:
  blend_pose(smooth(t/.4))
  if t<.4:phase='ground'
  elif t<1.2:center=flight(GROUND,CARRY,(t-.4)/.8);phase='transferring'
  else:center=CARRY.copy();phase='carried'
 elif name in ['chess_place','chess_capture_place','chess_safe_setdown']:
  blend_pose(1-smooth((t-.5)/1.0))
  center=CARRY.copy();phase='carried'
  if t>=.4:
   phase='transferring'
   if name=='chess_capture_place':
    hover=GROUND+Vector((0,0,HEIGHT+.012))
    if t<=1.1:center=flight(CARRY,hover,(t-.4)/.7)
    elif t<1.2:center=hover
    else:center=hover.lerp(GROUND,smooth((t-1.2)/.3))
    if t>=1.5:phase='ground'
   else:
    center=flight(CARRY,GROUND,(t-.4)/.8)
    if t>=1.2:phase='ground'
 else:
  blend_pose(1);center=CARRY.copy();phase='carried'
  if name in walks:
   row=walks[name][min(round(t*30),len(walks[name])-1)]
   for n,M in row.items():r.pose.bones[n].matrix_basis=M
   bpy.context.view_layer.update()
 scM=r.pose.bones['root.x'].matrix@WAIST_BIND
 return center,scM,clamp,phase

reset();base_hand_position={side:list(r.pose.bones['c_hand_fk.'+side].head)for side in ['l','r']};base_hand_q={side:r.pose.bones['c_hand_fk.'+side].matrix.to_quaternion().copy()for side in ['l','r']}
if '--probe-only'in sys.argv:sys.exit(0)
report={};guides={};poseRows={}

def keypose(f):
 for n in controls:
  for ch in ['location','rotation_quaternion','scale']:r.pose.bones[n].keyframe_insert(data_path=ch,frame=f,group=n)

def linear(a):
 for l in a.layers:
  for st in l.strips:
   for cb in st.channelbags:
    for fc in cb.fcurves:
     for kp in fc.keyframe_points:kp.interpolation='LINEAR'

for name,sp in spec.items():
 r.animation_data.action=None;rows=[];palm=[];clamps=[];snaps=[]
 times=sorted(set([i/15 for i in range(round(sp['duration']*15)+1)]+[e['time']for e in sp['events']]+[sp['duration']]))
 for t in times:
  f=1+t*30;s.frame_set(int(f),subframe=f%1);center,scM,c,phase=applypose(name,t);keypose(f);clamps.append(c)
  rows.append({'time':t,'chess':{'position':list(center),'quaternion_wxyz':[1,0,0,0]},'scoop':{'position':list(scM.translation),'quaternion_wxyz':list(scM.to_quaternion())},'phase':phase})
  err=[]
  if phase=='carried':
   for side,sign in [('l',1),('r',-1)]:err.append(((r.pose.bones['hand.'+side].matrix@PALM)-(center+Vector((sign*G.x,G.y,G.z)))).length)
  palm.extend(err);snaps.append({'time':t,'phase':phase,'contactErrorM':max(err,default=0)})
 action=r.animation_data.action;action.name=name;action.use_fake_user=True;linear(action)
 report[name]={'maxTargetClampM':max(clamps),'maxPalmErrorWhileAttachedM':max(palm,default=0),'levelCradle':arm_checks};guides[name]=rows;poseRows[name]=snaps
 assert max(clamps)<.0005;assert max(palm,default=0)<.0001
 print('AUTHORED',name,report[name]['maxPalmErrorWhileAttachedM'],flush=True)
 for ob,label in [(piece,'chess'),(scoop,'scoop')]:
  ob.animation_data_create();ob.animation_data.action=None;ob.rotation_mode='QUATERNION'
  for row in rows:
   ob.location=row[label]['position'];ob.rotation_quaternion=row[label]['quaternion_wxyz'];ob.scale=(1,1,1)
   for ch in ['location','rotation_quaternion','scale']:ob.keyframe_insert(data_path=ch,frame=1+row['time']*30)
  ob.animation_data.action.name=name+'_'+label+'_GUIDE';ob.animation_data.action.use_fake_user=True;linear(ob.animation_data.action)
r.animation_data.action=bpy.data.actions['chess_hold'];piece.animation_data.action=bpy.data.actions['chess_hold_chess_GUIDE'];scoop.animation_data.action=bpy.data.actions['chess_hold_scoop_GUIDE'];scoop.hide_render=False;scoop.hide_set(False);s.frame_start=1;s.frame_end=49;s.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(A/'authoring/Whale_Chess_EDITABLE.blend'))
for label,value in [('spec',spec),('authoring',report),('prop_guides_blender',guides),('palm_samples',poseRows)]: (A/'reports'/f'{label}.json').write_text(json.dumps(value,indent=2))
(A/'reports/anchors_blender.json').write_text(json.dumps({'pieceGroundCenter':list(GROUND),'pieceRadiusM':RADIUS,'bodyProfileRadiusHeight':[list(v)for v in profile[1:]],'pieceHeightM':HEIGHT,'gripLeft':list(G),'gripRight':[-G.x,G.y,G.z],'palmBoneLocal':list(PALM),'carryBottomHeightM':CARRY.z,'waistWorldInReferencePose':[list(v)for v in WAIST],'scoopHandMount':[list(v)for v in RM],'waistBone':'root.x','waistBoneLocal':[list(v)for v in WAIST_BIND],'sourceSha256':hashlib.sha256(SRC.read_bytes()).hexdigest(),'levelCradle':arm_checks,'pickupStyle':'user-approved magic flight into level two-hand cradle','boardScale':SCALE},indent=2))
