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

test("turn +180 落在 -180：同一个朝向，不能判失败", async () => {
  // 线上案例：从 yaw=90 请求 turn 180，实际落到 -90（有符号差 -180）
  const loco = {
    yaw: () => Math.PI / 2,
    position: () => ({ x: 0, z: 0 }),
    walk: async () => {},
    turn: async () => {},
    play: async () => {},
    tail: async () => {},
    sleep: async () => {},
  };
  // 先转到 90，再让 turn 落到 -90：degs 与结果相差 360，但朝向一致
  let yaw = Math.PI / 2;
  loco.yaw = () => yaw;
  loco.turn = async (deg) => {
    yaw = ((yaw + (deg * Math.PI) / 180 + Math.PI) % (Math.PI * 2)) - Math.PI;
  };
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "turn", angle_deg: 180 }] });
  assert.equal(r.steps[0].status, "succeeded", JSON.stringify(r.steps[0]));
  assert.equal(r.steps[0].reasonCode, "OK");
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

test("越界：场边向前走被拒绝，不移动（现在报 BLOCKED + 剩余距离）", async () => {
  const { loco, pos } = makeLoco();
  pos.z = 3.5;
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk", distance_m: 0.27 }] });
  assert.equal(r.steps[0].status, "failed");
  assert.equal(r.steps[0].reasonCode, "BLOCKED");
  assert.equal(r.steps[0].actual.error, "WALL_BLOCKED");
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

// ---- 钢盆互动：执行器前置条件与终态验证 ----
function makeBasinLoco() {
  const { loco, pos } = makeLoco(0);
  const view = { id: "basin", object_id: "basin", revision: 1, holder: null, state: "resting", position: [0, 0.13, 0], upright: true, stationary: true, available: true };
  const calls = [];
  let alignment = { distanceError: 0.005, yawErrorDeg: 0.4, ok: true };
  loco.basin = {
    items: () => [{ ...view }],
    reset: () => calls.push("reset"),
    snapshot: () => ({ ...view }),
    alignment: () => alignment,
    align: async () => {
      calls.push("align");
      pos.x = 0.2;
      return { ok: true, plan: { distanceM: 0.27, turn1Deg: 0, turn2Deg: 0, stand: { x: 0.2, z: 0 }, finalYawDeg: 0, reach: 0.585 } };
    },
    canStart: () => true,
    cancel: () => calls.push("cancel"),
    upright: async () => {
      calls.push("upright");
      const moved = 0.12;
      view.upright = true;
      return { ok: true, moved, rotatedDeg: 88 };
    },
    perform: async (_objectId, id) => {
      calls.push(id);
      if (id === "pickup_basin") { view.state = "held"; view.holder = "hand"; view.available = false; }
      if (id === "wear_basin") { view.state = "worn"; view.holder = "head"; }
      if (id === "unwear_basin") { view.state = "held"; view.holder = "hand"; }
      if (id === "throw_basin") { view.state = "flying"; view.holder = null; }
      view.revision++;
      return true;
    },
  };
  return { loco, view, calls, setAlignment: (a) => { alignment = a; } };
}

test("钢盆：未对准时 pickup 失败且不播放动画", async () => {
  const { loco, calls, setAlignment } = makeBasinLoco();
  setAlignment({ distanceError: 0.15, yawErrorDeg: 0.2, ok: false });
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({ steps: [{ action: "pickup", object_id: "basin" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0].reasonCode, "NOT_ALIGNED");
  assert.ok(!calls.includes("pickup_basin"), "没对准就不能播拾取动画");
});

test("钢盆：walk_to_basin → pickup → wear → unwear → throw 全链路", async () => {
  const { loco, view, calls } = makeBasinLoco();
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({
    steps: [
      { action: "walk_to_basin" },
      { action: "pickup", object_id: "basin" },
      { action: "wear", object_id: "basin" },
      { action: "unwear", object_id: "basin" },
      { action: "throw", object_id: "basin", yaw_deg: 0, elevation_deg: 10, speed_mps: 3 },
    ],
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["align", "pickup_basin", "wear_basin", "unwear_basin", "throw_basin"]);
  assert.equal(result.steps[4].actual.basin.state, "flying");
  assert.equal(view.state, "flying");
});

test("钢盆：状态不匹配时拒绝执行后续动作", async () => {
  const { loco } = makeBasinLoco();
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({ steps: [{ action: "wear", object_id: "basin" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0].reasonCode, "BASIN_STATE_MISMATCH");
});

test("钢盆：落地后 state 变 resting，throw 仍算成功", async () => {
  const { loco, view } = makeBasinLoco();
  view.state = "held";
  const original = loco.basin.perform;
  loco.basin.perform = async (objectId, id) => {
    const ok = await original(objectId, id);
    if (id === "throw_basin") { view.state = "resting"; view.upright = true; view.available = true; }
    return ok;
  };
  loco.basin.snapshot = () => ({ ...view });
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({ steps: [{ action: "throw", object_id: "basin", yaw_deg: 0, elevation_deg: 0, speed_mps: 2 }] });
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0].actual.basin.state, "resting");
});

test("钢盆：parallel 里不允许放物品动作", async () => {
  const { loco } = makeBasinLoco();
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({ steps: [{ action: "parallel", items: [{ action: "turn", angle_deg: 10 }, { action: "pickup", object_id: "basin" }] }] });
  assert.equal(result.status, "failed");
});

test("钢盆：侧躺时先扶正再拾取，证据里带挪动量", async () => {
  const { loco, calls, view } = makeBasinLoco();
  view.upright = false;
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({ steps: [{ action: "pickup", object_id: "basin" }] });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["upright", "pickup_basin"]);
  assert.equal(result.steps[0].actual.upright.moved, 0.12);
  assert.equal(result.steps[0].actual.basin.state, "held");
});

test("钢盆：扶正失败（挪动过远）就不播拾取动画", async () => {
  const { loco, calls, view } = makeBasinLoco();
  view.upright = false;
  loco.basin.upright = async () => {
    calls.push("upright");
    return { ok: false, moved: 0.8, rotatedDeg: 120 };
  };
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({ steps: [{ action: "pickup", object_id: "basin" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0].reasonCode, "NOT_ALIGNED");
  assert.deepEqual(calls, ["upright"]);
});

test("钢盆：walk_to_basin 不再要求盆已经正放", async () => {
  const { loco, view } = makeBasinLoco();
  view.upright = false;
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const result = await ex.run({ steps: [{ action: "walk_to_basin" }] });
  assert.equal(result.status, "completed");
});


// ---- 边界阻挡：必须明确告诉模型“走不动”，而不是只报位移不符 ----
test("贴墙走路：目标越界 → BLOCKED，并给出剩余可走距离", async () => {
  const { loco, pos } = makeLoco(0);
  pos.z = 3.6;
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk", distance_m: 0.27 }] });
  assert.equal(r.steps[0].status, "failed");
  assert.equal(r.steps[0].reasonCode, "BLOCKED");
  assert.equal(r.steps[0].actual.error, "WALL_BLOCKED");
  assert.ok(r.steps[0].actual.available_m <= 0.1001, JSON.stringify(r.steps[0].actual));
  assert.ok(String(r.steps[0].actual.hint).includes("边界"));
  assert.equal(pos.z, 3.6, "被挡住时不应该悄悄往前走");
});

/** 带 run/adjust 的假移动层，用来测边界 */
function makeMoveLoco(start = { x: 0, z: 0 }) {
  let yaw = 0;
  const pos = { ...start };
  const step = (m) => {
    pos.x += Math.sin(yaw) * m;
    pos.z += Math.cos(yaw) * m;
  };
  const clamp = () => {
    const half = 3.7; // 主循环的 clamp，模拟真实行为
    pos.x = Math.max(-half, Math.min(half, pos.x));
    pos.z = Math.max(-half, Math.min(half, pos.z));
  };
  const loco = {
    yaw: () => yaw,
    position: () => ({ ...pos }),
    walk: async (m) => { step(m); clamp(); },
    adjust: async (m) => { step(m); clamp(); },
    run: async (m) => { step(m); clamp(); },
    turn: async (deg) => { yaw += (deg * Math.PI) / 180; },
    play: async () => {},
    tail: async () => {},
    sleep: async () => {},
  };
  return { loco, pos };
}

test("贴墙短步：同样在移动前就判定 BLOCKED", async () => {
  const { loco, pos } = makeMoveLoco({ x: 0, z: 3.69 });
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk_adjust", distance_m: 0.08 }] });
  assert.equal(r.steps[0].reasonCode, "BLOCKED");
  assert.ok(r.steps[0].actual.available_m <= 0.0101);
  assert.equal(pos.z, 3.69);
});

test("贴墙跑动：越界同样 BLOCKED", async () => {
  const { loco, pos } = makeMoveLoco({ x: 3.5, z: 0 });
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  // 先转 90° 朝 +X，再跑 0.464m：x 会到 3.96，越界
  const r = await ex.run({ steps: [{ action: "turn", angle_deg: 90 }, { action: "run", distance_m: 0.464 }] });
  assert.equal(r.steps[1].reasonCode, "BLOCKED");
  assert.ok(r.steps[1].actual.available_m <= 0.2001);
  assert.equal(pos.x, 3.5, "被挡住时不应移动");
});

// ---- walk_to：宿主算转向和步数，模型只给坐标 ----
test("walk_to 走到坐标并回报剩余距离", async () => {
  const { loco } = makeMoveLoco();
  let called = null;
  loco.walkTo = async (x, z, tol) => {
    called = { x, z, tol };
    return { ok: true, distance_m: 0.05, moved: 0.9, position: { x, z } };
  };
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk_to", x: 1.6, z: -1.6, tolerance_m: 0.1 }] });
  assert.deepEqual(called, { x: 1.6, z: -1.6, tol: 0.1 });
  assert.equal(r.steps[0].status, "succeeded");
  assert.equal(r.steps[0].actual.distance_m, 0.05);
});

test("walk_to 没接线时报 CAPABILITY_DISABLED", async () => {
  const { loco } = makeMoveLoco();
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk_to", x: 1, z: 1, tolerance_m: 0.1 }] });
  assert.equal(r.steps[0].reasonCode, "CAPABILITY_DISABLED");
});

test("walk_to 走不到时报 NOT_ALIGNED", async () => {
  const { loco } = makeMoveLoco();
  loco.walkTo = async () => ({ ok: false, error: "NOT_ALIGNED", distance_m: 1.4, tolerance_m: 0.1 });
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk_to", x: 2.1, z: 1.1, tolerance_m: 0.1 }] });
  assert.equal(r.steps[0].reasonCode, "NOT_ALIGNED");
});

test("walk_to 之后接 place_stone：两步都执行", async () => {
  const { loco } = makeMoveLoco();
  loco.walkTo = async () => ({ ok: true, distance_m: 0.05 });
  loco.stone = {
    current: () => null,
    perform: async (step) => ({ ok: true, row: step.row, col: step.col }),
  };
  const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  const r = await ex.run({ steps: [{ action: "walk_to", x: 0, z: 0, tolerance_m: 0.1 }, { action: "place_stone", game_id: "g", row: 5, col: 5, expected_revision: 0 }] });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].status, "succeeded");
  assert.equal(r.steps[1].status, "succeeded");
});
