"""Append only new animation accessors to an untouched copy of accepted blink model."""
import json,struct,copy,hashlib,math,shutil
from pathlib import Path
import numpy as np
P=Path.cwd();A=P/'assets/xiangqi-v1';O=P/'public/models/xiangqi-v1';BASE=P/'public/models/blink-material-v2/character_material_only.glb'
def load(p):
 raw=p.read_bytes();n=struct.unpack_from('<I',raw,12)[0];g=json.loads(raw[20:20+n]);off=20+n;return g,bytearray(raw[off+8:off+8+struct.unpack_from('<I',raw,off)[0]])
def save(p,g,b):
 g['buffers']=[{'byteLength':len(b)}];j=json.dumps(g,separators=(',',':'),ensure_ascii=False).encode();j+=b' '*((-len(j))%4);b+=b'\0'*((-len(b))%4);tmp=p.with_suffix(p.suffix+'.pending');tmp.write_bytes(struct.pack('<III',0x46546c67,2,28+len(j)+len(b))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(b),0x004e4942)+b);tmp.replace(p)
g,b=load(BASE);original=copy.deepcopy(g);originalBinary=bytes(b);src,sb=load(A/'authoring/chess_baked_source.glb');nodes={n.get('name'):i for i,n in enumerate(g['nodes'])};spec=json.loads((A/'reports/spec.json').read_text());oldcat=json.loads((P/'public/models/playful-v2/catalog.json').read_text());wanted=set(oldcat['armMasks']['right_arm']);cache={};views={};tracks={}
# Direct 30 Hz sampling avoids a second export/resampling pass through Blender's
# animation exporter. Map world poses onto the accepted skeleton's exact rest axes.
C=np.array([[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]],float)
def nodeMat(n):
 if 'matrix' in n:return np.array(n['matrix']).reshape(4,4).T
 x,y,z,w=n.get('rotation',[0,0,0,1]);R=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],[2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],[2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])
 M=np.eye(4);M[:3,:3]=R@np.diag(n.get('scale',[1,1,1]));M[:3,3]=n.get('translation',[0,0,0]);return M
world={};nodeParent={}
def visit(i,pa):
 world[i]=pa@nodeMat(g['nodes'][i])
 for child in g['nodes'][i].get('children',[]):nodeParent[child]=i;visit(child,world[i])
for i in g['scenes'][g.get('scene',0)]['nodes']:visit(i,np.eye(4))
rest=json.loads((A/'reports/skeleton_rest.json').read_text());K={name:np.linalg.inv(np.array(mm))@C.T@world[nodes[name]]for name,mm in rest.items()}
def quatFromMatrix(R):
 tr=np.trace(R)
 if tr>0:
  s=math.sqrt(tr+1)*2;q=np.array([(R[2,1]-R[1,2])/s,(R[0,2]-R[2,0])/s,(R[1,0]-R[0,1])/s,.25*s])
 else:
  i=int(np.argmax(np.diag(R)));j=(i+1)%3;k=(i+2)%3;s=math.sqrt(max(0,1+R[i,i]-R[j,j]-R[k,k]))*2;q=np.zeros(4);q[i]=.25*s;q[3]=(R[k,j]-R[j,k])/s;q[j]=(R[j,i]+R[i,j])/s;q[k]=(R[k,i]+R[i,k])/s
 return q/np.linalg.norm(q)
def appendAccessor(values,kind):
 arr=np.array(values,dtype='<f4');b.extend(b'\0'*((-len(b))%4));vi=len(g['bufferViews']);g['bufferViews'].append({'buffer':0,'byteOffset':len(b),'byteLength':arr.nbytes});b.extend(arr.tobytes());a={'bufferView':vi,'componentType':5126,'count':len(arr),'type':kind}
 if kind=='SCALAR':a.update(min=[float(arr.min())],max=[float(arr.max())])
 ai=len(g['accessors']);g['accessors'].append(a);return ai
snapshots=json.loads((A/'reports/source_matrices.json').read_text())
for name,sp in spec.items():
 assert not any(a['name']==name for a in g['animations']);rows=snapshots[name];time=appendAccessor([r['time']for r in rows],'SCALAR');names=[n for n in rest if name not in ['stow_scoop','unstow_scoop']or n in wanted];values={n:{'translation':[],'rotation':[],'scale':[]}for n in names};last={}
 for row in rows:
  ww={nodes[n]:C@np.array(mm).reshape(4,4)@K[n]for n,mm in row['matrices'].items()}
  for n in names:
   ni=nodes[n];pa=nodeParent.get(ni);parent=ww.get(pa,world.get(pa,np.eye(4)));local=np.linalg.inv(parent)@ww[ni];sc=np.linalg.norm(local[:3,:3],axis=0);R=local[:3,:3]/sc;u,_,v=np.linalg.svd(R);q=quatFromMatrix(u@v)
   if n in last and q@last[n]<0:q=-q
   last[n]=q;values[n]['translation'].append(local[:3,3]);values[n]['rotation'].append(q);values[n]['scale'].append(sc)
 a={'name':name,'samplers':[],'channels':[]};tr=[]
 for n in names:
  for path,kind in [('translation','VEC3'),('rotation','VEC4'),('scale','VEC3')]:
   output=appendAccessor(values[n][path],kind);si=len(a['samplers']);a['samplers'].append({'input':time,'output':output,'interpolation':'LINEAR'});a['channels'].append({'sampler':si,'target':{'node':nodes[n],'path':path}});tr.append({'bone':n,'path':path})
 g['animations'].append(a);tracks[name]=tr
save(O/'character_xiangqi.glb',g,b)

# A lightweight motion-only alternative with the same node names, requiring name rebinding.
m=copy.deepcopy(g);m['animations']=m['animations'][len(original['animations']):]
for n in m['nodes']:
 for key in ['mesh','skin','weights']:n.pop(key,None)
for key in ['meshes','skins','images','textures','materials','samplers']:m.pop(key,None)
# Compact binary: motions only, no unused character texture payload.
oldg=g;oldb=b;mb=bytearray();newacc=[];newviews=[];amap={};vmap={}
for anim in m['animations']:
 for sa in anim['samplers']:
  for key in ['input','output']:
   ai=sa[key]
   if ai not in amap:
    aa=copy.deepcopy(oldg['accessors'][ai]);vi=aa['bufferView']
    if vi not in vmap:
     vv=copy.deepcopy(oldg['bufferViews'][vi]);off=vv.get('byteOffset',0);mb.extend(b'\0'*((-len(mb))%4));vv['byteOffset']=len(mb);mb.extend(oldb[off:off+vv['byteLength']]);vmap[vi]=len(newviews);newviews.append(vv)
    aa['bufferView']=vmap[vi];amap[ai]=len(newacc);newacc.append(aa)
   sa[key]=amap[ai]
m['accessors']=newacc;m['bufferViews']=newviews;save(O/'motions.glb',m,mb)
C=np.array([[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]],float)
def cv(v):return[v[0],v[2],-v[1]]
anchors=json.loads((A/'reports/anchors_blender.json').read_text())
def nodeMat(n):
 if 'matrix' in n:return np.array(n['matrix']).reshape(4,4).T
 x,y,z,w=n.get('rotation',[0,0,0,1]);R=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],[2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],[2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])
 M=np.eye(4);M[:3,:3]=R@np.diag(n.get('scale',[1,1,1]));M[:3,3]=n.get('translation',[0,0,0]);return M
world={}
def visit(i,pa):
 world[i]=pa@nodeMat(g['nodes'][i])
 for child in g['nodes'][i].get('children',[]):visit(child,world[i])
for i in g['scenes'][g.get('scene',0)]['nodes']:visit(i,np.eye(4))
rest=json.loads((A/'reports/skeleton_rest.json').read_text());K={name:np.linalg.inv(np.array(mm))@C.T@world[nodes[name]]for name,mm in rest.items()}
def boneBinding(bone,mm):return list((np.linalg.inv(K[bone])@np.array(mm)@C.T).T.ravel())
palmLocal={side:list((np.linalg.inv(K['hand.'+side])@np.array([*anchors['palmBoneLocal'],1]))[:3])for side in ['l','r']}

def q(v):return[v[1],v[3],-v[2],v[0]]
guides=json.loads((A/'reports/prop_guides_blender.json').read_text());anchors=json.loads((A/'reports/anchors_blender.json').read_text());motion={'space':'actor local, glTF +Y up +Z forward, meters','clips':{}}
for name,rows in guides.items():
 motion['clips'][name]={key:[{'time':row['time'],'position':cv(row[key]['position']),'quaternion':q(row[key]['quaternion_wxyz'])}for row in rows]for key in ['chess','scoop']}
(O/'prop_motion.json').write_text(json.dumps(motion,indent=2));(O/'tracks.json').write_text(json.dumps(tracks,indent=2))
layout=[];order=[('rook',4),('horse',3),('elephant',2),('advisor',1),('general',0),('advisor',1),('elephant',2),('horse',3),('rook',4)]
for side,home,cannons,soldiers in [('black',0,2,3),('red',9,7,6)]:
 counts={};pts=[(kind,t,home,col)for col,(kind,t)in enumerate(order)]+[('cannon',5,cannons,col)for col in [1,7]]+[('soldier',6,soldiers,col)for col in [0,2,4,6,8]]
 for kind,template,row,col in pts:
  counts[kind]=counts.get(kind,0)+1;layout.append({'pieceId':f'{side}_{kind}_{counts[kind]}','side':side,'kind':kind,'template':f'piece_{side}_{template}','row':row,'col':col,'position':[(col-4)*1.15,0,(row-4.5)*1.15],'rotationY':math.pi if side=='black'else 0})
(O/'initial_layout.json').write_text(json.dumps(layout,ensure_ascii=False,indent=2))
cat={'assetVersion':'xiangqi-assets-v1','status':'authored assets; host rules/state/navigation not integrated','rigVersion':oldcat['rigVersion'],'extends':'/models/playful-v2/catalog.json','catalogRole':'additive extension; retain existing prop/actions catalog','character':'character_xiangqi.glb','motionOnly':'motions.glb','units':'meters','coordinateSystem':'glTF +Y up +Z forward; actor wrapper identity scale','fps':30,'pieces':{'file':'pieces.glb','initialLayout':'initial_layout.json','radiusM':anchors['pieceRadiusM'],'radiusToCellWidth':.4,'diameterM':2*anchors['pieceRadiusM'],'heightM':anchors['pieceHeightM'],'bodyProfileRadiusHeight':anchors['bodyProfileRadiusHeight'],'visualOuterRadiusIncludingEdgeRingM':.17045/.17*anchors['pieceRadiusM'],'topRadiusM':.156/.17*anchors['pieceRadiusM'],'domeHeightM':.006*1.15,'sharedAtlas':'glyph_atlas.png','templates':14,'instancesInInitialPosition':32,'groundAnchor':[0,0,0],'gripsInCarrierFrame':{'left':cv(anchors['gripLeft']),'right':cv(anchors['gripRight'])},'gripPolicy':'radially symmetric side wall; contact frame follows actor, glyph yaw may retain board orientation'},'board':{'file':'board.glb','intersectionSpacingM':1.15,'extentM':[11.5,11.5],'requiredArenaM':[11.5,11.5],'row0':'black home at -Z','row9':'red home at +Z','mapping':'x=(col-4)*1.15; z=(row-4.5)*1.15; surface y=0'},'bindings':{'rightWaist':{'bone':'root.x','matrixColumnMajor':boneBinding('root.x',anchors['waistBoneLocal'])},'rightHand':oldcat['bindings']['rightHand'],'head':oldcat['bindings']['head']},'palmContact':{'bones':['hand.l','hand.r'],'boneLocalPoints':palmLocal,'toleranceM':.002},'chessAttachment':{'type':'one shared actor-local curve anchor; never independently attach to both hands','curveFile':'prop_motion.json','curveKey':'chess','referenceGroundCenter':cv(anchors['pieceGroundCenter']),'standOffM':-anchors['pieceGroundCenter'][1],'carryBottomHeightM':anchors['carryBottomHeightM'],'carryClearanceOverStationaryPieceM':anchors['carryBottomHeightM']-anchors['pieceHeightM']},'actions':[{'id':name,**sp,'clips':[name],'rootMotion':'in-place','blendInSeconds':0 if name.startswith('chess')else .12,'blendOutSeconds':0 if name.startswith('chess')else .15}for name,sp in spec.items()],'constraints':{'chessHands':'both empty; scoop stowed or elsewhere, basin worn or elsewhere','carrySpeedScale':[.75,1.25],'turnPolicy':'stop, hold, rotate whole actor and carry anchor together; no body-only yaw','blink':'retain current material eyelids with no face smoothing','layerPolicy':'chess clips own body, both arms, head and tail; disable ordinary holds/gestures/base/automatic tail until release; blink continues','captureGate':'release at .4; pause floating piece at 1.1 above victim; after commit remove victim, descend and land at 1.5','placeGate':'release at .4, float to target and pause at 1.2 until commit; both hands are already free','safeSetdown':'only from chess_hold at rest; save current pending piece/world pose, nearby unoccupied flat landing required; do not commit chess move','recover':'navigate to saved ground position then summon; no crouch, stretch or physical floor grasp','interrupt':'freeze current sampling immediately; executor must settle feet and piece onto valid nearby floor before playing static-entry setdown; arbitrary moving-phase interruption is a host integration acceptance gate'},'pickupStyle':'user-approved magic flight; cradle side middle with level forearms and neutral wrists','boardScaleFromReview':1.15,'pieceRadiusToCellWidth':.4,'latestReviewHeightMultiplier':2,'priorThinHeightM':.12765,'runtimeIntegrationVerified':False}
(O/'catalog.json').write_text(json.dumps(cat,ensure_ascii=False,indent=2))
report={'baseFile':str(BASE.relative_to(P)),'baseSha256':hashlib.sha256(BASE.read_bytes()).hexdigest(),'oldClipCount':len(original['animations']),'newClipCount':len(g['animations']),'newClips':list(spec),'nodesUnchanged':g['nodes']==original['nodes'],'meshSkinAndMaterialsUnchanged':all(g[k]==original[k]for k in ['meshes','skins','materials','images','textures']),'oldAnimationsUnchanged':g['animations'][:len(original['animations'])]==original['animations'],'baseBinaryPrefixUnchanged':bytes(b[:len(originalBinary)])==originalBinary,'motionOnlyBytes':(O/'motions.glb').stat().st_size}
assert all(report[k]for k in ['nodesUnchanged','meshSkinAndMaterialsUnchanged','oldAnimationsUnchanged','baseBinaryPrefixUnchanged'])
(A/'reports/runtime_integrity.json').write_text(json.dumps(report,indent=2));shutil.copy2(A/'reports/runtime_integrity.json',O/'integrity.json');print(json.dumps(report,indent=2))
