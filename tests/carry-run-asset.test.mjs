import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LayeredMotionPlayer } from '../src/character/LayeredMotionPlayer.ts';
import { XiangqiBoard } from '../src/game/XiangqiBoard.ts';

globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class extends Event { constructor(type, opts = {}) { super(type); Object.assign(this, opts); } };

async function rig() {
  const raw = fs.readFileSync('public/models/xiangqi-v1/character_xiangqi.glb');
  const size = raw.readUInt32LE(12);
  const j = JSON.parse(raw.subarray(20, 20 + size));
  const offset = 28 + size, length = raw.readUInt32LE(offset - 8);
  j.buffers[0].uri = 'data:application/octet-stream;base64,' + raw.subarray(offset, offset + length).toString('base64');
  // Retain the actual authored hierarchy and animation; Node needs no textures.
  for (const n of j.nodes) { delete n.mesh; delete n.skin; }
  j.meshes = []; j.skins = []; j.images = []; j.textures = []; j.materials = [];
  for (const a of j.animations) a.channels = a.channels.filter(c => c.target.path !== 'weights');
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(j), '');
  const root = new THREE.Group(); root.add(gltf.scene);
  return { root, player: new LayeredMotionPlayer(root, gltf.animations) };
}

test('真实模型抱棋跑：双手相对棋子的距离稳定，起伏随手，整段位移精确', async () => {
  const { root, player } = await rig();
  player.setCarrying(true);
  const board = new XiangqiBoard(new THREE.Scene());
  board.curves = JSON.parse(fs.readFileSync('public/models/xiangqi-v1/prop_motion.json')).clips;
  const piece = new THREE.Group(); root.add(piece);
  board.instances.set('test-piece', piece); board.carried.add('test-piece');
  const nodes = [];
  root.traverse(node => nodes.push(node));
  const hands = ['handl', 'handr'].map(name => nodes.find(node => node.name.replace(/[^a-z0-9]/gi, '').toLowerCase() === name));
  assert.ok(hands.every(Boolean));
  board.followCarry(player.carrySample.clip, player.carrySample.time);
  root.updateMatrixWorld(true);
  const relative = hand => piece.getWorldPosition(new THREE.Vector3()).applyMatrix4(hand.matrixWorld.clone().invert());
  const baseline = hands.map(relative);
  assert.equal(player.runDistance(1.744), true);
  let moved = 0, frames = 0;
  while (player.moving && frames++ < 400) {
    player.update(1 / 60); moved += player.movementDelta;
    root.position.z += player.movementDelta; root.updateMatrixWorld(true);
    const sample = player.carrySample;
    assert.ok(sample);
    board.followCarry(sample.clip, sample.time, sample.handTransform);
    root.updateMatrixWorld(true);
    for (let i = 0; i < hands.length; i++) {
      assert.ok(relative(hands[i]).distanceTo(baseline[i]) < 0.002, `hand ${i} lost its grip at frame ${frames}`);
    }
  }
  assert.equal(player.state.base, 'idle_stand');
  assert.ok(Math.abs(moved - 1.744) < 1e-6);
  assert.ok(frames <= 290, '1.744m should take about 4.8 seconds, not slow-walk duration');
});

test('真实模型组合抱棋：走、跑、微调和点头都保持双手抓握', async () => {
  const { root, player } = await rig();
  player.setCarrying(true);
  const board = new XiangqiBoard(new THREE.Scene());
  board.curves = JSON.parse(fs.readFileSync('public/models/xiangqi-v1/prop_motion.json')).clips;
  const piece = new THREE.Group(); root.add(piece);
  board.instances.set('piece', piece); board.carried.add('piece');
  const hands = [];
  root.traverse(node => { if (['handl', 'handr'].includes(node.name.replace(/[^a-z0-9]/gi, '').toLowerCase())) hands.push(node); });
  assert.equal(hands.length, 2);
  const follow = () => {
    const sample = player.carrySample;
    assert.ok(board.followCarry(sample.clip, sample.time, sample.handTransform));
    root.updateMatrixWorld(true);
  };
  const relative = hand => piece.getWorldPosition(new THREE.Vector3()).applyMatrix4(hand.matrixWorld.clone().invert());
  follow(); const baseline = hands.map(relative);
  assert.equal(player.gesture('greet'), false, '双手被占用时不能假装挥手成功');
  for (const [method, distance] of [['walkDistance', .27], ['adjustDistance', .01], ['adjustDistance', .08], ['runDistance', .464]]) {
    assert.equal(player[method](distance), true);
    let frames = 0, moved = 0;
    while (player.moving && frames++ < 500) {
      if (frames === 10) assert.equal(player.gesture('nod'), true);
      player.update(1 / 60); moved += player.movementDelta; root.position.z += player.movementDelta;
      follow();
      hands.forEach((hand, i) => assert.ok(relative(hand).distanceTo(baseline[i]) < .002, `${method}: hand ${i}, frame ${frames}`));
    }
    assert.ok(frames < 500);
    assert.ok(Math.abs(moved - distance) < 1e-6);
  }
});

test('真实模型长距离正常走路连续复用步态并精确累计位移', async () => {
  const { player } = await rig();
  assert.equal(player.runDistance(5.904), true);
  let moved = 0, frames = 0;
  while (player.moving && frames++ < 2000) { player.update(1 / 60); moved += player.movementDelta; }
  assert.ok(frames < 2000);
  assert.ok(Math.abs(moved - 5.904) < 1e-6);
  assert.equal(player.state.base, 'idle_stand');
});
