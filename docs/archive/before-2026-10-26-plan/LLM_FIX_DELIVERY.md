# LLM 行为修复交付报告

> 本地报告，不上传服务器、不进入服务器 Git。
> 日期：2026-10-25。基线：`f4bafb9`。当前：`b4a88b0`（分支 `feat/llm-loop`）。

## 1. 总体状态

| 批次 | 内容 | 状态 |
|---|---|---|
| A | 统一调度、取消、漫游门禁 | 已编码；走路中点角色、计划中点角色、连发抢占已实测；**停不下来拒绝接管未测** |
| B | 真实动作结果、超时与停止证据 | 已编码；20 项单测；0.09/0.27/0.45 实测；**1.71/1.89 与 ±180° 未实测** |
| C | 任务代际、执行账本、租约、重连对账 | 已编码；租约/代际/去重/持久化/重启对账；**双页面竞争、崩溃恢复未实测** |
| D | 能力注册表、提示词、事件协议 | 已编码：注册表驱动校验与输出契约、提示词改为 llm-design 文件、禁用能力带原因；**事件未接真实物品源** |
| E | 历史/记忆、上下文预算、聊天边界 | 部分：历史裁剪、整轮预算、记忆校验与契约字段、聊天守卫、IME；**确认/删除 UI、ownerScope 未做** |

本轮只完成了 A、B 两个批次的代码与测试；C–E 未开始，不能用“五批完成”表述。

## 2. 批次 A：调度与门禁

已编码：

- `main.ts` 新增 `runOwned(owner, plan)`：漫游与模型计划共用唯一入口，同一时刻只有一个动作所有者（`none / roaming / plan`）。
- 新计划进入时取消旧执行器、清手势、收步，等待身体停稳后再开始；用 `motionEpoch` 丢弃过期结果，旧计划结果不再回传服务端。
- 任务执行中点击角色：取消旧计划（`executor.cancel()` + epoch 递增），再走聊天入场流程。
- 漫游门禁新增：`errorActive`、`motionOwner === "none"`。
- 模型错误置 `errorActive = true` 并显示图标；发送新消息或收到公开回复才清除。

浏览器实测（生产 8090）：

```
执行计划期间 motionOwner = "plan"
计划结束后 motionOwner = "none"
walk 0.45 → status succeeded, actual 0.45, moved 0.45, stopped true
```

未完成：没有抽出独立 `Coordinator` 类；`main.ts` 仍是主要承载者；`TaskSession`、`SnapshotProvider` 未拆分。

## 3. 批次 B：结果真实性

已编码（`ActionExecutor` / `protocol.ts`）：

- 步骤状态扩展为 `succeeded / failed / cancelled / unsupported / timeout / unknown`。
- 每个动作有独立超时：turn `2000 + |deg|×20` ms、walk `2500+800+n×1600+800` ms、play 6 s、tail `dur+1.5 s`、wait `dur+0.8 s`。
- walk 完成后核对真实位移，误差 > 1 mm 判 `failed / DISPLACEMENT_MISMATCH`，`actual` 记录真实位移。
- turn 完成后核对有符号角度，误差 > 0.5° 判 `failed / ANGLE_MISMATCH`。
- 新增 `signedDeltaDeg`：`-180°` 不再被归一化成 `+180°`，用于方向验证。
- 超时：turn 报 `timeout / TIMEOUT`，walk 报 `unknown / TIMEOUT` 并带部分位移。
- 取消：已完成/部分执行的步骤保留 `actual` 与 `partial` 标记，后续步骤标 `cancelled`。
- `stopped` 由 `loco.isMoving()` 计算，不再固定 `true`。

单测（服务器上执行）：

```bash
node --test tests/executor.test.mjs
# tests 20, pass 20, fail 0
```

覆盖：11 个合法距离、0.5/0.449/字符串数字拒绝、±180 符号、底层不移动但正常返回（必须失败）、转角只完成一半（必须失败）、永不返回（超时）、取消、parallel 冲突、超 6 步。

浏览器实测（真实动画）：

| 请求 | actual | 真实位移 | 状态 |
|---|---|---|---|
| walk 0.45 | 0.45 | 0.45 | succeeded |
| walk 0.09 / 0.27 | 0.09 / 0.27 | 一致 | succeeded |

## 4. 真实 API

- 已配置服务端 `DEEPSEEK_API_KEY`（`.env`，600 权限，已 gitignore），模型 `deepseek-chat`。
- 实测：闲聊返回角色化文本；「跟我挥挥手」返回 `execute_plan(play greet)`，执行后 review 返回收尾语。
- 错误路径（401/429/超时/非法 JSON）代码已分类，但**未做故障注入实测**。

## 5. 未实测与已知限制

- C–E 全部未实现：无 taskId/planId 代际、无持久执行账本、无租约 fencing、无重连对账、无能力注册表、无世界快照协议、无记忆与上下文预算。
- 单页与双页租约：租约逻辑仍处于禁用状态，多标签页仲裁**未实现**。
- 重试按钮：未实现；错误只显示文本与红色图标。
- 聊天关闭后的任务继续：行为依赖服务端任务状态，**未做关闭时的端到端验证**。
- 1.71 / 1.89 米长距离只在单测（模拟 loco）中覆盖，**未做真实动画实测**。
- turn 实测只覆盖 -45°；±180° 的真实动画未测。
- IME composing、后台标签页 2 分钟超时：未实现完整处理，未测。
- 服务端仍使用内存会话；重启后任务丢失（位置/朝向已持久化）。

## 6. 配置项（不含值）

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 模型密钥，仅服务器 `.env` |
| `DEEPSEEK_MODEL` | 默认 `deepseek-chat` |
| `DEEPSEEK_BASE_URL` | 可选，默认官方地址 |
| `BRAIN_PORT` | systemd 中设为 8090 |

## 7. 部署与回滚

- 服务：`whale.service`（systemd），`npm build` 后 `systemctl restart whale`。
- 回滚：`git checkout f4bafb9 -- . && pnpm build && sudo systemctl restart whale`（或 `git revert` 两个提交）。
- 运行数据：`data/state.json`（位置/朝向），已 gitignore。

---

## 追加：C / D 两批进展（2026-10-25 晚）

### C（部分）

- 租约：持有者 + 单调 `leaseEpoch` + 心跳 5s / 到期 8s；新连接只读，旧持有者过期后可接管
- Fencing：`user_message` / `plan_result` 校验 `leaseEpoch` 与 `generation`，旧值拒绝
- 账本：`planId → dispatched/processing/done`；重复结果回放缓存回复，不重复执行
- 修复：重连对账曾把“本连接刚创建的任务”结束掉（日志 `reconciled after reconnect`），已按 `originWs` 区分
- 测试：`tests/server-lease.test.mjs`（1 项，通过）
- **未做**：持久化账本、跨重启对账、双页面实时接管复测

### D（部分）

- `server/capabilities.mjs`：能力注册表成为模型说明、Schema 与执行校验的唯一来源；严格类型（拒绝字符串数字、0.449、嵌套 parallel）
- `server/events.mjs`：关注事件去重（eventId / revision / 30s 冷却）
- 上下文新增 `capabilityVersion`
- 测试：`tests/capabilities.test.mjs`（7 项，通过）
- 合计：28 项测试全部通过
- **未做**：完整世界快照字段与 revision 推进、物品协议与真实事件源

### 浏览器实测

- 租约被占用时新页面只读，8 秒后自动接管（`leaseEpoch` 1→2）
- 接管后真实模型对话正常：`你好` → `你好呀。` → `你好呀，有什么想做的吗？`
- 仍存在“计划 speech + review speech”两条相似消息的问题，未去重

### 仍未做

E（记忆、上下文预算、聊天边界）、钢盆 v2 全部内容。

---

## 追加：浏览器仲裁实测（隔离服务，2026-10-25 晚）

测试环境：独立服务进程（端口 8117，/tmp 临时目录，无 API Key → FakeBrain），独立无头浏览器经 SSH 隧道访问，不接触生产 8090。

| 场景 | 结果 |
|---|---|
| 计划执行中（greet）点击角色 | `owner=plan → none`，聊天打开，旧计划未继续，只有计划台词无完成回复 |
| 走路中点击角色 | `walking=true → owner=none, chat=true`，行走被取消，聊天打开 |
| 计划中连发两条消息 | 旧计划取消，旧结果丢弃，最终只有一条 `做好了（1 个动作）。` |

发现并修复：点击取消计划后 `motionOwner` 残留为 `plan`，漫游永久不恢复（提交 `b4a88b0`，已复测通过）。

未覆盖：停不下来时拒绝接管、真实模型下的抢占、多页面租约竞争。

---

## 追加：A/B 浏览器实测（隔离服务，2026-10-25 晚）

| 场景 | 结果 |
|---|---|
| 计划执行中点击角色 | owner: plan → none；聊天打开；旧计划不再继续 |
| 走路中点击角色 | walking: true → owner none、chat 打开 |
| 计划中连发两条消息 | 旧结果丢弃，只有一条完成回复 |

修复：点击取消计划后 owner 残留（`b4a88b0`）。

未测：停不下来时拒绝接管（需故障注入）、1.71/1.89 米、±180°、双页面租约竞争、真实模型下的抢占。
