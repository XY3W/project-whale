/** Chess-case analysis, separate from legal move generation. No automatic draws.
 * Only proven tactical lines can cause a penalty. Search exhaustion is unknown,
 * never evidence that a player lost. Full CCA2020 diagram certification is pending.
 */
import {
  other, cloneGame, applyUnchecked, capturesBy, allLegalMoves, inCheck,
  signature, initialPieces, crossedRiver,
} from './xiangqi.mjs';

const SIDES = ['red', 'black'];
const moveKey = m => `${m.side}:${m.pieceId}:${m.from.row},${m.from.col}>${m.to.row},${m.to.col}`;
const cache = new WeakMap();

/** Reconstruct actual historical positions, preserving identities for chase analysis.
 * Older production saves have stable IDs; new captures also store capturedPiece.
 */
export function historicalPositions(game) {
  if (!(game.pieces instanceof Map)) return null;
  const initial = new Map(initialPieces().map(p => [p.id, p]));
  const positions = Array(game.moves.length + 1);
  let cursor = cloneGame(game);
  cursor.status = 'playing';
  positions[game.moves.length] = cursor;
  for (let i = game.moves.length - 1; i >= 0; i--) {
    const m = game.moves[i];
    cursor = cloneGame(cursor);
    const actor = cursor.pieces.get(m.pieceId);
    if (!actor || !m.from || !m.to || actor.row !== m.to.row || actor.col !== m.to.col) return null;
    if (cursor.board[m.to.row * 9 + m.to.col] !== actor.id) return null;
    cursor.board[m.to.row * 9 + m.to.col] = null;
    actor.row = m.from.row;
    actor.col = m.from.col;
    cursor.board[actor.row * 9 + actor.col] = actor.id;
    if (m.captured) {
      const raw = m.capturedPiece ?? initial.get(m.captured);
      if (!raw) return null;
      const victim = { ...raw, id: m.captured, row: m.to.row, col: m.to.col };
      cursor.pieces.set(victim.id, victim);
      cursor.board[victim.row * 9 + victim.col] = victim.id;
    }
    cursor.turn = m.side;
    cursor.revision = Math.max(0, (m.revision ?? i + 1) - 1);
    positions[i] = cursor;
  }
  return positions;
}

function asTurn(position, side) { return { ...position, status: 'playing', turn: side }; }
function afterMove(position, m) {
  const { next } = applyUnchecked(position, m.pieceId, m.row, m.col);
  next.turn = other(position.pieces.get(m.pieceId).side);
  next.status = 'playing';
  return next;
}

// CCA classes: a rook roughly equals two horses/cannons; horse and cannon
// are equal. Strong-for-many-weak trades cannot become a gain just by summing.
const strong = p => p.kind === 'rook' ? 2 : ['horse', 'cannon'].includes(p.kind) ? 1 : 0;
const weak = p => ['advisor', 'elephant'].includes(p.kind) ? 1 : 0;
function exchangeValue(taken, lost) {
  if (taken.every(p => p.kind === 'pawn') && lost.some(p => p.kind !== 'pawn')) return -1;
  if (lost.length && lost.every(p => p.kind === 'pawn') && taken.some(p => p.kind !== 'pawn' && p.kind !== 'rook')) return 0;
  const delta = fn => taken.reduce((n, p) => n + fn(p), 0) - lost.reduce((n, p) => n + fn(p), 0);
  const s = delta(strong);
  if (s) return Math.sign(s) * 100 + s;
  const w = delta(weak);
  if (w) return Math.sign(w) * 10 + w;
  // Pawn-for-piece swaps are not gains under 26.7 (except pawn for rook).
  if (taken.some(p => p.kind === 'pawn') && lost.some(p => p.kind !== 'pawn')) return -1;
  if (lost.some(p => p.kind === 'pawn') && taken.some(p => p.kind !== 'pawn')) return 0;
  return taken.filter(p => p.kind === 'pawn').length - lost.filter(p => p.kind === 'pawn').length;
}

/** Legal recaptures on the exchange square. Unlike a static "defended" flag,
 * this evaluates the position AFTER each capture, so pins, cannon screens,
 * horse legs and newly exposed protection are tested by the normal move rules.
 * An incomplete search can never establish a profitable chase.
 */
export function exchangeAssessment(position, threat, { nodeLimit = 1200 } = {}) {
  const actor = position.pieces.get(threat.attacker);
  const victim = position.pieces.get(threat.victim);
  if (!actor || !victim || victim.kind === 'general') return { gain: 0, complete: true, free: false, participants: [] };
  const attacker = actor.side;
  const next = afterMove(asTurn(position, attacker), { pieceId: actor.id, row: victim.row, col: victim.col });
  const target = victim.row * 9 + victim.col;
  const replies = capturesBy(next, other(attacker)).filter(t => t.row * 9 + t.col === target);
  const immediateMate = proveCheckingMate(next, other(attacker), { depth: 1, nodeLimit: 160 });
  if (immediateMate.exhausted) return { gain: 0, complete: false, free: false, participants: [] };
  if (immediateMate.proven) {
    return { gain: 0, complete: true, free: false, participants: [] };
  }
  let nodes = 0;
  let complete = true;
  function visit(p, side, taken, lost, participants) {
    if (++nodes > nodeLimit) { complete = false; return { gain: 0, participants }; }
    let best = { gain: exchangeValue(taken, lost), participants };
    const choices = capturesBy(p, side).filter(t => t.row * 9 + t.col === target);
    for (const t of choices) {
      const captured = p.pieces.get(t.victim);
      if (!captured || captured.kind === 'general') continue;
      const result = visit(afterMove(asTurn(p, side), { pieceId: t.attacker, row: t.row, col: t.col }),
        other(side), side === attacker ? [...taken, captured] : taken,
        side !== attacker ? [...lost, captured] : lost,
        side === attacker ? [...new Set([...participants, t.attacker])] : participants);
      if (side === attacker ? result.gain > best.gain : result.gain < best.gain) best = result;
    }
    return best;
  }
  const result = visit(next, other(attacker), [victim], [], [actor.id]);
  return { ...result, gain: complete ? result.gain : 0, complete, free: replies.length === 0, nodes };
}

/** Bounded proof of a checking mate threat. The attacker may only check;
 * every legal defender reply must be covered. Returns proof participants.
 * An unfinished branch is never treated as a mate proof.
 */
export function proveCheckingMate(position, side, { depth = 5, nodeLimit = 1600 } = {}) {
  let nodes = 0;
  let exhausted = false;
  function visit(p, turn, remaining) {
    if (++nodes > nodeLimit) { exhausted = true; return null; }
    const current = asTurn(p, turn);
    const moves = allLegalMoves(current);
    if (!moves.length) return turn !== side ? new Set() : null; // stalemate is also a loss
    if (remaining === 0) return null;
    if (turn === side) {
      for (const m of moves) {
        const next = afterMove(current, m);
        if (!inCheck(next, other(side))) continue;
        const proof = visit(next, other(side), remaining - 1);
        if (proof) { proof.add(m.pieceId); return proof; }
        if (exhausted) return null;
      }
      return null;
    }
    const union = new Set();
    for (const m of moves) {
      const proof = visit(afterMove(current, m), side, remaining - 1);
      if (!proof) return null;
      for (const id of proof) union.add(id);
    }
    return union;
  }
  const proof = visit(position, side, depth);
  return { proven: !!proof, participants: [...proof ?? []], exhausted, nodes, depth };
}

/** Classify THIS move at its historical position, not attacks elsewhere. */
export function classifyMove(before, after, record, previous = null) {
  if (cache.has(record)) return cache.get(record);
  const actor = after.pieces.get(record.pieceId);
  const done = value => { cache.set(record, value); return value; };
  if (!actor) return done({ type: 'unknown', chases: [] });
  if (record.check) return done({ type: 'check', chases: [] });
  if (actor.kind === 'general' && inCheck(before, actor.side)) return done({ type: 'idle', chases: [] });
  const old = new Set(capturesBy(before, actor.side).map(t => `${t.attacker}>${t.victim}`));
  const threats = capturesBy(after, actor.side).filter(t => {
    const victim = after.pieces.get(t.victim);
    if (!victim || victim.kind === 'general') return false;
    if (t.attacker !== actor.id && old.has(`${t.attacker}>${t.victim}`)) return false;
    if (victim.kind === 'pawn') {
      if (!crossedRiver(victim.side, victim.row)) return false;
      if (previous?.pieceId === victim.id && !crossedRiver(victim.side, previous.from.row)) return false;
    }
    return true;
  });
  const chases = [];
  for (const threat of threats) {
    const p = after.pieces.get(threat.attacker);
    // General answering check is idle; direct general/pawn chases are allowed.
    if (actor.kind === 'general' && inCheck(before, actor.side)) continue;
    if (['general', 'pawn'].includes(p.kind) && threat.attacker === actor.id) {
      if (!threats.some(t => t.victim === threat.victim && t.attacker !== actor.id)) continue;
    }
    const exchange = exchangeAssessment(after, threat);
    if (!exchange.complete || exchange.gain <= 0) continue;
    const victim = after.pieces.get(threat.victim);
    chases.push({ attacker: threat.attacker, victim: victim.id, victimKind: victim.kind,
      free: exchange.free, joint: exchange.participants.length > 1, participants: exchange.participants });
  }
  // A proved mate threat takes precedence over chasing. To avoid attributing an
  // unrelated old threat, require a new proof or movement of a proof participant.
  const mate = proveCheckingMate(after, actor.side);
  if (mate.exhausted) return done({ type: 'unknown', chases });
  if (mate.proven) {
    const oldMate = proveCheckingMate(before, actor.side);
    if (!oldMate.proven || mate.participants.includes(actor.id)) return done({ type: 'kill', chases, proofDepth: mate.depth });
  }
  return done({ type: chases.length ? 'chase' : 'idle', chases });
}

function sideOffense(moves) {
  if (moves.length < 2 || moves.some(m => !['check', 'kill', 'chase'].includes(m.type))) return null;
  if (moves.every(m => m.type === 'check')) return { reason: 'perpetual_check', rank: 100 };
  if (moves.some(m => m.type === 'kill')) return { reason: 'perpetual_attack', rank: 3 };
  const allChases = moves.filter(m => m.type === 'chase');
  if (!allChases.length) return null;
  // One piece or several alternating victims are both covered by 24.11.
  const severe = allChases.every(m => m.chases.some(t => (t.victimKind === 'rook' || t.free) && !t.joint));
  const joint = allChases.every(m => m.chases.some(t => (t.victimKind === 'rook' || t.free) && t.joint));
  return { reason: moves.some(m => m.type === 'check') ? 'perpetual_attack' : 'perpetual_chase', rank: severe ? 3 : joint ? 2 : 1 };
}

function responsibility(cycle, classifications) {
  if (classifications.some(c => c.type === 'unknown')) return null;
  const offense = new Map(SIDES.map(side => [side, sideOffense(classifications.filter((_, i) => cycle[i].side === side))]));
  const accused = SIDES.filter(side => offense.get(side));
  if (!accused.length) return null;
  let loser = accused[0];
  if (accused.length === 2) {
    const [red, black] = SIDES.map(side => offense.get(side));
    if (red.rank === black.rank || Math.max(red.rank, black.rank) < 3) return null;
    loser = red.rank > black.rank ? 'red' : 'black';
  }
  return { loser, reason: offense.get(loser).reason };
}

/** Repeat verdicts are either a proven one-sided offense, or null. Permitted
 * repeats and mutual attacks NEVER end the game: draws are agreed in chat.
 */
export function adjudicateRepeat(game, history) {
  if (!game || game.status !== 'playing' || !Array.isArray(history)) return null;
  const current = signature(game);
  const seen = [];
  for (let i = 0; i < history.length; i++) if (history[i] === current) seen.push(i);
  if (seen.length < 3) return null;
  const start = seen.at(-3);
  const cycle = game.moves.slice(start);
  if (!cycle.length) return null;
  const bySide = new Map(SIDES.map(side => [side, cycle.filter(m => m.side === side)]));
  const checkers = SIDES.filter(side => bySide.get(side).length >= 2 && bySide.get(side).every(m => m.check));
  if (checkers.length === 1) {
    const loser = checkers[0];
    return { reason: 'perpetual_check', winner: other(loser), loser, immediate: true };
  }
  if (checkers.length > 1) return null;
  const positions = historicalPositions(game);
  if (!positions) return null; // Never infer guilt from missing legacy data.
  const classifications = cycle.map((m, i) => classifyMove(positions[start + i], positions[start + i + 1], m, game.moves[start + i - 1]));
  if (classifications.some(c => c.type === 'unknown')) return null;
  const duty = responsibility(cycle, classifications);
  if (!duty) return null;
  return { ...duty, requiredSide: duty.loser, immediate: false,
    cycle: [...new Set(cycle.map(moveKey))], sinceRevision: game.revision,
    classifications: classifications.map((c, i) => ({ side: cycle[i].side, type: c.type })) };
}

/** 23.4: nine rounds of attacks from at least three points can be submitted
 * without three identical positions. Such a warning requires an idle move,
 * not merely moving the attack to a different point (23.5.2.3).
 */
export function adjudicateMultiPoint(game) {
  if (game.status !== 'playing' || game.moves.length < 18) return null;
  const start = game.moves.length - 18;
  const cycle = game.moves.slice(start);
  if (cycle.some(m => m.captured)) return null;
  const positions = historicalPositions(game);
  if (!positions) return null;
  const classifications = cycle.map((m, i) => classifyMove(positions[start + i], positions[start + i + 1], m, game.moves[start + i - 1]));
  const duty = responsibility(cycle, classifications);
  if (!duty) return null;
  const own = cycle.filter(m => m.side === duty.loser);
  if (own.length !== 9 || new Set(own.map(m => `${m.to.row},${m.to.col}`)).size < 3) return null;
  return { ...duty, requiredSide: duty.loser, immediate: false, needsIdle: true,
    cycle: [...new Set(cycle.map(moveKey))], sinceRevision: game.revision };
}

/** A non-check offense is a warning first (23.5.2). The original cycle cannot
 * be prolonged by opening a new warning every ply. Breaking its actual edges
 * clears it; continuing for two own turns forfeits. Persisted across restarts.
 */
export function advanceRuleWarning(game) {
  const warning = game.ruleWarning;
  if (!warning) return null;
  const m = game.moves.at(-1);
  if (!m || m.revision <= warning.lastRevision) return null;
  if (m.captured || (!warning.needsIdle && !warning.cycle.includes(moveKey(m)))) { game.ruleWarning = null; return null; }
  warning.lastRevision = m.revision;
  if (m.side !== warning.requiredSide) return null;
  if (warning.needsIdle) {
    const positions = historicalPositions(game);
    if (!positions) { game.ruleWarning = null; return null; }
    const classification = classifyMove(positions.at(-2), positions.at(-1), m, game.moves.at(-2));
    if (classification.type === 'idle' || classification.type === 'unknown') { game.ruleWarning = null; return null; }
  }
  warning.remainingTurns -= 1;
  if (warning.remainingTurns > 0) return null;
  return { winner: other(warning.requiredSide), loser: warning.requiredSide, reason: warning.reason };
}
