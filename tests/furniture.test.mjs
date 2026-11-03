import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCapabilities, validateStep } from '../server/capabilities.mjs';
import { roomContext } from '../server/public-state.mjs';
import { ROOM_FURNITURE } from '../shared/room-furniture.mjs';
import { canRoamNow, shouldEndFurnitureRest, FURNITURE_REST_MS } from '../src/behavior/roamGate.ts';

/** 家具能力与上下文：房间里的沙发/床。 */

test('use_furniture 已注册，参数只认 sofa / bed / none', () => {
  const cap = describeCapabilities().find((item) => item.id === 'use_furniture');
  assert.ok(cap, '能力表里要有 use_furniture');
  assert.ok(cap.params.furniture_id.enum.includes('sofa'));
  assert.equal(cap.persistent, true, '坐下/躺下是持续动作，要标 persistent');
  assert.deepEqual(validateStep({ action: 'use_furniture', furniture_id: 'sofa' }), { action: 'use_furniture', furniture_id: 'sofa' });
  assert.throws(() => validateStep({ action: 'use_furniture', furniture_id: 'fridge' }), /furniture_id|枚举|enum/i, '不认识的家具要拒绝');
});

test('房间里才有家具上下文，且带使用点', () => {
  assert.equal(roomContext('playground'), null, '场地里没有家具上下文');
  const room = roomContext('room');
  assert.ok(room);
  assert.equal(room.furniture.length, ROOM_FURNITURE.length);
  const sofa = room.furniture.find((item) => item.id === 'sofa');
  assert.equal(sofa.action, 'sit');
  assert.equal(sofa.use_point.x, ROOM_FURNITURE[0].use.x);
  assert.equal(sofa.use_point.z, ROOM_FURNITURE[0].use.z);
  assert.deepEqual(sofa.can, ['use_furniture']);
  const bed = room.furniture.find((item) => item.id === 'bed');
  assert.equal(bed.action, 'lie');
});

test('坐姿求解：大腿前摆、小腿向下，脚落在座面下方', async () => {
  const THREE = await import('three');
  const { solveSeatedLeg, poseForSeat } = await import('../src/character/FurniturePose.ts');
  const hip = new THREE.Vector3(0, 0.3, 0);
  const knee = new THREE.Vector3(0, 0.17, 0.01);
  const ankle = new THREE.Vector3(0, 0.07, 0);
  const solved = solveSeatedLeg(hip, knee, ankle, { hipDeg: -85, kneeDeg: 85, ankleDeg: 5 });
  assert.ok(solved.kneeNow.z > knee.z + 0.05, '膝盖应当前移');
  assert.ok(solved.kneeNow.y > knee.y, '膝盖不下沉');
  assert.ok(solved.ankleNow.y < solved.kneeNow.y, '脚踝低于膝');
  assert.ok(Math.abs(solved.ankleNow.z - solved.kneeNow.z) < 0.12, '小腿基本竖直');

  const sit = poseForSeat('sit', 0.2, 0.3);
  assert.equal(sit.hipDeg, -85);
  assert.ok(sit.dropY < 0, '坐下要下沉');
  const lie = poseForSeat('lie', 0.16, 0.3);
  assert.equal(lie.leanDeg, -90, '躺下整体后仰 90°');
});

test('坐着/躺着时禁止自主漫游，起身过渡期间也不许', () => {
  const base = {
    stateApplied: true, errorActive: false, readOnly: false, connected: true, motionOwner: 'none',
    hasDestination: false, roamBusy: false, taskActive: false, gameInProgress: false,
    phase: 'idle', walking: false, resting: true, persistentActionActive: false, persistentWeight: 0,
  };
  assert.equal(canRoamNow(base), true, '站着待机可以漫游');
  assert.equal(canRoamNow({ ...base, persistentActionActive: true }), false, '持续动作期间不能漫游');
  assert.equal(canRoamNow({ ...base, persistentWeight: 0.4 }), false, '退出过渡中也不能漫游');
  assert.equal(canRoamNow({ ...base, taskActive: true }), false, '任务中不漫游');
});

test('位姿用角色本地坐标：她走到别处坐下，腿不会留在原地', async () => {
  const THREE = await import('three');
  const { FurniturePose } = await import('../src/character/FurniturePose.ts');
  const character = new THREE.Object3D();
  const rootBone = new THREE.Bone(); rootBone.name = 'rootx'; rootBone.position.set(0, 0.34, 0);
  character.add(rootBone);
  const add = (name, x, y, z) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); rootBone.add(b); return b; };
  for (const side of ['l', 'r']) {
    const sign = side === 'l' ? 1 : -1;
    add(`thigh_twist${side}`, 0.066 * sign, -0.039, 0);
    add(`leg_stretch${side}`, 0.066 * sign, -0.171, 0.01);
    add(`foot${side}`, 0.07 * sign, -0.269, -0.033);
  }
  const pose = new FurniturePose(character, 0.2);
  pose.capture();
  // 她先走到沙发边（世界坐标变了），再坐下
  character.position.set(2, 0, -1);
  character.updateMatrixWorld(true);
  pose.sitOn('sofa', 'sit', 0.2);
  for (let i = 0; i < 40; i++) pose.update(1 / 60);
  assert.equal(pose.currentWeight, 1);
  const foot = character.getObjectByName('footl');
  const world = new THREE.Vector3();
  foot.getWorldPosition(world);
  // 坐姿会让脚略向前（FK），但必须"跟着她"到 (2,-1) 附近，而不是留在世界原点
  assert.ok(Math.abs(world.x - (2 + 0.07)) < 0.2, `脚应当跟着她走，实际 x=${world.x}`);
  assert.ok(Math.abs(world.z - (-1)) < 0.35, `脚应当跟着她走，实际 z=${world.z}`);
  assert.ok(world.y < 0.4, `脚不应该飞起来，实际 y=${world.y}`);
});

test('休息到点才算结束：坐着/躺着不会永远持续', () => {
  assert.equal(shouldEndFurnitureRest(1000, 0), false, '没在休息');
  assert.equal(shouldEndFurnitureRest(1000, 2000), false, '还没到点');
  assert.equal(shouldEndFurnitureRest(2000, 2000), true, '到点结束');
  assert.ok(FURNITURE_REST_MS > 0);
});
