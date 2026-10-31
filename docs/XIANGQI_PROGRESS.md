# 中国象棋接入进度（DeepSeek）

2026-10-31。入口与契约见 [XIANGQI_DEVELOPMENT_HANDOFF.md](XIANGQI_DEVELOPMENT_HANDOFF.md)、[XIANGQI_PLAN.md](XIANGQI_PLAN.md)、[XIANGQI_ASSET_HANDOFF.md](XIANGQI_ASSET_HANDOFF.md)。

## 已完成（服务端切片，273 项测试通过）

### ① 棋规引擎 `server/xiangqi.mjs`

纯函数，不依赖 IO/渲染。七类棋子走法、九宫、河界、蹩马腿、塞象眼、炮架、兵卒过河、将帅照面、自陷将军过滤、将军/将死/困毙。

**验证**：perft 深度 1/2/3 与公认标准值完全一致——**44 / 1920 / 79666**。这覆盖了走法生成、自陷将军过滤、照面判定与炮架规则，比逐条单测更有说服力。

### ② 权威服务 `server/xiangqi-service.mjs`

- 开局（用户选红/黑，红先）、认输、收摊、持久化到 `data/xiangqi.json`；
- 用户落子：`moveId` 幂等、`expectedRevision` 校验、只能动自己的子；
- 角色落子两阶段：`beginMove` 签发一次性 token（绑定 gameId/piece/源/目标/revision/任务代际）→ 客户端搬运 → `commitMove` 复检并结算，重复提交只回放不回滚；
- 公开快照 `publicGame`：回合、revision、32 子行列、按 pieceId 分组的 legalMoves、将军/结果/最近棋步。

### ③ 能力与工具

`server/capabilities.mjs` 注册并校验：`xiangqi_move(game_id,piece_id,to_row[0..9],to_col[0..8],expected_revision)`、`stow_scoop`、`unstow_scoop`。`xiangqi_move` 与 dig/place_stone 一样「单次且必须最后一步」。`shared/resources.mjs` 登记资源冲突：抱棋占用 `body_locomotion/left_arm/right_arm/both_hands/chess_carry/item:<piece>`，挂勺只占右臂+腰槽。工具 Schema 由能力表自动生成，模型侧无需另写。

### ④ 协议与提示词

- WS：`xiangqi_start` / `xiangqi_move`（用户）/ `xiangqi_commit`（客户端带 token 提交）/ `xiangqi_end` / `xiangqi_state`，回 `xiangqi_state` / `xiangqi_result`；`session_state` 增加 `xiangqi`；
- 三模式互斥：开象棋收起扫雷/五子棋，反之亦然；
- `server/prompts/system.txt`、`planning.txt`、`review.txt` 增加 `{{#xiangqi}}` 条件段（**仅在对局进行时注入**，实测 +853 字符）；`server/llm.mjs` 的 `renderSections` 支持 `xiangqi`；
- `server/public-state.mjs` 新增 `xiangqiContext`：10×9 文本盘面（红大写、黑小写）、合法候选、装备槽位、pending。

### 测试

`tests/xiangqi.test.mjs`（14，含 perft）、`tests/xiangqi-service.test.mjs`（9）、`tests/xiangqi-ws.test.mjs`（4，真实 WS：开局/用户走子/非法与幂等/授权提交/结束）。

## 未完成（客户端与正式场景）

1. **棋盘与场地**：11.5×11.5 场地、board.glb 铺地、隐藏 16×16 网格、相机/边界/寻路参数切换与退出恢复；
2. **用户交互**：选子抬升悬停、两种目标提示、悬停强调、弧线落座、拖动排除、重连恢复；
3. **角色搬运**：`character_xiangqi.glb`（61 段）加载与旧 45 段兼容、魔法吸附/抱持/送出、`chess_*` 16 段动作接入、右腰挂勺的视觉与槽位、两手单一持棋锚点；
4. **异常与抢占**：闹钟最高优先级打断、安全放置、ACK 丢失/重复、旧代际 token、多页租约；
5. **完整棋例**：长将/长捉/循环/自然限着目前只有 `adjudicateRepeat` 的保守占位（三次重复→不判和，仅标记），**不能宣称已完整符合 CCA2020 棋例**；逐例裁决待补；
6. **LLM 闭环实测**：能力、提示词、事件已就绪，但还没有真实模型 + 真人对局跑通「她走一着 → review → 等用户」的完整回合。

## 当前可否开局

服务端可开局、可走子、可提交，但**前端还没有象棋入口**，UI 不显示棋盘。按交接文档「素材数值通过不代表正式执行器已上线」，这一版只算服务端切片，不能当作象棋游戏已交付。
