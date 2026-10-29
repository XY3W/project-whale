# 下一阶段实现方案：LLM 行为闭环与点击聊天

> 状态：待评审，供 DeepSeek 实现；不代表功能已经完成。
> 日期：2026-10-25。
> 代码基线：已只读核对服务器 /home/xy3w/whale-app 的 main.ts、LayeredMotionPlayer.ts、Hud.ts。
> 存放：仅本地方案目录，不上传服务器。服务器用于代码开发和 Git 管理；本地用于方案、素材与交接数据。
> 优先级：本文覆盖旧 DESIGN 中的观察模式、点击地面移动、闲置定时触发 LLM 等冲突约定。

## 1. 本轮目标与已确认规则

实现“机械漫游 → 触发任务 → 思考 → LLM 下令 → 执行 → LLM 检查 → 继续或结束”的闭环。

- 无命令时保留机械随机漫游，优先级最低；它不调用 LLM、不主动说话。
- LLM 只在用户发送聊天、角色发现值得关注的物品/事件，以及任务结果检查时调用。没有闲置定时调用。
- LLM 决定任务中走多远、转多少度；执行器校验并完成指令，不偷偷修改目标。
- 取消观察模式。相机拖动、缩放仅操作相机，不触发角色行为或 LLM。
- 取消用户点击地面移动；普通 HUD/快捷键也不能成为直接操纵角色的旁路。
- 点击角色：停止机械漫游，安全收步，转向用户，再打开右侧聊天框。
- 聊天框默认隐藏；未打开时不能聊天。点击角色本身不调用 LLM，发送消息才调用。
- 打开聊天框后，连续两分钟无聊天键盘输入，自动关闭聊天框并退出聊天模式。
- 聊天仍打开时，任务完成后停留等待，不恢复漫游。
- 超时退出时若任务未完，先完成执行与检查闭环，确认无后续任务才恢复漫游。
- API 调用失败直接报错，头顶显示大型红色断连图标；不生成假回复，不自动漫游掩盖失败。
- 第一版偏安静，主动回应聊天；不加入跑跳坐、真实拾取、拿起角色、长期记忆或语音。

## 2. 现有实现与改造入口

服务器当前主场景已经使用 V9：83 骨运行时骨架、16 个分层片段、完整蒙皮权重；原 10 个用户动作加起步/收步内部片段已交付。

main.ts 目前直接管理 idle/stopping/turning/walking：
- 地面点击调用 requestMove，需要移除。
- 角色点击只播放 notice，需要改为聊天入口。
- Hud 暴露直接动作按钮，需要从普通用户界面移除，仅可留显式开发调试模式。
- 移动接近目标后才收步、根坐标最终 clamp，不能直接当作精确距离执行器。

建议职责拆分，不要求机械地创建大量空壳文件：

| 模块 | 职责 |
|---|---|
| BehaviorCoordinator | 唯一控制权仲裁、任务状态、聊天状态、恢复漫游门禁 |
| RoamingController | 机械漫游，不调用 LLM |
| ActionExecutor | 计划、步骤、并发通道、结果与取消 |
| LocomotionExecutor | 指定角度/距离、收步、路径边界校验 |
| CharacterInput | 角色点击、拖动分流 |
| ChatPanel / CharacterStatus / SpeechBubble | 右侧聊天、思考/错误图标、公开气泡 |
| WorldState / CapabilityRegistry / AttentionEvents | 世界快照、能力、关注事件 |
| shared/protocol + schema | 前后端共用协议和运行时校验 |
| server/ | 会话、模型适配器、任务闭环、校验和日志 |

保留 Stage、LayeredMotionPlayer、multiWeight 的正确链路。不得重新叠加旧 Idle/Gesture/TailController 的直接骨骼旋转或逐帧还原姿态。

## 3. 状态机与优先级

至少分离以下维度：

| 维度 | 状态 |
|---|---|
| 聊天 | closed / opening / open |
| 任务 | none / thinking / executing / checking / cancelling / error / blocked |
| 身体运动 | idle / starting / walking / stopping / turning |
| 控制来源 | system_chat_entry / llm_task / roaming / none |
| 网络 | connected / disconnected |
| 输入 | normal / composing |

优先级：安全停止/断连 > 用户点击和新消息 > 当前 LLM 任务 > 关注事件 > 机械漫游。

恢复漫游必须同时满足：
1. chat=closed；
2. task=none；
3. 连接正常、没有错误挂起；
4. 身体已达到可接管状态；
5. 没有待处理用户消息或关注事件。

只有 Coordinator 能决定恢复漫游。动画完成、聊天超时、模型回复、重连处理不能分别调用 roam.start()。

新消息或用户点击的优先级高，不等于瞬间冻结身体；撤销未执行步骤，当前移动安全收步并报告部分结果。

## 4. 点击角色与右侧聊天

### 4.1 进入聊天

- 初始沿用 6px 拖动阈值、400ms 点击阈值；正确处理 pointercancel。
- 仅点击命中角色才进入。点击地面不移动、不打开聊天。
- 进入 opening 时立即禁止产生新漫游目标，清除旧目的地，安全收步。
- “转向用户”定义为朝向点击时相机位置的水平投影；收步后用角色实际位置计算角度。保存点击时相机位置，后续拖动相机不改变目标。
- 相机投影与角色重合时保持朝向，避免 NaN。
- 停稳后平滑转向，然后打开聊天框、聚焦输入框。此转向是进入聊天的固定系统行为，不需要 LLM 下令。
- opening 重复点击幂等；open 时再次点击只聚焦，不重新转向、不调用 LLM，也不因鼠标点击延长键盘计时。
- 若角色正在执行任务，点击先发起安全取消并保存部分结果，再进入聊天；旧计划不在后台继续。下一条消息携带中断记录。

### 4.2 两分钟无输入

聊天框实际打开时设 lastKeyboardActivity，120 秒为截止时间。
- 输入框聚焦后的用户 keydown 重置计时，退格、方向键等键盘操作也计入。
- compositionstart/update/end 与用户 input 计入，覆盖中文输入法和移动端输入。
- 鼠标活动、相机拖动、模型回复、自动聚焦、程序填入文本、自动滚动不重置计时。
- 到时关闭聊天框；未发送草稿保留到下次打开，不自动提交。结束组合输入交互，但不能把组词文本误当成已发送消息。
- 用单调时钟和截止时间计算；后台定时器可能降频，visibilitychange/focus/下一次交互时必须复核，先处理已发生的超时。
- closed 状态前后端都拒绝新的聊天提交，不能用直接调用接口绕过入口。
- 超时不清空对话记录，也不取消已经提交的任务。
- 无任务时超时后恢复漫游；thinking/executing/checking 时关闭界面但继续任务闭环，finish 后恢复。
- error/blocked 状态不会因超时自动解除，断连图标仍保留。
- 本轮无需“恢复互动”按钮；若增加手动关闭聊天按钮，与超时共用退出路径。

### 4.3 聊天与气泡

显示用户消息、模型公开回复、任务状态、具体错误和重试按钮。使用纯文本或安全渲染，不直接将模型文字写入 innerHTML。

用户消息发送后立即入列。模型完整输出校验通过后，再展示公开回复和启动行为；不执行未经校验的流式 JSON 片段。不展示模型内部推理。

气泡与聊天框使用同一公开文本，不重复发送。建议 speech 最多 120 字，气泡最多三行，超出分页/省略而在聊天框保留全文；不能无限缩小字号。这是实现默认值，可调整，不影响行为权限。

## 5. LLM 完整任务闭环

1. 用户消息或有效关注事件到来，取得任务控制权，停止机械脚本产生新目标。
2. 请求安全收步，立即显示“思考中”；停稳后播放 think，不能破坏收步。
3. 获取稳定世界快照，请求 LLM，phase=planning。
4. 严格校验输出、能力、参数、场地边界、前置条件和版本；通过才执行。
5. 执行整套计划，逐步骤记录实际结果。某步失败时取消依赖它的后续步骤。
6. 全部完成、失败或中断后进入 checking，头顶显示“思考中”，提交实际结果，phase=review。
7. LLM 返回下一套 execute_plan，或 finish_task 明确结束。
8. finish_task 释放任务锁；聊天 open 则停留，closed 且满足门禁才恢复漫游。

普通聊天允许直接 finish_task + speech，无需先虚构一个身体动作再检查。计划已经执行过动作时，必须经过 review，不能执行器自行判定整个用户目标完成。

建议每个 task 最多 4 轮 execute→review、180 秒活动预算，超限进入 blocked 并解释需要新指示；不无限循环调用，也不假报断网。长计划必须预估时长，拒绝明显超过预算的计划。新用户消息创建新任务，不偷偷重置旧任务预算续跑。

## 6. LLM 输入快照

每次请求提供：
- protocolVersion、taskId、turnId、requestId、phase、assetVersion、rigVersion、capabilityVersion。
- 用户消息、有限短期上下文、当前任务目标、已完成和中断的步骤。
- 角色世界坐标（米）、水平朝向（度）、身体阶段和各动画通道状态。
- 坐标轴约定、场地可行走区域、安全余量、障碍信息。
- 聊天是否打开、控制来源、是否有更新的用户消息。
- 能力清单：enabled、参数、支持范围、是否移动、通道占用、前置条件、成功状态和时长。
- 可关注物品：稳定 ID、类型、位置、尺寸、revision、可交互能力、持有关系。
- review 时附执行器实际结果和最终快照，不能把模型的预测值当成执行结果。

不传逐帧位置，不因每次鼠标移动调用 LLM。建议最多保留最近 12 轮对话与本任务记录，按 token 上限截断；不额外调用模型总结闲置历史。暂不做跨会话长期记忆与复杂情绪数值。

## 7. 行为输出与执行协议

### 7.1 两种模型输出

模型只产生业务字段；sessionId/taskId/planId/stepId 由服务器生成和绑定，不能让模型自行指定执行身份。

execute_plan 示例：

```json
{
  "type": "execute_plan",
  "speech": "我往右边走一点，再挥挥手。",
  "steps": [
    {"action": "turn", "angle_deg": -45},
    {"action": "walk", "distance_m": 0.45},
    {
      "action": "parallel",
      "items": [
        {"action": "play", "action_id": "greet"},
        {"action": "tail", "style": "tail_swish", "duration_s": 3}
      ]
    }
  ]
}
```

finish_task 示例：

```json
{
  "type": "finish_task",
  "outcome": "completed",
  "speech": "好了，我走到这里啦。"
}
```

outcome 支持 completed / cannot_complete / cancelled。cannot_complete 要解释无法继续，不能冒充成功。系统错误保留 error，不用 finish_task 掩盖。

### 7.2 行为能力

| action | 参数 | 约定 |
|---|---|---|
| turn | angle_deg，初值 [-180,180] | 相对当前朝向，正为角色左转，负为右转 |
| walk | distance_m > 0 | 当前朝向前进，只接受已公布支持距离 |
| play | action_id | greet/notice/nod/look_left/look_right；think 另需有限 duration_s |
| tail | style、duration_s | tail_idle/tail_swish，有界持续，结束恢复轻摆尾 |
| wait | duration_s，初值 [0,5] | 有界等待，不调用模型 |
| parallel | items | 不冲突通道同时执行，等所有子项结束 |

计划初值最多 6 个顺序步骤；parallel 最多 3 个子项，不允许嵌套。运动通道一次一个 walk 或 turn，二者不能并发；上身一次一个，尾巴一次一个。允许 walk + greet + tail。

循环动作必须有时限或明确所有者，不得让 think/tail 使计划永远不结束。LLM 不获得任意骨骼参数、任意倍率、脚本、文件或网络能力。speech 在计划开始时公开一次；不把检查阶段话语无限重复显示。

坐标统一 glTF +Y 向上、初始 +Z 朝前。yaw 使用现有 atan2(dx,dz) 和 forward=(sin(yaw),0,cos(yaw))；实现必须用测试证明正负与角色左右一致，不能用屏幕左右代替。

### 7.3 结果

每步必须返回：
status=succeeded/failed/cancelled/unsupported；
requested、actual、startState、endState、reasonCode、duration。
walk 返回实际路径长度及位移向量，turn 返回实际有符号角度；不能用 requested 填 actual。

plan 结果包含步骤结果、未执行原因、最终快照、是否停稳。
至少定义 OUT_OF_BOUNDS、BLOCKED、UNSUPPORTED_DISTANCE、CAPABILITY_DISABLED、PRECONDITION_FAILED、SUPERSEDED、CLIENT_DISCONNECTED。

## 8. 精确移动距离：必须先处理的实现闸门

已核对现有播放器：
- 起步移动 0.045m；
- 每 1.6 秒步行循环移动 0.18m；
- 收步移动 0.045m；
- 停止请求等待左脚着地，1 倍速最长约 2.4 秒完成收步。
- 当前 main.ts 到目标 0.08m 范围才停止，仍有后续位移；最终 clamp 不是正确的精确到达方案。

### 8.1 先交付可验证的距离子集

不更改资产时，从站稳开始规划“起步 + n 个完整循环 + 收步”：
d = 0.09 + 0.18n 米，n 为非负整数。
建议单次最大 1.89m（n≤10），更远由 LLM 决定分段，并校验计划时长。

这只是当前能力边界，不改变“距离由 LLM 决定”的产品要求：
- 在 capability 中给出 supportedDistances。
- 对 0.5m 等不支持值返回 UNSUPPORTED_DISTANCE 和候选值。
- 必须由 LLM 重新决定，执行器不得静默改成 0.45m。
- 新增 executeDistance / stopAtSafePoint，精确编排循环数，不靠接近目标的阈值猜停止时间。
- n=0 必须测试起步后直接收步的边界。
- 后续任意厘米距离需要短步/变步幅资产或经验证的适配模块；不能只缩放根位移造成鞋底滑动。
- 此子集是分阶段实现取舍；若下一版产品要求任意距离，须先解决资产/执行器能力，不能假报全部支持。

### 8.2 校验

建议支持距离最终位移误差 ≤1cm，转向误差 ≤1°；保留原有支撑脚测试，不把到点等同无滑步。

预检整条路径、角色占用和收步距离；安全余量根据身体/尾巴包围范围保守确定，不盲信当前 AREA_HALF=3.7。越界/受阻返回原因，LLM 重新决定；执行中新障碍则受控停止并报告实际结果。最终 clamp 只作异常保护并报失败，不能静默成功。

转向暂沿用停稳后 smoothstep 根旋转，明确仍有脚底滑动；没有无滑步转身资产。禁止走路中暗中改方向，LLM 使用 turn 再 walk。进入聊天的系统转向是固定例外。

## 9. 机械随机漫游

不调用 LLM，不生成语言，复用同一执行器但 owner=roaming。
- 门禁成立才选择合法角度和支持距离，预检全路径；无法找到则待机。
- 建议每段后待机 3–8 秒，以 0.27–0.81m 支持值为主；属可调初值。
- 用户点击或 LLM 触发立即停止产生新目标、取消未执行漫游步骤，正在移动安全收步。
- 不保留聊天前旧目的地在结束后突然续走；恢复后重新采样。
- 任何 error/blocked 都不能被当作“没任务”而启动漫游。

## 10. 物品与交互能力框架

能力分 expression / locomotion / interaction；每项有 enabled、disabledReason、changesPosition、channels、preconditions、effects、animationRequirements。

物品至少包含 id、type、position、bounds、revision、affordances、heldBy、attentionTags。
affordances 可列 pickup/put_down/carry/push/use，角色与物品双方都支持才可执行。

预留 interact(verb,target_id,destination?,approach?)：
- target 来自世界快照；执行前复核物品 revision。
- pickup 是接近、停稳、抓取、确认持有的事务；不能仅播放动画就设置 heldBy。
- 搬运成功需要实际位置与持有关系证据。
- 接近物品仍由 LLM 给出 turn/walk；未来复合交互也要显式披露 approach，不能暗中替模型决定角度距离。
- 当前上述交互全部 disabled，标明缺少动作/执行器；解释可出现在能力说明中，但不得注册成可执行工具。
- 本轮交付 registry、协议、前置条件验证与测试，不制作真实拾取动作，不以挥手伪装拾取。

关注事件由脚本感知层产生：eventId/objectId/objectRevision/type/priority/summary。
同一状态进入一次，状态变化才可重新触发；冷却建议 30 秒。忙碌时排队合并，不并发开启第二个 LLM；物品消失或事件过期则丢弃。空场景不定时制造假事件，开发测试入口可注入事件。

事件不自动打开聊天框，不冒充用户消息。第一版无物品时仅聊天触发实际启用，事件框架保留。

## 11. 服务端与浏览器职责

建议 Node TypeScript 服务同源托管 dist、API 和 WebSocket；开发使用 Vite 代理到 Node。复用 pnpm，不重新折腾 Docker。

服务器负责会话、任务和版本、模型请求、能力/schema 校验、上下文、去重与错误。
浏览器负责实际动画/位移、输入 UI、世界状态、执行完成反馈；不能直连模型。

消息建议：
- C→S：hello、chat_opened、chat_activity、chat_closed、user_message、attention_event、state_snapshot、step_result、plan_result、retry_request。
- S→C：session_state、task_state、execute_plan、cancel_plan、public_reply、error。
- 按类型携带协议版本、sessionId、requestId/planId/stepId 和单调序号。

同一角色会话只允许一个活动执行浏览器，用 lease+heartbeat；多个页面不能各自执行同一计划。执行端断开后服务器标记状态未知，重连先对账，不直接重播任务。

计划绑定 stateRevision/capabilityVersion，接受前拒绝过期状态。计划内正常步骤更新预期 revision；不能每帧增加版本导致计划自我过期。

重复 stepId 只返回已记录结果，不重复走路。刷新后无法判断完成情况时标记 unknown，取实际状态，禁止盲重试。模型请求重试与动作重试是两回事。

API Key 从服务器环境变量取，不提交 Git、不进日志、不让用户在聊天里提供。模型、base URL、超时可配置；实现时核对官方当前 API，不猜接口支持。只接受结构化输出，校验未知字段、NaN/Infinity、越界、白名单和通道冲突。

先 FakeBrain 后真实 API。建议请求超时 30 秒，每会话仅一个 in-flight；没有 Key 明确报未配置，不伪装在线。

## 12. 思考、失败、抢占与恢复

- thinking/checking：头顶“思考中”；身体停稳后用 think，切入计划时淡出，不污染 upper。
- API 超时、网络、鉴权、限流、非法结构等：明确 error，头顶大型红色断连图标，聊天框显示具体类别与重试入口；不要把鉴权错误描述成网络错误。
- 图标建议 56–72 CSS px 固定屏幕尺寸，跟随头顶投影，在远景也可辨认。
- 错误时取消未执行计划，当前动作安全收尾，禁止漫游，保留执行记录。
- 不自动循环重试。用户重试时刷新状态：规划失败重试规划，review 失败只重试检查，不重放已完成动作。
- 超时退出聊天不清错误图标；再次点击角色仍可进入聊天看错误。重连后先对账，不自动续跑。
- 浏览器断连 watchdog 请求本地安全停止，服务器撤销 lease。
- 行为受阻/越界/能力不足属于结果，提交 LLM 检查，不都画断网；预算超限进入 blocked，等待新指示。

新消息到来：
1. 标记旧任务 superseded，撤销未执行步骤。
2. 当前步骤安全中断，记录 partial result；已经发生的位移不逆向撤销。
3. 废弃旧模型请求晚到的结果。
4. 新消息携带部分结果开启新任务；建议 300ms 有界合并连续消息，不对按键调用模型。
5. 用户消息优先于排队物品事件，不能让 Promise 完成先后来仲裁角色。

## 13. 实现顺序

### M1：点击聊天、仲裁和机械漫游（FakeBrain）
移除地面移动和普通 HUD 旁路；实现角色点击收步转向、聊天框、IME/后台标签页超时。
验收不开聊天不能发消息；点击本身不请求 LLM；无任务超时后恢复漫游。

### M2：精确动作执行器
实现支持距离、计划/并发、结果、取消、路径预检。消除接近目标才收步的超程和静默 clamp。
测试 turn ±45/±180、walk 0.09/0.27/0.45、unsupported 0.5、场边拒绝、组合动作和取消时实际结果。
距离子集不通过，就不能先对真实 LLM 开放 walk。

### M3：服务端闭环与错误 UI
FakeBrain 覆盖 execute→review→finish、失败补救、新消息抢占、过期回复、重复投递、断开重连。
验证 finish+聊天开着不漫游；超时但任务未完不抢占；review 失败重试不重复动作。

### M4：真实 DeepSeek
接适配器、服务端 Key、schema、能力/世界快照和短期上下文。
测试问候、指定角度与支持距离、未实现交互、执行后检查结束。
不展示内部推理，不记录 Key；没有能力不能假成功。

### M5：服务器构建和交接
- 全部代码在服务器 Git 仓库开发；先检查 HEAD 和工作区，再新建实现分支，不能覆盖他人改动。
- pnpm build 与 scripts/animation-v9/validate-runtime.mjs 必须通过；新增协议/状态机/距离测试。
- 在服务器构建并通过真实 8090 页面验收，不从本地 rsync 覆盖代码。
- 当前 screen+Vite 是运行现状。建议 Node 托管构建产物；systemd 服务化作为单独部署步骤，先在 loopback 临时端口验证，再切 8090，保留旧启动方式便于恢复；不动 8080。
- 最终交付 commit、运行命令、配置变量名（不含值）、测试证据、限制及回滚方式。
- 草稿方案不要求上传服务器；实现需要的简要使用说明可随代码交付，不能把未确认草案当已实现功能。

## 14. 最小验收矩阵

| 场景 | 预期 |
|---|---|
| 首次进入 | 聊天隐藏，机械漫游，零 LLM 调用 |
| 地面点击/相机拖动 | 不移动角色、不打开聊天、不调用模型 |
| 漫游时点击角色 | 停止新目标、收步、一次转向用户、打开聊天 |
| 聊天未发送 | 停留等待，不调用模型 |
| 第119秒输入/中文组词 | 重置计时 |
| 连续120秒无输入 | 关闭聊天，无任务漫游，有任务等闭环 |
| 动画完成但未review | 保持检查，不恢复漫游 |
| finish但聊天仍打开 | 停留 |
| 不支持距离/越界 | 明确结果，模型重新决定，不静默取整 |
| 要求拾取 | disabled，不改物品、不假播挥手 |
| API超时/401/429/非法JSON | 红图标、具体错误、可重试、漫游暂停 |
| review失败后重试 | 仅重新检查，不重复动作 |
| 新消息抢占 | 安全取消，保留部分结果，拒绝旧回复 |
| 重复计划/步骤结果 | 不重复执行、不重复更新状态 |
| 刷新/断连/重连 | 安全停止并对账，不盲重播 |
| 同一物品持续可见 | 事件去重，不刷模型 |
| 两个浏览器 | 只有一个执行角色 |
| 超出任务预算 | blocked，不无限循环调用 |

## 15. 非本轮范围与已知取舍

不重做眨眼表情，不新增跑跳坐/无滑步转身/拾取搬运，不加入拿起角色、任意路径避障、闲置聊天、长期记忆、语音或公网多用户。

物品交互本轮只交付可扩展框架和 disabled 校验。任意厘米距离不能在精确子集尚未验证时写成已完成。根节点转身仍有脚底滑动。以上限制必须出现在实现交接里。
