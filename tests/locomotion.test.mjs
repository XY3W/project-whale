import test from 'node:test';
import assert from 'node:assert/strict';
import { planWalkLegs, RUN_LADDER, WALK_LADDER, ADJUST_LADDER } from '../src/behavior/locomotion.ts';
import { RUN_DISTANCES, MOVE_CLIPS } from '../src/character/LayeredMotionPlayer.ts';

test('档位与素材一致：跑/走/微调三套距离表', () => {
  assert.deepEqual(RUN_LADDER, RUN_DISTANCES);
  assert.deepEqual(WALK_LADDER, [1.89, 1.71, 1.53, 1.35, 1.17, 0.99, 0.81, 0.63, 0.45, 0.27, 0.09]);
  assert.deepEqual(ADJUST_LADDER, [0.08, 0.06, 0.04, 0.02]);
  // 走速/跑速是素材定的，不是我们编的
  assert.equal(MOVE_CLIPS.walk.distance(1), 0.1125);
  assert.equal(MOVE_CLIPS.run.distance(1), 0.4);
});

test('远距离先跑、残差再走；近距离只走', () => {
  const far = planWalkLegs(4.6);
  assert.ok(far.some((l) => l.kind === 'run'), '4.6m 应该先跑');
  assert.ok(far.some((l) => l.kind === 'walk'), '该距离的残差仍需走路补齐');
  const near = planWalkLegs(0.27);
  assert.deepEqual(near, [{ kind: 'walk', meters: 0.27 }]);
  const noRun = planWalkLegs(4.6, { allowRun: false });
  assert.ok(!noRun.some((l) => l.kind === 'run'));
});

function seconds(legs) {
  return legs.reduce((sum, leg) => sum + (leg.kind === 'run'
    ? 0.8 + Math.round((leg.meters - 0.144) / 0.32) * 0.8
    : leg.kind === 'walk' ? 1.6 + Math.round((leg.meters - 0.09) / 0.18) * 1.6 : 0.8), 0);
}

test('空手接近 1.17m 不再全程慢走，取消固定 0.6m 尾段', () => {
  const approach = planWalkLegs(1.17);
  assert.deepEqual(approach, [{ kind: 'run', meters: 1.104 }, { kind: 'adjust', meters: 0.06 }]);
  assert.ok(Math.abs(seconds(approach) - 4) < 1e-9);
  assert.ok(seconds(approach) < seconds(planWalkLegs(1.17, { allowRun: false })) / 2);
  for (const d of [0.09, 0.27, 0.45, 0.63]) assert.ok(planWalkLegs(d).every(l => l.kind !== 'run'));
  assert.deepEqual(planWalkLegs(0.784), [{ kind: 'run', meters: 0.784 }], '精确跑到就收步，不凭空加慢走');
});

test('所有接近距离保持合法档位、不越过目标；无效距离不挂死', () => {
  for (let cm = 1; cm <= 1200; cm++) {
    const d = cm / 100;
    const legs = planWalkLegs(d);
    const total = legs.reduce((sum, l) => sum + l.meters, 0);
    assert.ok(total <= d + 1e-8);
    assert.ok(d - total < 0.02 + 1e-8);
  }
  for (const d of [Infinity, -Infinity, NaN, -1, 0]) assert.deepEqual(planWalkLegs(d), []);
});

test('分段加起来不超过目标距离，残差在档位以内', () => {
  for (const d of [0.09, 0.27, 1.17, 2, 3.2, 4.6, 7.5]) {
    for (const allowRun of [true, false]) {
      const legs = planWalkLegs(d, { allowRun });
      const total = legs.reduce((s, l) => s + l.meters, 0);
      assert.ok(total <= d + 1e-9, `${d}m 走超了`);
      assert.ok(d - total < 0.02 + 1e-9, `${d}m 残差太大 ${(d - total).toFixed(3)}`);
      for (const leg of legs) {
        if (leg.kind === 'run') assert.ok(RUN_LADDER.includes(leg.meters));
        if (leg.kind === 'walk') assert.ok(WALK_LADDER.includes(leg.meters));
        if (leg.kind === 'adjust') assert.ok(ADJUST_LADDER.includes(leg.meters));
      }
    }
  }
});
