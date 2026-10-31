// Read-only audit of the engine. Fixtures are isolated; no service or user data.
import assert from 'node:assert/strict';
import {
  createGame, move, signature, adjudicateRepeat, naturalLimit,
  serializeGame, restoreGame, inCheck,
} from '../../../server/xiangqi.mjs';

function setup(specs) {
  const g = createGame({ gameId: 'rules-audit' });
  g.board.fill(null);
  g.pieces.clear();
  for (const [id, side, kind, row, col] of specs) {
    g.pieces.set(id, { id, side, kind, row, col });
    g.board[row * 9 + col] = id;
  }
  assert.equal(inCheck(g, 'red'), false);
  assert.equal(inCheck(g, 'black'), false);
  return g;
}

function play(g, sequence) {
  const history = [signature(g)];
  let verdict = null;
  for (const [id, row, col] of sequence) {
    const result = move(g, id, row, col);
    assert.equal(result.ok, true, `${id} -> ${row},${col}: ${JSON.stringify(result)}`);
    history.push(signature(g));
    verdict = adjudicateRepeat(g, history);
    if (verdict) break;
  }
  return { plies: g.moves.length, verdict, moves: g.moves };
}

const generals = [
  ['rg', 'red', 'general', 9, 3], ['bg', 'black', 'general', 0, 5],
];
const background = setup([
  ...generals,
  ['rr', 'red', 'rook', 8, 0], ['bh-target', 'black', 'horse', 4, 0],
  ['rh', 'red', 'horse', 9, 1], ['bh', 'black', 'horse', 0, 7],
]);
const horseCycle = [['rh', 7, 2], ['bh', 2, 6], ['rh', 9, 1], ['bh', 0, 7]];
const backgroundResult = play(background, [...horseCycle, ...horseCycle]);
assert.equal(backgroundResult.verdict?.loser, 'red');
assert.equal(backgroundResult.verdict?.reason, 'perpetual_chase');

const generalChase = setup([
  ['rg', 'red', 'general', 8, 3], ['bg', 'black', 'general', 0, 5],
  ['bc', 'black', 'cannon', 7, 3],
]);
generalChase.turn = 'black';
const generalCycle = [['bc', 7, 4], ['rg', 8, 4], ['bc', 7, 3], ['rg', 8, 3]];
const generalResult = play(generalChase, [...generalCycle, ...generalCycle]);
assert.equal(generalResult.verdict?.loser, 'red');
assert.equal(generalResult.verdict?.reason, 'perpetual_chase');

const chaseSpecs = [
  ...generals, ['rr', 'red', 'rook', 2, 0], ['bc', 'black', 'cannon', 5, 1],
];
const evasionEnd = setup(chaseSpecs);
const rookCycle = [['rr', 2, 1], ['bc', 5, 0], ['rr', 2, 0], ['bc', 5, 1]];
const evasionResult = play(evasionEnd, [...rookCycle, ...rookCycle]);
assert.equal(evasionResult.verdict?.reason, 'repetition');
const attackEnd = setup([
  ...generals, ['rr', 'red', 'rook', 2, 1], ['bc', 'black', 'cannon', 5, 1],
]);
attackEnd.turn = 'black';
const offsetCycle = [['bc', 5, 0], ['rr', 2, 0], ['bc', 5, 1], ['rr', 2, 1]];
const attackResult = play(attackEnd, [...offsetCycle, ...offsetCycle]);
assert.equal(attackResult.verdict?.reason, 'perpetual_chase');
assert.equal(attackResult.verdict?.loser, 'red');

const early = createGame({ gameId: 'early-repeat' });
const initialCycle = [
  ['red_horse_1', 7, 2], ['black_horse_1', 2, 2],
  ['red_horse_1', 9, 1], ['black_horse_1', 0, 1],
];
const earlyResult = play(early, [...initialCycle, ...initialCycle]);
assert.equal(earlyResult.verdict?.reason, 'repetition');
assert.equal(earlyResult.verdict?.winner, null);

const bare = setup(generals);
assert.equal(move(bare, 'rg', 8, 3).ok, true);
assert.equal(bare.status, 'playing');

const original = createGame({ gameId: 'same-type' });
const swapped = restoreGame(serializeGame(original));
// restoreGame copies board but piece objects are shared here; clone them first.
swapped.pieces = new Map([...swapped.pieces].map(([id, p]) => [id, { ...p }]));
const left = swapped.pieces.get('red_rook_1');
const right = swapped.pieces.get('red_rook_2');
[left.col, right.col] = [right.col, left.col];
swapped.board[9 * 9] = right.id;
swapped.board[9 * 9 + 8] = left.id;
const typeSignature = (g) => g.board.map(id => {
  const p = g.pieces.get(id);
  return p ? `${p.side}:${p.kind}` : '.';
}).join('|') + '#' + g.turn;
assert.equal(typeSignature(original), typeSignature(swapped));
assert.notEqual(signature(original), signature(swapped));

// Counting-boundary probe only; this is not a claimed legal 120-ply game.
const countProbe = { status: 'playing', moves: Array.from({ length: 120 }, (_, i) => ({
  side: i % 2 ? 'black' : 'red', captured: null, check: i % 2 === 0 && i < 24,
})) };
assert.equal(countProbe.moves.filter(m => m.check).length, 12);
assert.equal(naturalLimit(countProbe), true);

console.log(JSON.stringify({
  baseline: '0289367',
  backgroundThreat: { expected: 'Do not classify unchanged rook threat as newly created chase', ...backgroundResult },
  generalChase: { expected: 'General-only chase is permitted under 26.1; red must not lose for perpetual chase', ...generalResult },
  chasePhaseDependence: {
    expected: 'Classify the chase from the historical attack positions, not the final evasion position',
    afterEvasion: evasionResult, afterAttack: attackResult,
  },
  earlyQuietRepeat: { expected: 'Apply 4.3 red-side change requirement within 25 rounds, not unconditional draw', ...earlyResult },
  bareGenerals: { expected: 'Recognize simple position with neither side able to win, 4.2.2', actualStatus: bare.status },
  identicalTypePositions: { sameVisiblePosition: true, engineSignatureEqual: false, note: 'Representation probe, not a played swap sequence' },
  naturalLimitCounting: { checksByRed: 12, plies: 120, actualDraw: true, note: 'Counting-only probe; 22.2 counts at most 10 checks by claimant' },
}, null, 2));
