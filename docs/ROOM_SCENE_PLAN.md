> 2026-11-04 持续坐躺规则更新：取消 60 秒自动起身，以及新聊天/思考/执行状态通知触发的起身。已经坐稳或躺稳时保持状态并阻止随机漫游，直到明确 use_furniture(none)、执行需要站立的动作或切换场景。任务抢占只停止正在执行的动作；进入坐姿尚未完成时仍安全退出。此规则覆盖下文所有“一分钟/新任务自动起身”的历史描述。

> 2026-11-04 家具更新：本节为当前网格与美术规格，覆盖下文的早期占位几何描述。

## 当前家具与网格规格

- 房间沿用 8×8m / 16×16 格；每格 0.5m，原点为左后角 `(-4,-4)`，列沿 +X、行沿 +Z，索引从 0 开始。
- **按地面占地边缘对齐格线**，不是把所有中心强行放到格点：奇数格宽的家具中心在格心，偶数格宽的中心在格线上。圆角、靠垫、抽屉把手等不能越出占地。家具高度按角色比例设计，不强制整格。
- `shared/room-furniture.mjs` 是网格、尺寸、摆放、互动点的单一来源；`roomFurniture.ts` 按配置生成可见模型，导航使用同一占地，物理碰撞取自对应实体网格（不包含布边、书脊等装饰）。

| 家具 | 列、行（0 起） | 占格（X×Z） | 地面尺寸 | 外观 |
| --- | --- | --- | --- | --- |
| 沙发 | 2、1 | 3×2 | 1.5×1m | 木底框、短腿、双座垫、软靠背、包边与小靠枕 |
| 床 | 10、1 | 2×3 | 1×1.5m | 木床架、软床头、床垫、枕头、蓝白被面 |
| 床头柜与台灯 | 13、1 | 1×1 | 0.5×0.5m | 两层抽屉、木把手、暖色灯罩 |
| 书架 | 14、7 | 1×3 | 0.5×1.5m | 面向室内的开放层板、分隔与书本 |
| 地毯 | 5、6 | 6×4 | 3×2m | 蓝白边框；不阻挡移动 |

角色出生点、道具默认锚点、家具使用点均取格心；**角色的普通移动与坐躺根节点不强制吸附格子**。沙发使用点 `(-2.25,-2.25)`，床使用点 `(2.75,-2.25)`；落座点为 `(-2.25,-2.58)`，床中心为 `(1.5,-2.75)`。沙发座面仍为 0.20m、床面仍为 0.16m，保持现有坐躺参数。沙发落座点靠近座垫前缘、底框内收，为小腿留出空间。

房间提示词仅在房间内加载：`room.grid` 给出格距与原点，`room.layout` 给出所有家具占地及是否阻挡，`room.furniture` 保留沙发/床互动入口。床头柜和书架目前只有静态展示与碰撞，未新增开抽屉、拿书等能力；家具仍为代码生成的模型，没有修改原角色资产。

---

> 2026-11-04 实现更新：本方案中的早期“暂不做家具位姿/导航”等描述属于历史范围。当前已接入坐躺，新增家具静态碰撞和平面拐点绕行；刷新采用无转场初始化。最新状态见 PROGRESS.md，姿态恢复/碰撞回归见 tests/room-regressions.test.mjs。

# 房间场景（Room）方案

2026-11-03 立项 · 2026-11-04 状态：**P0–P3 已实现**（坐/躺用运行时位姿，不是素材片段；见文末「实现记录」）。

目标：在现有 playground 之外新增一个"房间"场景，摆放可互动的家具与电器；前端加场地切换按钮，
切换时两个场地左右滑动换位，角色带消失/出现特效落到新场地。

---

## 一、目标与非目标

**本期目标**

1. 场地成为一个正式概念：`playground`（现有下棋/小游戏场地）与 `room`（新房间）互斥存在。
2. 一键切换，滑动转场 + 角色 poof 特效，全程不打断渲染（同一 WebGL 上下文）。
3. 房间里有家具与电器；先做到"能看、能挡路、能被她提到"，再逐步接互动。
4. 服务端知道她当前在哪个场地，模型上下文、提示词、道具、物理都跟着走。

**非目标（本期不做）**

- 不做多场景并行（同一时刻只有一个active场景，另一个只是转场中的视觉对象）。
- 不做房间内的寻路（只做障碍阻挡与滑动绕行，不做 A*）。
- 不做家具的自由摆放/用户编辑。
- 不在没有素材的前提下硬做"坐下/躺下"（见 §3.9 互动分级）。

---

## 二、代码现状（方案的事实基础）

| 位置 | 现状 |
| --- | --- |
| `src/core/Stage.ts` | 渲染器、相机、轨道控制、主光/补光、`buildGround()` 直接建台座+网格贴图到 `scene`；`setArena(size)` 按游戏改场地尺寸并重算相机与阴影包围盒 |
| `src/core/arena.ts` / `server/arena.mjs` | 场地半径唯一来源：普通 4m、象棋 5.75m；`walkableHalf = half - 0.3` |
| `src/game/*.ts` | 棋盘自己 `scene.add(group)`，并靠 `groundTop.visible` 隐藏地面网格 |
| `src/prop/*` | 盆/勺是独立 RigidBody + 快照；`propsContext` 输出所有道具坐标与可用动作 |
| `src/prop/basinPhysics.ts` | 单个 Rapier world，地面+四面墙+道具刚体；`setArenaHalf` 改墙 |
| `server/index.mjs` | `modelContext()` 组装 `world{walkableHalf,stageHalf}`、`props`、`board/gomoku/xiangqi`；`applyClientSnapshot` 收客户端位姿与道具 |
| `src/main.ts` | 所有接线都在这里：`stage.setArena(XQ_HALF*2)` 切象棋场地、棋盘更新、按钮状态 |
| 客户端快照 | `snapshot()` 只报位姿/手持/道具，服务端据此裁剪坐标 |

**结论**：现在没有"场景"这层抽象，地面和道具都直接挂在全局 `scene` 上；要加房间必须先引入场景容器，
否则滑动转场会连棋盘、盆勺、灯一起拖走。

---

## 三、总体设计

### 3.1 场景是一等公民

新增 `src/scene/`：

```
scene/
├── types.ts          SceneId='playground'|'room'；SceneDef{ id,label,half,spawn,camera,lights,build(env) }
├── playground.ts     把 Stage.buildGround 的台座/网格搬进来，加棋盘挂载点
├── room.ts           房间：地板、三面墙、窗、家具、电器
├── furniture.ts      家具工厂（沙发/茶几/书架/床/冰箱/电视/灯/地毯/植物）
└── SceneManager.ts   两个 THREE.Group、active 状态、转场动画、相机预设、物理与障碍切换
```

- 每个场景一个 `THREE.Group`（`env.root`），场景内所有网格、灯光、家具都是它的子节点。
- `Stage` 退化为"渲染器 + 相机 + 全局主光"，不再知道地面长什么样：
  `Stage.mount(sceneRoot)` / `Stage.setCameraPreset(preset)`。
- 棋盘从"直接 `scene.add`"改为挂到 `playground.root`（`Board.attachTo(group)`），
  不再靠 `groundTop.visible` 控制显隐——房间模式下整个 playground group 不可见。
- 道具（盆/勺）不挂在场景里：它们是角色携带的刚体，跨场景始终存在，切换时按 §3.6 搬到新场景锚点。

**为什么要两个 group 都在内存里**：滑动转场要求两个场景同时可见。房间用程序化几何体，
首包体积为 0；后续换成 GLB 时再按需加载。

### 3.2 转场时间轴（默认 1000ms，可调）

`SceneManager.transition(to)`，`S = 12m`（8m 场地 + 4m 间距，读起来像"隔壁房间"）：

| 时间 | 动作 |
| --- | --- |
| 0 | 锁定：执行器挂起、角色不可操作、按钮置灰；两个 group 就位（新场景在 `x = +S`） |
| 0–150ms | 角色 poof-out：缩到 15%、上浮 0.15m、粒子爆开 0.35s |
| 150–850ms | `worldRoot.position.x: 0 → -S`，`easeInOutCubic`；旧场景左移出屏、新场景从右滑入 |
| 500ms | 角色瞬移到新场景 `spawn`（此时不可见） |
| 850–1000ms | 角色 poof-in：从 15% 弹到 100%，粒子上浮；相机切到新场景预设（同时插值） |
| 1000ms | 收尾：旧 group 归位并隐藏，`worldRoot.x = 0`，解锁，广播 `scene` 完成 |

实现要点：

- 动的是 `worldRoot`（包住两个场景 group 的容器），不是相机——避免和 OrbitControls 打架。
  转场期间 `controls.enabled = false`，结束后按新场景的 presets 重置 target/距离。
- 缓动统一用 `easeInOutCubic`；`prefers-reduced-motion` 时退化为 200ms 交叉淡出（不滑动）。
- 转场中禁止二次切换、禁止发消息、禁止开局；服务端同样拒绝（`TRANSITIONING`）。

### 3.3 角色的消失/出现特效

现有素材没有透明淡出通道，且材质被多层共用（多权重蒙皮、眨眼眼皮、`MaterialEyelids`），
直接改 `opacity` 风险高。分两步：

1. **P1（无侵入）**：复用"棋子淡出"的既有手法——整体缩放到 15% + 轻微上浮 + 0.35s 后 `visible=false`；
   出场反向弹一下（0.15 → 1.0，带一点回弹）。同时播粒子。
2. **粒子**：一个 `THREE.Points` 爆发（60–80 个点，additive、无贴图或小圆点贴图），
   颜色取角色主色（蓝白），寿命 0.5–0.7s，向上扩散 + 轻微重力；消失与出现各一次。
   落地点加一圈扩散的环形闪光（`RingGeometry` + 透明衰减）做"落场"反馈。
3. **P3 可选**：如果确认每个 mesh 的材质是独立实例，再补真正的 alpha 淡出（影子同步 `castShadow` 关闭）。

所有特效都是"装饰层"，不参与物理与拾取。

### 3.4 相机

每个场景一个预设，转场末尾用 400ms 插值过去：

| 场景 | target | 距离 | fov | 极角范围 |
| --- | --- | --- | --- | --- |
| playground | `(0, 0.42, 0)` | 外接圆 ×1.12（现值） | 32 | 0.35–1.25 |
| room | `(0, 0.55, 0)` | 约 9.5m（待实测） | 34 | 0.55–1.30（限制俯角，别看到屋顶外） |

轨道旋转/缩放保留，只是约束不同。象棋开局仍会临时把 playground 拉到 11.5m，逻辑不变。

### 3.5 场地与游戏互斥（房间内禁止开局）

**决定（2026-11-03）**：切到房间时，三个开局按钮直接隐藏，并且在代码层面禁止开局，不做"自动切回场地"。

三层防线，缺一不可：

1. **入口隐藏**：`body` 挂 `scene-room` class，CSS 隐藏 `#start-minesweeper / #start-gomoku / #start-xiangqi`
   与三个 `game-chip`；同时清掉象棋规则提示条 `#xiangqi-rule-note`。切回 playground 时恢复。
2. **客户端硬拒绝**：`startGame` / `startGomoku` / `startXiangqi` 三个入口第一行检查
   `sceneManager.active !== 'playground'` → 直接 return（不发请求、不弹窗），并打一条 `console.warn`，
   防止"隐藏了但还有别的路径"（快捷键、残留事件、调试入口）。
3. **服务端权威拒绝**：`game_start` / `gomoku_start` / `xiangqi_start` 三个 handler 在租约校验后加
   `if (sceneOf(store.state) !== 'playground') { send(ws,'error',{code:'WRONG_SCENE', message:'房间里不能开局，先回场地'}); break; }`。
   错误码固定为 `WRONG_SCENE`，前端统一提示，不弹模态框。

反向约束：有棋局进行中（含未收摊的终局）时切房间 → 拒绝（`IN_GAME`），提示"先收摊/结束棋局"。
转场进行中 → 拒绝（`TRANSITIONING`）。

**她正在执行任务时切换 → 排队（2026-11-03 用户选择）**：

- 服务端记 `pendingScene`，广播 `scene_pending`；按钮显示"已排队"，再点一次取消。
- 当前任务结束（`endTask`）后统一入口应用：切换 `scene`、清 `pendingScene`、广播，客户端播放转场。
- 任务被抢占/取消也走同一出口；服务重启会丢弃队列（任务本身不跨重启）。
- 不做乐观动画：排队路径下客户端等到 `scene` 变更事件再播，避免"人还在走路，画面先滑走"。

### 3.6 道具归属（盆和勺一起搬，重置点按场景）

**决定（2026-11-03，用户确认）**：盆和勺永远跟着她走；切换场景时，**身上的（held/worn）不重置**，
**不在身上的（resting）重置到新场景锚点**。

- 每个 `SceneDef` 定义 `propAnchors: { basin: {x,z,yaw}, rice_scoop: {x,z,yaw} }`，
  写在场景配置里（房间的具体位置等美术定了再填，先给占位值）。
- 切换场景时，无论道具当前是 `held` / `worn` / `resting`：
  - `held` / `worn`：状态不变，跟着角色一起到新场景（手持/头顶的都不落地）。
  - `resting`：直接搬到新场景对应的 anchor（不是随便丢在地上），并清速度、唤醒刚体、
    重置 `upright` 与 `variant`，保证下次拾取/投掷从干净状态开始。
- 服务端道具记录仍带 `scene` 字段，但语义变为"上一次所在的场景"（便于快照对齐与审计），
  读取时不做场景过滤——盆勺在两个场景都可用、都在场。
- 角色携带时，anchor 只是"万一掉落"的兜底位置；`restore` / 取消回滚 / 断线重连都用当前场景的 anchor。
- 象棋棋子不在此列：它属于棋局，只存在于 playground，房间内不可见。

> 说明：这条覆盖了"留原地"的做法——用户明确要求一起带走，避免切回场地发现盆还在房间里。

### 3.7 服务端状态与协议

| 项 | 设计 |
| --- | --- |
| 状态 | `store.state.scene = 'playground'`，持久化；`store.state.pendingScene`（任务中排队，不跨重启）；`sceneEpoch` 防乱序 |
| 消息 | 客户端 → 服务端 `scene_switch { to, leaseEpoch }` |
| 校验 | 必须是执行者（`NOT_EXECUTOR`）、`STALE_LEASE`、无进行中棋局（`IN_GAME`）、当前不在转场中（`TRANSITIONING`）、合法场景 id（`INVALID_SCENE`）；任务进行中**不拒绝**，改为排队 |
| 广播 | 更新后 `session_state` 带 `scene` 与 `pendingScene`，所有页面（含只读页）同步 |
| 只读页 | 只跟随渲染，不发起切换 |

前端**乐观切换**：本地先播放动画（点击即刻响应），同时发消息；服务端拒绝时回滚并弹提示
（正常情况下本地状态已经能预判，拒绝极少发生）。

### 3.8 模型上下文与提示词

- `world.scene` / `world.sceneLabel` / `world.stageHalf` 进每轮快照（易变区，位置在 §缓存布局的末尾段）。
- 新增 `room` 段：家具清单 `[{ id, type, position, interactable, state }]`，
  只列当前场景；房间外为 `null`。
- `system.txt` 加一个 `{{#room}}` 条件段落（约 150 字）：说明她在房间里、屋里有什么、可以做什么、
  不许把房间外的棋盘当成眼前的场景。
- **缓存影响**：条件段落随场景切换改变 system prompt，一次切换作废一次前缀缓存，可接受；
  家具清单必须放易变快照，不能写进 system。

### 3.9 家具与互动分级

现有动作库没有任何"坐/躺/伸手"片段（`playful-v2` 只有走/跑/挥手/点头/看/思考/拿盆勺/dig 等），
所以互动必须分级：

| 级别 | 例子 | 依赖 | 阶段 |
| --- | --- | --- | --- |
| L1 场景物 | 沙发、床、书架、地毯、植物 | 只有碰撞与描述 | P1 |
| L2 开关类 | 台灯开/关、电视开/关（屏幕自发光+噪点+声音）、冰箱门开合（门轴旋转）、窗帘拉合 | 宿主动画家具本身，角色站在使用点播 `nod`/`notice` | P3 |
| L3 身体接触类 | 坐到沙发上、躺床、开冰箱取东西、喝水 | **需要新素材**：`sit_down/sit_idle/stand_up/lie_down/lie_idle/get_up/reach_open/grasp` | P4（等 Codex） |
| L4 长时状态 | 睡觉（关灯+躺床+环境变暗）、泡澡（需新场景件） | L3 + 计时器联动 | 以后 |

L2 的诚实说明：角色是"走到跟前按下开关"，手不会真的碰到，靠停位、朝向和 0.2s 的伸手预备动作
（现有 `notice` 前 0.2s）掩饰；文档里写清楚，不宣称有真实接触。

### 3.10 碰撞与障碍

现状只有 `walkableHalf` 边界夹取，没有障碍物概念（棋盘穿模问题也是这个缺口）。

- 新增 `src/behavior/obstacles.ts`：每场景一组 AABB（x/z 范围 + 高度），
  角色每一步位移后做"推出"（沿穿透最小的轴滑开），不阻挡视线、不影响拾取距离判定。
- 家具在 Rapier 里也建固定碰撞体（给盆/勺和投掷用），与 AABB 共用同一份家具数据，避免两套真相。
- 已知限制：只做滑动绕行，不做寻路；被家具围死时执行器报告 `BLOCKED`，由模型决定换目标。

---

## 四、文件改动清单

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `src/core/Stage.ts` | 抽出 `buildGround`；保留 renderer/camera/key light；新增 `mount()`、`setCameraPreset()` | 中：改的是所有页面共用的舞台 |
| `src/scene/*` | 新增 types/playground/room/furniture/SceneManager | 低 |
| `src/main.ts` | 初始化 SceneManager；转场期间锁执行器与聊天；快照加 `scene`；三个开局入口加场景硬拒绝；切场景时搬盆勺到锚点 | **高**：1772 行的接线中心 |
| `src/ui/Controls.ts`、`src/style.css` | 场地切换分段按钮；`body.scene-room` 下隐藏三个开局按钮与状态条 | 低 |
| `src/game/*.ts` | 棋盘挂到 playground group，去掉对 `Stage.groundTop` 的依赖 | 中 |
| `src/prop/*.ts` | 道具快照加 `scene`；切场景时 held/worn 跟随、resting 落到新场景 anchor（清速度/唤醒刚体） | 中 |
| `src/behavior/obstacles.ts` | 新增 AABB 障碍与推出逻辑 | 中 |
| `server/index.mjs` | `scene_switch` 处理、`session_state.scene`、上下文注入、三个开局 handler 加 `WRONG_SCENE` | 中 |
| `server/public-state.mjs` | `roomContext()`、`scene` 字段、道具锚点信息 | 中 |
| `server/prompts/system.txt` | `{{#room}}` 条件段落 | 低 |
| `tests/*` | 新增场景状态机、协议、上下文、障碍 4 个测试文件 | 低 |

---

## 五、分阶段与验收

**P0 场地抽象（不动视觉，0.5 天）**
产出：Stage 拆出 playground group，棋盘改挂载，行为与现在完全一致。
验收：374 项测试全绿；截图与改动前逐像素一致（除无关抗锯齿）；象棋场地仍能拉到 11.5m。

**P1 房间与转场（1.5 天）**
产出：程序化房间（地板/三面墙/窗/沙发/茶几/书架/床/灯/地毯）、相机预设、切换按钮、
滑动转场、角色 poof + 粒子、`prefers-reduced-motion` 降级。
验收：连续切 20 次不泄漏（renderer.info 内存、group 子节点数稳定）；转场不掉帧
（1280×717 headless 下记录帧时间）；无 WebGL 上下文重建；正面小窗不黑屏。

**P2 服务端与模型（1 天）**
产出：`scene` 状态与持久化、`scene_switch` 协议与拒绝路径、任务中的排队与任务结束后的应用、`session_state` 同步、
上下文 `world.scene` + `room` 家具清单、`{{#room}}` 提示词、房间内隐藏按钮且开局被双重拒绝。
验收：只读页拒绝切换；任务进行中切场景显示"已排队"，任务结束后自动完成转场（再点一次可取消）；重连/重启后场景保持；房间内三个开局按钮不可见，
直接发 `game_start/gomoku_start/xiangqi_start` 得到 `WRONG_SCENE` 且不产生棋局；
切场景后盆勺都到位（resting 落到新场景锚点）；模型能正确回答"你现在在哪、
屋里有什么"（真实模型对局记录进 `docs/XIANGQI_PROGRESS.md` 风格的过程记录）。

**P3 家具互动与障碍（1.5 天）**
产出：台灯/电视/冰箱门/窗帘四件 L2 互动（`use_furniture` 能力）、AABB 障碍与滑行、
Rapier 家具碰撞体、使用点站位。
验收：走到沙发旁被挡住能滑开；关灯后场景变暗但角色仍可见；电视声音受音量条控制；
四个互动各有拒绝路径（距离不够/已开启/不可用）。

**P4 新素材（依赖 Codex）**
产出：`sit_down/sit_idle/stand_up/lie_down/lie_idle/get_up/reach_open` 的素材包与契约，
接入沙发、床、冰箱取物。
验收：坐下/起身衔接误差 < 2mm（沿用抱棋测试的标准），起身后能直接走。

---

## 六、测试计划

- `tests/scene-manager.test.mjs`：转场状态机（进行中拒绝二次切换、reduced-motion 降级、
  结束态一致）、`S` 与相机预设的数值、group 归位。
- `tests/scene-protocol.test.mjs`：`scene_switch` 的 `NOT_EXECUTOR / STALE_LEASE / IN_GAME / TRANSITIONING / INVALID_SCENE`、
  持久化、只读页同步；任务中切换进入排队、任务结束自动应用、重复点击取消排队、重启丢弃队列；
  房间内三个 `*_start` 全部返回 `WRONG_SCENE` 且棋盘为空；
  切场景后盆勺位置等于新场景锚点（held/worn 时不落地）。
- `tests/room-context.test.mjs`：`world.scene` 与家具清单只含当前场景；房间外为 null；
  提示词只在 room 注入；缓存布局（棋谱仍是尾部大块、快照最后）不被破坏。
- `tests/obstacles.test.mjs`：AABB 推出不穿墙、角落滑行、被围死返回 BLOCKED。
- 人工：转场录制 3 段（普通/快速双击/低帧率），确认没有场景重叠或角色悬空。

---

## 七、风险与备选

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| `main.ts` 接线过于集中 | 1772 行，加转场锁容易漏路径 | P0 先把场景抽干净再加特效；转场期间用一个 `transitioning` 总闸 |
| 材质淡出污染 | 多权重/眼皮材质共用，改 opacity 可能整角色变半透 | P1 只用缩放+粒子；确认材质独立后再上 alpha |
| 阴影 | 房间有墙，主光从外面打会被挡 | 房间自带灯组（顶灯+台灯+电视冷光），主光只保角色影子 |
| 物理双份真相 | AABB 与 Rapier 家具体不一致 | 同一份家具数据生成两者 |
| 棋盘绑定 `groundTop` | 现有隐显逻辑依赖它 | P0 改成 group 级显隐 |
| 首包体积 | 房间若用 GLB 会拉高加载 | P1 先程序化几何体，GLB 后置 |

**备选方案**：不做两个 group 滑动，改"淡出淡入 + 角色 poof"（成本低一半）。
滑动更符合你说的效果，推荐做主方案；如果 P1 发现掉帧严重，降级为淡入淡出。

---

## 八、待确认

1. **房间美术**：现代温馨小客厅（沙发+茶几+电视+书架+床），还是别的风格？
   P1 先用程序化几何体（纯色块+灯光）验证交互与动效，等美术素材到位再替换，可以吗？
2. **家具互动**：L2（开关灯/电视/冰箱门，角色站定按开关）够不够？
   L3（坐下/躺床）需要 Codex 出新素材，是否现在就提需求？
3. ~~道具~~ 已定：盆勺一起带走，切场景换成该场景的重置点。
4. ~~房间内开局~~ 已定：隐藏按钮 + 客户端/服务端双重禁止，错误码 `WRONG_SCENE`。

---

## 九、实现记录（2026-11-04）

已完成（对应 §五 的 P0–P2）：

| 项 | 落点 |
| --- | --- |
| 场地抽象 | `src/scene/playground.ts` 接管原 `Stage.buildGround`；`Stage` 只留渲染器/相机/灯光，新增 `mount / attachArena / setActiveHalf / applyCameraPreset` |
| 房间 | `src/scene/room.ts`：地板、三面墙、窗、地毯、沙发、床、小几台灯、书架；尺寸按她 0.7m 的身高定（座面 0.2m、床面 0.16m） |
| 转场 | `src/scene/SceneManager.ts`：1000ms，0–150ms 角色 poof-out，150–850ms 世界平移一个场地间距（12m），500ms 交换，850–1000ms 出现并插值相机 |
| 特效 | `src/scene/transitionFx.ts`：64 粒子向上扩散 + 地面光环，随帧衰减 |
| 按钮 | 左栏「场地」分段控件；房间内 `body.scene-room` 隐藏三个开局按钮与状态条 |
| 协议 | `scene_switch {to}`；`session_state` 带 `scene/pendingScene`；`scene_changed` 广播；错误码 `NOT_EXECUTOR/STALE_LEASE/INVALID_SCENE/IN_GAME/WRONG_SCENE` |
| 排队 | 任务进行中切换写 `pendingScene`，`endTask` 统一应用；重启丢弃；客户端等服务端确认再播转场 |
| 开局禁止 | 客户端三入口 `sceneAllowsGame()` 硬拒绝 + 服务端三个 `*_start` 返回 `WRONG_SCENE` |
| 道具 | 切场景时 held/worn 跟随，resting 用 `resetToCenter` 落到该场景锚点 |
| 模型 | `world.scene/sceneLabel`；`system.txt` 的 `{{#room}}` 段落说明"在房间里、不能开局" |
| 测试 | `tests/scene-protocol.test.mjs` 4 项（默认场地、房间禁开局、只读/棋局拒绝、任务中排队、房间上下文与提示词）；全量 378 项通过 |

P3 已接（2026-11-04）：

- `use_furniture{furniture_id}`：sofa 坐下、bed 躺下、none 起身；能力注册、`validateStep`、`roomContext` 与 `{{#room}}` 提示词都已就位。
- `src/character/FurniturePose.ts`：扁平骨架的运行时位姿——先按髋/膝/踝角度算腿的 FK（三段骨骼整体搬移），再把 root.x 下沉/后仰；在 mixer 之后按 weight 覆盖，坐下 0.45s、起身反向，不会跳变。
- `shared/room-furniture.mjs`：家具位置、使用点、座面高度、可做动作的单一来源，客户端建场景与服务端上下文共用。
- 失败码：`NOT_IN_ROOM / HANDS_BUSY / OUT_OF_RANGE / UNKNOWN_FURNITURE`。
- 2026-11-04 修正：躺下改为瞬间到位（无过渡）；躺下前自动把盆勺从当前位置扔开；腿骨目标在骨架旋转之后计算（整副骨架一起躺）；坐/躺有 60s 休息上限，到点或新任务时起身回使用点，休息期间不漫游。

仍未做：

- 家具美术资产（现在全是程序化几何体）；
- 裙摆/头发的二次运动没有参与坐躺（从正面看裙摆会盖住腿，个别角度会穿过座面）；
- 坐下/躺下没有专门的过渡片段，只有线性混合。
