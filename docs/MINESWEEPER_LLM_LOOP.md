# 扫雷 LLM 闭环：提示词、双手物品、场地事件

2026-10-26 · 承接 [MINESWEEPER_IMPLEMENTATION.md](MINESWEEPER_IMPLEMENTATION.md) §5–§7。
上一批（`8c7d1b5`）只做到「规则核心 + 服务端对局 + 棋盘渲染」；这一批把**模型真正接到棋盘上**：
提示词增补、双手物品注册表、公开快照、场地事件触发的自主回合，以及 dig 的代码级前置条件。

## 0. 棋盘与难度变更（10×10/15 → 16×16/53 → 16×16/40）

- 先按「高级密度」改到 `SIZE=16` / `MINE_COUNT=53` / `SAFE_TOTAL=203`（20.70% vs 经典高级 20.63%）。
- 2026-10-27 再调：高级密度在小盘面上太难、一局要玩很久，改成 **`MINE_COUNT=40`**（15.63%），
  对齐经典「中级」的 16×16/40，`SAFE_TOTAL=216`。
- 棋盘仍然占 **8m × 8m** 场地（`CELL_M=0.5`、`BOARD_HALF=4`），格心公式随之变成
  `x = -4 + (col+0.5) * 0.5`。客户端不再写死 0.5：`cellSize/boardHalf` 随棋盘下发。
- 模型看到的棋盘从 256 条 JSON 记录换成 **16 行 × 16 字符的网格**
  （`.` 未揭示、`0-9` 数字、`*` 引爆的雷）。同样的信息，planning 上下文从 ~8.5k
  降到 ~6.7k tokens；未揭示格仍然不带任何数值。
- 旧存档兼容：`serializeGame()` 现在写 `size/mineCount`，尺寸不符或雷索引越界的旧存档
  直接忽略并开新局，不会把 10×10 的索引套到 16 宽的网格上。
- 拾取判据修正：有落地变体的物品（饭勺）改用「到站位点的距离 + 朝向差」判定，
  不再用径向距离 + 方位角——16 格更密的站位下，2cm 的切向偏差会被放大成 4.5° 朝向误差，
  导致合法的拾取被判 `NOT_ALIGNED`。
- 挖掘站位容差仍是 0.12m（格宽 0.5m，半格 0.25m），执行器会给出实际距离让模型微调。

## 1. 能力注册表（`server/capabilities.mjs`）

- 修掉一个会让 **run 永远不可用** 的缺陷：注册表里同时存在 `run(enabled:true)` 和旧的
  `run(enabled:false, "没有跑步片段")`，`byId` 取最后一个，所有 `run` 计划都被判
  `CAPABILITY_DISABLED`。现在只剩一条，`describeDisabled()` 只报 `sit`。
- 双手物品用一张表描述，工具参数由它生成：

  | object_id | 槽位 | pickup | throw | wear/unwear |
  |---|---|---|---|---|
  | `basin` | 左手 / 头顶 | ✓ | ✓ | ✓ |
  | `rice_scoop` | 右手 | ✓ | ✓ | ✗ |

  `wear`/`unwear` 只接受 `basin`；饭勺戴头在注册表层就被拒绝，不依赖模型自觉。
- **一次挖掘的硬限制写进校验器**，而不是只写在提示词里：
  `assertDigPlacement()` 拒绝 `MULTIPLE_DIG_STEPS`、`DIG_NOT_LAST`、`DIG_IN_PARALLEL`。
  违规计划整体拒绝，服务端不派发残步。

## 2. 提示词（`server/prompts/`）

- `system.txt` 原文接入交付包 `llm-design/MINESWEEPER_PROMPT_ADDENDUM.md` 的共享段落
  （双手、跑动距离、拾取对齐、10×10 规则、一计划一 dig、零格展开、事件合并、预算纪律）。
- `planning.txt` / `review.txt` 追加 planning/review 阶段约束（见同一份交付）。
- `llm.mjs` 的上下文块改成 `REQUEST_CONTEXT_JSON:` 前缀 + 函数式替换，
  避免 JSON 里的 `$&`/`$1` 被 `String.replace` 当成替换语法吃掉。

## 3. 公开快照（`server/public-state.mjs`）

每次模型调用都会收到同一套公开字段，字段名与交付包 §5 对齐：

```text
goal.originalText / goal.origin     用户目标与触发来源
userMessage                          本轮用户消息（自主回合为 null）
attentionEvents                      本批场地事件（game_started/board_updated/game_finished）
executionReport                      review 阶段的逐步结果
leaseAndBudget                       租约、轮数、剩余预算
capabilities / disabledCapabilities  由注册表生成
world / characterState               场地、坐标约定、位置/朝向/当前格
props.slots / props.objects          双手槽位、物品状态、位置、pickupStand、可用动作
board                                10×10 公开棋盘（未揭示格只有 row/col/state）
history / memory                     预算内历史与已确认记忆
```

- 棋盘未揭示格**不带 value**，上下文里不含 `mines`、种子或任何邻雷统计。
- 物品注册表从「单个 BasinProp」升级为 `props` Map：`basin` 与 `rice_scoop` 各一份，
  槽位由物品状态推导（`slotsOf`），不信任客户端单独上报的 slots。
- 饭勺的 `pickupStand`（站位点 + 站位朝向 + 落地变体）由客户端按「物品位置 − 朝向变换后的拾取偏移」
  算出后随快照上报；模型据此自己 turn/walk，不需要猜偏移。
- 旧存档迁移：`holder:"hand"` 按物品落到 `left_hand`/`right_hand`，`head` 仍是 `head`；
  `flying`/`transferring` 这类不稳定状态退回上一份稳定快照，没有上一份就按落地处理；
  饭勺的 `worn` 记录降级成右手持有。

## 4. 场地事件驱动的自主回合（`server/index.mjs` + `server/events.mjs`）

```text
按钮开局 ──► game_started ┐
                          ├─► 事件队列（同类只留最高 revision）
dig 提交成功 ─► board_updated ┤
挖到雷/挖完 ─► game_finished ─┘
                                 │
                 没有进行中的任务 ─┴─► 400ms 合并窗口 → 自主 planning 回合
                 有任务 ─────────────► 等该任务的下一次 planning/review 合并处理
```

- 事件与 `plan_result` **合并进同一次 review**：一次调用里既看到执行报告，也看到
  `board_updated@N`，处理完即从队列移除（不会重复投喂）。
- 自主回合和用户消息走同一个 `beginTask()`：同样的租约、代际、`MAX_ROUNDS=4`、
  `BUDGET_MS=180s`、去重账本。游戏事件不能私建不受控循环。
- 用户消息优先：用户说话时，攒下的场地事件并入同一轮 planning，而不是另起一回合。
- 自主回合允许完全沉默（`speech` 为空时不发 `public_reply`），也不再机械输出「好了。」。
- 客户端接管失败（身体停不下来）也必须回传 `plan_result`，否则服务端会一直等到预算耗尽。

## 5. 挖掘前置条件（客户端 + 服务端）

`DigBridge.precheck()` 在播放动画前逐项检查，失败直接返回 `PRECONDITION_FAILED` + 具体原因：

| 检查 | 原因码 |
|---|---|
| 棋盘存在且 `status=playing` | `NO_GAME` / `GAME_OVER` |
| `game_id` 一致 | `STALE_GAME` |
| `expected_revision` 一致 | `STALE_REVISION` |
| 右手持有 `rice_scoop` | `NO_SCOOP` |
| 角色根位置距格心 ≤0.12m | `NOT_IN_CELL`（带实际距离与格心） |
| 目标格未揭示 | `ALREADY_REVEALED` |
| 身体站稳（非行走/转身/表演中） | `NOT_STILL` |

服务端仍然自己复算格子（`cellAt(x,z)`）、校验 `gameId`/`revision`，不信任客户端传来的 row/col。
动画执行超时改成 90s 的卡死兜底（低帧率机器一段 2.5s 片段可能要跑几十秒墙钟），
walk/run/adjust/play 的墙钟预算同样放宽，真正的「卡住」交给进度看门狗。

## 6. 顺带修掉的三个渲染/位移缺陷

真实动画验收暴露了两个与扫雷无关、但会直接影响“走到格子”的老问题：

1. **每一段多周期走路都少走一圈**。`walkDistance()` 里 `cyclesLeft = n - 1`，而
   `walk_start → walk` 的转移并不扣数，实际只走了 `n-1` 圈：请求 1.89m 只到 1.71m，
   执行器报 `DISPLACEMENT_MISMATCH`。现在 `cyclesLeft = n`，并且 `n=0`（0.09m）时
   起步后直接收步；点击地面行走改用 `cyclesLeft = Infinity` + `haltMovement()` 不再续圈。
   修复前 1.89m 只走 1.71m，修复后实测 1.890m。
2. **棋盘平面离地，把贴地物件「切」了**（两次修）。地板顶面在 `y=0.002`，棋盘原来是
   悬在 `y=0.005` 的第二张平面，而盆底/角色脚底在 `y≈0`——网格线（和半透明底色）会盖在
   盆底那一截上，看起来像「网格线有厚度、盆陷进棋盘里」。第一次只是把它降到 0.0025 并加
   polygonOffset，**治标不治本**：只要棋盘是浮在地板上的一层平面，贴地物件必然被切。
   最终做法是**不再有第二层平面**——`Stage` 把地板顶面（8×8）和原始装饰贴图暴露出来，
   `MinesweeperBoard` 开局时直接把棋盘画布贴到地板上（`groundTop.material.map = texture`），
   结束后还原装饰网格。棋盘就是地面，不可能和任何贴地物件相交；顺带还让地板原有的
   阴影接收生效，盆和勺现在也会在地板上投影，落地感更实。
3. **低帧率下墙钟超时把正常动作判成超时**。walk/run/adjust/play/turn/dig 的预算改成
   宽松的卡死兜底（walk 180s + 15s/圈、turn 15s 无进展），真正的卡住交给进度看门狗；
   180° 转身在 1.5fps 的 headless 环境里从「4 秒超时」变成正常完成。

## 7. 她自己的局：开局与续玩（2026-10-26 追加）

扫雷是**她自己玩**的，不是等用户点按钮的任务：

- `AUTO_MINESWEEPER`（默认开）驱动一个 5 秒的调度器 `tickAutoPlay()`：
  - 没有进行中的局 → 自己开一局（`trigger: "self"`），客户端收到 `game_state` 与
    `game_started`，模型开始下；
  - 局还没结束 → 发 `self_play` 事件请她继续（棋盘没变，只是邀请）。
- 只在「没有任务、有执行端、聊天面板关着、phase 不是 unknown」时触发；
  用户一开口她就让位。关掉聊天后自动回到自己的局。
- 节奏与刹车（都可用环境变量覆盖）：
  `AUTO_CONTINUE_IDLE_MS=45s`、`AUTO_START_IDLE_MS=90s`、
  `AUTO_MAX_TURNS=6`/小时、退避上限 10 分钟。
- **按进展退避**：一个自主回合结束时，如果 `revision` 没涨（原地打转、或者她判断需要猜），
  下次间隔翻倍（×2…×8，封顶 10 分钟）；真的挖到了就恢复正常节奏。这样既不会因为她
  “不想玩了”而空转烧 API，也不会因为一次失败而停摆。
- 自主回合用完 4 轮预算、或超时，都不再弹「需要新的指示」这类面向用户的话。
- 自主回合**不带历史对话**：`goal.originalText=null` + `goal.note` 写明本轮触发原因，
  `history` 整个省略。加这个是因为第一次上线时模型把 history 里上一句
  「把勺子扔出去」当成了这一轮的目标，转头去扔勺子而不是挖格子。
- 成本参考：思考模式下每次调用约 7k 输入 + 6–7k 思考 token，约 0.07 元/次；
  默认上限下每小时最多约 24 次调用。想更省就调大 `AUTO_CONTINUE_IDLE_MS`
  或调小 `AUTO_MAX_TURNS`，`AUTO_MINESWEEPER=0` 可以完全关掉。

## 8. UI

- 左上角按钮：调试模式 / 重置盆 / 重置勺 / 扫雷开局。**只要盘面还在**（进行中 / 踩雷 /
  通关 / 已结束）第四个按钮就是「扫雷结束」（红色）：
  - 进行中 → 结束这一局，状态记 `ended`、揭开全部雷区，盘面留着看结果；
  - 已经踩雷/通关/结束 → 收起盘面，场地回到正常状态（地板还原装饰网格、光效变回静止蓝）。
  收摊会暂停自主开局 30 分钟（`AUTO_AFTER_MANUAL_END_MS`），点「扫雷开局」可立刻重开。
- 棋盘直接复用 8×8 地板贴图（不是第二层平面），所以盆/勺/角色贴地时不会被网格线切；
  物件现在也投接触阴影。
- 场地光效配色：**进行中=琥珀 `#ffb828`（呼吸）、通关=绿 `#4ade80`、踩雷=红 `#ff5f6d`、
  没有对局=蓝 `#58a6ff`（静止不呼吸）**；用户手动结束的“已收局”用中性灰蓝 `#a0abc2`，
  不和进行中的琥珀混淆。3D 材质用 `setHex`（sRGB）取色，和画布里那套 CSS 颜色一致，
  避免 `setRGB` 把琥珀算成发白的淡黄。
- 场地特效：进行中时棋盘四周竖起一圈 **0.3m 高的发光能量围栏**，随状态呼吸式明暗
  （进行中蓝 / 通关绿 / 踩雷红 / 已结束琥珀），配合盘面本身的外框与开局扫光，
  一眼能看出「现在是扫雷模式」。围栏只在 `status=playing` 时亮，结束/胜负后自动收起，
  盘面保留最终结果。两个重置是分开的——「重置盆」把盆放回
  场地中心，「重置勺」把饭勺放到中心偏 (0.85, 0.85) 的空白处（两件都回正中心会叠在一起）。
- 「扫雷开局」连接未就绪时点它会提示而不是静默失败。
- 棋盘悬停高亮 + 显示 `row,col`（只做渲染，格子不移动、不挖掘）。
- 揭示格显示数字/雷，胜负整盘着色。
- **开局视觉**：棋盘从半透明玻璃改成近乎不透明的深靛蓝底 + 交替格纹 + 亮蓝网格线，
  外框按状态发光（进行中蓝 / 通关绿 / 踩雷红），新一局有 1.3 秒的斜向扫光。
  之前 16×16 的棋盘线和地板上那张 16×16 装饰网格几乎重合，看不出「开始了」。
- 左上角状态条：`扫雷 16×16 · 53 雷 · 进行中 · 剩 N`，跟着状态变色。

## 9. 验收证据

| 项目 | 方式 | 结果 |
|---|---|---|
| 注册表/校验规则 | `node --test tests/` | 102 项通过 |
| 事件循环（假模型） | `node scripts/event-loop-smoke.mjs` | 256 格棋盘；开局事件触发自主回合；dig 后 review 同时收到 `board_updated@1`；事件只消费一次；后续 dig 仍是同一任务新计划 |
| 浏览器 UI + 真实 dig | `scripts/probes/minesweeper-ui.js` | 按钮→棋盘（256 格 hidden，16×16）；悬停 `13,10`；无勺 dig → `NO_SCOOP`；捡勺对齐（站位误差 13.9mm、朝向 0°）→ 右手持有；dig → `dig_result ok`、rev 1；格心外挖 → `NOT_IN_CELL 5.303m`；重复挖 → `ALREADY_REVEALED`；第二次 dig → rev 2 |
| 生产页面 | `http://192.168.0.100:8090` | 加载正常、按钮「扫雷开局/重置盆」、256 格 hidden、刷新后棋盘自动恢复、无控制台错误 |
| 生产模型调用 | `journalctl -u whale.service` | `[event] turn t100 ← game_started@0`、`[ctx] planning ~9186 tokens · events=1`、思考内容为用户目标（先找饭勺） |
| 棋盘贴地 | `scripts/probes/board-closeup.js` | 盆底与网格线的接触处：修前网格线横穿盆底，修后干净；角色裙摆/脚底同样干净 |
| 长距离真实动画 | `scripts/probes/motion-long.js` | 180° 转身 + 1.89m 走路 + 0.08m 短步 + 0.464m 跑动 + -180° 转身全部 `succeeded`，终点 (0, -2.434)、朝向 0°，耗时 142.7s（1.5fps） |
| 自主开局 | `scripts/probes/autoplay-check.js` + 生产日志 | 不点任何按钮：`[autoplay] tick → [event] turn t100 ← self_play`，随后 `[plan] steps=turn,walk,dig`，棋盘 rev 从 0 涨到 9、31 格揭示 |
| 刷新恢复 | 生产页 `PROBE_SHOT` | 只读页面加载后自动显示服务端正在进行的棋盘 |

本地模型调用实测：planning 上下文 ~6.7k tokens（含 16×16 网格棋盘），
思考模式 `enabled/minimal`，`reasoning_tokens≈1024`。

## 10. 这一轮顺带修掉的上下文/输出问题

- **思考 token 把 JSON 截断**：`max_tokens` 原来 2400，16×16 棋盘上模型常思考 2400+，
  JSON 被截断 → `INVALID_JSON`，表现为“她站着不动”。现在默认 8000，并在
  `finish_reason=length` 时直接报 `TRUNCATED`，不再伪装成解析失败。
- **执行报告带整张棋盘**：旧客户端会把 `dig_result.board`（256 格）原样塞进
  `dig.actual`，一次 review 多 9.8KB。现在 ①拍平客户端回包；②服务端在进入模型前
  用 `trimExecutionReport()` 再剥一次，上下文大小与客户端版本无关（9.2KB → 0.3KB）。

## 11. 尚未完成 / 已知限制

- **一轮任务最多 4 次 execute→review（180s）**：一局 203 个安全格不可能自动扫完，
  预算用尽后需要用户再说一句才继续。这是既有预算规则，没有被游戏事件绕过。
- `game_finished`（胜利/踩雷）与 `plan_result` 的合并在单元测试与代码路径上成立，
  但没有在真实浏览器里跑到「挖完 85 格」或「踩雷」那一步。
- 双客户端争用执行权、挖掘提交点前后的掉帧、以及 dig 过程中刷新页面的恢复，
  只做了机制层面（租约代际、幂等、`session_state` 恢复棋盘），没有专项端到端测试。
- `walk_adjust` 只验证了 0.08m 一档，0.02/0.04/0.06 没有逐个跑真实动画。
- `pickupStand` 目前只验证了 1 个落地变体（平躺朝上）；朝向/变体矩阵还没批量跑。
- 生产日志里同时出现过两个浏览器（192.168.0.116 / .119）抢租约，
  服务端按 epoch 正确切换，但「两个页面同时操作」的 UX 还没有专门打磨。


## 12. 代码审查（55220a4）优先项修复

对应 `CODE_REVIEW_55220A4.md` 的 F01–F06，本轮按优先级处理：

- **F01 密钥备份**：`.env.bak.1792948342` 已 `git rm --cached` 并从服务器删除，`.gitignore`
  补上 `.env*`（保留 `!.env.example`）。该文件在 `768b24f` 已进入远端历史，**凭据需要轮换**；
  历史重写要协调远端，本轮没有强推。
- **F02 持物层**：`applyHolds()` 的让位方向原来写反了（`full_except_left_arm` 跳过了左手），
  现在按 `perfOwnsArm(layer, slot)` 判断“这个动作接管哪只手”，并且只在动作还没进入收尾淡出时让位。
  主循环也改成按“这只手有没有东西”开关持仓层，不再用“是否正在表演”一刀切。
  实测：`dig`（full_except_left_arm）→ applied 左、skipped 右；`wear_basin`（full_except_right_arm）
  → applied 右、skipped 左；`player.holdStats` 可查。
- **F03 挖掘授权**：计划里的 dig 由服务端发放一次性 `digAuthId`，随 `execute_plan` 下发。
  `dig_commit` 必须同时满足：当前租约（含代际且心跳未过期）、授权存在、任务/代际/计划匹配、
  棋盘仍是同一局且 `playing`、`expectedRevision` 一致、右手确实持勺、上报坐标离授权格心 ≤0.12m。
  同一实例重发**回放第一次的结算**（幂等），所有回包都带原 `actionInstanceId`。
  无任务、无勺、无授权、迟到提交都拿不到成功结果。
- **F04 手动暂停**：新增 `autoplay.manualPauseUntil`，`noteAutoPlayDelay()` 只会在它之后取时间，
  任务收尾/事件唤醒都缩不短；只有手动「扫雷开局」清除它。
- **F05 超时取消**：预算到期先在 `cancelCurrentPlan()` 里发 `cancel_plan`（并把账本从
  `dispatched` 挪到 `cancelled`），再 `endTask`；用户抢占也复用同一路径。执行端收到后
  取消执行器并停止位移。
- **F06 租约/重连**：所有写操作（user_message / state_snapshot / plan_result / dig_commit /
  game_start / game_end / chat_*）都必须带当前 `leaseEpoch`，缺字段不再放行；心跳过期的迟到
  `plan_result` 直接丢弃；对账时把 `dispatched` 的账本标成 `unknown`；任务号从已持久化的
  账本里取最大值 +1，代际也随 `session` 持久化，重启不会复用 `t100-p1-g1`。

测试：新增 `tests/dig-auth.test.mjs`（授权/幂等/预算取消/手动暂停四条集成用例）与
`GameService` 收摊用例，合计 114 项通过；`player.holdStats` 实测两种 layer 的让位方向。

### 附：授权的浏览器验收入口

`whale.run()` 是不经服务端的调试入口，带 dig 的调用现在会被授权校验拒绝（`NO_AUTH`），
这是预期的。真实链路用 `scripts/probes/dig-authorized.js`：服务端以 `BRAIN_DEV=1` 启动后，
探针通过 `debug_plan` 注入一份「服务端计划」，拿到 `digAuthId`，再由真实客户端执行
dig → dig_contact → `dig_commit`。生产环境不开 `BRAIN_DEV`，该消息直接返回 `DEBUG_DISABLED`。

本轮浏览器实测：计划 t100 下发 `digAuthId=dig1-g1`，客户端提交
`dig_commit { digAuthId: "dig1-g1", taskId: "t100" }`，服务端接受，棋盘 revision 0 → 1，
(3,3) 揭示为 0。


## 13. 2026-10-27：为什么会「扫一会就回去随机走动」

日志复现（00:04–00:16）：5 次自主体回合每次都 `board=playing revision=0`，一整天有 19 次
`NOT_IN_CELL`；随后 `[autoplay] 每小时上限到了` 反复出现，中间就是机械漫游。

三个原因叠加：

1. **挖掘站位容差太紧**。0.5m 格子配 0.12m 容差，模型只知道「我在这一格里」（`currentCell`），
   不知道离格心还有 0.16–0.24m，于是直接 dig → `NOT_IN_CELL`。现在容差放到
   **`DIG_TOLERANCE_M = 0.18`**（格子半宽 0.25，仍保证人站在格内），并把
   `digToleranceM`、`currentCellDistanceM`、`digRule` 一起放进公开棋盘，
   提示词也写明「currentCell 不代表够近」。
2. **按回合计费的上限把成本低估 4 倍**。一个回合 = 1 次 planning + 最多 3 次 review，
   6 回合/小时的实际上限只有 24 次调用，玩 15 分钟就触发，然后 10 分钟起步的长冷却。
   现在改成按**模型调用**计费：`AUTO_MAX_CALLS=60`/小时（0 = 不限），预算用尽时按
   「最早那次调用滑出一小时窗口」精确计算等待时间，不再固定睡 10 分钟。
3. **没有局的时候漫游是合理的，但有局时不该走开**。现在客户端在
   `gameBoard.status === "playing"` 期间不启动机械漫游——模型思考/退避时她留在盘边。

另外新增**看门狗**：只要还有一局在进行、又没人占用任务，超过 `AUTO_STILL_PLAYING_MS`（默认 60s）
没有模型活动，宿主就主动入队一条 `game_still_active` 事件把她叫醒（每分钟最多一次，
受同一份调用预算约束）。集成测试覆盖：0.5s 阈值下 1.7s 内被唤醒。

`game_still_active` 的提示词说明：棋盘没变，只是提醒「这局还在进行」——能推进就继续，
不想继续就说明原因。


## 14. 2026-10-27：成本边界改成「一局」，调用预算放宽

用户的要求：一局之内别卡预算，反正一局结束就不会自己继续了。

先说清一个事实：**改之前她确实会自动重开**。日志里 `[autoplay] tick board=ended` →
`[autoplay] 自己开了一局` 出现过两次（23:42:30、00:02:37），也就是通关/踩雷/手动结束后
过 90 秒会自己再开一局；手动结束的 30 分钟暂停还存在内存里、重启即失效。

按用户的理解把行为定死：

- `tickAutoPlay()` 在 `board.status !== "playing"` 时直接返回——**一局结束后不自动重开**，
  必须手动点「扫雷开局」。
- 手动「扫雷结束」的暂停默认改成 **无限期**（`AUTO_AFTER_MANUAL_END_MS=Infinity`，
  测试可用环境变量覆盖），只有手动开局清除。
- 于是「一局」就是一个明确的成本边界，调用预算从 60/h 放宽到 **`AUTO_MAX_CALLS=300/h`**
  （0 表示不限），一局之内基本不会被预算打断。
- 看门狗只在 `status=playing` 时工作，局结束就停。

关于「每挖一格会不会重新触发 LLM」：会。任务还有轮次时是走 **review**（每次 dig 的
结果都会送审一次），第 4 轮之后任务结束，那次 dig 的 `board_updated` 会开启一个**新任务**
再调一次 planning。日志里 24 次 `[dig] auth` 对应 88 次 `[ctx]`，就是“计划一次 + 结果审一次”
的节奏。唯一的缺口是第 4 轮的结果不单独 review（F09），而是作为新任务的输入被看到。


## 15. 2026-10-27：说话方式（可爱、呆萌、有点傻）

原来的开场只有一句“表达自然、简短、安静、友好”，实际输出全是客服腔（“我这边暂时没看到……”
“等宿主把快照送过来”）。现在把人格写成明确的一节：

- **你是谁**：可爱、呆萌、有点傻乎乎的鲸鱼娘——反应慢半拍、容易走神、算数会数错，
  但很努力、很开心、喜欢被夸；不是客服也不是助手。
- **怎么说话**：短句口语、每句最多一个语气词、会犯小迷糊并自己纠正、用孩子气的具体比喻、
  允许小得意和小沮丧、不客服腔、不说明书腔、不每句感叹号或颜文字。
- **风格样例**（示意语气，禁止照抄内容）+ **禁用词**：我这边 / 暂时 / 目前 / 根据 /
  当前快照 / 等宿主 / 无法判断 / 请稍等 / 为您 / 感谢您的理解。
- 系统提示词最后加了一遍【写 speech 前的最后一遍】自查清单（像不像小鲸鱼、最多两句、
  有一点小情绪、别用禁用词、自己玩时多数回合可以沉默）。

抽样验证（服务端用自己的 key 跑真实请求，只打印 speech）：

| 用户 | 改前 | 改后 |
|---|---|---|
| 你在干嘛呀 | 在琢磨扫雷……还有，顺便看看你。 | 在数格子玩呀。数到一半忘了，唔……从头再来。 |
| 你好厉害 | 谢谢你这么说。我只是慢慢做自己能做的事。 | 欸嘿……是在说我吗？我刚刚就站着呀。 |
| 刚踩到雷 | 踩到雷了……这局结束。记下那个位置，下次不碰。 | 呜哇……炸了。那边我明明觉得安全的。 |

并且用**真实的 planning 消息**（含输出契约）复测，仍然稳定输出合法 JSON：

```json
{"type":"execute_plan","speech":"在发呆呀。这里空空的，我就摇摇尾巴。","steps":[{"action":"tail"}]}
```

提示词体积：`system.txt` 16.4KB ≈ 3.9k tokens，整轮估算 ~6.9k，仍在 14k 预算内。


## 16. 2026-10-27：头顶「正在想」指示器

模型在 planning / review 阶段可能要等几秒到几十秒，之前只有聊天面板里一行小字。现在角色头顶
（`y = 1.24`，头高 1.113）会浮出一个深色胶囊 + 三个跳动的小点，跟随角色投影定位：

- 只在 `phase === "thinking" | "checking"`（等模型）时显示；
  `executing` 是她在做动作，不亮；`idle` / 断连立即收起。
- 纯 CSS 动画（`think-bounce`，三个点依次延迟 0.16s），不占渲染循环算力。
- 与红色断连图标、对话气泡分层：头顶 → 气泡(1.35) → 断连图标(1.75)。

实测（用一个延迟 9 秒的模型桩把状态钉在 thinking）：`show=true, opacity=1, transform 跟随
(640, 324), dots=3`，截图见 `docs/minesweeper-thinking.png`。


## 17. 2026-10-27：贴墙走不动必须说清楚

贴墙死循环的成因：`walk` 越界只返回 `OUT_OF_BOUNDS`（没有“还能走多远”），
`walk_adjust` 干脆没有边界预检——在 3.69m 处要求 0.08m 短步，主循环把它 clamp 到 3.70，
位移只剩 0.01m，于是报 `DISPLACEMENT_MISMATCH`。模型看到的是“位移不符”，
既不知道是墙，也不知道下一步该走多小，于是反复重试同一个指令。

改法（统一在 `ActionExecutor`）：

- 新增 `forwardRoom(before, yaw)`：沿当前朝向算到边界的剩余距离；
- `walk` / `walk_adjust` / `run` 在**移动前**统一预检，越界一律返回 **`BLOCKED`**，
  `actual` 里带 `error: "WALL_BLOCKED"`、`requested_m`、`available_m`、`boundary_m`、
  当前坐标和一句 `hint`（“先 turn 换方向，或用更小的 walk/walk_adjust”）。
- 万一真的被主循环 clamp 截断（目标在界内但走不满），也按 BLOCKED 而不是位移不符回报。
- 提示词写明：可走范围 ±3.7m；收到 BLOCKED 要换方向或换更小的步长，不许重复同一条指令；
  边缘格格心在 ±3.75m 本来就在范围外，站在 3.7m 已满足挖掘容差，不用硬挤。

浏览器实测（站在 z=3.69，yaw=0，要求 0.08m 短步）：

```json
{"error":"WALL_BLOCKED","requested_m":0.08,"available_m":0.01,"boundary_m":3.7,
 "hint":"前方 0.01m 就到场地边界（可走范围 ±3.7m）。先 turn 换个方向，或用更小的 walk/walk_adjust 挪；不要重复同一条走不通的指令。"}
```

先 `turn 90°` 再走同样的 0.08m → `succeeded`。单测覆盖 walk / walk_adjust / run 三种越界。
