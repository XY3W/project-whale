import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { LayeredMotionPlayer, MOVE_CLIPS, CARRY_ADJUST_DISTANCES } from '../src/character/LayeredMotionPlayer.ts';

const DIR = 'public/models/xiangqi-v1/';

function readGlb(file) {
  const raw = fs.readFileSync(file);
  const size = raw.readUInt32LE(12);
  const json = JSON.parse(raw.subarray(20, 20 + size).toString('utf8'));
  return json;
}

// ---------- 素材契约：抱棋动作真的在交付模型里，数值与 catalog 一致 ----------

test('交付模型带齐 14 段 chess 动作，时长与 catalog 一致', () => {
  const glb = readGlb(DIR + 'character_xiangqi.glb');
  const catalog = JSON.parse(fs.readFileSync(DIR + 'catalog.json', 'utf8'));
  const durations = new Map(glb.animations.map((a) => [a.name, glb.accessors[a.samplers[0].input].max[0]]));
  const chess = catalog.actions.filter((a) => a.id.startsWith('chess'));
  assert.equal(chess.length, 14);
  for (const action of chess) {
    assert.ok(durations.has(action.id), `缺片段 ${action.id}`);
    assert.ok(Math.abs(durations.get(action.id) - action.duration) < 1e-6, `${action.id} 时长`);
    assert.equal(action.rootMotion, 'in-place');
    assert.equal(action.layer, 'full_body');
  }
  const byId = new Map(chess.map((a) => [a.id, a]));
  assert.equal(byId.get('chess_carry_walk').strideM, 0.18);
  assert.equal(byId.get('chess_carry_walk').speedMps, 0.1125);
  assert.equal(byId.get('chess_carry_start').distanceM, 0.045);
  assert.equal(byId.get('chess_carry_stop').distanceM, 0.045);
  for (const d of CARRY_ADJUST_DISTANCES) {
    const id = `chess_carry_adjust_${String(Math.round(d * 100)).padStart(2, '0')}`;
    assert.ok(byId.has(id), `缺 ${id}`);
    assert.equal(byId.get(id).distanceM, d);
  }
  // 位移曲线与素材表逐条对齐（同钟位移的唯一来源）
  const end = (base, t) => MOVE_CLIPS[base].distance(t);
  assert.ok(Math.abs(end('chess_carry_start', 0.8) - 0.045) < 1e-9);
  assert.ok(Math.abs(end('chess_carry_stop', 0.8) - 0.045) < 1e-9);
  assert.ok(Math.abs(end('chess_carry_walk', 1.6) - 0.18) < 1e-9);
  for (const d of CARRY_ADJUST_DISTANCES) {
    const base = `chess_carry_adjust_${String(Math.round(d * 100)).padStart(2, '0')}`;
    assert.ok(Math.abs(end(base, 0.8) - d) < 1e-9);
  }
  // 循环链：起步 0.045 + 4 圈 0.18 + 停步 0.045 + 4×0.08 + 0.02 = 一格 1.15m（素材表里的满盘演示）
  const demo = 0.045 + 4 * 0.18 + 0.045 + 4 * 0.08 + 0.02;
  assert.ok(Math.abs(demo - 1.15) < 1e-9);
});

test('抱棋全身片段包含尾巴轨道，走路分层里没有，所以必须切掉尾巴', () => {
  const glb = readGlb(DIR + 'character_xiangqi.glb');
  const bones = (name) => new Set(glb.animations.find((a) => a.name === name).channels.map((c) => glb.nodes[c.target.node].name));
  const lower = bones('walk.lower');
  const upper = bones('walk.upperBase');
  const tail = bones('tail_idle');
  for (const name of ['chess_hold', 'chess_carry_start', 'chess_carry_walk', 'chess_carry_stop']) {
    const set = bones(name);
    for (const bone of set) assert.ok(lower.has(bone) || upper.has(bone) || tail.has(bone), `${name} 出现未知骨骼 ${bone}`);
    assert.ok([...set].some((b) => tail.has(b)), `${name} 应含尾巴轨道`);
    assert.ok([...set].some((b) => !tail.has(b)), `${name} 应含身体轨道`);
  }
});

// ---------- 状态机：真的用 chess_* 走、真的不摆臂 ----------

function makeRig() {
  const root = new THREE.Group();
  for (const name of ['foot.l', 'foot.r', 'hand.l', 'hand.r', 'WhaleTail_01']) {
    const o = new THREE.Object3D();
    o.name = name;
    root.add(o);
  }
  return root;
}

// 轨道名与真实素材同构：walk 分层只有下半身/上半身，尾巴单独一层
const LOWER = 'foot.l.position';
const UPPER = 'hand.l.quaternion';
const TAIL = 'WhaleTail_01.quaternion';
const track = (name, value, duration) =>
  new THREE.VectorKeyframeTrack(name, [0, duration], [0, 0, 0, value, value, value]);
const clip = (name, tracks, duration = 1.6) => new THREE.AnimationClip(name, duration, tracks);

function makeClips() {
  const split = (base, duration) => [
    clip(`${base}.lower`, [track(LOWER, 0, duration)], duration),
    clip(`${base}.upperBase`, [track(UPPER, 0, duration)], duration),
  ];
  const clips = [
    ...split('idle_stand', 2),
    ...split('walk_start', 0.8), ...split('walk', 1.6), ...split('walk_stop', 0.8),
    ...split('run_start', 0.4), ...split('run', 0.8), ...split('run_stop', 0.4),
    ...split('walk_adjust_02', 0.8), ...split('walk_adjust_04', 0.8),
    ...split('walk_adjust_06', 0.8), ...split('walk_adjust_08', 0.8),
    clip('tail_idle', [track(TAIL, 0, 2)]),
    clip('tail_swish', [track(TAIL, 0.1, 1)]),
  ];
  for (const [name, duration] of [['chess_hold', 1.6], ['chess_carry_start', 0.8], ['chess_carry_walk', 1.6], ['chess_carry_stop', 0.8],
    ['chess_carry_adjust_01', 0.8], ['chess_carry_adjust_02', 0.8], ['chess_carry_adjust_04', 0.8],
    ['chess_carry_adjust_06', 0.8], ['chess_carry_adjust_08', 0.8]]) {
    clips.push(clip(name, [track(LOWER, 0, duration), track(UPPER, 0, duration), track(TAIL, 0, duration)], duration));
  }
  return clips;
}

function run(player, seconds, onFrame) {
  const dt = 1 / 60;
  let moved = 0;
  for (let t = 0; t < seconds; t += dt) {
    player.update(dt);
    moved += player.movementDelta;
    onFrame?.(t);
    if (!player.moving && t > dt * 2) break;
  }
  return moved;
}

test('抱棋时走路换成 chess_* 一套，位移与片段同钟，落地回到 chess_hold', () => {
  const player = new LayeredMotionPlayer(makeRig(), makeClips());
  assert.equal(player.state.base, 'idle_stand');
  assert.equal(player.setCarrying(true), true);
  assert.equal(player.state.base, 'chess_hold');
  assert.equal(player.state.resting, true);
  assert.equal(player.state.carrying, true);

  // 抱棋片段的尾巴轨道被剔除，只留下半身 + 上半身
  assert.deepEqual(player.carryTrackCounts, { lower: 1, upper: 1 });

  const bases = new Set();
  assert.equal(player.walkDistance(0.27), true);
  const moved = run(player, 10, () => bases.add(player.state.base));
  assert.ok(Math.abs(moved - 0.27) < 1e-6, `位移 ${moved} 应等于 0.27`);
  assert.ok(!bases.has('walk'), '抱棋时不该出现普通走路');
  const allowed = new Set(['chess_carry_start', 'chess_carry_walk', 'chess_carry_stop', 'chess_hold']);
  for (const b of bases) assert.ok(allowed.has(b), `意外基底 ${b}`);
  assert.equal(player.state.base, 'chess_hold');
  assert.equal(player.moving, false);
});

test('抱棋微调多一档 1cm，非抱棋时不接受 1cm', () => {
  const normal = new LayeredMotionPlayer(makeRig(), makeClips());
  assert.equal(normal.adjustDistance(0.01), false);
  assert.equal(normal.adjustDistance(0.08), true);
  run(normal, 5);

  const carry = new LayeredMotionPlayer(makeRig(), makeClips());
  carry.setCarrying(true);
  assert.equal(carry.adjustDistance(0.01), true);
  assert.equal(carry.state.base, 'chess_carry_adjust_01');
  const moved = run(carry, 5);
  assert.ok(Math.abs(moved - 0.01) < 1e-6, `位移 ${moved} 应等于 0.01`);
  assert.equal(carry.state.base, 'chess_hold');
  assert.equal(carry.adjustDistance(0.05), false, '0.05 没有对应片段');
});

test('抱棋允许跑，收步回到托棋；移动中不能切换抱棋模式', () => {
  const player = new LayeredMotionPlayer(makeRig(), makeClips());
  player.setCarrying(true);
  assert.equal(player.runDistance(0.464), true);
  assert.equal(player.state.base, 'chess_carry_run_start');
  assert.equal(player.setCarrying(false), false);
  assert.ok(Math.abs(run(player, 10) - 0.464) < 1e-6);
  assert.equal(player.state.base, 'chess_hold');

  assert.equal(player.walkDistance(0.27), true);
  assert.equal(player.setCarrying(false), false, '走步中途不允许换基底');
  run(player, 10);
  assert.equal(player.setCarrying(false), true);
  assert.equal(player.state.base, 'idle_stand');
  assert.equal(player.state.carrying, false);
});

test('抱棋跑动：真实跑步下肢、固定托棋上身，位移与时长在多种帧率下一致', () => {
  for (const dt of [1 / 60, 1 / 20, 0.25]) {
    for (const speed of [0.75, 1, 1.25]) {
      const root = makeRig();
      const clips = makeClips();
      const hold = clips.find(c => c.name === 'chess_hold');
      hold.tracks = hold.tracks.map(t => t.name === UPPER
        ? new THREE.VectorKeyframeTrack('hand.l.position', [0, 1.6], [0.2, 0.5, 0.3, 0.2, 0.5, 0.3]) : t);
      for (const base of ['run_start', 'run', 'run_stop']) {
        const upper = clips.find(c => c.name === `${base}.upperBase`);
        upper.tracks = [new THREE.VectorKeyframeTrack('hand.l.position', [0, upper.duration], [9, 9, 9, -9, -9, -9])];
        const lower = clips.find(c => c.name === `${base}.lower`);
        lower.tracks = [new THREE.VectorKeyframeTrack(LOWER, [0, lower.duration], [0, 0, 0, 1, 0, 0])];
      }
      const p = new LayeredMotionPlayer(root, clips); p.speed = speed; p.setCarrying(true);
      assert.equal(p.runDistance(1.744), true);
      let moved = 0, elapsed = 0, legsMoved = false;
      const allowed = new Set(['chess_carry_run_start', 'chess_carry_run', 'chess_carry_run_stop', 'chess_hold']);
      while (p.moving && elapsed < 15) {
        p.update(dt); elapsed += dt; moved += p.movementDelta;
        assert.ok(allowed.has(p.state.base));
        assert.ok(root.getObjectByName('hand.l').position.distanceTo(new THREE.Vector3(0.2, 0.5, 0.3)) < 1e-6, 'must not inherit running arm swing');
        if (root.getObjectByName('foot.l').position.x > 0.01) legsMoved = true;
        const sample = p.carrySample;
        assert.equal(sample.clip, 'chess_hold');
        if (p.moving) assert.ok(sample.handTransform, 'running must keep a valid prop attachment');
      }
      assert.ok(legsMoved);
      assert.equal(p.moving, false);
      assert.ok(Math.abs(moved - 1.744) < 1e-6);
      assert.ok(Math.abs(elapsed - 4.8 / speed) <= dt + 1e-6);
      assert.equal(p.state.base, 'chess_hold');
    }
  }
});

test('抱棋跑动曲线跟随手部上下起伏，而不是棋子悬在原地', async () => {
  const { XiangqiBoard } = await import('../src/game/XiangqiBoard.ts');
  const board = new XiangqiBoard(new THREE.Scene());
  board.curves = { chess_hold: { chess: [{ time: 0, position: [0.2, 0.5, 0.3], quaternion: [0, 0, 0, 1] }] } };
  const obj = new THREE.Group(); board.instances.set('piece', obj); board.carried.add('piece');
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.04, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.1), new THREE.Vector3(1, 1, 1));
  const expected = obj.position.clone().set(0.2, 0.5, 0.3).applyMatrix4(transform);
  assert.equal(board.followCarry('chess_hold', 0, transform), true);
  assert.ok(obj.position.distanceTo(expected) < 1e-6);
  assert.ok(Math.abs(obj.quaternion.angleTo(new THREE.Quaternion().setFromRotationMatrix(transform))) < 1e-6);
});

test('互动片段播放期间切抱棋：先记状态，片段收尾才落到 chess_hold', async () => {
  const clips = makeClips();
  clips.push(clip('chess_pickup', [track(LOWER, 0, 0.5), track(UPPER, 0, 0.5)], 0.5));
  const player = new LayeredMotionPlayer(makeRig(), clips);
  const done = player.perform('chess_pickup', [{ time: 0.2, type: 'grasp' }], () => {});
  assert.equal(player.setCarrying(true), true);
  assert.equal(player.state.base, 'idle_stand', '片段没结束前不换基底');
  for (let t = 0; t < 2; t += 1 / 60) player.update(1 / 60);
  assert.equal(await done, true);
  assert.equal(player.state.base, 'chess_hold');
  assert.equal(player.state.carrying, true);
  assert.equal(player.state.resting, true);
});
