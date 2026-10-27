/**
 * 五子棋对局服务：持有唯一棋局、处理开局/落子/结束、持久化。
 * 规则全在 gomoku.mjs，这里只做 IO、幂等和版本校验。
 */
import fs from "node:fs";
import path from "node:path";
import { BLACK, WHITE, createGame, endGame, place, publicGame, restoreGame, serializeGame } from "./gomoku.mjs";

export class GomokuService {
  constructor(file) {
    this.file = file;
    this.game = this.load();
    this.lastRequestId = null;
    /** 最近几次落子的结果，用于客户端重发时幂等回放 */
    this.decisions = {};
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
      console.error("gomoku save failed", err.message);
    }
  }

  /** 开局：同一 requestId 幂等；带 requestId 一定开新局（黑先） */
  start(requestId) {
    if (requestId && requestId === this.lastRequestId && this.game) return this.public();
    if (!requestId && this.game && this.game.status === "playing") return this.public();
    // 交给 createGame 生成带随机后缀的 id：同一毫秒连开两局也不会撞
    this.game = createGame({});
    this.lastRequestId = requestId ?? null;
    this.decisions = {};
    this.save();
    return this.public();
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

  /**
   * 落子。color 由调用方给出：用户固定 WHITE，角色固定 BLACK。
   * 校验顺序：有局 → 同一局 → 状态 → 版本（含幂等重放）→ 交给规则核心。
   */
  move({ moveId, gameId, row, col, color, expectedRevision } = {}) {
    if (moveId && this.decisions[moveId]) {
      return { ...this.decisions[moveId], replay: true, board: this.public() };
    }
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (gameId !== this.game.gameId) return { ok: false, reason: "STALE_GAME" };
    if (this.game.status !== "playing") return { ok: false, reason: "GAME_OVER", status: this.game.status };
    if (expectedRevision !== undefined && expectedRevision !== this.game.revision) {
      // 客户端重发同一个落子：上一次已经成功，直接回放
      const last = this.game.lastMove;
      if (last && last.row === row && last.col === col && this.game.revision === expectedRevision + 1) {
        return { ok: true, replay: true, move: last, status: this.game.status, turn: this.game.turn, board: this.public() };
      }
      return { ok: false, reason: "STALE_REVISION", revision: this.game.revision };
    }
    const result = place(this.game, row, col, color ?? this.game.turn);
    if (moveId) {
      this.decisions[moveId] = { ok: result.ok, ...result, board: undefined };
      const keys = Object.keys(this.decisions);
      if (keys.length > 100) for (const key of keys.slice(0, keys.length - 100)) delete this.decisions[key];
    }
    if (result.ok) this.save();
    return { ...result, board: this.public() };
  }

  /** 用户点「五子棋结束」：进行中 → 结束；已结束 → 收摊 */
  end() {
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (this.game.status === "playing") {
      const result = endGame(this.game);
      if (result.ok) this.save();
      return { ...result, board: this.public() };
    }
    this.clear();
    return { ok: true, cleared: true, board: null };
  }

  clear() {
    this.game = null;
    this.lastRequestId = null;
    this.decisions = {};
    try {
      fs.writeFileSync(this.file, "null");
    } catch (err) {
      console.error("gomoku clear failed", err.message);
    }
    return { ok: true, cleared: true };
  }

  /** 她（黑方）该走吗 */
  waitingForCharacter() {
    return !!this.game && this.game.status === "playing" && this.game.turn === BLACK;
  }

  /** 用户（白方）该走吗 */
  waitingForUser() {
    return !!this.game && this.game.status === "playing" && this.game.turn === WHITE;
  }
}

export { BLACK, WHITE };
