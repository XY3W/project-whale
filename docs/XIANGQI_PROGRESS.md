# 中国象棋接入进度（DeepSeek）

2026-10-31。入口与契约见 [XIANGQI_DEVELOPMENT_HANDOFF.md](XIANGQI_DEVELOPMENT_HANDOFF.md)、[XIANGQI_PLAN.md](XIANGQI_PLAN.md)、[XIANGQI_ASSET_HANDOFF.md](XIANGQI_ASSET_HANDOFF.md)。

## 已完成（服务端 + 客户端接线，288 项测试通过）

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

### ⑤ 场地、棋盘与用户交互（客户端）

- `Stage.setArena(11.5)`：台座与地板平面重建、相机按新外接圆重新取景；`resetArena()` 退出复原 8m。
- `src/game/XiangqiBoard.ts`：加载 `board.glb`（正好 11.5×11.5 木纹棋盘）与 `pieces.glb` 的 14 模板，按 `initial_layout.json` 摆 32 枚棋子；只渲染服务端公开状态——被吃子移除、合法目标来自 `legalMoves`、选中棋子抬高 4.5cm、目标环（青=空位/红=吃子/金=悬停与最近一步）。
- 交互：射线打到 y=0 平面取最近交点（0.45 格内），点己方子选中、点合法目标发 `xiangqi_move`（moveId = game+revision+piece），点别处取消；左侧工具栏新增「象棋开局」。
- 顺手修掉两个既有问题：棋子 id 改成素材的 `*_soldier_*`（原来 `*_pawn_*` 导致 10 枚兵不渲染）；扫雷的蓝色边墙在构造时就 visible=true 且从没隐藏过，会一直压在其他场地上。

**浏览器实测**：32/32 枚实例、场地半边长 5.75、网格地板隐藏；点 (6,0) 红兵选中并出现合法目标环，点 (5,0) 走成——revision 1、轮到黑、lastMove 记录正确。

### 测试

`tests/xiangqi.test.mjs`（14，含 perft）、`tests/xiangqi-service.test.mjs`（9）、`tests/xiangqi-ws.test.mjs`（4，真实 WS：开局/用户走子/非法与幂等/授权提交/结束）。

## 未完成（客户端与正式场景）

1. ~~棋盘与场地~~ ✅ 已完成（场地与执行器 walkableHalf 都跟随 11.5m）
2. **用户交互**（基础已通）：被吃子消失时序、拖动排除、触屏、重连恢复仍缺；
3. ~~角色搬运~~ ✅ 抱棋步态、腰挂勺、魔法吸附、双手公共锚点都已接（见 ⑦⑧⑫）；
4. **异常与抢占**：~~旧代际 token~~ ✅、~~抢占撤回与安全放置~~ ✅（见 ⑨⑩）；ACK 丢失/重复由服务端 replay 兜住，但**重连恢复**（搬运中断线重进）没做；多页租约沿用服务端租约机制，没专门测；
5. **完整棋例**：长将判负、长捉白吃判负、其余三次重复判和、60 回合自然限着判和已实现（见 ⑪⑭）；**长兑/长跟/长拦这类"有保护子被反复攻击"的情形仍按判和处理**，逐例精细裁决未做，仍不能宣称已完整符合 CCA2020；
6. ~~LLM 闭环实测~~ ✅ 2026-10-31 19:31 生产环境真人对局跑通（见 ⑯）。

### ⑥ 角色搬棋（第一版跑通）

链路：`execute_plan.xiangqiToken` → 执行器 `xiangqi_move` → 宿主走位（0.85m 站位，0.09+0.18n 拆步 + walk_adjust 补零）→ `chess_pickup`（0.4s 召唤 / 1.2s grasp 时把同一枚棋子挂到角色身上）→ 抱到目标旁 → `chess_place`（0.4s release 交回棋盘、1.2s settle）→ `xiangqi_commit` 带 token 复检。

**真实链路验证**（本地服务 + 浏览器，headless ~1.5fps）：

```
[plan] t100 turn=1 steps=xiangqi_move
[xiangqi] 搬运授权 xq-t100-...-g1 black_cannon_1 (2,1)→(3,1) rev=1
[xiangqi] 她落子 black_cannon_1 → (3,1) rev=2
```

服务端确认这一着已 committed、revision 前进、盘面更新——走近、吸附、送出、提交整条链路成立。

仍未接：`chess_carry_start/walk/stop`（抱棋时仍在用普通走路摆臂）、右腰挂勺、抢占/安全放置、完整棋例。

前端已有入口（「象棋开局」）。按交接文档「素材数值通过不代表正式执行器已上线」，这一版算**可玩的服务端 + 客户端成型切片**，但抢占/安全放置/完整棋例与真实模型对局仍未完成，不能当作象棋已交付。

### ⑦ 抱棋步态（已接）

素材的 14 段 `chess_*` 是整段全身动画（含尾巴）。`LayeredMotionPlayer` 新增抱棋基底层：

- 按 `walk.lower` 的骨骼分区把 `chess_hold / chess_carry_start / chess_carry_walk / chess_carry_stop / chess_carry_adjust_*` 切成 `lower` + `upperBase` 两层，**尾巴轨道丢掉**交给尾巴层独占（不丢会双写尾巴）。没有参照分区就不启用抱棋，宁可退回普通步态。
- 位移曲线照抄 catalog：起步 `0.045u²`、循环 `0.1125t`（每圈 0.18m）、停步 `0.045(2u-u²)`、微调 `d·u²(3-2u)`，多一档 1cm（`chess_carry_adjust_01`）。位移仍由 `movementDelta` 输出，与动画同一时钟。
- 走完落到 `chess_hold`（抱棋静姿）而不是 `idle_stand`；`state.resting` 统一表示"站定了"，等步/收步/结算的判定都改用它，否则抱棋会被当成永远没停。
- 抱棋时不能跑（`runDistance` 直接拒绝），也不能在走步中途切模式（`setCarrying` 返回 false）。

**浏览器实测**（本地服务 + headless）：采样 3362 帧，抱棋阶段出现的基底只有 `chess_hold / chess_carry_start / chess_carry_walk / chess_carry_stop`，全程没有 `walk`；提交成功 `black_cannon_1 → (3,1) rev=2`。

### ⑧ 右腰挂勺（已接）

- `stow_scoop` / `unstow_scoop` 进执行器（此前只在能力表和协议里，执行时是 `CAPABILITY_DISABLED`）。
- `PropItem` 新增 `waist` 模式：挂点来自象棋目录 `bindings.rightWaist`（bone `root.x` + 列主序矩阵），用到时才拉目录并 `setWaistTarget`，给 `playful-v2` 目录零改动（它有 SHA 校验）。
- 事件按素材走：`stow_scoop` 0.9s `waist_attach`、`unstow_scoop` 0.5s `hand_attach`，整段 `right_arm` 层，手臂交给动作、持物层让位。
- 挂上后 `state=worn / mode=waist`，`dig`/`throw` 的前置条件自然不再满足；快照新增 `slots.waist_slot`。

**浏览器实测**：`stow` 返回 `{ok, slot:"waist_slot", state:"worn"}`，勺子贴到腰高 0.354m；身体转 90° 后勺子跟着走 0.265m；`unstow` 回到 `{slot:"right_hand", state:"held"}`。

### ⑨ 旧授权作废

`beginMove` 签发新 token 时把上一张未使用的标记为 `superseded`，`commitMove` 返回 `SUPERSEDED`——抢占/重来之后，上一轮的 token 不能把棋子落下去。

### ⑩ 抢占与安全放置（已接）

- 搬运桥每一步之前问执行器 `isCancelled()`（新增到 `xiangqiMove` 的 ctx），被取消就立刻返回 `CANCELLED`，不再把整段搬运跑完。
- `try/finally` 兜底：只要棋子在手上（`carried`）而流程没走到 release，就把棋子放回原格、退出抱棋，**不提交棋步**。服务端 revision 不动，轮次还是她的。
- `setCarrying` 允许在互动片段（含取消后的淡出）期间只记状态，片段收尾再落基底，避免淡出被硬切。

**浏览器实测（取消路径）**：搬运中 `carrying=true / base=chess_hold` → 调 `executor.cancel()` → 4 秒后 `carrying=false / base=idle_stand / resting=true`，服务端 `revision` 仍为 1、`black_cannon_1` 还在 (2,1)、`turn=black`。

### ⑪ 棋例裁决（部分）

- 走子记录补上 `side` 与 `check`，作为裁决依据（服务端权威，模型看不到内部结构）。
- `adjudicateRepeat(game, history)`：同一局面（棋盘 + 走子方）第三次出现时，回看最后一次循环；若该方在循环里每一步都在将军 → **长将判负**；否则**判和**。
- `naturalLimit(game)`：连续 60 回合（120 手）无吃子 → **和棋**。
- 服务层在用户走子与角色提交两条路径上都调用裁决，结果写进 `status/result`，之后 `move` 直接返回 `GAME_OVER`。

**测试**：长将/普通重复/自然限着边界 3 项（引擎），真实 8 手来回动马触发三次重复判和 1 项（服务，走完整 `userMove` 与 `beginMove→commitMove` 两条路径）。

**明确没做**：长捉、长兑、长拦等需要逐例判断"捉"的定义与例外，目前一律按和棋处理；对外只能说"实现了长将与和棋"，不能说完整 CCA2020 棋例。

### ⑫ 双手公共持棋锚点（已接）

- 之前棋子是"贴在角色根节点的固定偏移 (0, 0.45, 0.36)"，抱棋动作一摆，棋子就和手脱开。现在按素材交付的 `prop_motion.json` 曲线走：每个 `chess_*` 动作一条 actor-local 曲线，`followCarry(clip, time)` 用与动画同一个时钟采样。
- 时钟来源：互动片段（`chess_pickup` / `chess_place`）用 `performanceTime`，抱棋基底层用 `baseTime` 并对循环片段取模（新增 `player.carrySample`）。
- `beginCarry` 清掉缓动目标、`tick` 跳过被抱的棋子——否则盘面缓动会和曲线抢同一个 transform（这是第一版锚点漂移的真正原因）。
- 锚点契约有测试兜底：棋子中心 = 曲线点，左右手心 = 中心 + `pieces.gripsInCarrierFrame`（与素材自带 `validate_runtime` 同一套接触窗口规则）。

**实测**：`beginCarry` 后 `followCarry('chess_hold', 0.5)` 把棋子放到 (0, 0.3223, 0.6267)，与曲线完全一致；抱棋全程曲线在推进（采样间位移 0.845m），提交照常成功。

### ⑬ 吃子落位用专用片段

`placementFor(pieces, moverId, row, col)`：目标格上有敌子 → `chess_capture_place`（0.4 release / 1.1 capture_commit_gate / 1.5 land_confirmed），空位 → `chess_place`（0.4 / 1.2 / 1.3）。之前吃子也播普通落子片段，等于白丢一段交付动作。

## 仍然没做的（截至 306cd14）

1. **捉的精细判定**：现在只把"吃白食"（受害子没人保）判成长捉；被保护子被反复攻击一律判和。
   CCA2020 还要看兑换价值、被牵制的保护子等情况，这部分没做，所以规则层仍标"部分实现"，
   不能宣称完整符合 CCA2020。
   （长将判负、长捉白吃判负、长兑/长跟/长拦判和、60 回合自然限着判和都已实现。）
2. ~~真实 deepseek-flash 对局~~ ✅ 2026-10-31 19:31 生产环境跑通（见 ⑯）。
3. ~~客户端交互~~ ✅ 拖动排除（6px/400ms）、触屏手势、重连恢复、被吃子淡出都已接（见 ⑮⑰）。
4. **异常动画版**：取消时是逻辑回退（棋子立刻回原格），没播 `chess_safe_setdown`；中断后重新吸附的 `chess_recover` 也没接。
5. ~~多页租约~~ ✅ 双页面实测：先连的是执行者，后连的是只读（见 ⑱）。

### ⑭ 长捉（白吃才判）

- 每手走完记录 `attacks`：这一方此刻能吃掉哪些敌子（临时借用轮次算完即还）。
- 三次重复时，若该方在循环里**每一手都在威胁同一个敌子**，且那子**没人保护**（吃了不会被反吃），判长捉、该方负。
- 判据是"吃这口子赚子力"：没人保 = 白吃拿满；有人保 = 按吃子后被反吃的净差算（车 9 / 炮 4.5 / 马 4 / 士象 2 / 兵 1，过河兵 2）。换亏或兑子（净差 ≤ 0）只算长兑/长跟/长拦，判和。
- 这是 CCA2020"捉"的简化版：只看一步交换，不看被牵制的保护子、连环兑子这些更深的账，所以仍标"部分实现"。
- 代价：约 +1ms/手（8 手 7ms 实测），可接受。

**测试**：白吃长捉判负、有保护只判和、每次换目标不算长捉，3 项。

### ⑮ 重连恢复与心跳

- 心跳超时从 8s 放宽到 20s：客户端每 5s 发一次心跳，慢机器上加载 40MB 棋子素材或单帧卡死超过 8s，整段任务会被当成"客户端没了"撤掉——本地实测就撞到过一次 `[plan] cancel ... (heartbeat_expired)`。断线仍然靠 ws close 兜底。
- 客户端新增 `keepAlive()`，渲染循环每帧调用：心跳超过 4s 没发出去（典型是被长任务或长帧卡住）就立刻补一发。
- `canvas` 加 `touch-action: none`，触屏拖动交给 OrbitControls、点选交给棋盘点选，不被浏览器拿去滚动缩放。

**重连实测**（本地服务 + 真浏览器，搬运中途 `location.reload()`）：
- 刷新前：`carrying=true / base=chess_hold`，棋子贴在曲线锚点 (0, 0.3223, 0.6267)；
- 刷新后：`carrying=false / base=idle_stand`，没有漂浮棋子，`revision` 仍为 1，`black_cannon_1` 仍在 (2,1)，32 枚棋子齐全——完全按服务端真相重建；
- 再发一次搬运：服务端 `她落子 black_cannon_1 → (3,1) rev=2`，旧授权没有留下第二手。

### ⑯ 真实对局（生产，deepseek-flash）

2026-10-31 19:31 在服务器 8090 上由用户执红实下：

```
19:31:37 [xiangqi] 开局 xqmvwbmbg00hm（用户执红）
19:31:47 [xiangqi] 用户走子 red_soldier_3 → (5,4) rev=1
19:32:07 [llm] prompt_tokens=15722 completion_tokens=436
19:32:07 [llm] thinking enabled/minimal · reasoning_tokens=258
19:32:07 [plan] t478-228bde94 turn=1 steps=stow_scoop,xiangqi_move speech=yes
19:32:07 [xiangqi] 搬运授权 xq-t478-228bde94-1-g383 black_cannon_2 (2,7)→(2,4) rev=1
19:33:22 [xiangqi] 她落子 black_cannon_2 → (2,4) rev=2
19:33:24 [llm] prompt_tokens=18442 completion_tokens=141  → [task] finish:completed
```

这一轮同时验证了：条件提示词（她先按"勺先挂腰"把装备收了）、`stow_scoop` 真实执行、`xiangqi_move` 走位/搬运/提交、review 回灌后收尾。模型仍是 deepseek-flash、thinking minimal，没有改动。

### ⑰ 被吃子淡出

- 提交后盘面少了一枚子时，不再"啪"地消失：`update(view)` 把它从 `instances` 摘下来放进 `fading`，`tick` 用 0.28s 把它缩到 15% 并微微抬起再移除（最长 0.25s 一跳，低帧率下 2 帧收完）。
- 同一枚子又回到盘面（撤步/重连回放）时，先收掉还在淡出的替身再建新的，避免留下鬼影。
- 退出象棋（`update(null)`）会立刻清掉所有淡出对象。

**实测**：人为把 `black_soldier_1` 从 view 里去掉 → `instances 32→31`、`fading=1`、缩放 1 → 0.241 → 移除；再把原 view 还回去 → 棋子回到盘面、缩放为 1。

### ⑱ 多页租约（双页面实测）

两个浏览器同时连本地服务：

```
[lease] connect c1 → grant epoch=1 to c1      # 页面 A：执行者
[lease] connect c2                            # 页面 B：没有 grant，只读
[xiangqi] 开局 xqmvwcckk0rd9（用户执红）        # 只有 A 能开局
[lease] close c2 lease=false
```

页面 B 能收到 `xiangqi_state`（32 枚棋子、轮次都同步），但调 `startXiangqi` 不会产生开局——服务端按 `NOT_EXECUTOR` 拒绝。租约随连接关闭释放，符合"同一时刻只有一个执行者"的约定。

## 审查回应（CODE_REVIEW_XIANGQI_2026-10-31）

基线 26fd9ec 的 10 项发现逐条处理，回归用例集中在 `tests/xiangqi-review.test.mjs`（15 项，全部断言"修复后应有的行为"）：

| 项 | 处理 | 证据 |
| --- | --- | --- |
| R01 场地边界 | 新增 `src/core/arena.ts` / `server/arena.mjs` 作为唯一来源；逐帧夹取、快照回填、接近规划、模型上下文、道具物理墙全部跟随 `roomHalf` | `walkableHalfOf(5.75)=5.45`、客户端与服务端同源测试 |
| R02 落子不等 ACK | 片段时钟可暂停；release 后在等待点暂停 → 提交 → 回执到了才继续下降；明确失败中止并回原格；UNKNOWN_COMMIT 用 revision 自证 | 桥顺序测试：pause → commit → animation_complete；失败时 cancel + 回原格 |
| R03 腰挂只说通 | snapshot 的 holder 增加 `waist_slot`；sanitizeProp 不再把挂腰降级成手持；slotsOf 增加腰槽；restore 接受腰状态并预装绑定 | 挂腰快照仍是 worn/waist_slot、右手为空；脏数据仍降级 |
| R04 授权不认局 | 抽出 `server/xiangqi-auth.mjs`；game_id 不符直接拒绝；换局/收摊/取消撤销；parallel 禁止 xiangqi_move；客户端走位前验收权 | 错局授权测试、换局撤销测试、parallel 拒绝测试 |
| R05 取消还拾取 | walkToPoint 入口与每个 await 后都查取消；源站位失败立即返回；finally 送还原格 | 取消跑测试：0 次 perform |
| R06 长将误判和 | 按循环内双方各自责任判定，不再看"最后走子方" | 真实合法对局：红车来回将军、黑将走回重复，最后一手是黑，仍判红负 |
| R07 重启复活 | 状态统一成 drawn（兼容 draw）；decisions 与 history 落盘并恢复 | 重启后仍 drawn、幂等与历史都在 |
| R08 开局入口 | 执色选择弹窗（红/黑/取消，取消不发请求）；按钮文案随状态切换；两种执色都触发一次开局事件（用户执红只确认不抢第一着） | 浏览器实测：闲置显示"象棋开局"、点击弹三选项、取消不建局、执黑后她执红先行 |
| R09 落子不落地 | 弧线改为按真实时间推进的一跳，u=1 精确落地；每手刷新金色环；取消选择归零 | 240 帧后 y 必须为 0；select(null) 目标高度归零 |
| R10 提示词条件 | 详细棋规仅在 `status === "playing"` 注入；终局只留最小结果；rows 改成 ASCII（红大写/黑小写） | 无局/终局不加载、终局无 rows/legalMoves、编码可区分敌我 |

仍未做（审查也点明属独立缺口）：完整 CCA2020 的捉/兑换例外逐例裁决、`chess_safe_setdown`/`chess_recover` 的表现层接入、棋子障碍导航。

## Codex复核与本批修复

见 [复核与走子唤醒修复](XIANGQI_RECHECK_2026-10-31.md)。用户走子无思考的实际根因为旧游戏手动暂停未解除，已修正象棋开局/合法走子/执行端恢复的唤醒与去重；相机改为中键拖拽旋转、左键交互。310项测试与构建通过。复核仍发现释放棋子不等ACK、物理底板未放大、腰绑定恢复竞态和事件内暂停剩余时间问题；原方案的导航/完整棋例/临时放置恢复仍未完成，不能将上表“处理”直接理解为全部验收关闭。
