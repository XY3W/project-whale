import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupRange, PICKUP_RANGE_M } from '../src/prop/pickupRange.ts';

test('拾取按三维距离判定边界，不依赖朝向', () => {
  const root = {x:0,y:0,z:0};
  assert.equal(pickupRange(root,{x:PICKUP_RANGE_M,y:0,z:0}).ok,true);
  assert.equal(pickupRange(root,{x:PICKUP_RANGE_M+.001,y:0,z:0}).ok,false);
  assert.equal(pickupRange(root,{x:0,y:1,z:0}).ok,false);
  assert.equal(pickupRange(root,{x:NaN,y:0,z:0}).ok,false);
});

test('盆和勺无论地面朝向都可瞬时进入对应手部，不能重复拾取', async () => {
  const THREE = await import('three');
  const { readFileSync } = await import('node:fs');
  const { PropItem } = await import('../src/prop/PropItem.ts');
  const base = new URL('../public/models/playful-v2/', import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL('catalog.json',base)));
  const propMotion = JSON.parse(readFileSync(new URL('prop_motion.json',base)));
  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const bones = new Map();
  for (const name of ['hand.l','hand.r','head.x']) {
    const bone = new THREE.Bone(); bone.name=name; root.add(bone);
    bones.set(name.replace(/[^A-Za-z0-9_]/g,''),bone);
  }
  root.updateMatrixWorld(true);
  for (const id of ['basin','rice_scoop']) {
    const shape = new THREE.Group(); shape.add(new THREE.Mesh(new THREE.BoxGeometry(.1,.1,.1)));
    const item = await PropItem.create({id,catalog,propMotion,charRoot:root,scene:shape,bones,parent:scene});
    item.object.rotation.set(.7,1.2,2.1);
    assert.equal(item.pickupInstant(),true);
    assert.equal(item.state,'held');
    assert.equal(item.snapshot().holder,id==='basin'?'left_hand':'right_hand');
    assert.equal(item.pickupInstant(),false);
  }
});
