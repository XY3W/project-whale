import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor, normalizeDeg, signedDeltaDeg } from "../src/behavior/ActionExecutor.ts";
import { cyclesFor, nearestSupported, supportedDistances } from "../src/behavior/distances.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLoco(delay = 0) {
  let yaw = 0;
  const pos = { x: 0, z: 0 };
  return {
    pos,
    get yaw() {
      return yaw;
    },
    loco: {
      yaw: () => yaw,
      position: () => ({ ...pos }),
      walk: async (m) => {
        if (delay) await sleep(delay);
        pos.x += Math.sin(yaw) * m;
        pos.z += Math.cos(yaw) * m;
      },
      turn: async (deg) => {
        if (delay) await sleep(delay);
        yaw += (deg * Math.PI) / 180;
      },
      play: async () => {
        if (delay) await sleep(delay);
      },
      tail: async () => {},
      sleep: async () => {},
    },
  };
}

test("distances: 0.09 + 0.18n, 11 个值", () => {
  const list = supportedDistances();
  assert.equal(list.length, 11);
  assert.equal(list[0], 0.09);
  assert.equal(list[1], 0.27);
  assert.equal(list[2], 0.45);
  assert.equal(list[10], 1.89);
});

test("cyclesFor: 支持值返回 n，0.5 返回 null", () => {
  assert.equal(cyclesFor(0.09), 0);
  assert.equal(cyclesFor(0.27), 1);
  assert.equal(cyclesFor(0.45), 2);
  assert.equal(cyclesFor(1.89), 10);
  assert.equal(cyclesFor(0.5), null);
  assert.equal(cyclesFor(0), null);
  assert.equal(cyclesFor(NaN), null);
});

test("nearestSupported: 0.5 给出 0.45 / 0.63", () => {
  const n = nearestSupported(0.5);
  assert.equal(n.below, 0.45);
  assert.equal(n.above, 0.63);
});

test("normalizeDeg: 折返到 (-180,180]", () => {
  assert.equal(normalizeDeg(190), -170);
  assert.equal(normalizeDeg(-190), 170);
  assert.equal(normalizeDeg(180), 180);
  assert.equal(normalizeDeg(-180), 180);
  assert.equal(normalizeDeg(725), 5);
});

test("turn +45：actual 与 requested 一致", async () => {
  const { loco } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({ steps: [{ action: "turn", angle_deg: 45 }] });
  assert.equal(r.status, "completed");
  assert.equal(r.steps[0].status, "succeeded");
  assert.equal(r.steps[0].actual.angle_deg, 45);
});

test("turn -180：方向与符号正确", async () => {
  const { loco } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  await ex.run({ steps: [{ action: "turn", angle_deg: -180 }] });
  assert.ok(Math.abs((loco.yaw() * 180) / Math.PI + 180) < 1e-6);
});

test("walk 0.27：位移一致", async () => {
  const { loco, pos } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({ steps: [{ action: "walk", distance_m: 0.27 }] });
  assert.equal(r.steps[0].status, "succeeded");
  assert.equal(r.steps[0].actual.distance_m, 0.27);
  assert.ok(Math.abs(pos.z - 0.27) < 1e-9);
});

test("walk 0.5：拒绝并给出候选值", async () => {
  const { loco, pos } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({ steps: [{ action: "walk", distance_m: 0.5 }] });
  assert.equal(r.steps[0].status, "unsupported");
  assert.equal(r.steps[0].reasonCode, "UNSUPPORTED_DISTANCE");
  assert.equal(pos.z, 0);
  assert.deepEqual(r.steps[0].actual.nearest, { below: 0.45, above: 0.63 });
});

test("越界：场边向前走被拒绝，不移动", async () => {
  const { loco, pos } = makeLoco();
  pos.z = 3.5;
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk", distance_m: 0.27 }] });
  assert.equal(r.steps[0].status, "failed");
  assert.equal(r.steps[0].reasonCode, "OUT_OF_BOUNDS");
  assert.equal(pos.z, 3.5);
});

test("组合：turn → walk → play 顺序执行", async () => {
  const { loco } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({
    steps: [
      { action: "turn", angle_deg: 90 },
      { action: "walk", distance_m: 0.45 },
      { action: "play", action_id: "greet" },
    ],
  });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.steps.map((s) => s.action), ["turn", "walk", "play"]);
  assert.equal(r.steps[1].actual.distance_m, 0.45);
});

test("parallel：walk + greet + tail 允许", async () => {
  const { loco } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({
    steps: [
      {
        action: "parallel",
        items: [
          { action: "walk", distance_m: 0.27 },
          { action: "play", action_id: "greet" },
          { action: "tail", style: "tail_swish", duration_s: 2 },
        ],
      },
    ],
  });
  assert.equal(r.steps[0].status, "succeeded");
});

test("parallel：两个 walk 冲突", async () => {
  const { loco } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({
    steps: [
      {
        action: "parallel",
        items: [
          { action: "walk", distance_m: 0.27 },
          { action: "walk", distance_m: 0.45 },
        ],
      },
    ],
  });
  assert.equal(r.steps[0].status, "failed");
  assert.equal(r.steps[0].reasonCode, "PRECONDITION_FAILED");
});

test("取消：执行中取消，后续步骤标记 cancelled", async () => {
  const { loco } = makeLoco(50);
  const ex = new ActionExecutor(loco, { half: 4 });
  const p = ex.run({
    steps: [
      { action: "walk", distance_m: 0.45 },
      { action: "play", action_id: "greet" },
    ],
  });
  await sleep(10);
  ex.cancel();
  const r = await p;
  assert.equal(r.status, "cancelled");
  assert.equal(r.steps[1].status, "cancelled");
  assert.equal(r.steps[1].reasonCode, "CANCELLED");
});

test("超过 6 步直接失败", async () => {
  const { loco } = makeLoco();
  const ex = new ActionExecutor(loco, { half: 4 });
  const steps = Array.from({ length: 7 }, () => ({ action: "wait", duration_s: 0 }));
  const r = await ex.run({ steps });
  assert.equal(r.status, "failed");
});

function makeLocoBroken(kind) {
  const pos = { x: 0, z: 0 };
  let yaw = 0;
  return {
    yaw: () => yaw,
    position: () => ({ ...pos }),
    walk: async (m) => {
      if (kind === "stuck") await new Promise(() => {});
      if (kind === "nomove") return;
      pos.x += Math.sin(yaw) * m;
      pos.z += Math.cos(yaw) * m;
    },
    turn: async (deg) => {
      if (kind === "stuck") await new Promise(() => {});
      yaw += ((kind === "halfturn" ? deg / 2 : deg) * Math.PI) / 180;
    },
    play: async () => {
      if (kind === "stuck") await new Promise(() => {});
    },
    tail: async () => {},
    sleep: async () => {},
  };
}

test("底层不移动但正常返回：walk 必须失败而不是成功", async () => {
  const loco = makeLocoBroken("nomove");
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({ steps: [{ action: "walk", distance_m: 0.27 }] });
  assert.equal(r.steps[0].status, "failed");
  assert.equal(r.steps[0].reasonCode, "DISPLACEMENT_MISMATCH");
  assert.equal(r.steps[0].actual.distance_m, 0);
});

test("转角只完成一半：必须报 ANGLE_MISMATCH", async () => {
  const loco = makeLocoBroken("halfturn");
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({ steps: [{ action: "turn", angle_deg: 45 }] });
  assert.equal(r.steps[0].status, "failed");
  assert.equal(r.steps[0].reasonCode, "ANGLE_MISMATCH");
});

test("底层永不返回：turn 超时，不得报成功", async () => {
  const loco = makeLocoBroken("stuck");
  const ex = new ActionExecutor(loco, { half: 4 });
  const r = await ex.run({ steps: [{ action: "turn", angle_deg: 10 }] });
  assert.ok(["timeout", "unknown"].includes(r.steps[0].status));
  assert.equal(r.steps[0].reasonCode, "TIMEOUT");
});

test("0.449 与字符串数字必须拒绝", async () => {
  const loco = makeLocoBroken("ok");
  const ex = new ActionExecutor(loco, { half: 4 });
  const r1 = await ex.run({ steps: [{ action: "walk", distance_m: 0.449 }] });
  assert.equal(r1.steps[0].status, "unsupported");
  const r2 = await ex.run({ steps: [{ action: "walk", distance_m: "0.45" }] });
  assert.equal(r2.steps[0].status, "unsupported");
});

test("全部 11 个合法距离都能成功且 actual 一致", async () => {
  const loco = makeLocoBroken("ok");
  const ex = new ActionExecutor(loco, { half: 100 });
  for (const d of [0.09, 0.27, 0.45, 0.63, 0.81, 0.99, 1.17, 1.35, 1.53, 1.71, 1.89]) {
    const r = await ex.run({ steps: [{ action: "walk", distance_m: d }] });
    assert.equal(r.steps[0].status, "succeeded", `distance ${d}`);
    assert.equal(r.steps[0].actual.distance_m, d);
  }
});

test("±180 方向符号正确（-180 不被归一成 +180）", async () => {
  for (const deg of [180, -180]) {
    const loco = makeLocoBroken("ok");
    const ex = new ActionExecutor(loco, { half: 4 });
    const r = await ex.run({ steps: [{ action: "turn", angle_deg: deg }] });
    assert.equal(r.steps[0].status, "succeeded", `turn ${deg}`);
    assert.equal(r.steps[0].actual.angle_deg, deg);
  }
  assert.equal(signedDeltaDeg(0, -180), -180);
  assert.equal(signedDeltaDeg(0, 180), 180);
});
