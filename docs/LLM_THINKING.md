# 思考模式与思考强度

2026-10-26 · DeepSeek API 实测（`deepseek-chat`，服务器上的真实 key）

## 开关与档位

请求体里两个字段，都是枚举，传错值会 422 并直接把可选值列出来：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `thinking.type` | `enabled` / `adaptive` / `disabled` | 是否推理；`adaptive` 由服务端自己决定 |
| `reasoning_effort` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `ultra` / `max` | 思考强度，共 8 档 |

`thinking.type` 传 `bogus` 时服务端返回：

```
422 thinking.type: unknown variant `bogus`, expected one of `adaptive`, `enabled`, `disabled`
```

`reasoning_effort` 传 `bogus` 时返回 `expected one of none, minimal, low, medium, high, xhigh, ultra, max`。所以强度是**可调**的。

## 环境变量

```bash
DEEPSEEK_THINKING=1                 # 1/true/on/yes 等同 enabled；也可写 adaptive / disabled
DEEPSEEK_REASONING_EFFORT=minimal   # 8 档之一；不写时默认 minimal
DEEPSEEK_MAX_TOKENS=2400            # 思考 token 计入上限，默认开思考 2400 / 关闭 800
DEEPSEEK_TIMEOUT_MS=90000           # 默认开思考 90s / 关闭 30s
```

`server/llm.mjs` 在开思考时不再传 `temperature`（思考模式下不生效且容易参数冲突），并把推理内容只写日志：

```
[llm] thinking enabled/medium · reasoning_tokens=109 · We need respond execute_plan. ...
```

`reasoning_content` 不会进回复、不会给用户看，只在服务端日志里保留 token 数与 80 字符摘要。

## 实测（真实计划上下文，同样的问题“把盆戴到头上”）

单次结果噪声很大，下面是 3 次的中位数：

| effort | reasoning tokens（中位） | 延迟（中位） | 计划 |
| --- | --- | --- | --- |
| `minimal` | 194 | 2.3 s | walk_to_basin → pickup → wear |
| `low` | 1659 | 10.9 s | 同上 |
| `medium` | 394 | 2.8 s | 同上 |
| `high` | 295 | 2.7 s | 同上 |

结论：档位确实改变思考长度，但**不是单调阶梯**——`low` 在这一类任务上反而想得最多、最慢，`minimal`/`medium`/`high` 都在 2–3 秒。计划质量没有可见差异。

## 当前线上配置

```
DEEPSEEK_THINKING=1
DEEPSEEK_REASONING_EFFORT=minimal
```

代码里的默认值也是 `minimal`（只要开了思考、又没显式设置强度）。要更多推敲就改 `high` / `xhigh`，改完重启服务即可，不需要改代码。

`minimal` 档实测（真实计划上下文，同一问题三次）：

| reasoning tokens | 延迟 | 计划 |
| --- | --- | --- |
| 58 / 12 / 12 | 1.27 s / 0.66 s / 0.68 s | walk_to_basin → pickup → wear |

比不开思考的 ~0.8 秒只多一点点，判断链仍然完整。

## 代价与限制

- 思考 token 按输出计费，`max_tokens` 必须给推理留出空间，否则 JSON 被截断。
- 延迟从 ~1 秒涨到 2–3 秒（`low` 会到 10 秒以上），而任务预算是 180 秒、最多 4 轮。
- `response_format: json_object` 在思考模式下依然有效，实测没有冲突。
