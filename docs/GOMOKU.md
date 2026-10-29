# 五子棋（本地开发版，未上传）

15×15 自由规则五子棋：**她执黑先手、用户执白**，用户点交点落子，她通过 LLM 自主落子。
和扫雷共用同一块 8m×8m 地板，两局互斥，场上一次只摆一个盘。

## 1. 规则

`server/gomoku.mjs`（纯函数）

- `SIZE=15`、`WIN_LENGTH=5`、`CELL_M=8/15≈0.5333`、`CELLS=225`。
- 黑白交替；横竖斜任意方向连成 **≥5** 即胜（不设禁手）；225 格下满判和。
- 判胜只沿最后一子的四条线数，O(1)；`winningLine` 会校验起点颜色，避免"空点+四连"误判。
- `board` 是一维数组（`null | "black" | "white"`），索引 `row*15+col`。

## 2. 坐标约定（服务端与客户端一致）

```js
x = -4 + (col + 0.5) * 0.5333
z = -4 + (row + 0.5) * 0.5333
```

- `row` 从 -Z 向 +Z，`col` 从 -X 向 +X。
- 四周留半格边距：交点落在 ±3.733，外框在 ±4；她的可走范围是 ±3.7，够得到最外一行。
- 客户端点击：射线打到地板 → `gomokuCellAt` 取最近交点，距交点超过 0.46 格视为没点中。

## 3. 服务端

`server/gomoku-service.mjs`（`GomokuService`，形态照 `GameService`）

| 方法 | 说明 |
|---|---|
| `start(requestId)` | 同 requestId 幂等；新局换 gameId、revision 归零、黑先 |
| `move({moveId, gameId, row, col, color, expectedRevision})` | 校验 有局→同局→状态→版本 → 规则核心；`moveId` 幂等回放 |
| `end()` | 进行中 → `ended` 保留盘面；已结束 → 收摊（`board:null`） |
| `waitingForCharacter()/waitingForUser()` | 回合调度用 |

持久化 `data/gomoku.json`（tmp+rename 原子写），重启/刷新恢复同一局。

**落子时机**：和挖掘完全一致——**先下发一次性授权，客户端走到交点旁、做完落子动作后再提交**。

1. 服务端派发计划时发 `stoneAuthId`（绑定任务/代际/计划/局/交点/版本），**此时棋盘不变**；
2. 客户端 precheck：轮到黑方、版本一致、交点为空、**根位置距交点 ≤ `stoneToleranceM`（0.2m）**；
3. 客户端做完落子动作（当前用一次 `nod`）后发 `gomoku_commit`；
4. 服务端复检授权、版本、以及**角色权威坐标**是否也在容差内，通过才 `gomoku.move`。

没走到位会返回 `NOT_ALIGNED` + `distance_m` / `tolerance_m` / `target` / `hint`，模型据此先走位再落子。
用户的落子走 `gomoku_move`（固定白色）。

### 协议

| 方向 | 消息 |
|---|---|
| C→S | `gomoku_start {requestId, leaseEpoch}`、`gomoku_move {gameId,row,col,expectedRevision,moveId}`、`gomoku_end` |
| S→C | `gomoku_state {board, result?, ended?}`；`session_state` 也带 `gomoku` |

事件（进 `gameEvents` 队列，模型回合合并处理）：`gomoku_started`、`gomoku_turn`（用户落子后轮到她）、
`gomoku_finished`、`gomoku_your_turn`（看门狗提醒）。

## 4. 能力与校验

`place_stone {game_id,row,col,expected_revision}`：

- 一次计划最多一次、必须是最后一步、不能进 `parallel`（与 `dig` 共用同一段校验：
  `MULTIPLE_STONE_STEPS` / `STONE_NOT_LAST` / `DIG_IN_PARALLEL`）。
- 执行器走 `loco.stone` 桥：`precheck`（站位/回合/版本/占位）→ `perform`（落子动作 + 提交授权）。
- 落子动作目前用 `play("nod")`：现有六个表情片段里没有专门的"放子"，点头表示把子按在这一点上；
  美术出了 `place_stone` 片段后换掉即可。

## 5. 模型上下文

`gomokuContext()` 产出：

```json
{
  "gameId": "...", "revision": 3, "status": "playing", "size": 15, "winLength": 5,
  "turn": "white", "myColor": "black", "yourTurn": false,
  "lastMove": {"row":6,"col":6,"color":"black"}, "moves": 3,
  "rows": ["...............", ".......●○......", "..."],
  "coordinateRule": "row 从 -Z 向 +Z ...",
  "legend": "● 黑（你）、○ 白（用户）、. 空"
}
```

约 0.7KB/次（15 行 × 15 字符）。**不给任何引擎提示**（不说哪里能赢/该堵哪），她自己看盘。

## 6. 提示词

`planning.txt` / `review.txt` 各加一段五子棋约束：

- 执黑先行、一计划一子且必须最后、不许重复下同一点、不许替用户走；
- 被拒（`STALE_REVISION`/`OCCUPIED`）后按最新 `gomoku.rows` 重新判断；
- 开局前后走到棋盘外侧边缘，别站在交点上挡棋子。

## 7. 客户端

`src/game/GomokuBoard.ts`：和扫雷一样把画布贴到 `groundTop.material.map`（不叠第二层平面）。

- 15×15 网格（只在交点之间连线，四周留半格）、5 个星位、黑/白子（径向渐变 + 投影 + 描边）、
  最后一手小圆环、五连高亮、悬停预落子（半透明 + 坐标提示）。
- 状态色：进行中琥珀 / 有人赢绿 / 和棋与收局中性灰蓝；开局有一次扫光脉冲。
- **地板是共享资源**：两块棋盘各自只在"当前贴图确实是自己的"时才还原地板，
  切换时先让另一块 `show(false)` 交还，再贴自己的，避免互相覆盖。

`src/main.ts`：

- 顶部按钮 `五子棋开局 / 五子棋结束`（进行中→结束保留盘面，再点→收摊），状态条显示
  `五子棋 15×15 · 轮到你 / 她正在想 / 你赢了 · 第 N 手`。
- 交点点击只在**白方回合**生效；点到已有子、非自己回合、离交点太远都不响应。
- 两盘互斥：任一局上桌就收起另一块棋盘。

## 8. 她的回合看门狗

`tickStillPlaying` 扩展：`gomoku.status=playing` 且 `turn=black`、没有任务、超过
`AUTO_STILL_PLAYING_MS`（60s）没有模型活动 → 入队 `gomoku_your_turn` 重新唤醒。
扫雷那条逻辑不变；五子棋进行中也不会自动开局扫雷。

## 9. 验收

- 单测 166 项全绿：新增 16 条规则（`tests/gomoku.test.mjs`）、8 条服务
  （`tests/gomoku-service.test.mjs`）、4 条 WS 链路（`tests/gomoku-ws.test.mjs`）。
- 浏览器 E2E（stub 模型，逐帧截图见 `docs/gomoku-*.png`）：
  1. 点「五子棋开局」→ 她执黑，`gomoku_started` 触发她自己走第一手 (7,7)，状态条变「轮到你」；
  2. 把 (7,8) 交点投影到屏幕坐标，派发真实 `pointerdown/pointerup` → 白子落下、回合切回黑；
  3. `gomoku_turn` 触发模型 → 她下 (6,6) → 状态条「轮到你 · 第 3 手」；
  4. 结束 → `ended` 保留盘面 → 再点 → 收摊、按钮回到「五子棋开局」。
- 悬停验证：`gomokuBoard.state.hover` 在交点处返回 `{row:6,col:6}`，非交点返回 null。

## 10. 已知限制

- **她会挡住脚下的棋子**：棋盘铺满整块地板，她站在中腹时脚下 1–2 个交点会被身体遮住。
  提示词已让她开局后往边缘站，但真正挡住的点仍看不见（可以拖动视角避开）。
- 无禁手、无让子、无悔棋；她每步 1 次 planning 调用（约 0.03–0.06 元），一局 30–60 步。
- 本地无 Key 时不会自动落子（`gomoku_started` 需要 Key 才驱动模型），验收用 `BRAIN_DEV=1` +
  `debug_plan` 或 stub 模型。


## 11. 2026-10-27 修正：走到位才能落子

用户指出"角色不用走到位置就可以落子"，于是把落子从"派发即生效"改成"授权 + 走到位 + 提交"：
`stoneAuthId` 随 `execute_plan` 下发，客户端 precheck（≤0.2m、轮到她、版本一致、交点为空）、
做落子动作后 `gomoku_commit`，服务端再用**角色权威坐标**复检一次。站位不对返回
`NOT_ALIGNED` 并带上还差多少米。

浏览器实测：站在中心时注入 `(3,3)` 的 place_stone → 棋盘不变（precheck 拒绝）；
把她挪到 `(3,3)` 交点旁再注入 → 落子成功、轮到白方。

同批修掉了"用户落子不触发 LLM"的根因：手动「扫雷结束/收起」会把自主暂停设成**无限期**，
而 `gomoku_start` 当时没有清它，`autonomousAllowed()` 一直是 false，事件回合全部被静默丢弃。
现在手动开五子棋 / 用户落子都会清掉这个暂停，并加了回归测试
（`tests/gomoku-pause.test.mjs`：结束扫雷 → 开五子棋 → 必须出现 gomoku_started 的模型请求）。


## 12. 2026-10-27 晚：可操作半径 1m + 提示词按对局注入

**可操作范围**：落子不再要求站到交点旁 0.2m，改成**以她当前位置为圆心、半径 1m 内的任意空交点**
都能落子（`STONE_TOLERANCE_M = 1m`，随公开棋盘下发 `stoneToleranceM`）。目标点在范围内就不用挪；
超出范围才需要先走近。容差同时用于客户端 precheck 和服务端提交复检。

**先想目标再想走法**：planning 新增【先想目标，再想走法】一节，五子棋与扫雷各自再强调一次
"先定行列/格子，再算 turn/walk/walk_adjust"，避免模型先算路线再看目标、或给多个候选点分别算路线。

**提示词按对局注入**：`system.txt` / `planning.txt` / `review.txt` 支持条件段
`{{#minesweeper}} ... {{/minesweeper}}`、`{{#gomoku}} ... {{/gomoku}}`，由 `renderSections()` 在
每次请求时按当前上下文裁剪：

| 状态 | system 长度 | 注入内容 |
|---|---|---|
| 没有对局 | 6146 | 通用规则 + 人格 + 一句"会自己玩扫雷，也会和你下五子棋" |
| 扫雷进行中 | 8078 | 加上扫雷/挖掘/棋盘规则 |
| 五子棋进行中 | ~7.4k | 只加五子棋规则，不含任何扫雷段落 |

实测：五子棋上下文里 `挖掘需要右手` 不出现；扫雷上下文里 `gomoku.rows` 不出现；没有对局时两边都不出现。
