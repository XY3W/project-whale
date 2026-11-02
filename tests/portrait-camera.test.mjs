import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PORTRAIT, portraitPose } from '../src/ui/portraitCamera.ts';

const project = (position, yaw) => {
  const { position: eye, target } = portraitPose(position, yaw);
  const camera = new THREE.PerspectiveCamera(PORTRAIT.fov, PORTRAIT.aspect, 0.05, 12);
  camera.position.copy(eye);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const head = new THREE.Vector3(position.x, position.y + 1.05, position.z).project(camera);
  const feet = new THREE.Vector3(position.x, position.y + 0.02, position.z).project(camera);
  return { head, feet, eye, target };
};

test('正面小窗：无论站哪、朝哪，角色都在画面中央且完整入画', () => {
  const spots = [
    { x: 0, y: 0, z: 0 }, { x: 3.7, y: 0, z: 3.7 }, { x: -5.2, y: 0, z: 2.4 }, { x: 4.9, y: 0, z: -5.1 },
  ];
  for (const spot of spots) {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const { head, feet } = project(spot, yaw);
      // 水平居中（相机正对角色）
      assert.ok(Math.abs(head.x) < 0.05, `head x=${head.x.toFixed(3)} 没居中`);
      assert.ok(Math.abs(feet.x) < 0.05, `feet x=${feet.x.toFixed(3)} 没居中`);
      // 头顶和脚都在画面内（留一点边距）
      assert.ok(head.y < 0.9 && head.y > -0.2, `head y=${head.y.toFixed(2)} 超出画面`);
      assert.ok(feet.y > -0.95 && feet.y < 0.2, `feet y=${feet.y.toFixed(2)} 超出画面`);
    }
  }
});

test('正面小窗：相机永远在角色前方（沿朝向），不会拍成背面', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const { position: eye, target } = portraitPose({ x: 0, y: 0, z: 0 }, yaw);
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const toEye = eye.clone().sub(target).setY(0).normalize();
    assert.ok(toEye.dot(forward) > 0.99, '相机必须站在她面朝的方向上');
  }
});
