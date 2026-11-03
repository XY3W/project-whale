import test from "node:test";
import assert from "node:assert/strict";
import {
  MOVE_HISTORY_HEADER,
  filterXiangqiHistory,
  moveHistoryBlock,
  planningMessages,
  reviewMessages,
  toolStartMessages,
} from "../server/llm.mjs";

/**
 * 缓存契约：DeepSeek 的前缀缓存按 token 逐字匹配，命中长度等于"新旧请求的公共前缀"。
 *   稳定 → 易变：system → 阶段指令 → 输出契约/工具说明 → 棋谱（只追加）→ 上下文 JSON（每轮都变）
 * 棋谱追加时旧内容仍是新一轮的前缀，所以能整段命中；
 * 盘面快照每走一手都改，必须排最后，否则它一变，后面的棋谱就全部失效。
 */

const moves = (n) => Array.from({ length: n }, (_, i) => ({
  revision: i + 1,
  side: i % 2 === 0 ? "red" : "black",
  pieceId: `red_soldier_${(i % 5) + 1}`,
  from: { row: 6, col: i % 9 },
  to: { row: 5, col: i % 9 },
  captured: null,
  check: false,
}));

/** 真实对局里走一手：棋谱加一条、revision 前进、轮次换手。 */
const view = ({ history = 0, turn = "red" } = {}) => ({
  gameId: "cache-game",
  ruleset: "CCA2020",
  revision: history,
  status: "playing",
  turn,
  userSide: history % 2 === 0 ? "red" : "black",
  characterSide: "black",
  check: false,
  result: null,
  lastMove: history ? { pieceId: "red_soldier_1", to: { row: 5, col: 0 } } : null,
  rows: ["rnbakabnr"],
  legalMoves: [],
  pieces: [{ id: "red_soldier_1", side: "red", kind: "pawn", row: 5, col: 0 }],
  moveHistory: moves(history),
});

const CTX = "REQUEST_CONTEXT_JSON:";

const userOf = (messages) => messages.find((m) => m.role === "user").content;
/** 真实请求 = system + user，缓存命中率按整条请求算。 */
const requestOf = (messages) => messages.map((m) => m.content).join("\n");

function historyOf(user) {
  const at = user.indexOf(`${MOVE_HISTORY_HEADER}\n`);
  assert.ok(at >= 0, "提示词里应当有棋谱块");
  const end = user.indexOf(CTX, at);
  return JSON.parse(user.slice(at + MOVE_HISTORY_HEADER.length + 1, end < 0 ? undefined : end).trim());
}

function contextJson(user) {
  const at = user.lastIndexOf(CTX);
  assert.ok(at >= 0, "提示词里应当有上下文 JSON");
  const start = at + CTX.length + 1;
  const end = user.indexOf("\n", start);
  return JSON.parse(user.slice(start, end < 0 ? undefined : end));
}

const prefixBefore = (content, marker) => content.slice(0, content.indexOf(marker));
const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

for (const [name, build] of Object.entries({ toolStartMessages, planningMessages, reviewMessages })) {
  test(`${name}：棋谱在上下文 JSON 之前`, () => {
    const user = userOf(build({ xiangqi: view({ history: 4 }), skills: { index: [] } }));
    assert.ok(user.indexOf(MOVE_HISTORY_HEADER) < user.lastIndexOf(CTX), "棋谱块必须在 JSON 之前");
    assert.ok(user.trimEnd().endsWith("}"), "每轮都变的快照收尾在最后");
    assert.deepEqual(historyOf(user), moves(4));
  });

  test(`${name}：棋谱变长不改变它前面的任何字节`, () => {
    const short = userOf(build({ xiangqi: view({ history: 3 }), skills: { index: [] } }));
    const long = userOf(build({ xiangqi: view({ history: 120 }), skills: { index: [] } }));
    assert.equal(prefixBefore(long, MOVE_HISTORY_HEADER), prefixBefore(short, MOVE_HISTORY_HEADER));
    assert.ok(long.length > short.length + 10000, "长棋谱确实把提示词撑大");
  });

  test(`${name}：棋谱不进上下文 JSON`, () => {
    const user = userOf(build({ xiangqi: view({ history: 2 }), skills: { index: [] } }));
    assert.equal(contextJson(user).xiangqi.moveHistory, undefined);
    assert.deepEqual(contextJson(user).xiangqi.rows, ["rnbakabnr"], "盘面仍在 JSON 里");
  });

  test(`${name}：走一手后公共前缀覆盖整局旧棋谱（≥95%）`, () => {
    for (const n of [10, 50, 100]) {
      const before = requestOf(build({ xiangqi: view({ history: n, turn: "red" }), skills: { index: [] } }));
      const after = requestOf(build({ xiangqi: view({ history: n + 1, turn: "black" }), skills: { index: [] } }));
      const shared = commonPrefix(before, after);
      assert.ok(shared / Math.min(before.length, after.length) >= 0.95, `n=${n} 公共前缀 ${shared}`);
      assert.ok(shared > before.indexOf(MOVE_HISTORY_HEADER), "前缀应当吃进棋谱块");
    }
  });
}

test("盘面变化只动末尾 JSON，指令与棋谱都不变", () => {
  const a = userOf(toolStartMessages({ xiangqi: view({ history: 5, turn: "red" }), skills: { index: [] } }));
  const b = userOf(toolStartMessages({ xiangqi: view({ history: 5, turn: "black" }), skills: { index: [] } }));
  assert.equal(prefixBefore(a, CTX), prefixBefore(b, CTX), "除 JSON 外逐字相同");
  assert.equal(contextJson(a).xiangqi.turn, "red");
  assert.equal(contextJson(b).xiangqi.turn, "black");
});

test("没有棋局时没有棋谱块", () => {
  const user = userOf(toolStartMessages({ skills: { index: [] } }));
  assert.equal(user.includes(MOVE_HISTORY_HEADER), false);
  assert.equal(moveHistoryBlock(null), "");
  assert.equal(moveHistoryBlock({ status: "playing" }), "");
});

test("工具循环里棋谱按当前棋局刷新，且不重复出现在工具结果里", () => {
  const starter = toolStartMessages({ xiangqi: view({ history: 2, turn: "red" }), skills: { index: [] } });
  const before = userOf(starter);
  starter.push({ role: "tool", content: JSON.stringify({ world: { xiangqi: view({ history: 2 }) } }) });
  const refreshed = filterXiangqiHistory(starter, "cache-game", view({ history: 3, turn: "black" }));
  const after = userOf(refreshed);
  assert.equal(prefixBefore(after, MOVE_HISTORY_HEADER), prefixBefore(before, MOVE_HISTORY_HEADER), "刷新只动棋谱与 JSON");
  assert.deepEqual(historyOf(after).map((m) => m.revision), [1, 2, 3]);
  assert.equal(refreshed[2].content.includes("moveHistory"), false, "工具结果不携带棋谱");
});
