import { Character } from "../character/Character";
import { Idle } from "../character/Idle";

export interface DirectorState {
  label: string;
  sub: string;
  energy: number;
  boredom: number;
  clip: string;
}

interface Intent {
  id: string;
  label: string;
  sub: string;
  duration: number;
  weight: () => number;
  enter?: () => void;
  update?: (t: number, dt: number) => void;
  exit?: () => void;
}

/**
 * 规则导演：现在它只是"这个角色想干嘛"的替身。
 *
 * 它对外暴露的东西——意图标签、动作时长、可打断——就是将来
 * 接 DeepSeek 时 Action IR 需要覆盖的最小集合。之后把 pick() 换成
 * 一次模型调用即可，下面的表演层完全不用动。
 */
export class Director {
  energy = 0.82;
  boredom = 0.18;
  /** 暂停自动决策（调试/截图用） */
  paused = false;

  private current: Intent | null = null;
  private elapsed = 0;
  private waitFor = 1.6;
  private lastLabel = "待机";
  private lastSub = "呼吸 · 微动 · 眨眼";

  constructor(
    private readonly character: Character,
    private readonly idle: Idle,
    /** 没有动画片段时（V8 静态阶段），走/跑/跳不进入候选 */
    private readonly hasClips = true,
  ) {}

  private intents: Intent[] = [
    {
      id: "glance",
      label: "四处看看",
      sub: "视线游移",
      duration: 3.8,
      weight: () => 3.2,
      enter: () => this.idle.lookAway(0, 0),
      update: (t) => {
        // 两段式：先看一边，再看另一边
        const phase = Math.floor(t / 1.9);
        const dir = phase % 2 === 0 ? -1 : 1;
        this.idle.lookAway(dir * (0.32 + ((phase * 37) % 10) / 60), dir * 0.04);
      },
      exit: () => this.idle.lookAtCursor(),
    },
    {
      id: "notice",
      label: "注意到你",
      sub: "视线回到光标",
      duration: 2.4,
      weight: () => 2.4,
      enter: () => {
        this.idle.lookAtCursor();
        this.idle.tiltTarget = -0.05;
      },
      exit: () => {
        this.idle.lookAtCursor();
        this.idle.tiltTarget = 0;
      },
    },
    {
      id: "think",
      label: "想了想",
      sub: "抬头 · 挑眉",
      duration: 3.0,
      weight: () => 1.4,
      enter: () => {
        this.idle.lookAway(0.42, 0.22);
        this.idle.tiltTarget = 0.11;
      },
      exit: () => {
        this.idle.lookAtCursor();
        this.idle.tiltTarget = 0;
      },
    },
    {
      id: "shift",
      label: "换个重心",
      sub: "重心摆动放大",
      duration: 4.2,
      weight: () => 2.0,
      enter: () => {
        this.idle.swayGain = 2.6;
        this.idle.breathGain = 1.5;
      },
      exit: () => {
        this.idle.swayGain = 1;
        this.idle.breathGain = 1;
      },
    },
    {
      id: "tilt",
      label: "歪了歪头",
      sub: "头部侧倾",
      duration: 2.8,
      weight: () => 1.7,
      enter: () => {
        this.idle.tiltTarget = 0.09;
        this.idle.swayGain = 1.5;
      },
      exit: () => {
        this.idle.tiltTarget = 0;
        this.idle.swayGain = 1;
      },
    },
    {
      id: "walk",
      label: "走两步",
      sub: "播放慢走片段",
      duration: 3.74,
      weight: () => 1.5,
      enter: () => this.character.play("walk", 0.4),
      exit: () => this.character.stand(0.5),
    },
    {
      id: "run",
      label: "小跑",
      sub: "播放慢跑片段",
      duration: 3.2,
      weight: () => (this.energy > 0.5 ? 0.9 : 0),
      enter: () => {
        this.character.play("run", 0.35);
        this.energy = Math.max(0.15, this.energy - 0.12);
      },
      exit: () => this.character.stand(0.5),
    },
    {
      id: "jump",
      label: "跳一下",
      sub: "播放跳跃片段",
      duration: 2.24,
      weight: () => (this.energy > 0.55 ? 0.75 : 0),
      enter: () => {
        this.character.play("jump", 0.22);
        this.energy = Math.max(0.15, this.energy - 0.16);
        this.boredom = 0;
      },
      exit: () => this.character.stand(0.35),
    },
  ];

  update(dt: number) {
    if (this.paused) return;
    this.energy = Math.min(1, this.energy + dt * 0.012);
    this.boredom = Math.min(1, this.boredom + dt * 0.018);

    if (!this.current) {
      this.waitFor -= dt;
      if (this.waitFor <= 0) this.pick();
      return;
    }

    this.elapsed += dt;
    this.current.update?.(this.elapsed, dt);

    if (this.elapsed >= this.current.duration) {
      this.current.exit?.();
      this.current = null;
      this.waitFor = 1.2 + Math.random() * 2.0;
    }
  }

  /** 手动触发（按钮 / 点击角色 / 键盘） */
  trigger(id: string) {
    if (!this.hasClips && (id === "walk" || id === "run" || id === "jump")) return;
    const intent = this.intents.find((i) => i.id === id);
    if (intent) this.start(intent);
  }

  private pick() {
    const pool = this.intents.filter(
      (i) => i.weight() > 0 && (this.hasClips || (i.id !== "walk" && i.id !== "run" && i.id !== "jump")),
    );
    // 无聊时更想动，安静时更倾向小动作
    const weights = pool.map((i) => {
      const moving = i.id === "walk" || i.id === "run" || i.id === "jump";
      const base = i.weight();
      return moving ? base * (0.6 + this.boredom * 1.6) : base * (1.4 - this.boredom * 0.5);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        this.start(pool[i]);
        return;
      }
    }
    this.start(pool[0]);
  }

  private start(intent: Intent) {
    if (this.current) this.current.exit?.();
    this.current = intent;
    this.elapsed = 0;
    this.boredom = Math.max(0, this.boredom - 0.25);
    intent.enter?.();

    this.lastLabel = intent.label;
    this.lastSub = intent.sub;
  }

  get state(): DirectorState {
    return {
      label: this.current ? this.lastLabel : "待机",
      sub: this.current ? this.lastSub : "呼吸 · 微动 · 眨眼",
      energy: this.energy,
      boredom: this.boredom,
      clip: this.character.currentClipName,
    };
  }
}
