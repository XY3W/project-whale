import test from "node:test";
import assert from "node:assert/strict";
import { ProgressMonitor } from "../src/behavior/progress.ts";

test("进度看门狗：持续有进展就一直等（不受墙钟长度影响）", () => {
  const monitor = new ProgressMonitor({ start: 0, idleMs: 1000, maxMs: 600000 });
  let progress = 0;
  for (let t = 0; t <= 120000; t += 100) {
    progress += 0.001;
    assert.equal(monitor.sample(t, progress, false), "waiting");
  }
});

test("进度看门狗：连续 idleMs 没有进展判定卡住", () => {
  const monitor = new ProgressMonitor({ start: 0, idleMs: 1000, maxMs: 600000 });
  assert.equal(monitor.sample(100, 0, false), "waiting");
  assert.equal(monitor.sample(900, 0, false), "waiting");
  assert.equal(monitor.sample(1100, 0, false), "stalled");
});

test("进度看门狗：有进展就重置计时", () => {
  const monitor = new ProgressMonitor({ start: 0, idleMs: 1000, maxMs: 600000 });
  assert.equal(monitor.sample(900, 0, false), "waiting");
  assert.equal(monitor.sample(950, 0.5, false), "waiting");
  assert.equal(monitor.sample(1900, 0.5, false), "waiting");
  assert.equal(monitor.sample(2000, 0.5, false), "stalled");
});

test("进度看门狗：完成优先于卡住判定", () => {
  const monitor = new ProgressMonitor({ start: 0, idleMs: 100, maxMs: 1000 });
  assert.equal(monitor.sample(5000, 0, true), "done");
});

test("进度看门狗：maxMs 兜底", () => {
  const monitor = new ProgressMonitor({ start: 0, idleMs: 100000, maxMs: 5000 });
  assert.equal(monitor.sample(4000, 0, false), "waiting");
  assert.equal(monitor.sample(5001, 0, false), "stalled");
});

test("进度看门狗：微小抖动不算进展", () => {
  const monitor = new ProgressMonitor({ start: 0, idleMs: 1000, maxMs: 600000, epsilon: 1e-4 });
  assert.equal(monitor.sample(100, 0.5, false), "waiting");
  assert.equal(monitor.sample(1200, 0.50001, false), "stalled");
});

test("进度看门狗：1.89 m 的行走在慢机器上依然等到走完", () => {
  // 60 fps 时 1.89 m 约 17.6 秒；3 fps 时每帧动画被 clamp 到 0.05 s，
  // 同样 17.6 秒的动画要跑约 110 秒墙钟
  const fps = 3;
  const dt = Math.min(1 / fps, 0.05);
  const monitor = new ProgressMonitor({ start: 0, idleMs: 8000, maxMs: 600000 });
  let t = 0;
  let distance = 0;
  while (distance < 1.89 && t < 600000) {
    t += 1000 / fps;
    distance += 0.1125 * dt;
    assert.notEqual(monitor.sample(t, distance, false), "stalled", `在 t=${Math.round(t / 1000)}s 被误判卡住`);
  }
  assert.ok(t > 100000, `墙钟确实超过 100 秒（实际 ${Math.round(t / 1000)} 秒）`);
  assert.equal(monitor.sample(t, distance, distance >= 1.89), "done");
});
