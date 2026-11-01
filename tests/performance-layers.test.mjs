import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LayeredMotionPlayer } from '../src/character/LayeredMotionPlayer.ts';

const IDENTITY = [0, 0, 0, 1];
const RAISED = [0.7071068, 0, 0, 0.7071068]; // 抬起 90°

function rig() {
  const root = new THREE.Group();
  const bones = {};
  for (const name of ['root.x', 'hand.l', 'hand.r']) {
    const bone = new THREE.Object3D();
    bone.name = name;
    root.add(bone);
    bones[name] = bone;
  }
  const quat = (name, value, duration = 1) =>
    new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, duration], [...IDENTITY, ...value]);
  // 恒定姿势：整段都保持 value（用于"上一段动作停在某处的残留"）
  const hold = (name, value, duration = 1) =>
    new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, duration], [...value, ...value]);
  const pos = (name, duration = 1) =>
    new THREE.VectorKeyframeTrack(`${name}.position`, [0, duration], [0, 0, 0, 0, 0, 0]);
  const clip = (name, tracks, duration = 1) => new THREE.AnimationClip(name, duration, tracks);
  const clips = [
    clip('idle_stand.lower', [pos('root.x', 2)], 2),
    clip('idle_stand.upperBase', [quat('hand.l', IDENTITY, 2), quat('hand.r', IDENTITY, 2)], 2),
    clip('tail_idle', [quat('hand.l', IDENTITY, 2)], 2),
    clip('tail_swish', [quat('hand.l', IDENTITY, 2)], 2),
    // 上一段动作：把右手抬到 90°（模拟"平举"后的残留）
    clip('raise_right', [pos('root.x'), hold('hand.l', RAISED), hold('hand.r', RAISED)]),
    // 持物层：只写右臂，把右手抬起来
    clip('hold_like', [hold('hand.r', RAISED)]),
    // 投盆类动作：clip 只管左臂与身体，右手不在轨道里
    clip('throw_like', [pos('root.x'), quat('hand.l', IDENTITY)]),
  ];
  return { root, player: new LayeredMotionPlayer(root, clips), bones };
}

const advance = (player, frames, dt = 1 / 60) => {
  for (let i = 0; i < frames; i++) player.update(dt);
};

test('片段没接管的骨骼会回到静姿，不会冻在上一段的最后一帧', () => {
  const { player, bones } = rig();
  // 右手举着东西（持物层），这是真实场景里"平举"的来源
  player.setHold('right_hand', player.actions.get('hold_like').getClip());
  advance(player, 10);
  assert.ok(Math.abs(bones['hand.r'].quaternion.w - RAISED[3]) < 0.05, '先要把右手摆到抬起状态');

  // 东西放下、持物层让位，再播一个不接管右手的动作（投盆类）
  player.setHoldEnabled('right_hand', false);
  void player.perform('throw_like', [], () => {}, 'full_except_right_arm');
  advance(player, 10);
  const during = bones['hand.r'].quaternion.clone();
  assert.ok(Math.abs(during.w - 1) < 0.02, `右手应回到静姿，实际 w=${during.w.toFixed(3)}`);
});
