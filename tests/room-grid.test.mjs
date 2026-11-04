import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ROOM_LAYOUT, ROOM_GRID, ROOM_FURNITURE, roomFootprint } from '../shared/room-furniture.mjs';
import { buildRoom, ROOM_DEF } from '../src/scene/room.ts';
import { navigationPath, inside, expandObstacle } from '../src/scene/navigation.ts';
import { roomContext } from '../server/public-state.mjs';

const close = (a,b) => assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);
test('家具可见占地边缘与完整网格吻合，所有摆放均在房间内且不重叠',()=>{
  const room=buildRoom(), solids=[];
  for(const item of ROOM_LAYOUT){
    const {col,row,cols,rows}=item.grid;
    assert.ok([col,row,cols,rows].every(Number.isInteger)); assert.ok(cols>0&&rows>0);
    assert.ok(col>=0&&row>=0&&col+cols<=ROOM_GRID.columns&&row+rows<=ROOM_GRID.rows);
    const f=roomFootprint(item.grid), object=room.root.getObjectByName(`furniture:${item.id}`);
    const bounds=new THREE.Box3().setFromObject(object);
    for(const [a,b] of [[bounds.min.x,f.minX],[bounds.max.x,f.maxX],[bounds.min.z,f.minZ],[bounds.max.z,f.maxZ]])close(a,b);
    if(item.kind!=='rug')solids.push(f);
  }
  for(let i=0;i<solids.length;i++)for(let j=i+1;j<solids.length;j++){
    const a=solids[i],b=solids[j];assert.ok(a.maxX<=b.minX||b.maxX<=a.minX||a.maxZ<=b.minZ||b.maxZ<=a.minZ);
  }
});
test('出生点、道具锚点、家具互动站位均在格心；家具之间可正常绕行',()=>{
  const room=buildRoom();
  const points=[ROOM_DEF.spawn,...Object.values(ROOM_DEF.propAnchors),...ROOM_FURNITURE.map(s=>s.use)];
  for(const p of points){
    for(const n of [p.x,p.z])close(((n+ROOM_GRID.half)/ROOM_GRID.cellSize)%1,.5);
    assert.ok(!room.obstacles.some(o=>inside(p,expandObstacle(o,.215))));
    assert.ok(navigationPath(ROOM_DEF.spawn,p,room.obstacles,3.7));
  }
  assert.ok(navigationPath(ROOM_FURNITURE[0].use,ROOM_FURNITURE[1].use,room.obstacles,3.7));
});
test('寻路和物理碰撞不越出家具占地；模型提示词与实际布局同源',()=>{
  const room=buildRoom(),context=roomContext('room');
  assert.equal(context.grid.cell_size_m,.5);assert.equal(roomContext('playground'),null);
  assert.equal(context.layout.length,ROOM_LAYOUT.length);
  for(const [i,item] of ROOM_LAYOUT.entries())assert.deepEqual(context.layout[i].footprint,roomFootprint(item.grid));
  for(const c of room.colliders){
    assert.ok(room.obstacles.some(o=>c.x-c.hx>=o.minX-1e-5&&c.x+c.hx<=o.maxX+1e-5&&c.z-c.hz>=o.minZ-1e-5&&c.z+c.hz<=o.maxZ+1e-5));
  }
  assert.equal(room.obstacles.length,4,'地毯和地面网格不阻挡角色');
  for(const spec of ROOM_FURNITURE){
    assert.ok(room.colliders.some(c=>Math.abs(c.y+c.hy-spec.surfaceY)<1e-5&&Math.abs(c.x-(spec.rest.x+.06))<c.hx&&Math.abs(c.z-spec.rest.z)<c.hz),'互动点下方有对应高度的物理支撑面');
  }
});
