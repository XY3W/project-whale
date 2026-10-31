/**
 * 象棋对局服务：持有唯一棋局、签发单次搬运授权、处理提交、持久化与公开快照。
 *
 * 与规则模块分离（规则在 xiangqi.mjs）。这里只做：
 * - 开局 / 换边 / 结束
 * - 用户落子（moveId 幂等）
 * - 角色落子的两阶段事务：beginMove 签发 token → 客户端搬运 → commitMove 结算
 * - 公开状态（给模型和前端）
 */
import fs from "node:fs";
import path from "node:path";
import {
  RULESET, RED, BLACK, createGame, legalMoves, move as applyMove, position,
  publicGame, restoreGame, serializeGame, signature, other,
} from "./xiangqi.mjs";

const TOKEN_TTL_MS = 5 * 60 * 1000;

export class XiangqiService {
  constructor(file) {
    this.file = file;
    this.game = this.load();
    this.lastRequestId = null;
    this.tokens = new Map();
    this.tokenSeq = 0;
    /** moveId → 结算结果，用于客户端重发时幂等回放 */
    this.decisions = {};
    this.history = this.game ? [signature(this.game)] : [];
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.decisions = raw?.decisions ?? {};
      return restoreGame(raw);
    } catch {
      this.decisions = {};
      return null;
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...serializeGame(this.game), decisions: this.decisions }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("xiangqi save failed", err.message);
    }
  }

  public() {
    return this.game ? publicGame(this.game) : null;
  }

  get status() {
    return this.game?.status ?? null;
  }

  get turn() {
    return this.game?.turn ?? null;
  }

  /** 开局：红先；userSide 决定谁执红。同 requestId 幂等。 */
  start({ requestId, userSide = RED } = {}) {
    if (requestId && requestId === this.lastRequestId && this.game) return this.public();
    if (!requestId && this.game && this.game.status === "playing") return this.public();
    this.game = createGame({ gameId: `xq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, userSide: userSide === BLACK ? BLACK : RED });
    this.lastRequestId = requestId ?? null;
    this.tokens.clear();
    this.decisions = {};
    this.history = [signature(this.game)];
    this.save();
    return this.public();
  }

  /** 用户落子：moveId 幂等 + 版本校验 + 只能动自己的一方 */
  userMove({ moveId, gameId, pieceId, toRow, toCol, expectedRevision } = {}) {
    if (moveId && this.decisions[moveId]) return { ...this.decisions[moveId], replay: true, board: this.public() };
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (gameId !== this.game.gameId) return { ok: false, reason: "STALE_GAME" };
    if (this.game.status !== "playing") return { ok: false, reason: "GAME_OVER", status: this.game.status };
    // 先把“局面过期”和“没轮到你”判掉，再判棋子归属，错误码更有指向性
    if (expectedRevision !== undefined && expectedRevision !== this.game.revision) {
      const last = this.game.lastMove;
      if (last && last.pieceId === pieceId && last.to.row === toRow && last.to.col === toCol && this.game.revision === expectedRevision + 1) {
        return { ok: true, replay: true, move: last, board: this.public() };
      }
      return { ok: false, reason: "STALE_REVISION", revision: this.game.revision };
    }
    if (this.game.turn !== this.game.userSide) return { ok: false, reason: "NOT_YOUR_TURN", turn: this.game.turn };
    const piece = this.game.pieces.get(pieceId);
    if (!piece) return { ok: false, reason: "NO_PIECE" };
    if (piece.side !== this.game.userSide) return { ok: false, reason: "NOT_YOUR_PIECE" };
    const result = applyMove(this.game, pieceId, toRow, toCol);
    if (moveId) {
      this.decisions[moveId] = { ok: result.ok, ...result, board: undefined };
      const keys = Object.keys(this.decisions);
      if (keys.length > 100) for (const key of keys.slice(0, keys.length - 100)) delete this.decisions[key];
    }
    if (result.ok) {
      this.history.push(signature(this.game));
      this.save();
    }
    return { ...result, board: this.public() };
  }

  /**
   * 角色落子第一步：校验并签发一次性 token。
   * 绑定 gameId / pieceId / 目标 / revision / 任务代际；token 由宿主生成，模型不能编造。
   */
  beginMove({ pieceId, toRow, toCol, expectedRevision, taskId = null, generation = null } = {}) {
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (this.game.status !== "playing") return { ok: false, reason: "GAME_OVER", status: this.game.status };
    if (expectedRevision !== undefined && expectedRevision !== this.game.revision) {
      return { ok: false, reason: "STALE_REVISION", revision: this.game.revision };
    }
    if (this.game.turn !== this.game.characterSide) return { ok: false, reason: "NOT_YOUR_TURN", turn: this.game.turn };
    const piece = this.game.pieces.get(pieceId);
    if (!piece) return { ok: false, reason: "NO_PIECE" };
    if (piece.side !== this.game.characterSide) return { ok: false, reason: "NOT_YOUR_PIECE", side: piece.side };
    const legal = legalMoves(this.game, pieceId);
    if (!legal.some((m) => m.row === toRow && m.col === toCol)) {
      return { ok: false, reason: "ILLEGAL_MOVE", legalMoves: legal };
    }
    const token = `xq-${++this.tokenSeq}-g${generation ?? 0}`;
    this.tokens.set(token, {
      token,
      gameId: this.game.gameId,
      pieceId,
      toRow,
      toCol,
      expectedRevision: this.game.revision,
      taskId,
      generation,
      issuedAt: Date.now(),
      used: false,
      response: null,
    });
    // 新授权签发即作废旧授权：抢占/重来之后，上一轮的 token 不能再把棋子落下去
    for (const t of this.tokens.values()) if (!t.used && t.token !== token) t.superseded = true;
    const used = [...this.tokens.values()].filter((t) => t.used);
    for (const t of used.slice(0, Math.max(0, used.length - 8))) this.tokens.delete(t.token);
    return { ok: true, token, from: { row: piece.row, col: piece.col }, to: { row: toRow, col: toCol }, revision: this.game.revision };
  }

  /** 角色落子第二步：带 token 提交，服务端复检后结算。 */
  commitMove({ token, revision, toRow, toCol } = {}) {
    const auth = this.tokens.get(String(token ?? ""));
    if (!auth) return { ok: false, reason: "NO_AUTH" };
    if (auth.used) return { ...(auth.response ?? { ok: false, reason: "ALREADY_COMMITTED" }), replay: true, board: this.public() };
    if (auth.superseded) return { ok: false, reason: "SUPERSEDED" };
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (this.game.gameId !== auth.gameId) return { ok: false, reason: "STALE_GAME" };
    if (auth.issuedAt && Date.now() - auth.issuedAt > TOKEN_TTL_MS) return { ok: false, reason: "EXPIRED" };
    if (this.game.status !== "playing") return { ok: false, reason: "GAME_OVER", status: this.game.status };
    if (toRow !== undefined && (toRow !== auth.toRow || toCol !== auth.toCol)) return { ok: false, reason: "STALE_TARGET" };
    if (revision !== undefined && revision !== auth.expectedRevision) return { ok: false, reason: "STALE_REVISION", revision: this.game.revision };
    if (this.game.revision !== auth.expectedRevision) return { ok: false, reason: "STALE_REVISION", revision: this.game.revision };
    const result = applyMove(this.game, auth.pieceId, auth.toRow, auth.toCol);
    const response = { ...result, committed: result.ok, token };
    auth.used = true;
    auth.response = response;
    if (result.ok) {
      this.history.push(signature(this.game));
      this.save();
    }
    return { ...response, board: this.public() };
  }

  /** 用户认输 / 结束 */
  resign(side = null) {
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (this.game.status !== "playing") return { ok: false, reason: "GAME_OVER", status: this.game.status };
    const loser = side ?? this.game.userSide;
    this.game.status = "won";
    this.game.result = { winner: other(loser), reason: "resign" };
    this.game.revision += 1;
    this.save();
    return { ok: true, board: this.public() };
  }

  /** 收摊 */
  clear() {
    this.game = null;
    this.lastRequestId = null;
    this.tokens.clear();
    this.decisions = {};
    this.history = [];
    try {
      fs.writeFileSync(this.file, "null");
    } catch (err) {
      console.error("xiangqi clear failed", err.message);
    }
    return { ok: true, cleared: true };
  }

  waitingForCharacter() {
    return !!this.game && this.game.status === "playing" && this.game.turn === this.game.characterSide;
  }

  waitingForUser() {
    return !!this.game && this.game.status === "playing" && this.game.turn === this.game.userSide;
  }

  /** 局面数据（将军/合法着法/终局），给公开快照与提示词用 */
  facts() {
    return this.game ? position(this.game) : null;
  }

  get ruleset() {
    return RULESET;
  }
}
