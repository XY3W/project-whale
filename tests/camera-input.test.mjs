import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { configureCameraInput } from '../src/core/cameraInput.ts';

class Canvas extends EventTarget {
  style = {}; clientHeight = 600; clientWidth = 800; document = new EventTarget();
  getRootNode() { return this.document; }
  setPointerCapture() {}
  releasePointerCapture() {}
}
function event(type, fields) { return Object.assign(new Event(type, { cancelable: true }), fields); }
test('Left drag leaves the camera still, middle drag rotates, and wheel zoom remains available', () => {
  const canvas = new Canvas(), camera = new PerspectiveCamera(32, 4 / 3, .1, 100);
  camera.position.set(0, 4, 8);
  const controls = new OrbitControls(camera, canvas); configureCameraInput(controls);
  const drag = button => {
    const data = { pointerId: 1, pointerType: 'mouse', button, clientX: 100, clientY: 100, pageX: 100, pageY: 100 };
    canvas.dispatchEvent(event('pointerdown', data));
    canvas.dispatchEvent(event('pointermove', { ...data, clientX: 220, pageX: 220 }));
    canvas.dispatchEvent(event('pointerup', { ...data, clientX: 220, pageX: 220 }));
  };
  const initial = camera.position.clone(); drag(0);
  assert(camera.position.distanceTo(initial) < 1e-9, 'Left drag must not orbit');
  drag(1); assert(camera.position.distanceTo(initial) > .1, 'Middle drag must orbit');
  const radius = camera.position.distanceTo(controls.target);
  canvas.dispatchEvent(event('wheel', { deltaY: -100, deltaMode: 0, clientX: 100, clientY: 100, ctrlKey: false }));
  assert(camera.position.distanceTo(controls.target) < radius, 'Wheel must still zoom');
  controls.dispose();
});
