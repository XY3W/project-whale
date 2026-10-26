import test from "node:test";
import assert from "node:assert/strict";
import { boardContext, characterContext, propsContext, sanitizeProp, slotsOf } from "../server/public-state.mjs";
import { createGame, dig, publicBoard } from "../server/minesweeper.mjs";
import { createGameEventQueue } from "../server/events.mjs";

const basin = (over = {}) => ({
  object_id: "basin",
  state: "resting",
  position: [1, 0.134, 2],
  quaternion: [0, 0, 0, 1],
  upright: true,
  ...over,
});

const scoop = (over = {}) => ({
  object_id: "rice_scoop",
  state: "resting",
  position: [-1, 0.02, 0.5],
  quaternion: [0, 0, 0, 1],
  ...over,
});

test("旧存档迁移：holder=hand 按物品落到左/右手", () => {
  const handBasin = sanitizeProp(basin({ state: "held", holder: "hand" }));
  assert.equal(handBasin.holder, "left_hand");
  const handScoop = sanitizeProp(scoop({ state: "held", holder: "hand" }));
  assert.equal(handScoop.holder, "right_hand");
  const worn = sanitizeProp(basin({ state: "worn", holder: "head" }));
  assert.equal(worn.holder, "head");
});

test("饭勺不能戴头：旧数据 worn 降级成右手持有", () => {
  const rec = sanitizeProp(scoop({ state: "worn", holder: "head" }));
  assert.equal(rec.state, "held");
  assert.equal(rec.holder, "right_hand");
});

test("飞行/转移中不落盘：退回上一份稳定快照", () => {
  const previous = sanitizeProp(basin({ state: "held", holder: "left_hand" }));
  const flying = sanitizeProp(basin({ state: "flying", holder: null }), previous);
  assert.equal(flying.state, "held");
  assert.equal(flying.holder, "left_hand");
  const orphan = sanitizeProp(scoop({ state: "transferring" }));
  assert.equal(orphan.state, "resting");
  assert.equal(orphan.holder, null);
});

test("坐标不合法或未知物品直接拒绝", () => {
  assert.equal(sanitizeProp({ object_id: "basin", state: "resting", position: [0, 0] }), null);
  assert.equal(sanitizeProp({ object_id: "cup", state: "resting", position: [0, 0, 0] }), null);
  assert.equal(sanitizeProp(null), null);
});

test("槽位由物品状态推导：两手同时持物", () => {
  const props = new Map([
    ["basin", sanitizeProp(basin({ state: "held", holder: "hand" }))],
    ["rice_scoop", sanitizeProp(scoop({ state: "held", holder: "hand" }))],
  ]);
  assert.deepEqual(slotsOf(props), { left_hand: "basin", right_hand: "rice_scoop", head: null });
  props.set("basin", sanitizeProp(basin({ state: "worn", holder: "head" })));
  assert.deepEqual(slotsOf(props), { left_hand: null, right_hand: "rice_scoop", head: "basin" });
});

test("模型上下文：物品只给公开字段和可用动作", () => {
  const props = new Map([
    ["basin", sanitizeProp(basin({ state: "resting" }))],
    ["rice_scoop", sanitizeProp(scoop({ state: "held", holder: "hand" }))],
  ]);
  const ctx = propsContext(props);
  assert.equal(ctx.slots.right_hand, "rice_scoop");
  const s = ctx.objects.find((o) => o.object_id === "rice_scoop");
  assert.ok(s.actions.includes("pickup"));
  assert.ok(!s.actions.includes("wear"), "饭勺不能佩戴");
  assert.ok(!("quaternion" in s), "不把内部姿态塞进提示词");
});

test("公开棋盘：未揭示格没有 value，也不泄露雷表", () => {
  const game = createGame({ gameId: "g-test", seed: 42 });
  dig(game, 5, 5);
  const view = publicBoard(game);
  const ctx = boardContext(view, { x: 0.4, z: -0.4, yawDeg: 90 });
  assert.equal(ctx.rows.length, 16);
  assert.ok(ctx.rows.every((row) => row.length === 16));
  // 未揭示格只有 "."，网格里不出现任何可推断答案的符号
  const chars = new Set(ctx.rows.join(""));
  assert.ok([...chars].every((ch) => ch === "." || ch === "*" || /[0-9]/.test(ch)));
  assert.ok(!("mines" in ctx));
  assert.deepEqual(ctx.currentCell, { row: 7, col: 8 });
  assert.ok(ctx.coordinateRule.includes("0.5"));
  assert.equal(ctx.revision, 1);
});

test("角色上下文：朝向换算成 forward", () => {
  const ctx = characterContext({ x: 1.23456, z: -2, yawDeg: 90 });
  assert.equal(ctx.yawDeg, 90);
  assert.equal(ctx.forward.x, 1);
  assert.ok(Math.abs(ctx.forward.z) < 1e-9);
});

test("事件队列：同类合并、旧 revision 丢弃、异类并存、消费一次", () => {
  const q = createGameEventQueue();
  const ev = (id, type, revision) => ({ eventId: id, type, gameId: "g", revision });
  q.push(ev("1", "game_started", 0));
  q.push(ev("2", "board_updated", 1));
  q.push(ev("3", "board_updated", 2));
  q.push(ev("4", "game_finished", 2));
  q.push(ev("5", "board_updated", 1)); // 迟到的旧事件
  assert.deepEqual(q.peek().map((e) => `${e.type}@${e.revision}`), ["game_started@0", "board_updated@2", "game_finished@2"]);
  const taken = q.take();
  assert.equal(taken.length, 3);
  assert.equal(q.size(), 0);
});
