import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGame, move, signature, adjudicateRepeat, serializeGame, inCheck } from '../server/xiangqi.mjs';
import { historicalPositions, classifyMove, exchangeAssessment, proveCheckingMate, adjudicateMultiPoint } from '../server/xiangqi-adjudication.mjs';
import { XiangqiService } from '../server/xiangqi-service.mjs';

const generals = [['rg', 'red', 'general', 9, 3], ['bg', 'black', 'general', 0, 5]];
function setup(specs, turn = 'red') {
  const g = createGame({ gameId: 'cca-regression' });
  g.board.fill(null); g.pieces.clear(); g.turn = turn;
  for (const [id, side, kind, row, col] of specs) {
    g.pieces.set(id, { id, side, kind, row, col }); g.board[row * 9 + col] = id;
  }
  assert.equal(inCheck(g, 'red'), false);
  assert.equal(inCheck(g, 'black'), false);
  return g;
}
function play(g, sequence) {
  const history = [signature(g)];
  for (const [id, row, col] of sequence) {
    const result = move(g, id, row, col);
    assert.equal(result.ok, true, `${id} -> ${row},${col}: ${JSON.stringify(result)}`);
    history.push(signature(g));
  }
  return { history, verdict: adjudicateRepeat(g, history) };
}
const repeat = cycle => [...cycle, ...cycle];
function service(t, g) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cca-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const svc = new XiangqiService(path.join(dir, 'game.json'));
  svc.game = g; svc.history = [signature(g)]; svc.save();
  return svc;
}
function serviceMove(svc, [pieceId, toRow, toCol]) {
  const g = svc.game;
  const result = g.turn === g.userSide
    ? svc.userMove({ gameId: g.gameId, moveId: `m${g.revision}`, expectedRevision: g.revision, pieceId, toRow, toCol })
    : (() => {
      const auth = svc.beginMove({ pieceId, toRow, toCol, expectedRevision: g.revision });
      assert.equal(auth.ok, true, JSON.stringify(auth));
      return svc.commitMove({ token: auth.token, revision: auth.revision });
    })();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, svc.status, 'reply must contain post-adjudication status');
  return result;
}
const rookCycle = [['rr', 2, 1], ['bc', 5, 0], ['rr', 2, 0], ['bc', 5, 1]];
const rookChase = () => setup([...generals, ['rr', 'red', 'rook', 2, 0], ['bc', 'black', 'cannon', 5, 1]]);

test('24.3: unchanged rook threat is not caused by unrelated horse shuffles', () => {
  const g = setup([...generals, ['rr', 'red', 'rook', 8, 0], ['target', 'black', 'horse', 4, 0],
    ['rh', 'red', 'horse', 9, 1], ['bh', 'black', 'horse', 0, 7]]);
  const cycle = [['rh', 7, 2], ['bh', 2, 6], ['rh', 9, 1], ['bh', 0, 7]];
  assert.equal(play(g, repeat(cycle)).verdict, null);
  const p = historicalPositions(g);
  for (let i = 0; i < g.moves.length; i++) assert.equal(classifyMove(p[i], p[i + 1], g.moves[i]).type, 'idle');
});

test('26.1: general-only chase of cannon is permitted in either cycle phase', () => {
  for (const blackFirst of [false, true]) {
    const g = setup([['rg', 'red', 'general', 8, 3], ['bg', 'black', 'general', 0, 5],
      ['bc', 'black', 'cannon', 7, blackFirst ? 3 : 4]], blackFirst ? 'black' : 'red');
    const cycle = blackFirst ? [['bc', 7, 4], ['rg', 8, 4], ['bc', 7, 3], ['rg', 8, 3]]
      : [['rg', 8, 4], ['bc', 7, 3], ['rg', 8, 3], ['bc', 7, 4]];
    assert.equal(play(g, repeat(cycle)).verdict, null);
  }
});

test('chase is determined historically, same after attack or after evasion', () => {
  const a = play(rookChase(), repeat(rookCycle)).verdict;
  const b = setup([...generals, ['rr', 'red', 'rook', 2, 1], ['bc', 'black', 'cannon', 5, 1]], 'black');
  const otherPhase = [['bc', 5, 0], ['rr', 2, 0], ['bc', 5, 1], ['rr', 2, 1]];
  const c = play(b, repeat(otherPhase)).verdict;
  for (const v of [a, c]) {
    assert.equal(v.reason, 'perpetual_chase'); assert.equal(v.requiredSide, 'red');
    assert.equal(v.immediate, false); assert.equal(v.winner, undefined);
  }
});

test('chase responsibility is symmetric when sides and board coordinates are reversed', () => {
  const original = rookChase();
  const specs = [...original.pieces.values()].map(p => [p.id, p.side === 'red' ? 'black' : 'red', p.kind, 9 - p.row, 8 - p.col]);
  const mirrored = setup(specs, 'black');
  const sequence = repeat(rookCycle).map(([id, row, col]) => [id, 9 - row, 8 - col]);
  assert.equal(play(mirrored, sequence).verdict.requiredSide, 'black');
});

test('24.11: alternating chase of two targets is still a prohibited cycle', () => {
  const g = setup([...generals, ['rr', 'red', 'rook', 2, 0],
    ['bc0', 'black', 'cannon', 5, 0], ['bc1', 'black', 'cannon', 5, 1], ['br', 'black', 'rook', 0, 8]]);
  const cycle = [['rr', 2, 1], ['br', 1, 8], ['rr', 2, 0], ['br', 0, 8]];
  const v = play(g, repeat(cycle)).verdict;
  assert.equal(v.requiredSide, 'red'); assert.equal(v.reason, 'perpetual_chase');
});

test('26.9: equal mutual chase does not arbitrarily forfeit the first side visited', () => {
  const g = setup([...generals, ['rr', 'red', 'rook', 2, 0],
    ['bc0', 'black', 'cannon', 5, 0], ['bc1', 'black', 'cannon', 5, 1],
    ['br', 'black', 'rook', 0, 7], ['rc0', 'red', 'cannon', 0, 6], ['rc1', 'red', 'cannon', 1, 6]]);
  const cycle = [['rr', 2, 1], ['br', 1, 7], ['rr', 2, 0], ['br', 0, 7]];
  assert.equal(play(g, repeat(cycle)).verdict, null);
});

test('24.13: alternating check and chase requires the attacking side to change', () => {
  const g = setup([['rg', 'red', 'general', 9, 3], ['bg', 'black', 'general', 0, 4],
    ['rr', 'red', 'rook', 2, 5], ['screen', 'black', 'cannon', 1, 5], ['bc', 'black', 'cannon', 5, 5]]);
  const cycle = [['rr', 2, 4], ['bg', 0, 5], ['rr', 2, 5], ['bg', 0, 4]];
  const v = play(g, repeat(cycle)).verdict;
  assert.equal(v.requiredSide, 'red'); assert.equal(v.reason, 'perpetual_attack');
});

test('23.5.2: warn before penalty, continuing two own moves forfeits; state survives restart', t => {
  let svc = service(t, rookChase());
  for (const m of repeat(rookCycle)) serviceMove(svc, m);
  assert.equal(svc.status, 'playing');
  assert.equal(svc.game.ruleWarning.requiredSide, 'red');
  assert.equal(svc.game.ruleWarning.remainingTurns, 2);
  serviceMove(svc, rookCycle[0]);
  assert.equal(svc.game.ruleWarning.remainingTurns, 1);
  svc = new XiangqiService(svc.file);
  assert.equal(svc.game.ruleWarning.remainingTurns, 1);
  serviceMove(svc, rookCycle[1]);
  const result = serviceMove(svc, rookCycle[2]);
  assert.equal(svc.status, 'won'); assert.equal(result.result.winner, 'black');
  assert.equal(svc.game.ruleWarning, null);
});

test('a different move clears a warning rather than continuing the old countdown', t => {
  const svc = service(t, rookChase());
  for (const m of repeat(rookCycle)) serviceMove(svc, m);
  serviceMove(svc, ['rr', 3, 0]);
  assert.equal(svc.status, 'playing'); assert.equal(svc.game.ruleWarning, null);
});

test('23.4: nine attacking rounds from three points warn even without three identical positions; an idle move clears it', t => {
  const g = setup([['rg', 'red', 'general', 9, 3], ['bg', 'black', 'general', 0, 4], ['rr', 'red', 'rook', 2, 3]]);
  const sequence = [['rr',0,3],['bg',1,4],['rr',1,3],['bg',2,4],['rr',2,3],['bg',1,4],
    ['rr',1,3],['bg',2,4],['rr',2,3],['bg',1,4],['rr',2,4],['bg',1,5],
    ['rr',1,4],['bg',2,5],['rr',2,4],['bg',1,5],['rr',1,4],['bg',2,5]];
  const { history, verdict } = play(g, sequence);
  assert.equal(verdict, null);
  assert.ok([...new Set(history)].every(sig => history.filter(s => s === sig).length <= 2));
  const warning = adjudicateMultiPoint(g);
  assert.equal(warning.requiredSide, 'red'); assert.equal(warning.needsIdle, true);
  const svc = service(t, g); svc.history = history;
  svc.adjudicate(); assert.equal(svc.game.ruleWarning.needsIdle, true);
  serviceMove(svc, ['rr', 3, 4]);
  assert.equal(svc.game.ruleWarning, null); assert.equal(svc.status, 'playing');
});

test('permitted early repetition, 120 no-capture plies and bare generals never auto-draw', t => {
  const svc = service(t, createGame({ gameId: 'quiet' }));
  const cycle = [['red_horse_1', 7, 2], ['black_horse_1', 2, 2], ['red_horse_1', 9, 1], ['black_horse_1', 0, 1]];
  for (let i = 0; i < 30; i++) for (const m of cycle) serviceMove(svc, m);
  assert.equal(svc.game.moves.length, 120); assert.equal(svc.status, 'playing');
  assert.equal(svc.game.ruleWarning, null);
  const bare = service(t, setup(generals));
  serviceMove(bare, ['rg', 8, 3]); assert.equal(bare.status, 'playing');
});

test('manual draw needs explicit agreement and current game/revision, persists and invalidates tokens', t => {
  const svc = service(t, rookChase());
  const base = { gameId: svc.game.gameId, expectedRevision: 0, userAgreed: true };
  assert.equal(svc.agreeDraw({ ...base, userAgreed: false }).reason, 'USER_AGREEMENT_REQUIRED');
  assert.equal(svc.agreeDraw({ ...base, gameId: 'old' }).reason, 'STALE_GAME');
  assert.equal(svc.agreeDraw({ ...base, expectedRevision: 9 }).reason, 'STALE_REVISION');
  const out = svc.agreeDraw(base);
  assert.equal(out.board.result.reason, 'agreed_draw'); assert.equal(svc.status, 'drawn');
  assert.equal(new XiangqiService(svc.file).status, 'drawn');
  assert.equal(svc.userMove({ gameId: svc.game.gameId }).reason, 'GAME_OVER');
});

test('same side/kind positions share a signature while individual identities are preserved', () => {
  const g = createGame(); const before = signature(g);
  const a = g.pieces.get('red_rook_1'), b = g.pieces.get('red_rook_2');
  [a.col, b.col] = [b.col, a.col];
  g.board[81] = b.id; g.board[89] = a.id;
  assert.equal(signature(g), before);
  assert.notEqual(g.board[81], 'red_rook_1');
});

test('legacy save migrates ID-based signatures and reconstructs captured pieces', t => {
  const svc = service(t, createGame({ gameId: 'legacy' }));
  serviceMove(svc, ['red_cannon_1', 0, 1]); // captures the initial black horse over its cannon
  const raw = serializeGame(svc.game); delete raw.ruleVersion;
  delete raw.moves[0].capturedPiece;
  fs.writeFileSync(svc.file, JSON.stringify({ ...raw, history: ['old-id-signature'] }));
  const restored = new XiangqiService(svc.file);
  assert.equal(restored.history.length, 2);
  assert.equal(restored.history[0], signature(createGame()));
  assert.equal(restored.history[1], signature(restored.game));
  assert.equal(restored.game.ruleVersion, 2);
});

test('exchanges: actual legal recaptures, pinned defenders, equal horse/cannon value', () => {
  const guarded = setup([...generals, ['rr', 'red', 'rook', 8, 0], ['bh', 'black', 'horse', 4, 0], ['br', 'black', 'rook', 3, 0]]);
  assert.ok(exchangeAssessment(guarded, { attacker: 'rr', victim: 'bh' }).gain < 0);
  const pinned = setup([['rg', 'red', 'general', 9, 3], ['bg', 'black', 'general', 0, 4],
    ['pin', 'red', 'rook', 0, 8], ['br', 'black', 'rook', 0, 6], ['rr', 'red', 'rook', 3, 8], ['bh', 'black', 'horse', 3, 6]]);
  const p = exchangeAssessment(pinned, { attacker: 'rr', victim: 'bh' });
  assert.equal(p.free, true); assert.ok(p.gain > 0);
  const equivalent = setup([...generals, ['rh', 'red', 'horse', 6, 1], ['bc', 'black', 'cannon', 4, 2], ['br', 'black', 'rook', 3, 2]]);
  assert.equal(exchangeAssessment(equivalent, { attacker: 'rh', victim: 'bc' }).gain, 0);
  assert.equal(exchangeAssessment(equivalent, { attacker: 'rh', victim: 'bc' }, { nodeLimit: 0 }).complete, false);
});

test('checking mate proof covers every legal response; budget exhaustion is not proof', () => {
  const g = setup([['rg', 'red', 'general', 9, 3], ['bg', 'black', 'general', 0, 4],
    ['r1', 'red', 'rook', 2, 3], ['r2', 'red', 'rook', 1, 0]]);
  const mate = proveCheckingMate(g, 'red', { depth: 1 });
  assert.equal(mate.proven, true);
  assert.ok(mate.participants.includes('r1'));
  const limited = proveCheckingMate(g, 'red', { depth: 1, nodeLimit: 1 });
  assert.equal(limited.proven, false); assert.equal(limited.exhausted, true);
  g.ruleWarning = { requiredSide: 'red', remainingTurns: 1 };
  assert.equal(move(g, 'r1', 0, 3).status, 'won');
  assert.equal(g.result.reason, 'checkmate');
  assert.equal(g.ruleWarning, null, 'a completed game cannot keep a change-move warning');
});
