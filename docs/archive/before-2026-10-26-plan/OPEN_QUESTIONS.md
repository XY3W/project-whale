# 当前问题与不确定项（待 GPT 解答）

> 本地文档，不上传服务器与 Git。
> 日期：2026-10-25 20:35。服务器仓库 HEAD：`93ed3eb`（分支 `feat/llm-loop`）。

> 2026-10-25 Codex 已复核并逐项答复：[OPEN_QUESTIONS_ANSWERS.md](OPEN_QUESTIONS_ANSWERS.md)。原问题保留下方；“C 基本完成”和“只有租约阻塞”不作为验收结论。

## 0. 环境事实

- 代码：`/home/xy3w/whale-app`，systemd 服务 `whale.service`，Node 直接托管 `dist` 与 `/ws`，端口 8090
- 模型：DeepSeek API（服务端 `.env`，不入库）
- 测试：`node --test tests/*.test.mjs`，当前 35 项全过（executor 20、capabilities 7、lease 1、store 3、context/memory 4）
- 已实现：A 部分、B 部分、C 基本完成（租约/代际/账本/持久化/重启对账）、D 部分（注册表/事件去重）、E 部分（上下文预算/记忆校验/聊天关闭守卫/IME）

## 1. 阻塞问题：浏览器端一直“只读”

### 现象

无头浏览器打开 8090，等待 10 秒后仍显示“另一个页面正在执行角色，这里只读”，`client.leaseEpoch = 1`。

即使服务刚重启、没有任何浏览器常驻，也会出现。多次测试结果一致。

### 已确认

- 服务端集成测试 `server-lease.test.mjs` 通过：首连接获租约、第二连接只读、只读端发消息被 `NOT_EXECUTOR` 拒绝
- 服务端 `hello` 逻辑：`if (!isLeaseAlive()) grantLease(ws)`；`isLeaseAlive` 要求 `lease.readyState === 1` 且 `now - leaseAt < 8s`
- 客户端在只读时每 3 秒发一次 `hello`，期望 8 秒后接管
- 一次测试中确实接管成功过：`leaseEpoch` 1→2，只读提示消失，随后对话正常

### 不确定

1. 是否存在“已关闭但服务端仍认为 readyState=1 且持续心跳”的连接？如果客户端页面已关闭，心跳应该停止，为什么 lease 仍活着？
2. 客户端 `scheduleRetry` 在 close 后会自动重连；如果旧页面进程没退出，它会一直抢租约——这是测试环境问题还是真实用户也会遇到？
3. 只读页面打开聊天会发送 `chat_opened`，服务端 `session.chatOpen` 是全局的；这是否意味着只读页面能间接影响执行权？应该如何隔离？

### 需要的答案

- 租约持有者失效的判定标准应该是什么（心跳超时是否足够？是否需要服务端 ping/pong？）
- 只读页面是否允许打开聊天？如果允许，`chatOpen` 应该属于会话还是执行端？
- 浏览器端接管后，是否需要重新拉取权威状态（任务、账本、物品）再允许发送？

## 2. 重复的公开文本

计划下发的 `speech` 显示一次，review 阶段的 `finish_task.speech` 又显示一次，内容经常相同（例如两次“你好呀。”）。

### 不确定

- 应该由服务端去重（比较与上一条公开文本），还是由模型避免重复？
- 去重时是否要保留“检查后补充信息”的能力（比如实际位移与预期不符时说明）？

## 3. 重连对账的语义

已修复：`state_snapshot { reconciled:true }` 只结束“不是当前连接创建”的任务（`originWs`）。否则刚发出的消息会被立即结束。

### 不确定

- 重连后应该恢复到什么状态？继续任务、标 unknown、还是要求用户确认？
- 对账期间是否允许新的用户消息（是否需要阻塞到对账完成）？
- 服务重启后，持久化里 `phase=unknown` 的任务，前端应该显示什么、允许什么？

## 4. 上下文预算

当前估算方式：`chars * 0.6`，历史预算 1200 tokens，超出丢弃最旧消息，返回 `droppedMessages` 和估算方式。

### 不确定

- 这个估算与截断策略是否可接受？是否需要真正的 tokenizer（tiktoken/DeepSeek tokenizer）？
- 系统提示词本身约 1000+ tokens，加上能力说明和快照，预算应如何分配？
- 丢弃历史时，是否必须保留“当前用户目标”和“执行证据”，即使它们很旧？

## 5. 记忆

已实现：`validateProposals` 白名单（nickname/style/interest）、要求来源消息 ID、最多 2 条、写为 `candidate` 入存储。

### 不确定

- candidate 由谁确认？当前没有 UI，是否应该先只存不确认，等 UI 再做？
- “明确说记住”是否可以直接 confirmed？如何判断来源可靠？
- 删除记忆时，是否需要清理派生摘要？现在没有摘要，是否需要预留结构？
- 多会话/多浏览器共享同一角色时，记忆的 ownerScope 如何定义？

## 6. 聊天关闭守卫

已实现：服务端要求 `chat_opened` 后才能 `user_message`，否则 `CHAT_CLOSED`。

### 不确定

- 页面刷新后 `chatOpen` 是否应重置为 closed？（当前服务端是全局布尔，刷新不会发 closed）
- 超时自动关闭聊天时，客户端会发 `chat_closed` 吗？目前 `close()` 只在手动关闭按钮里调用；超时路径没有调用 `client.setChatOpen(false)`。
- 两个页面都打开聊天时，`chatOpen` 是全局的，会互相覆盖，怎么处理？

## 7. 持久化

当前：`data/brain-state.json`（原子写 + 防抖），保存 history / ledger / session phase / memories；位置与朝向单独 `data/state.json`。

### 不确定

- 是否现在就迁移到 SQLite？方案推荐 SQLite，但当前 JSON 能满足单进程运行。
- 30 天保留策略、未完成任务证据不清理，如何在 JSON 结构里表达？
- 服务重启后 `unknown` 任务是否需要保留账本供对账，还是允许清理？

## 8. 钢盆 v2 的启动条件

方案要求生产启用拾取/投掷前必须具备可靠 Coordinator、真实执行结果、任务代际、租约、账本、能力注册表。当前缺口：

- Coordinator 仍是 main.ts 内的 `runOwned`，不是独立模块
- 租约在真实浏览器上不稳定（见 §1）
- 物品/事件协议、完整快照未实现

### 不确定

- 是否允许先做“离线资产 + 独立物理沙盒页”，不接生产？
- 沙盒页是否可以使用生产 8090 端口下的独立路径（如 `/sandbox.html`），还是必须独立进程？
- 动画制作（pickup/hold/throw/wear/unwear）需要 Blender，是否应由模型侧完成后再接入？

## 9. 测试方法

无头浏览器测试会互相抢租约，导致结果不稳定（多次 readOnly）。

### 需要的答案

- 端到端测试应如何隔离租约？（每次测试用独立服务进程与端口？测试专用 header 关闭租约？）
- 是否接受“服务端集成测试 + 单次人工浏览器验收”的组合，而不是每次自动化跑浏览器？

## 10. 本人判断（供参考）

- §1 是当前唯一真正的阻塞；其余都是设计取舍
- §6 的超时未发 `chat_closed` 是一个明确的遗漏，需要修
- §8 建议先做离线资产与独立沙盒页，不接生产
