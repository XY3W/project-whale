# 象棋复核与用户走子唤醒修复

2026-10-31，Codex。DeepSeek修复基线`9b3d5a0`，本地与服务器一致。先完成修复复核；用户随后明确要求直接修复“用户走子后不触发LLM”，并将视角操作改为按住滚轮旋转，因此本批业务改动只处理这两件事，其他缺口仍保留。

## 已确认修复的部分

- 开局执色弹窗、取消不开局、按钮“象棋开局/象棋结束”切换：隔离浏览器实际点击红/黑、取消与结束路径通过。没有操作真实用户棋局。
- 基础场地坐标/上报限制随场地放大；旧局game_id拒绝、无token执行门禁、parallel限制已补。
- 上一轮真实长将反例、和棋重启状态、decisions/history保存恢复：已修并有回归。
- 用户移动棋子的永久悬空、选择取消高度：已修。
- 新请求只在playing时加入详细象棋段，终局裁剪盘面；中文大小写错误已换为ASCII。
- 腰挂holder/服务端槽位正常路径已修，但绑定加载竞态仍见下文。
- DeepSeek基线305项测试与构建通过；下面列出的未关闭问题不会因这些测试通过自动关闭。

## 本批直接修复：用户走子唤醒与相机输入

### 根因与改动

服务器实际处于`autoplay.manualPaused=true`，棋局revision=1、turn=black、characterSide=black，任务idle。此前结束扫雷/五子棋留下硬暂停；象棋开局与用户合法走子没有像其他游戏一样解除它，因而事件入队后无法调度。

- 象棋开局、每一手新的合法用户走子解除旧游戏留下的暂停并持久化。非法步和幂等重发不唤醒。
- 新执行端hello时，若当前轮到角色，为该租约补一次恢复事件；重复hello/只读连接不重复触发。部署或刷新导致内存事件丢失时，也不会永久卡住。
- 开局事件与用户第一手在400ms内合并时，提示词按最新权威轮次生成，不能被旧的“用户先走，请等待”说明覆盖。
- 象棋在场时阻止自动扫雷抢占场地；结束象棋清理旧事件并保留手动停止意图。定时任务最高优先级和现有预算门禁保持不变。
- 相机改为按住鼠标滚轮旋转；左键留给选子/角色交互；滚动滚轮继续缩放，触屏手势不变。非左键pointer事件不参与落子或轻拍，避免误触。

### 验证

- `tests/xiangqi-wakeup.test.mjs`：本地HTTP流式模型桩 + 真实WebSocket/服务端，全程无真实模型费用。JSON与tools两种协议分别走两次用户合法走子，均各唤醒一次；非法步/重发不唤醒；恢复棋局、重复/只读hello、开局与第一手合并均通过。
- `tests/camera-input.test.mjs`：使用真实OrbitControls和内存EventTarget发送拖拽/滚轮事件，左拖相机不动、中键拖拽旋转、滚轮缩放均通过。
- 最终`node --test tests/*.test.mjs`：**310/310通过**；`npm run build`通过。保留既有大chunk提示。

## 仍不能关闭的复核发现

复现脚本：[audit.mjs](review-evidence/xiangqi-9b3d5a0/audit.mjs)，结果：[results.json](review-evidence/xiangqi-9b3d5a0/results.json)。这些是独立的现状复现，不是要求后续版本保留缺陷的生产测试。

1. **P1：释放棋子仍直接跳到目标，不随暂停时钟等待。** `XiangqiBoard.endCarry`生成的target没有pending/from；tick的无from分支下一帧就精确复制目标。真实类复现从手中底高0.32235米，一帧变为目标Y=0。因此新增pausePerformance只停住人物，不能阻止棋子在吃子确认前落进敌子里；取棋0.4秒飞入仍未接，到1.2秒才beginCarry。对应`src/game/XiangqiBoard.ts:348-352,422-430`、`src/main.ts:1179-1196`。
2. **P1：物理墙扩大了，物理地板没扩大。** `BasinPhysics.setArenaHalf`只重建墙，地板仍是half=4时的±5米，11.5米棋盘外圈没有底。真实Rapier复现：x=5.35米处释放小碰撞体，两秒后Y约-17.16米，掉穿可见场地。对应`src/prop/basinPhysics.ts:117-118,148-153`。
3. **P2：腰挂绑定仍存在刷新竞态。** ensureWaist是void异步预取；onBasin只restore一次，不等待绑定。若快照先返回，腰勺恢复成resting/world；之后setWaistTarget只安装矩阵，不重新恢复。真实PropItem复现先restore后装绑定，最终仍holder=null。对应`src/main.ts:1100,1516-1524`和`src/prop/PropItem.ts:512-537`。
4. **P2：事件内暂停不能精确停在事件点。** advancePerformance的while在回调pausePerformance后仍吃掉本帧剩余dt；实际播放器从1.08秒更新0.05秒，在1.1秒暂停事件后停于1.13秒。不能只用“播放前先暂停”的单测证明等待点准确。对应`src/character/LayeredMotionPlayer.ts:565-573`。

原方案仍未实现：棋子障碍/身体裙摆尾巴轮廓导航、到位核验、完整CCA2020棋例、safe_setdown/recover与真实在途阶段恢复、网页认输/协商和棋入口。执行桥仍没有双手空闲的硬校验。UNKNOWN_COMMIT仅看revision增大，未核对gameId/moveId/实际棋步；tools连续会话中的旧条件system也还需跟随游戏切换更新。以上不在本次用户走子唤醒与相机操作修复范围。

结论：开局入口等确有修复；用户走子唤醒和滚轮视角本批已直接处理，不能据此宣称原10组审查问题和全部方案都已完成。
