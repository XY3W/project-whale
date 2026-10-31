# Project Whale

让 LLM 驱动的 3D 桌宠。方向是**预生成动画 + LLM 选择 + 分层叠加**：
模型只决定“现在做什么动作”，动作质量由美术保证。

## 当前开发交接

2026-10-31：中国象棋请从[开发交接入口](docs/XIANGQI_DEVELOPMENT_HANDOFF.md)开始，配套[正式方案](docs/XIANGQI_PLAN.md)、[素材契约](docs/XIANGQI_ASSET_HANDOFF.md)与[提示词增补](docs/llm-design/XIANGQI_PROMPT_ADDENDUM.md)。独立素材验收页：`/xiangqi-assets.html`。共享Mac开发与部署遵守[版本管理约定](docs/VERSION_MANAGEMENT.md)。

下方早期模型/功能说明保留作历史背景；当前代码和本轮交接优先，不能据此判断最新功能是否存在。

## 运行

```bash
pnpm install
pnpm dev        # http://127.0.0.1:5178
```

- 主场景：V9 动作库 + 分层播放器（`/`）
- 动作验收页：`/animation.html`
- 旧 V4 调试页：`/lab.html`

## 结构

```
src/
├── main.ts                    入口；默认 V8
├── core/Stage.ts              渲染器、相机、灯光、地面
├── character/
│   ├── LayeredMotionPlayer.ts 分层播放、手势过渡、慢走起停
│   ├── multiWeight.ts         完整权重、法线、阴影蒙皮
│   ├── Character.ts           V4 旧模型（仅调试页使用）
│   └── V8Character.ts         V8 静态模型（旧方案，保留）
├── brain/Director.ts          规则导演
└── ui/Hud.ts                  状态面板
```

## 文档

- [DESIGN.md](./docs/DESIGN.md)：方向、架构、分层、里程碑
- [ANIMATION_SPEC.md](./docs/ANIMATION_SPEC.md)：动作清单、轨道切分、待解决项、验收
- [INFRA.md](./docs/INFRA.md)：服务器与排错记录

## 已知状态

- V9 动作库已接入：待机、慢走、挥手、注意、点头、左右看、思考、大小摆尾
- 脸部形态键仍损坏，眨眼与表情禁用
- 跑步、坐下、跳跃、任意转弯不在本次交付范围

## 素材

`assets/完整绑定_V4.zip` 为原始交付包；运行时资产在
`public/models/`（V4）与 `public/models/dev/v8-provisional/`（V8 临时）。
