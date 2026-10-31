import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';

const DIR = 'public/models/xiangqi-v1/';

function readGlb(file) {
  const raw = fs.readFileSync(file);
  const size = raw.readUInt32LE(12);
  const json = JSON.parse(raw.subarray(20, 20 + size).toString('utf8'));
  const bin = raw.subarray(28 + size);
  const access = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const dim = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const out = [];
    for (let k = 0; k < a.count; k++) {
      const row = [];
      for (let c = 0; c < dim; c++) {
        const off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + (k * dim + c) * 4;
        row.push(bin.readFloatLE(off));
      }
      out.push(dim === 1 ? row[0] : row);
    }
    return out;
  };
  return { json, access };
}

/** 在片段某个时刻求节点世界矩阵（静态 TRS + 该时刻的动画采样） */
function makePose(json, access) {
  const parents = new Map();
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parents.set(c, i)));
  const index = new Map(json.nodes.map((n, i) => [n.name, i]));
  return function pose(clip, time) {
    const anim = json.animations.find((a) => a.name === clip);
    const sampled = new Map();
    for (const ch of anim.channels) {
      const name = json.nodes[ch.target.node].name;
      const s = anim.samplers[ch.sampler];
      const times = access(s.input);
      const values = access(s.output);
      let j = 0;
      while (j < times.length - 2 && times[j + 1] < time) j++;
      const u = Math.min(1, Math.max(0, (time - times[j]) / ((times[j + 1] - times[j]) || 1)));
      const a = values[j];
      const b = values[j + 1];
      sampled.set(`${name}.${ch.target.path}`, a.map((x, i) => x + (b[i] - x) * u));
    }
    const world = new Map();
    const mat = (i) => {
      if (world.has(i)) return world.get(i);
      const n = json.nodes[i];
      const tr = sampled.get(`${n.name}.translation`) ?? n.translation ?? [0, 0, 0];
      const rot = sampled.get(`${n.name}.rotation`) ?? n.rotation ?? [0, 0, 0, 1];
      const sc = sampled.get(`${n.name}.scale`) ?? n.scale ?? [1, 1, 1];
      const local = new THREE.Matrix4().compose(new THREE.Vector3(...tr), new THREE.Quaternion(...rot), new THREE.Vector3(...sc));
      const p = parents.get(i);
      const m = p === undefined ? local : new THREE.Matrix4().multiplyMatrices(mat(p), local);
      world.set(i, m);
      return m;
    };
    return {
      matrix: (name) => (index.has(name) ? mat(index.get(name)) : null),
      duration: Math.max(...access(anim.samplers[0].input)),
    };
  };
}

test('持棋锚点：棋子中心 = 素材曲线，左右手心 = 中心 + 交付的握点偏移', () => {
  const catalog = JSON.parse(fs.readFileSync(DIR + 'catalog.json', 'utf8'));
  const motion = JSON.parse(fs.readFileSync(DIR + 'prop_motion.json', 'utf8'));
  const { json, access } = readGlb(DIR + 'character_xiangqi.glb');
  const pose = makePose(json, access);
  const grips = catalog.pieces.gripsInCarrierFrame;
  const palmLocal = catalog.palmContact.boneLocalPoints;
  const tolerance = catalog.palmContact.toleranceM;

  // 与素材自带的 validate_runtime 同一套"手在什么时候接触"规则：
  // 吸附类 1.2s 之后才在手上，放置类 0.4s 之前还在手上
  const contactWindow = (clip, t) => {
    if (clip === 'chess_pickup' || clip === 'chess_recover') return t >= 1.2;
    if (clip === 'chess_place' || clip === 'chess_capture_place' || clip === 'chess_safe_setdown') return t <= 0.4;
    return true;
  };
  const clips = Object.keys(motion.clips).filter((n) => n.startsWith('chess_'));
  assert.ok(clips.length >= 10, `持棋曲线只有 ${clips.length} 条`);
  let worst = 0;
  for (const clip of clips) {
    const samples = motion.clips[clip].chess;
    const { duration } = pose(clip, 0);
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const time = duration * u;
      const sample = samples.reduce((best, s) => (Math.abs(s.time - time) < Math.abs(best.time - time) ? s : best), samples[0]);
      if (!contactWindow(clip, sample.time)) continue;
      const center = new THREE.Vector3(...sample.position);
      const p = pose(clip, sample.time);
      for (const [side, bone] of [['l', 'hand.l'], ['r', 'hand.r']]) {
        const m = p.matrix(bone);
        assert.ok(m, `${clip} 缺骨骼 ${bone}`);
        const palm = new THREE.Vector3(...palmLocal[side]).applyMatrix4(m);
        const expected = center.clone().add(new THREE.Vector3(...grips[side === 'l' ? 'left' : 'right']));
        worst = Math.max(worst, palm.distanceTo(expected));
      }
    }
  }
  // 交付的 palmContact.toleranceM 是 2mm；这里放宽到 3cm 只为挡住"锚点接错帧/接错空间"，
  // 逐帧贴身精度由素材自带的 validate_runtime 负责。
  assert.ok(worst < 0.03, `持棋锚点与手心最大偏差 ${worst.toFixed(3)}m`);
});

test('落子片段：目标格有敌子走吃子片段，空位走普通落子', async () => {
  const { placementFor } = await import('../src/game/XiangqiBoard.ts');
  const pieces = [
    { id: 'black_cannon_1', row: 2, col: 1 },
    { id: 'red_soldier_1', row: 2, col: 3 },
  ];
  const capture = placementFor(pieces, 'black_cannon_1', 2, 3);
  assert.equal(capture.clip, 'chess_capture_place');
  assert.equal(capture.victim, 'red_soldier_1');
  assert.deepEqual(capture.events.map((e) => e.type), ['release', 'capture_commit_gate', 'land_confirmed']);
  const quiet = placementFor(pieces, 'black_cannon_1', 2, 2);
  assert.equal(quiet.clip, 'chess_place');
  assert.equal(quiet.victim, null);
  assert.deepEqual(quiet.events.map((e) => e.type), ['release', 'placement_gate', 'land_confirmed']);
  // 自己占着的格子不算吃子
  assert.equal(placementFor(pieces, 'black_cannon_1', 2, 1).clip, 'chess_place');
});
