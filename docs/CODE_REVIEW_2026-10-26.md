# 2026-10-26 最新复核

复核基线：`810ebf4a59895927713d9591acfcbb485f8e91dc`，分支 `feat/llm-loop`。服务器工作区干净，whale.service active，systemd 入口仍是 `server/index.mjs`。

结论：**稳定状态的盆恢复有所修复，其他上一轮问题多数仍未解决；另发现 Git 凭据备份和 think 单次动作不结束两个新问题。**

本次没有修改服务器代码、环境或生产数据，没有重启生产服务，没有调用真实 DeepSeek API。后续工作已排入 [今日计划](DAY_PLAN_2026-10-26.md)。

## 新发现

### N1 · P0 · 环境备份带密钥进入 Git

Git 跟踪了 `.env.bak.1792948342`，其中 `DEEPSEEK_API_KEY` 非空。只输出了变量名和是否为空；没有展示或复制值，未确认仓库公开范围。需要轮换旧凭据、移除跟踪并协调清理历史，不能仅删当前文件就宣布处理完成。

还发现仓库根目录有 17 份与 server/tests 对应文件相同的 .mjs 副本，以及 prompts 副本。实际服务使用 server/index.mjs，应清理重复入口并修正同步排除规则。

### N3 · P1 · 新开放的 play(think) 不会自行结束

`server/capabilities.mjs` 新增 think 为可执行上身动作，但 `LayeredMotionPlayer` 对 think 仍使用 LoopRepeat；loco.play 等待 upper 清空，执行器 30 秒兜底超时也不清理循环。

隔离加载实际 GLB 后执行 gesture('think')，连续推进 **40 秒动画时间**，upper 仍是 think，clip.loop=2201（LoopRepeat）。这不是模型推理耗时，属于动作播放语义问题；新增单测只验证字符串合法，未覆盖真实结束条件。

## 上一轮 12 项的复核状态

[上一轮完整 Finding 与源码位置](archive/before-2026-10-26-plan/CODE_REVIEW_2026-10-26_before-refresh.md)。原 ID 保持稳定，方便今天逐项关闭。

| ID | 复核结果 | 当前证据/下一步 |
| --- | --- | --- |
| R1 取消后继续移动 | 未解决，重新复现 | 第一段 turn 时取消，后续 walk 与 final turn 仍执行；报告却为 cancelled |
| R2 租约/只读门禁 | 未解决，重新复现 | 8.2 秒过期后仍接受结果；隔离只读页仍会转身并打开聊天 |
| R3 无证据对账清任务 | 未解决，重新复现 | 只有 reconciled=true 与坐标，unknown 即变 idle，task 被清空 |
| R4 重启 ID 复用 | 未解决，重新复现 | 新任务再次生成 t100-p1-g1，覆盖预置 done 条目 |
| R5 物品恢复 | **部分修复** | 新增 pose/holder 持久化；隔离浏览器戴盆刷新后仍 worn，角色与盆位置保持。但飞行/转移仍被过滤，服务端继续提供旧稳定状态，不能关闭整项 |
| R6 半圈方向误报 | 未解决，重新复现 | ±10°/±170° 起点请求 ±180°，实际完成后仍 ANGLE_MISMATCH |
| R7 预算没有取消执行 | 未解决，重新复现 | 180 秒定时器加速夹具中，回复停止并 idle，但 cancel_plan 数量为 0 |
| R8 第四轮漏审核 | 未解决，重新复现 | 只调用 4 次模型，第 4 份执行结果后没有最终 review |
| R9 证据覆盖/公开文本 | 未解决，重新复现 | done 只剩 reply；空 speech 被补“好了。”；同任务“你好”重复显示 |
| R10 扶正/投掷范围偏离 | 未解决，代码仍在 | 自动扶正仍启用，投掷仍开放 ±180°；未获得新的产品确认 |
| R11 调试预览恢复 | 未解决，重新复现 | 独播退出后 tail_idle 未调度；退出戴盆预览后 resting 物品仍停在头顶 |
| R12 行走方向校验 | 未解决，重新复现 | yaw=0 却向 +X 走同样距离，仍返回 OK |

## R5 的改进与剩余缺口

新增 sanitizeBasin / restore / onBasin，并把 quaternion、holder 和稳定状态写入 state.json。

- 隔离浏览器：角色在 `(1.234,0.567)`，盆 worn/head；刷新后角色坐标不变，盆仍 worn/head，位置约 `(1.190,0.913,0.520)`。
- 为隔离恢复逻辑，夹具直接设置真实 BasinProp 的 worn 状态，并等初始恢复握手完成；没有把这个设置过程冒充整套 UI 动画验收。
- 隔离服务依次上报 worn revision=10、flying revision=11，新 session_state 仍提供旧 worn revision=10。飞行/转移被忽略后，旧姿态会冒充当前状态；刷新仍可能回退成之前拿着或戴着盆。
- 客户端 onBasin/onSnapshot 仍只应用一次；稳定恢复不代表租约切换、重连和中断对账已验收。

## 其他尚未补齐的内容

真实关注事件/落地事件触发 LLM、按阶段重试、原目标与累积证据必保、review 整请求预算、完整快照字段、记忆确认/删除及历史保留、头顶思考显示，都继续在今日计划中。思考模式 API 配置已有实现与历史实测报告，本次没有重新用真实凭据验证。

## 本次验证

- `node --test tests/*.test.mjs`：**80/80 通过**。
- TypeScript 检查、Vite 构建：通过。
- 隔离模型 stub/服务端复现、实际 GLB 骨架与控制逻辑故障注入：完成。
- 隔离 Chrome：稳定 worn 刷新恢复通过；只读页转身缺陷仍复现。
- 没有真实 API、生产交互、跨浏览器或长时稳定性验收。

本轮证据：[review-evidence/810ebf4/README.md](review-evidence/810ebf4/README.md)。原始 ZIP 和当前模型源文件未修改。
