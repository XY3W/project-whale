import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitShadowBounds } from '../src/core/shadowBounds.ts';

const LIGHT = [11.4, 5.3, 5.7]; // 灯被拉远到 3 倍距离（方向不变），见 Stage.buildLights
const TARGET = [0, 0.65, 0];

const viewMatrix = ([lx, ly, lz], [tx, ty, tz]) => {
  const eye = new THREE.Vector3(lx, ly, lz);
  const rotation = new THREE.Matrix4().lookAt(eye, new THREE.Vector3(tx, ty, tz), new THREE.Vector3(0, 1, 0));
  return new THREE.Matrix4().makeTranslation(lx, ly, lz).multiply(rotation).invert();
};
// 地面四角 + 角色高度处的四角：影子投射体比地面高，两者都要在阴影相机里
const corners = (half, y = 0) => [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => new THREE.Vector3(sx * half, y, sz * half));
const allCorners = (half) => [...corners(half, 0), ...corners(half, 1.4)];

test('阴影相机覆盖整个场地四角（8m 与 11.5m 都覆盖）', () => {
  for (const half of [4, 5.75]) {
    const fit = fitShadowBounds({ lightPosition: LIGHT, target: TARGET, roomHalf: half });
    const view = viewMatrix(LIGHT, TARGET);
    for (const corner of allCorners(half)) {
      const p = corner.clone().applyMatrix4(view);
      assert.ok(Math.abs(p.x) <= fit.extent, `${half}m 角点 x=${p.x.toFixed(2)} 超出 ±${fit.extent}`);
      assert.ok(Math.abs(p.y) <= fit.extent, `${half}m 角点 y=${p.y.toFixed(2)} 超出 ±${fit.extent}`);
      assert.ok(-p.z >= fit.near && -p.z <= fit.far, `${half}m 角点深度超出 near/far`);
    }
  }
});

test('阴影范围随场地变大，旧写死的 4.2 覆盖不了 11.5m', () => {
  const small = fitShadowBounds({ lightPosition: LIGHT, target: TARGET, roomHalf: 4 });
  const big = fitShadowBounds({ lightPosition: LIGHT, target: TARGET, roomHalf: 5.75 });
  assert.ok(big.extent > small.extent, '11.5m 的阴影范围必须比 8m 大');
  // 旧实现的固定 ±4.2：把 11.5m 的角点投进去，一定有漏的
  const view = viewMatrix(LIGHT, TARGET);
  const outside = allCorners(5.75).some((corner) => {
    const p = corner.clone().applyMatrix4(view);
    return Math.abs(p.x) > 4.2 || Math.abs(p.y) > 4.2;
  });
  assert.equal(outside, true, '旧固定值应当确实漏掉角点（这就是"角落没有影子"的原因）');
});
