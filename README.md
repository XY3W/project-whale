# Project Whale

让 LLM 驱动的 3D 桌宠。方向是**预生成动画 + LLM 选择 + 分层叠加**：
模型只决定“现在做什么动作、去哪里”，动作质量由美术保证。

## 先读这个

- **当前状态**：[docs/PROGRESS.md](docs/PROGRESS.md)（按日期倒序，最上面是最新进度）。
- **协作与部署**：[docs/VERSION_MANAGEMENT.md](docs/VERSION_MANAGEMENT.md)——Mac 开发、GitHub 同步、服务器只拉取构建。
- **中国象棋**：[交接入口](docs/XIANGQI_DEVELOPMENT_HANDOFF.md) · [方案](docs/XIANGQI_PLAN.md) · [素材契约](docs/XIANGQI_ASSET_HANDOFF.md) · [进度](docs/XIANGQI_PROGRESS.md)。
- **提示词分段与缓存**：[docs/PROMPT_CACHE_LAYOUT.md](docs/PROMPT_CACHE_LAYOUT.md)——棋谱放哪、为什么。

## 运行

```bash
pnpm install
pnpm dev                                   # 前端 http://127.0.0.1:5178，代理到 8090
BRAIN_PORT=8099 BRAIN_DEV=1 AUTO_MINESWEEPER=0 node server/index.mjs   # 服务端 + 假大脑
```

- 主场景 `/`：完整角色 + 分层播放器 + 三个游戏 + 左下角正面小窗
- 场地切换：左栏「场地 / 房间」，1 秒滑动转场；房间里隐藏开局入口
- 动作验收页 `/animation.html`
- 眨眼验收 `/blink.html`，象棋素材页 `/xiangqi-assets.html`
- 旧 V4 调试页 `/lab.html`

## 结构

```
src/
├── main.ts                  入口：场景、聊天、游戏桥、抢占与搬运
├── core/                    渲染舞台、相机、阴影包围盒、场地
├── character/               分层播放器、位姿叠加、眨眼、注视、尾巴、轨道归属
├── behavior/                move_to 执行器、步态阶梯、协议、漫游
├── game/                    扫雷、五子棋、象棋棋盘表现
├── prop/                    盆/勺道具、物理、拾取范围、catalog
├── ui/                      聊天、HUD、定时器、正面小窗与相机
└── brain/                   模型客户端与规则导演
server/                      权威服务：棋规、扫雷、五子棋、LLM 闭环、技能、记忆、租约
tests/                       node --test 全量回归（374 项）
```

## 已知状态

- 角色：83 骨，原 45 段 + 象棋 16 段；材质眨眼已启用（早期“眨眼禁用”的说明已作废）。
- 移动：模型只给坐标，执行器自选走路/慢走/跑步并处理转向、收步。
- 象棋：服务端权威棋规可玩；**精细“捉”仍标部分实现**，取消时没有 `chess_safe_setdown` 表现层。
- 扫雷 16×16 / 40 雷，五子棋 15×15，三者与聊天互斥调度。
- 正面小窗：前景棋子可能遮住下半身（已知，暂不处理）。
- 房间：程序化几何体家具（沙发/床/书架/台灯），暂无坐下/躺下动作。

## 素材

原始交付包在 `assets/`；运行时资产在 `public/models/`，当前角色为
`public/models/xiangqi-v1/character_xiangqi.glb`（完整副本），旧版
`blink-material-v2` 与 `v8-provisional` 保留作对照。
