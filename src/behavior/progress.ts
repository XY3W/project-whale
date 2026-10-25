/**
 * 进度看门狗。
 *
 * 问题背景：走路 1.89 m 需要 17.6 秒的“动画时间”，而动画是按帧推进的。
 * 浏览器掉到 5 fps 时同样的位移要跑两分多钟，任何按墙钟写的固定超时都会提前返回，
 * 于是执行器量到“只走了 1.64 米”，把正常行走报成位移不符。
 *
 * 这里改成只看“有没有进展”：只要位移/角度还在变就继续等，连续 idleMs 没有进展
 * 才判定卡住；maxMs 只是最后的兜底。
 */
export type ProgressState = "waiting" | "done" | "stalled";

export interface ProgressMonitorOptions {
  start: number;
  initial?: number;
  /** 连续多久没有进展就判定卡住（毫秒） */
  idleMs?: number;
  /** 总时长兜底（毫秒） */
  maxMs?: number;
  /** 进展判定的最小增量 */
  epsilon?: number;
}

export class ProgressMonitor {
  private readonly start: number;
  private readonly idleMs: number;
  private readonly maxMs: number;
  private readonly epsilon: number;
  private readonly initial: number;
  private best: number;
  private lastProgressAt: number;

  constructor(opts: ProgressMonitorOptions) {
    this.start = opts.start;
    this.idleMs = opts.idleMs ?? 6000;
    this.maxMs = opts.maxMs ?? 180000;
    this.epsilon = opts.epsilon ?? 1e-4;
    this.initial = opts.initial ?? 0;
    this.best = this.initial;
    this.lastProgressAt = opts.start;
  }

  sample(now: number, progress: number, done: boolean): ProgressState {
    if (done) return "done";
    if (progress > this.best + this.epsilon) {
      this.best = progress;
      this.lastProgressAt = now;
    }
    if (now - this.lastProgressAt >= this.idleMs) return "stalled";
    if (now - this.start >= this.maxMs) return "stalled";
    return "waiting";
  }

  get progress(): number {
    return this.best;
  }

  get elapsedSinceProgress(): number {
    return this.lastProgressAt - this.start;
  }
}
