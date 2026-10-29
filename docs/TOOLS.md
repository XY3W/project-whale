# 工具协议迁移（模型驱动）

> 状态：已完成 ①–⑤，生产已切到 `LLM_PROTOCOL=tools`（2026-10-29 01:48）。
> 回退：删掉 `.env` 里的 `LLM_PROTOCOL=tools` 并重启服务，即回到旧的 JSON 信封。

## 为什么

原来每轮重建 `[system, user]` 两条消息、把整份上下文重发一遍，一次动作要两次模型调用
（planning + review），输入 token 付两遍以上。改成原生 tool calling 后一条任务是一段
**追加式 transcript**，前缀稳定、能吃到上下文缓存，一次动作也只多一轮"结果回灌"。

## 结构

```
system（人格 + 规则 + 技能索引）      ← 稳定，可缓存
user（任务上下文 JSON + 工具摘要）     ← 每个任务一次
assistant(tool_calls: run_plan …)     ← 模型决定
tool(result JSON, 含最新世界快照)      ← 客户端执行结果
assistant(tool_calls: finish …)       ← 结束
```

- `server/tools.mjs`：从 `CAPABILITIES` **自动生成** JSON Schema（19 种动作变体），
  外加 `skill` / `timer` / `finish` 三个工具。动作参数的事实来源只有能力表。
- `server/llm.mjs`：`LLM_PROTOCOL=json|tools`；tools 模式发 `tools` + `tool_choice:"auto"`，
  解析流式 `tool_calls` 增量（`mergeToolDelta` / `finalizeToolCalls`），返回 `{mode, content, calls}`。
- `server/index.mjs`：`runToolLoop()` 驱动，最多 6 轮；`run_plan` 复用原来的派发路径，
  用 `task.pending` 这个 Promise 等 `plan_result`，结果作为 `tool` 消息回灌。

## 三个关键决定

| 决定 | 原因 |
|---|---|
| 动作仍是**复合** `run_plan(steps)`，不拆成单步工具 | 一次挖格子 = turn+walk+adjust+dig；拆开就是 4 次往返，单步从 20 秒变一分多钟 |
| 校验失败/参数非法 → **工具错误文本** | 模型当轮就能改，不会像以前那样把任务终止或重新规划 |
| 工具结果里带**最新世界快照** | transcript 只追加，不重发上下文；棋盘变化必须随结果回灌 |

## 压缩

transcript 超过 40k 字符时，把较早的 `tool` 结果换成 300 字预览（system、首条 user、
最近 4 条不动）。避免长任务把上下文越滚越大。

## 沙箱（`skill.kind:"script"`）

- `server/sandbox.mjs`：QuickJS 编译到 wasm，**只注入** `emit` / `log`；
  `require` / `process` / `fetch` / `Buffer` / `setTimeout` 全部不存在，读不到 `.env`、发不出请求。
- 上限：CPU 300ms（死循环会被中断）、内存 32MB、日志 20 条、返回值 4KB、源码 4000 字。
- 技能：`kind:"text"`（默认）或 `kind:"script"`（≤3000 字），用 `skill {operation:"run", skill_id, input}`
  执行；索引里标 `[脚本]`；管理界面可新建/查看。
- 脚本约定：`input` 读入参，`emit(value)` 给返回值，`log(...)` 记日志。

## 验证记录

| 项 | 结果 |
|---|---|
| 真实 API + thinking + tools | 通过（模型正确返回 `run_plan: turn 180 → turn 180 → play nod`） |
| 浏览器端到端（真实模型） | 通过：18 秒两轮，`[plan] steps=turn,play` → `finish:completed`，yaw 转了 162.5° |
| 生产写技能 | 通过：`[skill] create sk_8iwrxs 转身点头`，聊天出现「技能 +1」（随后我关掉探针页面，任务按 CANCELLED 收尾） |
| 缓存前缀 | 第二次请求的 system 段与第一次**完全相同**（6930 字），只追加 assistant/tool |
| 沙箱隔离 | 10 条测试：无宿主全局、死循环中断、内存上限、输出上限、日志上限、语法错误 |

## 开关与回退

```bash
# 开
echo "LLM_PROTOCOL=tools" >> /home/xy3w/whale-app/.env && systemctl restart whale
# 关（回到 JSON 信封）
sed -i '/^LLM_PROTOCOL=/d' /home/xy3w/whale-app/.env && systemctl restart whale
```

## 已知限制

- 每轮动作仍然是"一次工具调用 = 一套动作"，模型在一个任务里最多 6 轮；
- transcript 里的世界快照是**派发那一刻**的，模型看不到更细的实时变化；
- 沙箱没有 `Date`/随机数以外的环境，脚本只能做纯计算；
- 错误以工具文本回灌，模型可能反复重试同一个坏参数（有 6 轮上限兜底）。
