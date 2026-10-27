/**
 * 扫雷对局服务：持有唯一棋盘、处理开局与挖掘提交、持久化、产出公开快照。
 * 雷表只在服务端存储里；对外只给 publicBoard（未揭示格无 value）。
 */
import fs from "node:fs";
import path from "node:path";
import { createGame, dig, endGame, publicBoard, restoreGame, serializeGame, cellAt } from "./minesweeper.mjs";

export class GameService {
  constructor(file) {
    this.file = file;
    this.game = this.load();
    this.lastRequestId = null;
  }

  load() {
    try {
      const raw=JSON.parse(fs.readFileSync(this.file,"utf8"));this.decisions=raw?.digDecisions??{};return restoreGame(raw);
    } catch {
      this.decisions={};return null;
    }
  }

  save() {
    if (!this.game) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp=this.file+".tmp";fs.writeFileSync(tmp,JSON.stringify({...serializeGame(this.game),digDecisions:this.decisions??{}}));fs.renameSync(tmp,this.file);
    } catch (err) {
      console.error("minesweeper save failed", err.message);
    }
  }

  /** 开局：同一 requestId 幂等；新局换 gameId、revision 归零 */
  start(requestId) {
    if (requestId && requestId === this.lastRequestId && this.game) return this.public();
    // 刷新页面后继续当前进行中的对局，而不是静默开新局
    if (!requestId && this.game && this.game.status === "playing") return this.public();
    this.game = createGame({ gameId: `g${Date.now().toString(36)}`, seed: (Math.random() * 0xffffffff) >>> 0 });
    this.lastRequestId = requestId ?? null;
    this.save();
    return this.public();
  }

  lookup(actionInstanceId){return this.decisions?.[actionInstanceId]??null;}

  public() {
    return this.game ? publicBoard(this.game) : null;
  }

  get status() {
    return this.game?.status ?? null;
  }

  /** 挖掘提交：校验 gameId / revision / 坐标，再由规则核心原子结算 */
  commit({ actionInstanceId, gameId, row, col, expectedRevision } = {}) {
    if(actionInstanceId&&this.decisions?.[actionInstanceId])return {...this.decisions[actionInstanceId],board:this.public()};
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (gameId !== this.game.gameId) return { ok: false, reason: "STALE_GAME" };
    if (expectedRevision !== undefined && expectedRevision !== this.game.revision) {
      return { ok: false, reason: "STALE_REVISION", revision: this.game.revision };
    }
    const result = dig(this.game, row, col);
    if(actionInstanceId){this.decisions??={};this.decisions[actionInstanceId]=result;this.decisions=Object.fromEntries(Object.entries(this.decisions).slice(-100));}
    if (result.ok || actionInstanceId) this.save();
    return { ...result, board: this.public() };
  }

  /**
   * 用户点「扫雷结束」：
   * - 进行中 → 结束并揭开雷区，盘面留着看结果；
   * - 已经胜负/结束 → 收摊，清掉对局，场地回到正常状态。
   */
  end() {
    if (!this.game) return { ok: false, reason: "NO_GAME" };
    if (this.game.status === "playing") {
      const result = endGame(this.game);
      if(result.ok)this.save();
      return { ...result, board: this.public() };
    }
    this.clear();
    return { ok: true, cleared: true, board: null };
  }

  /** 收摊：忘掉这一局，重启后也不会又冒出来 */
  clear() {
    this.game = null;
    this.lastRequestId = null;
    try {
      fs.writeFileSync(this.file, "null");
    } catch (err) {
      console.error("minesweeper clear failed", err.message);
    }
    return { ok: true, cleared: true };
  }

  /** 角色所在格（由服务端按权威坐标复算，不信任客户端） */
  cellOf(x, z) {
    return cellAt(x, z);
  }
}
