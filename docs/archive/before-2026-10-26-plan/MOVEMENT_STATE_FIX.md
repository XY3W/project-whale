# 定位与移动对不上：排查与修复

2026-10-26 · 现象来自一段聊天记录：模型反复说“执行报告和快照对不上”“直走只走了 1.64 米就停住”“快照仍写 yaw=0、坐标还是起点”。

两个独立的 bug 叠在一起。

## Bug 1：模型看到的是任务开始前的坐标

服务端把 `character`（x/z/yaw）放在 `session_state` 和每轮请求的 `characterState` 里。它只在一处被更新：客户端发来的 `state_snapshot`。而客户端只在

```ts
stateApplied && now - lastReport > 2000 && !player.state.walking && phase === "idle" && !taskActive
```

同时成立时才发。也就是“空闲、不在任务里、停稳 2 秒”——一旦开始任务就再也不发。于是从任务开始到任务结束，服务端的 `character` 一直是任务开始前的值：`yaw=0`、起点坐标。

模型这一轮同时拿到旧 `characterState` 和新 `clientSnapshot`，两者冲突，它只能自己挑一个信，于是出现了“x=3.394、z=0.496，朝向 yaw=0”这种自相矛盾的描述。

修复：

- `plan_result` 现在带 `snapshot`（执行完之后的真实位姿）。
- 服务端新增 `applyClientSnapshot()`，在两条路径上刷新 `character` 后再组上下文：`user_message`（规划前）和 `plan_result`（审核前）。
- 审核上下文补上 `clientSnapshot`。
- 转向结束后把 `root.rotation.y` 归一化到 (-π, π]，避免累计转向出现 400° 这类数值。

验证：`scripts/server-snapshot-smoke.mjs` 起一个本地服务端，发 `user_message` 带 (1.5, -0.4, 45°)，再读 `session_state`，`character` 确实变成 (1.5, -0.4, 45)。

## Bug 2：超过约 1.5 米的行走会被 15 秒墙钟超时截断

`loco.walk` 里写的是：

```ts
await waitFor(() => !player.state.walking && player.state.base === "idle_stand"); // timeoutMs 默认 15000
```

而 1.89 米需要 0.8 + 10×1.6 + 0.8 = **17.6 秒的动画时间**。动画按帧推进，60 fps 下就要 17.6 秒墙钟，超时必然先触发：

- 15 秒时 `waitFor` 提前 resolve，执行器量到 0.1125 × 14.6 ≈ **1.64 米**，报 `DISPLACEMENT_MISMATCH`；
- 角色并没有停，继续走；下一轮计划接管时被 `setWalking(false)` 掐断——用户看到的就是“走一半停住”。

低帧率下更糟：dt 被 clamp 到 0.05，3 fps 时 17.6 秒动画要跑约 110 秒墙钟，任何固定超时都必错。

修复：新增 `ProgressMonitor`（`src/behavior/progress.ts`），把等待从“墙钟多久”改成“还在不在动”：

- 走路：进展 = 已走距离；连续 8 秒没有进展才判定卡住；
- 转向：进展 = |yaw 变化|，4 秒没有进展判定卡住；
- 卡住时 promise reject，执行器按 `TIMEOUT` 汇报并带上已走的实际距离，不再是“位移不符”这种误导性结论。
- 执行器里 walk/turn/play 的墙钟预算提高到 60 s / 60 s / 30 s（只做兜底，真正判定在 locomotion）；
- `waitBodySettled` 4 s → 30 s（收步也是按帧推进的）。

验证：3 fps 的 headless 浏览器里跑 1.17 米，**76.4 秒**墙钟后成功，`actual.distance_m = 1.17`、坐标精确落在 (0, 1.17)；同样的场景在修复前 15 秒就会失败。

## 复验：报告与快照一致性

同一次运行里先转 -81.675°、再走 0.45 米：

```
turn  endState {x:0, z:0, yawDeg:-81.675}
walk  endState {x:-0.445, z:0.065, yawDeg:-81.675}
whale 实时快照 {x:-0.445, z:0.065, yawDeg:-81.675}
```

三处完全一致——模型再问“我现在在哪”，宿主给的答案就是它实际站的位置。

## 仍然存在的限制

- 走路速度是 0.1125 m/s（动画本身就这么慢），1.89 米要走 17.6 秒。现在汇报是准的，但“走很久”是资产本身的节奏，不是 bug。
- 后台标签页里 rAF 暂停，动画不走；进度看门狗会在 8 秒无进展后判定卡住。这是有意的：与其无限等，不如如实报错。
