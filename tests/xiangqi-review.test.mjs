import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGame, move, signature, adjudicateRepeat } from '../server/xiangqi.mjs';
import { XiangqiService } from '../server/xiangqi-service.mjs';
import { xiangqiContext } from '../server/public-state.mjs';
import { toolStartMessages } from '../server/llm.mjs';


/** 一份完整的公开盘面（用于棋盘类回归） */
function boardView() {
  const game = createGame({ gameId: 'review-board' });
  return {
    gameId: game.gameId, ruleset: 'CCA2020', revision: 0, status: 'playing', turn: 'red',
    userSide: 'red', characterSide: 'black', check: false, result: null, lastMove: null,
    pieces: [...game.pieces.values()].map(({ id, side, kind, row, col }) => ({ id, side, kind, row, col })),
    legalMoves: [],
  };
}

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whale-xq-review-')), 'xiangqi.json');

// ---------- R06：循环由防守方走回重复局面时，长将也要判将军方负 ----------

test('长将：被将一方走回重复局面，判连续将军的一方负', () => {
  const g = createGame({ gameId: 'g-perpetual' });
  g.board.fill(null);
  g.pieces.clear();
  for (const p of [
    { id: 'red_general', side: 'red', kind: 'general', row: 9, col: 3 },
    { id: 'black_general', side: 'black', kind: 'general', row: 0, col: 5 },
    { id: 'red_rook', side: 'red', kind: 'rook', row: 2, col: 4 },
  ]) {
    g.pieces.set(p.id, { ...p });
    g.board[p.row * 9 + p.col] = p.id;
  }
  const history = [signature(g)];
  for (let round = 0; round < 2; round++) {
    for (const [id, row, col] of [['red_rook', 2, 5], ['black_general', 0, 4], ['red_rook', 2, 4], ['black_general', 0, 5]]) {
      const result = move(g, id, row, col);
      assert.equal(result.ok, true, JSON.stringify(result));
      history.push(signature(g));
    }
  }
  // 循环里红方每一手都在将军，最后一手是黑方走回的
  const redMoves = g.moves.filter((m) => m.side === 'red');
  assert.ok(redMoves.length >= 4);
  assert.ok(redMoves.every((m) => m.check));
  assert.equal(g.moves.at(-1).side, 'black');
  const verdict = adjudicateRepeat(g, history);
  assert.equal(verdict.reason, 'perpetual_check');
  assert.equal(verdict.loser, 'red');
  assert.equal(verdict.winner, 'black');
});

test('长将：互将时判和，不冤枉任何一方', () => {
  const board = new Array(90).fill(null);
  const game = { status: 'playing', board, turn: 'red', moves: [] };
  const sig = signature(game);
  const moves = [
    { side: 'red', check: true },
    { side: 'black', check: true },
    { side: 'red', check: true },
    { side: 'black', check: true },
  ];
  const verdict = adjudicateRepeat({ ...game, moves }, [sig, 'a#black', sig, 'b#black', sig]);
  assert.equal(verdict.reason, 'repetition');
  assert.equal(verdict.winner, null);
});

// ---------- R07：重启要保住"已判和"、幂等与循环历史 ----------

test('重启后仍是和棋，幂等记录与循环历史都还在', () => {
  const file = tmp();
  const svc = new XiangqiService(file);
  const start = svc.start({ requestId: 'r-restart', userSide: 'red' });
  let n = 0;
  for (let round = 0; round < 2; round++) {
    for (const [id, row, col] of [['red_horse_1', 7, 2], ['black_horse_1', 2, 2], ['red_horse_1', 9, 1], ['black_horse_1', 0, 1]]) {
      let result;
      if (id.startsWith('red')) {
        result = svc.userMove({ gameId: start.gameId, pieceId: id, toRow: row, toCol: col, moveId: `m-${n++}`, expectedRevision: svc.public().revision });
      } else {
        const auth = svc.beginMove({ pieceId: id, toRow: row, toCol: col, expectedRevision: svc.public().revision });
        assert.equal(auth.ok, true, auth.reason);
        result = svc.commitMove({ token: auth.token });
      }
      assert.equal(result.ok, true, JSON.stringify(result));
    }
  }
  assert.equal(svc.status, 'drawn');
  const before = { decisions: Object.keys(svc.decisions).length, history: svc.history.length };

  const restored = new XiangqiService(file);
  assert.equal(restored.status, 'drawn', '判和之后重启不能复活成 playing');
  assert.equal(Object.keys(restored.decisions).length, before.decisions, '幂等记录要跟着落盘');
  assert.equal(restored.history.length, before.history, '循环历史要跟着落盘');
  // 已判和的棋局不能再走
  const late = restored.userMove({ moveId: 'm-late', gameId: start.gameId, pieceId: 'red_horse_1', toRow: 7, toCol: 2, expectedRevision: restored.public().revision });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'GAME_OVER');
  // 重启前的幂等回放依旧可用
  const replay = restored.userMove({ moveId: 'm-0', gameId: start.gameId, pieceId: 'red_horse_1', toRow: 7, toCol: 2, expectedRevision: 0 });
  assert.equal(replay.replay, true);
});

// ---------- R10：详细棋规只在"正在下"时注入，rows 能区分红黑 ----------

const hasXiangqiSection = (view) => toolStartMessages({ xiangqi: view, skills: { index: [] } })[0].content.includes('【中国象棋】');

test('提示词：没有棋局和终局都不加载详细棋规，对局中才加载', () => {
  assert.equal(hasXiangqiSection(null), false);
  assert.equal(hasXiangqiSection({ status: 'playing' }), true);
  assert.equal(hasXiangqiSection({ status: 'won' }), false);
  assert.equal(hasXiangqiSection({ status: 'drawn' }), false);
});

test('提示词：终局只留最小结果，不再带盘面和候选着法', () => {
  const finished = xiangqiContext({
    gameId: 'g', ruleset: 'CCA2020', revision: 9, status: 'drawn', turn: 'red', userSide: 'red', characterSide: 'black',
    check: false, result: { winner: null, reason: 'repetition' }, lastMove: null,
    pieces: [{ id: 'red_rook_1', side: 'red', kind: 'rook', row: 9, col: 0 }], legalMoves: [{ pieceId: 'red_rook_1', row: 8, col: 0 }],
  });
  const messages = toolStartMessages({ xiangqi: finished, skills: { index: [] } });
  const message = messages.find((m) => m.content.startsWith('REQUEST_CONTEXT_JSON'));
  const ctx = JSON.parse(message.content.split('\n')[1]);
  assert.equal(ctx.xiangqi.status, 'drawn');
  assert.equal(ctx.xiangqi.result.reason, 'repetition');
  assert.equal(ctx.xiangqi.rows, undefined, '终局不该再带盘面');
  assert.equal(ctx.xiangqi.legalMoves, undefined, '终局不该再带旧候选');
});

test('盘面编码：红方大写、黑方小写，同一行能分清敌我', () => {
  const view = {
    gameId: 'g', ruleset: 'CCA2020', revision: 0, status: 'playing', turn: 'red', userSide: 'red', characterSide: 'black',
    check: false, result: null, lastMove: null,
    pieces: [
      { id: 'red_rook_1', side: 'red', kind: 'rook', row: 9, col: 0 },
      { id: 'black_rook_1', side: 'black', kind: 'rook', row: 0, col: 0 },
      { id: 'red_general', side: 'red', kind: 'general', row: 9, col: 3 },
      { id: 'black_general', side: 'black', kind: 'general', row: 0, col: 3 },
    ],
    legalMoves: [],
  };
  const view2 = xiangqiContext(view);
  assert.equal(view2.rows[9][0], 'R');
  assert.equal(view2.rows[0][0], 'r');
  assert.equal(view2.rows[9][3], 'K');
  assert.equal(view2.rows[0][3], 'k');
  assert.match(view2.legend, /红方大写/);
});

// ---------- R03：腰间勺子在快照/槽位里必须还是腰 ----------

test('挂腰的勺子：快照保持 worn + waist_slot，右手是空的', async () => {
  const { sanitizeProp, slotsOf } = await import('../server/public-state.mjs');
  const cleaned = sanitizeProp({
    object_id: 'rice_scoop', state: 'worn', holder: 'waist_slot',
    position: [0, 0.35, 0], quaternion: [0, 0, 0, 1],
  });
  assert.equal(cleaned.state, 'worn');
  assert.equal(cleaned.holder, 'waist_slot');
  const slots = slotsOf(new Map([['rice_scoop', cleaned]]));
  assert.equal(slots.right_hand, null, '挂腰之后右手要如实报空');
  assert.equal(slots.waist_slot, 'rice_scoop');
  // 旧数据/脏数据仍按原规则处理
  const bogus = sanitizeProp({ object_id: 'rice_scoop', state: 'worn', holder: null, position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  assert.equal(bogus.state, 'held');
  assert.equal(bogus.holder, 'right_hand');
});

test('盆戴在头上仍然是 head，不受腰槽影响', async () => {
  const { sanitizeProp, slotsOf } = await import('../server/public-state.mjs');
  const cleaned = sanitizeProp({ object_id: 'basin', state: 'worn', holder: 'head', position: [0, 0.9, 0], quaternion: [0, 0, 0, 1] });
  const slots = slotsOf(new Map([['basin', cleaned]]));
  assert.equal(cleaned.holder, 'head');
  assert.equal(slots.head, 'basin');
  assert.equal(slots.waist_slot, null);
});

// ---------- R04：授权必须对得上当前这盘棋 ----------

test('授权：计划指向别的棋局时一个 token 都不发', async () => {
  const { issueXiangqiAuth } = await import('../server/xiangqi-auth.mjs');
  const svc = new XiangqiService(tmp());
  svc.start({ requestId: 'new-game', userSide: 'black' });
  const session = { xiangqiSeq: 0, xiangqiAuth: new Map(), pendingXiangqi: null };
  const plan = { steps: [{ action: 'xiangqi_move', game_id: 'previous-unrelated-game', piece_id: 'red_soldier_1', to_row: 5, to_col: 0, expected_revision: 0 }] };
  const result = issueXiangqiAuth({ xiangqi: svc, session, task: { id: 't1', generation: 1 }, plan, log: () => {} });
  assert.equal(result.token, null);
  assert.equal(result.error.reason, 'STALE_GAME');
  assert.equal(session.xiangqiAuth.size, 0);
  assert.equal(session.pendingXiangqi, null);
});

test('授权：game_id 对上了才签发，换局时撤销', async () => {
  const { issueXiangqiAuth, pendingXiangqiCleanup } = await import('../server/xiangqi-auth.mjs');
  const svc = new XiangqiService(tmp());
  const board = svc.start({ requestId: 'g1', userSide: 'black' });
  const session = { xiangqiSeq: 0, xiangqiAuth: new Map(), pendingXiangqi: null };
  const plan = { steps: [{ action: 'xiangqi_move', game_id: board.gameId, piece_id: 'red_soldier_1', to_row: 5, to_col: 0, expected_revision: 0 }] };
  const issued = issueXiangqiAuth({ xiangqi: svc, session, task: { id: 't2', generation: 3 }, plan, log: () => {} });
  assert.ok(issued.token);
  assert.equal(session.pendingXiangqi.stage, 'reserved');
  assert.equal(session.pendingXiangqi.generation, 3);
  assert.equal(pendingXiangqiCleanup(session, 'xiangqi_start', () => {}), 2, 'token 与 pending 一起撤销');
  assert.equal(session.xiangqiAuth.size, 0);
  assert.equal(session.pendingXiangqi, null);
});

test('能力：xiangqi_move 不能放进 parallel，也不能嵌套', async () => {
  const { validatePlan } = await import('../server/capabilities.mjs');
  assert.throws(
    () => validatePlan({ type: 'execute_plan', steps: [{ action: 'parallel', items: [{ action: 'xiangqi_move', game_id: 'g', piece_id: 'black_rook_1', to_row: 3, to_col: 1, expected_revision: 1 }, { action: 'wait', duration_s: 0.2 }] }] }),
    /parallel/,
  );
  assert.throws(
    () => validatePlan({ type: 'execute_plan', steps: [{ action: 'parallel', items: [{ action: 'parallel', items: [{ action: 'wait', duration_s: 0.2 }] }] }] }),
    /嵌套/,
  );
});

// ---------- R09：用户走子必须真的落到地面 ----------

test('落子弧线按时间推进，最终精确落地；取消选择也把棋子放回地面', async () => {
  const THREE = await import('three');
  const { XiangqiBoard } = await import('../src/game/XiangqiBoard.ts');
  const board = new XiangqiBoard(new THREE.Scene());
  const layout = JSON.parse(fs.readFileSync('public/models/xiangqi-v1/initial_layout.json', 'utf8'));
  for (const p of layout) {
    board.layout.set(p.pieceId, p);
    board.templates.set(p.template, new THREE.Group());
  }
  const view = JSON.parse(JSON.stringify(boardView()));
  board.update(view);
  // 走一手：红兵 (6,0) → (5,0)
  const moved = JSON.parse(JSON.stringify(view));
  moved.revision = view.revision + 1;
  moved.pieces.find((p) => p.id === 'red_soldier_1').row = 5;
  board.update(moved);
  for (let i = 0; i < 240; i++) board.tick(1000 + i * 16.667);
  const obj = board.instances.get('red_soldier_1');
  assert.equal(+obj.position.y.toFixed(6), 0, '240 帧之后必须落在地面，不能浮在 0.055');
  assert.equal(+obj.position.z.toFixed(3), +((5 - 4.5) * 1.15).toFixed(3));
  // 选中抬高、取消落回
  board.select('red_rook_1');
  assert.equal(+board.targets.get('red_rook_1').pos.y.toFixed(3), 0.045);
  board.select(null);
  assert.equal(+board.targets.get('red_rook_1').pos.y.toFixed(3), 0);
});

// ---------- R01：场地尺寸只有一个来源 ----------

test('场地：象棋 11.5m 时角色可走范围跟着放大，退出复原', async () => {
  const { walkableHalfOf } = await import('../src/core/arena.ts');
  const { stageHalfNow, walkableHalfNow } = await import('../server/arena.mjs');
  assert.equal(walkableHalfOf(4), 3.7);
  assert.equal(walkableHalfOf(5.75), 5.45);
  assert.equal(stageHalfNow(false), 4);
  assert.equal(stageHalfNow(true), 5.75);
  assert.equal(walkableHalfNow(false), 3.7);
  assert.equal(walkableHalfNow(true), 5.45);
  // 客户端与服务端必须是同一组数字
  assert.equal(walkableHalfOf(4), walkableHalfNow(false));
  assert.equal(walkableHalfOf(5.75), walkableHalfNow(true));
});
