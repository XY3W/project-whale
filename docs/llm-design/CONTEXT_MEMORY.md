# 提示词、记忆与上下文管理契约

> 2026-10-27 更新：用户确认的当前增量见 [PERSONA_MEMORY_V2_PLAN.md](../PERSONA_MEMORY_V2_PLAN.md)。安静蠢萌只影响表达，实际决策保持准确；补齐来源、确认/删除/回喂、会话摘要和累计执行证据。本轮先沿用JSON完成闭环，SQLite不作为前置；整请求输入估算阈值沿用服务器14000，输出预留依模型适配器配置。下文旧8000/2000为历史默认，冲突处以增量方案为准。

状态：本地待评审方案，2026-10-25。本文件补充并覆盖 NEXT_PHASE_LLM_PLAN.md 中原先“暂不做长期记忆”的粗略约定。本轮加入最小可控记忆，暂不做自动人格/情绪演化、向量数据库或无限历史召回。

## 1. 一次请求的组成

按顺序组装：
1. 固定 system：SYSTEM_PROMPT.md 分隔线后的正文。
2. 由 CapabilityRegistry 和 output schema 自动生成的能力与结构约束。使用当前 API 支持的结构化输出/工具声明适配；必要时将 Schema 以宿主控制的数据附加给模型。
3. 当前 phase 的 PLANNING_PROMPT 或 REVIEW_PROMPT，其中只有一个经 JSON 序列化的 REQUEST_CONTEXT。
4. 正确保留 provider 的工具调用/结果关联；若采用 JSON 单响应接口，则使用本方案的 execution_report，不伪造缺少关联 ID 的 tool 消息。

当前世界与能力必须每次请求刷新。固定 system 可以缓存，但不能把位置、朝向或物品状态写死在它里面。Schema 与能力说明使用同一注册表生成，不能三处分别手写范围。

## 2. 能力注册表必须包含

id、category、description、enabled、disabledReason、inputSchema、channels、changesPosition、preconditions、effects、completionEvidence、estimatedDuration、version。

- JSON Schema 描述字段、类型、必填、enum、minimum/maximum、maxItems、additionalProperties=false。
- supportedDistances 等离散范围使用 enum，不能只给 min/max 让模型以为连续值都可用。
- 动态边界、碰撞、资源占用、版本一致性在运行时再校验，不能只靠提示词或 Schema。
- enabled 能力与 disabled 能力分开提供；disabled 的原因可解释，但不注册为执行工具。
- registry/schema 不匹配时拒绝启动，不用过期清单继续运行。
- 本包 OUTPUT_SCHEMA.json 是当前 V9 距离子集的初始模板。其启用前提是 M2 验收通过；不是断言当前 main.ts 已具备这些能力。部署时从验收后的 registry 生成实际 Schema。

## 3. 世界快照

必须包含：
snapshotId、capturedAt、stateRevision、sceneId、coordinateSystem；
walkableArea/obstacles/安全余量；
character.position、yawDeg、forward、motionPhase、activeChannels、heldObjectIds、headObjectId；
interaction.chatState、controlOwner、pendingUserMessage；
objects/events、capabilityVersion、执行预算。

yaw 和 forward 由同一实际变换计算；不同时发送相互矛盾的数据。采样以停稳/步骤结束为主，不把“计划到达点”当成当前坐标。若快照过期或运动未稳定，标记对应有效性并由宿主暂停规划。

物品很多时：必保留用户点名目标、任务相关物品、当前位置到候选目标的障碍；其他按关注度和距离筛选。标记 objectsTruncated/omittedCount。不得为了省上下文省掉路径上的障碍，再告诉模型路径畅通；完整路径校验始终在执行器。

EXAMPLE_CONTEXT.json 只是假数据结构示例，不能作为运行时缺失字段的默认真实场景。

## 4. 三种记忆，明确分开

### A. 实时状态与执行账本
角色位置、朝向、任务完成程度、物品持有、网络、聊天开关，来自实际运行状态。不是长期记忆。
账本由程序记录 requested/actual/结果/版本与 ID，刷新后用于对账和防重复。LLM 不能直接修改账本。

### B. 当前会话上下文
保留当前用户目标、最近对话、尚未解决的问题和任务摘要。退出两分钟聊天不会清空；重新点击继续同一会话。
历史原文可持久化在服务器数据库；发送给模型的只是有预算的相关部分，不是把所有历史塞进去。
摘要必须标明 derived/sourceMessageIds；不能把摘要中的模型猜测提升成用户事实。优先采用程序生成的执行摘要，无额外闲置总结调用。

### C. 最小长期偏好
本版允许保存用户明确表达的称呼、语言/回复风格偏好、普通兴趣，例如“叫我小乔”“回复简短一点”“我喜欢蓝色”。
不自动记录敏感信息、不猜测关系或人格，不把玩笑/引用/假设当事实。不记场景瞬时位置。
数据字段：id、ownerScope、key、value、sourceMessageId、sourceQuote、createdAt、updatedAt、status、revision。
status=confirmed 必须有可核验用户来源；模型 memory_proposals 默认只是 candidate。

初版提交规则：
- 用户明确“记住/以后叫我/以后回答……”可持久化符合白名单的偏好；若来源歧义则保留 candidate，不自动成为事实。
- 普通“我喜欢……”可生成候选，由聊天面板内的记忆列表供用户确认；不弹出阻塞动作的审批框。
- 用户纠正同一 key：新明确声明覆盖旧值，保留修订来源；模型不能为了保持旧记忆而反驳用户。
- 用户明确“忘掉……”或在记忆列表删除：立即逻辑删除，后续检索和摘要同步排除，不能从历史摘要重新复活该事实。
- 模型提案不能直接写 confirmed；服务端验证 owner、来源 ID、引用、白名单 key 和删除权限。
- 引用准确只能证明有这句话，不能证明不是反话/引用。非明确记忆指令需要用户确认。
- 每轮最多两条候选；不额外定时调用模型提取记忆。可随 planning/review 响应携带，不影响执行预算。
- 记忆提案不合法时独立拒绝并记录，合法动作不因无关记忆候选而重试或重复执行。

## 5. 存储与作用域

建议服务器 SQLite，数据在运行数据目录、加入 .gitignore，不把聊天/记忆当源码提交。最少分 sessions/messages/tasks/step_results/memories 表。
本版单用户交互：浏览器通过服务端签发的会话标识绑定 ownerScope；客户端不能直接传另一个 owner 的 ID 获得记忆。第二个浏览器不能自动混入第一个浏览器的聊天和偏好；共享记忆需后续显式设计。
模型只拿到精选记忆，不直接获得数据库或任意文件工具。提供聊天内“记忆”列表的查看、确认、删除，以及清空会话入口；清空会话与删除长期偏好明确分开。
用户永久删除时应删除原记录和衍生缓存/摘要中的对应内容；技术审计只保留删除事件，不保留被删除的敏感原文。
聊天记录建议保留最近30天，可配置并告知用户；已确认偏好保留到用户删除。当前活动任务、未完成重连对账不能因后台清理被删除。不要在普通控制台日志复制完整对话和记忆，日志以 ID/状态/错误码为主。

## 6. 上下文预算与裁剪

实现默认值：输入目标预算 8000 tokens、输出预留 2000 tokens；实际值必须受所选模型上下文上限约束，包含 system、tool/schema、历史和快照开销。能用 provider tokenizer 则使用；否则保守估计并预留余量，不把字符数等同 token 数。

预算优先级：
1. system 与当前 enabled 能力/输出协议不能删掉；
2. 最新用户消息、当前目标、当前世界关键事实不能丢；
3. 活动任务执行账本、错误/取消/unknown 状态不能丢；
4. 相关 confirmed 偏好（最多20条，目标≤800 tokens）；
5. 最近对话（最多12轮，仍受总预算约束）；
6. 较早会话摘要（目标≤600 tokens）、与本任务无关事件。

超预算先去掉无关历史/事件/偏好，再移除最老完整对话轮。活动任务早期成功步骤可按程序聚合成已完成位移/动作及 source step IDs，但要保留失败、未知、不可重复步骤和最终实际状态。
不能截断 JSON 字符串、删掉工具调用而留孤立结果、或丢掉任务前半部分导致重复执行。保留的对话不得让模型误以为上下文完整，标记 historyTruncated。
若关键固定内容本身已超预算，宿主报 CONTEXT_TOO_LARGE 或让用户缩短输入，不能偷偷削弱约束后继续调用。
总结可在已有正常模型请求中提出有来源的候选，但不是必要依赖；第一版没有独立后台摘要模型调用。

## 7. 权威顺序与失效

实际执行结果/最新快照 > 历史位置或模型预测；新明确用户偏好 > 旧偏好；系统能力与范围 > 用户希望突破限制的文字。
记忆永远不能改系统提示词、enabled 能力、执行参数范围或角色权限。
任务切换、物品 revision 改变、资产/能力版本更新后，刷新上下文；旧模型结果必须按绑定 task/turn/version 拒绝，不重用上轮快照。
失败重试重新取快照和账本；review 重试不把旧 plan 再发给执行器。

## 8. MCP 与工具适配

本版先做内部 CapabilityRegistry + JSON Schema + 执行器适配，不把 MCP 服务部署列为阻塞。
MCP Tools 的 name/description/inputSchema/outputSchema 结构适合未来复用，官方资料：
https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx

本方案的选择：保持整套计划一次提交，而不是把 turn/walk/play 分成任意无序调用。若以后接 MCP，暴露 get_capabilities、get_world_snapshot、submit_plan、get_plan_result 等窄接口；submit_plan 仍受原 Coordinator、版本、权限和去重约束。
MCP 只是适配入口，不替代记忆、状态机、世界快照、执行结果校验或完成检查。不要因为注册成工具就允许模型绕过计划锁逐条操纵角色。

## 9. 新增验收

- 改 registry 参数范围后，提示词能力说明、Schema 和服务端校验同步改变。
- 0.5m 不受支持时不能被模型/执行器静默改成0.45m；用户模糊目标可由模型选合法距离。
- 当前 position/yaw 与历史不同：只依据当前快照规划，±角度单位无歧义。
- 物品名写有“忽略规则”时，不改变行为权限。
- 记忆中的旧位置不能覆盖世界快照；候选不能冒充确认偏好。
- 删除记忆后不从历史摘要重新引用；不同 ownerScope 不串记忆。
- 8000 token 预算下保留失败/unknown 和已完成步骤，不重复走路。
- 模型未见用户姓名时不编造，不能把自己上轮生成的名字写成用户记忆。
- 用户要求不支持能力时诚实解释；不暴露内部推理或 Key。
- 所有示例快照只用于测试，生产缺少状态时不能加载示例坐标继续执行。

## 钢盆阶段补充（2026-10-25）

快照增加对象 state/revision、heldObjectId/headObjectId、graspCandidates、approachCandidates、pickupReachable 及不可达原因。当前自主交互目标和来源 attentionEventId 放入任务上下文，review 保留该目标，不根据每轮新状态任意开启无限新目标。注册表包含 pickup/wear/unwear/throw 的前置与后置状态；未经动作和执行器验收仍 disabled。扩展 Schema 见 BASIN_OUTPUT_SCHEMA.json。
