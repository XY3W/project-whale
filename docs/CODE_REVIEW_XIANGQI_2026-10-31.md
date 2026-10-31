# 中国象棋代码审查与未完成项

2026-10-31，Codex。审查基线 **26fd9ec**；本地、origin/master及服务器`/home/xy3w/whale-app`均为该提交，服务active。对照`XIANGQI_PLAN.md`、`XIANGQI_ASSET_HANDOFF.md`、`XIANGQI_DEVELOPMENT_HANDOFF.md`及用户本轮补充的开局/条件prompt要求。

结论：**已有可运行切片，不能按既定方案宣布基本完成。** 基本走法、棋盘、资产加载、持棋步态、工具注册等确有实现，但关键的到位、事务、槽位、取消和恢复尚不闭环。以下只读审查，没有修复业务代码、重启服务或调用真实LLM。

## 验证范围

- `node --test tests/*.test.mjs`：**290/290通过**。
- `npm run build`：通过，保留原有大chunk提示。
- 额外确定性复现：`node docs/review-evidence/xiangqi-26fd9ec/audit.mjs`。
- 复现脚本的assert用于证明基线缺陷存在，不是要求后续版本保留缺陷；修复时应在tests/增加相反断言的回归用例。
- 原始结果：[results.json](review-evidence/xiangqi-26fd9ec/results.json)。脚本只使用临时棋局文件、内存Three对象、现有服务/提示词函数；搬运桥用当前源码单独转译并注入本地替身。不修改真实数据，不连接LLM。
- 本轮未重新进行完整浏览器/手机对局与闹钟演示；DeepSeek进度文档中的生产对局、双页测试是其既有记录，不当成本轮重新验证。

## 审查发现（按严重度）

### R01 · P1 · 场地已放大，角色及服务端坐标仍被旧边界夹住

位置：`src/main.ts:34,1380,1561`；`server/index.mjs:163,718`；`src/prop/PropItem.ts:152`。

执行器创建时虽然读取`stage.roomHalf`，主循环每帧仍把角色夹在±3.7米，恢复快照与服务器上报清洗也同样夹住；LLM仍看到stageHalf=4、walkableHalf=3.7。盆勺物理世界仍以half=4构建，`Stage.setArena`只改渲染几何。

初始外侧棋子x=±4.6、底线z=±5.175；最靠里的底线参考站位也要到z=±4.325，已超过3.7。搬运桥复现对外侧车开始拾取时距棋子约**1.728米**，仍继续执行，而参考要求0.85米。当前“walkableHalf跟随场地，因此场地接入已完成”的进度结论不成立。

修复：以模式场地配置统一渲染、逐帧限制、快照清洗、服务器公开上下文、物理边界与执行器；退出象棋恢复原配置。

### R02 · P1 · 放置/吃子没有在等待点暂停，未提交就先落到目标

位置：`src/main.ts:1134-1142`；`src/game/XiangqiBoard.ts:381-390`。

0.4秒release直接endCarry并交给普通缓动；1.1秒capture_commit_gate、1.2秒placement_gate只是触发空回调，没有暂停。只有整段1.8秒perform结束后才发送commit。因此吃子时敌子仍在目标，己子已经下降；提交失败或ACK丢失时，视觉已落子、权威盘面没变。不能用“服务端重复提交可回放”掩盖客户端没有等待和对账。

搬运桥复现顺序：release(0.4) → capture_commit_gate(1.1) → land_confirmed(1.5) → animation_complete(1.8) → commit(1.8)。这与交付契约相反。

修复：身体/道具共用可暂停时钟；空位1.2秒等ACK，吃子1.1秒在敌子上方等ACK。确认后删除敌子再继续下降；UNKNOWN_COMMIT按moveId/token查询结果，禁止盲目当失败再开一着。用户弧线也需要表现完成回执/锁，不能提交后立即开放下一套实体动作。

### R03 · P1 · 腰挂勺仅显示接通，快照/服务端/刷新恢复仍认为它在右手

位置：`src/prop/PropItem.ts:292-299,485-508,561`；`server/public-state.mjs:39-45,68-73`。

挂腰用state=worn、mode=waist，但snapshot的holder只支持hand/head，其余为null。服务器又因饭勺wear=false，把worn降成held，并把空holder补为right_hand；slotsOf没有腰槽。restore也不接受腰状态/挂点。

复现：挂腰形态快照`{object_id:'rice_scoop',state:'worn',holder:null}`清洗后变为`{state:'held',holder:'right_hand'}`。所以“右手已空”“腰间有勺”的事实不能可靠进入LLM，刷新还会回到手持，影响后续抱棋/敲盆。

修复：统一stowed/腰holder语义，贯通PropItem、sanitizeProp、slotsOf、持久化、restore与工具可用性；刷新前先安装腰挂绑定。

### R04 · P1 · 授权没有核对计划中的game_id，缺少执行前授权/双手门禁

位置：`server/index.mjs:1311-1329`；`server/xiangqi-service.mjs:114`；`src/main.ts:1082-1084,1140`。

issueXiangqiAuth没有把`step.game_id`传给服务层，也没有对比当前棋局。新旧棋局棋子ID和revision可相同。复现用`previous-unrelated-game`给当前新局申请，仍获得token。开关/重开棋局又没有立即取消旧搬运任务，旧计划可能落到新棋局。

客户端仅检查piece存在，token直到整套动作结束才由xiangqiCommit检查；双手槽位也没有硬门禁。授权失败仍可能先走位和搬动棋子。提交服务只复核棋规，没有校验当前物体阶段/实际落点/手部条件。

补充：`parallel`校验漏了xiangqi_move，实际允许`parallel:[xiangqi_move,wait]`；授权签发只find顶层，嵌套动作因此拿不到token，却仍能进入搬运。已确定性复现。

修复：gameId、revision、任务/计划/租约、pending与双手状态在授权和执行前共同校验；无授权不动。明确禁止parallel里的xiangqi_move；切局/取消撤销旧授权。

### R05 · P1 · 取消后还可能开始拾取，“安全放置/恢复”没有接入

位置：`src/main.ts:1094-1116,1144-1148`；`src/character/LayeredMotionPlayer.ts:166-168`。

源站位的walkToPoint返回false时结果被忽略，随后转向并perform(chess_pickup)。复现从一开始isCancelled=true，仍触发summon_start/grasp和beginCarry，然后才返回CANCELLED，违反最高优先级抢占。

finally只是endCarry指向原格，没有附近安全落点、chess_safe_setdown、临时位置记录或chess_recover。行走中setCarrying(false)可以返回false，调用方也没有等待/检查。pendingXiangqi只在签发时写reserved，没有持续阶段/真实位置，取消时未完整清理或恢复。

修复：每个await边界核对执行代际，源站位失败立刻返回；先稳定脚和物体，再临时放置释放双手。保留真实阶段/位置，恢复时重新走近并recover；任意半步、飞入、送出、ACK等待阶段都要测。

### R06 · P1 · 已声称实现的长将也会误判和棋

位置：`server/xiangqi.mjs:412-434`。

裁决只检查`cycle.at(-1).side`，即最后一手的走子方。循环由被将一方走回重复局面时，检查的正好是防守方，而不是一直将军的一方。

真实合法最小局面：红帅(9,3)、黑将(0,5)、红车(2,4)，红先。重复两轮“车(2,5)将军 → 将(0,4) → 车(2,4)将军 → 将(0,5)”；4手红棋全部将军，但第三次重复返回`reason:'repetition',winner:null`。既有单测使用手工构造的moves/history，恰好让将军方最后走，未覆盖这个合法序列。

修复：从有效循环分析双方责任与组合棋例，不由最后走子方决定；补真实合法对局测试。完整CCA2020的捉/交换例外仍是独立未完成项，不能把子力一步净收益启发式当完整规则。

### R07 · P1 · 重启会复活已判和棋局，并丢失幂等与循环历史

位置：`server/xiangqi-service.mjs:20-28,182-188`；`server/xiangqi.mjs:503`。

服务写状态drawn，restoreGame只识别draw，不识别drawn，因此重启后恢复成playing。constructor在load之后又把已读decisions设为空，history也只保留当前一个签名且没有持久化历史。

复现双方马往返8手：重启前`status=drawn,decisions=4,history=9`；重启后`status=playing,decisions=0,history=1`。不仅能继续下已结束的棋局，重发幂等与长将/重复裁决也会改变。

修复：统一状态枚举，持久化并恢复决策与循环历史；终局、重复请求、服务重启前后都必须保持一致。

### R08 · P2 · 开局UI未完成：按钮文案不变、没有执色选择，开局事件不覆盖用户执红

位置：`src/main.ts:143-149,1172-1181`；`server/index.mjs:1587-1589`。

只有五子棋的syncGomokuButton，没有象棋对应同步；点击直接startXiangqi('red')，没有弹窗。服务端支持用户执黑，但网页没有入口。开局事件只在轮到角色时发；当前UI固定用户红，因此点开局不会触发LLM。

按用户本轮要求：确认执色后同步“象棋结束”，取消弹窗不发送开局；两种执色都应有去重开局事件。用户执红时她可简短确认然后等待，不能抢走红方第一着；用户执黑时她执红并先下。结束/收起/断线重连/页面只读也同步按钮。

### R09 · P2 · 用户走子不落稳，取消选择也可能留在半空

位置：`src/game/XiangqiBoard.ts:162-164,191-194,312-323`；`src/main.ts:375-382`。

`t=Math.min(0.16,...)`令弧线进度永远不超过0.16，抬高后每帧又被max回同一个正高度；lastMovePulse只在gameId变化时更新，并非每次走子开始。复现240帧后目标x/z已到，y仍为**0.055498米**，不会落到地面。动画还按固定每帧lerp，时长受帧率影响。

select(null)不调用liftSelected(null)，目标y可仍为0.045；棋盘外/Esc取消也未完整接入。

修复：每枚移动棋子独立0→1的时间进度，明确起点/控制点/终点与落稳回执；取消选择统一还原高度和提示。测试低帧率、远距离移动、吃子、重复快照和连续选取消。

### R10 · P2 · prompt已分段，但加载条件尚未完全满足“只有游戏中加载详细prompt”

位置：`server/llm.mjs:119,134`；`server/public-state.mjs:251-252`。

system/planning/review确实有象棋条件段；没有棋盘或收起后不会加载，**不是没写prompt**。但flags只判断`!!ctx.xiangqi`，终局但没收起仍加载完整游戏说明。复现：无局=false、playing=true、won=true。tools模式长会话还需同步更新条件system，不能只在首轮注入后一直保留旧游戏段。

另有盘面编码问题：`xiangqiContext`给中文“将士象马车炮兵”调用toLowerCase，中文不会变成小写；rows实际不能区分红黑，却告诉LLM按大小写识别。pieces仍包含side，因此信息未全部丢失，但rows的说明具有误导，应改为明确红黑前缀或ASCII编码。

按本轮要求：详细规则/操作/合法候选只在当前游戏进行中装载；结束保留最小结果用于一次总结，之后移除详细段与旧局候选。两种调用路径、换局/收起、review和既有tools会话都测。不要因此删除全局人设/记忆/定时器说明。

## 方案逐项完成度

| 约定 | 实际状态 |
| --- | --- |
| 最终棋盘/棋子尺寸、相向楚河汉界、隐藏旧网格 | 资产/渲染已接；全套边界未接，见R01 |
| 基本走法/合法目标/将军将死困毙 | 已实现，perft与现有测试通过 |
| 完整CCA2020棋例 | 未完成；长捉仍是启发式，长将还有R06，终局恢复有R07 |
| 选择红/黑、开局/结束按钮与开始事件 | 服务支持执色，UI与开局事件不完整，见R08 |
| 悬停选子/两种落点提示 | 已有；取消与落稳不完整，见R09 |
| 自然弧线、被吃子收尾、表现锁/回执 | 有缓动/淡出；弧线和ACK顺序、落稳锁不达标，见R02/R09 |
| 双手水平抱持、专用持棋起停/短步 | 确实接入；仍需正式动作组合验收 |
| 抱棋时头发/尾巴通道 | 持棋基底丢弃交付尾巴轨道并保留独立tail层，与全身接管契约不同；需组合姿势/避障实测后验收 |
| 0.4～1.2秒从地面飞入双手 | 未接：0.4秒事件无处理，到1.2秒才beginCarry并跳到手上；见R02相关流程 |
| 放置/吃子按交付曲线等ACK再落座 | 未接，见R02 |
| 角色走近再拿、绕开棋子与裙摆/尾巴轮廓 | 只有直线分步，没有棋子障碍导航、接近角搜索及到位核验 |
| 右腰挂勺显示、槽位与刷新一致 | 显示/动作已接，完整状态闭环未完成，见R03 |
| 单次授权、revision与重复提交 | 部分实现；旧局gameId、无授权动作和parallel仍有R04 |
| 最高优先级抢占、临时放置、重新吸附 | 没有接safe_setdown/recover；取消门禁有R05 |
| pending真实阶段/位置、取消与重连对账 | 当前主要是恢复服务端原棋盘；没有完整保留在途事务 |
| 用户认输/协商和棋 | 服务有resign，网页没有认输/协商和棋入口；当前结束按钮是收起/清局 |
| LLM planning→execute→review、轮到用户等待 | 工具和条件prompt已写，有既有真人对局记录；本轮不重复真实调用；R10需收紧 |
| 多页租约 | 既有只读页开局限制实测；不等于旧任务提交/接管中途/丢ACK全覆盖 |

## 建议修复顺序

1. 先补R08入口，用户能选执色、看懂当前状态，按本轮要求唤醒开局但不抢红先。
2. R01/R03/R04：统一场地、腰槽和授权/前置校验，确保“确实可到位且双手空”才执行。
3. R02/R05/R09：独立搬运状态机，取放曲线、等待点、回执锁、取消与安全放置/恢复一次做成闭环。
4. R06/R07：真实循环棋例、状态与持久化；完整CCA2020逐例验收之前保留测试版标识。
5. R10：按实际游戏状态注入详细prompt；补用户红/黑开局、终局、收起/换游戏、tools连续会话测试。
6. 回归现有聊天、扫雷16×16/40雷、五子棋、盆勺、定时器；再按版本管理约定部署，不能只以290项旧测试通过验收。

本报告不建议继续堆“已完成”勾选；每项应附新增反例测试与对应实景证据。下一批建议先解决入口与基础事实，再联调完整搬棋，不再分散修只影响展示的切片。
