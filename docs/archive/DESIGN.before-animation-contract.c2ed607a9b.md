# Project Whale · 设计

> v0.6 · 2026-10-24
> 方向：预生成动画 + LLM 选择 + 分层叠加。

## 0. 目标与技术方案

### 0.1 要做什么

一个 DeepSeek 鲸鱼娘 3D 桌宠。它待在一个空场里，可以自由观察、点击移动、说话；
**由 DeepSeek 决定“现在做什么”**——从一套精心制作的动画里挑一个，而不是实时生成动作。

核心价值不在“模型生成动作”，而在：

- **动作质量由美术保证**（预生成片段）
- **性格来自选择**：选什么、什么时候选、说什么
- **可分层**：走路时能挥手，说话时尾巴自己在摆

### 0.2 一期范围

| 做 | 不做 |
|---|---|
| 单个角色（V8 绑定） | 换装、多角色 |
| 一个空场 + 自由相机 | 家具、道具、物理互动 |
| 8–10 个动作片段 | 程序化骨骼控制、IK 抓取 |
| 分层播放（base/upper/tail/gaze） | face 层（等形态键修复） |
| 点击移动 + 点击反应 | 寻路避障 |
| 气泡说话（文本） | TTS / 语音输入 |
| 规则导演 → DeepSeek API | 多轮长记忆 |
| homeserver 内网部署 | 公网、多端同步 |

### 0.3 技术方案

```
资产    Blender（V8 绑定）→ 按层切分轨道的 GLB 片段
运行时  three.js + AnimationMixer
        ├─ catalog   动作目录（id/层/循环/时长/可打断/冷却）
        ├─ player    分层权重、交叉淡出
        ├─ state     idle / moving / acting
        └─ locomotion 位置朝向、速度匹配
大脑    规则导演（先）→ DeepSeek 工具调用（后）
        list_actions / play / move_to / say / stop
部署    Docker on homeserver 192.168.0.100:8090（内网）
```

关键约定：

- 动作按层切分轨道，three.js 天然形成 mask，不写额外遮罩系统
- 移动必须用 `locomotion` 片段；执行器拒绝类型不符
- LLM 只输出动作 id 与少量参数，不接触骨骼

### 0.4 资产依赖

1. V8 动作库（规格见 [ANIMATION_SPEC.md](./ANIMATION_SPEC.md)）
2. 脸部形态键修复（阻塞眨眼与表情）
3. 领结权重修复（可选，影响摇头/抬手观感）

### 0.5 可选：VRM

VRM 是**资产规范**，不是动画方案。它能让动作库跨模型复用、自带表情与弹簧骨，
但动画本身、分层逻辑仍由我们实现。建议运行时稳定后再决定是否迁移；
迁移主要动资产层，不推翻现有运行时。

### 0.6 已确认（2026-10-24）

1. **大脑用 DeepSeek API**，Key 只放服务端，浏览器不接触
2. **一期只出气泡**，不接 TTS
3. **先做网页版**，Tauri 桌面窗后置

## 1. 方向

角色不再由代码逐帧控制骨骼，而是：

**LLM 根据情境选择一个动画片段 → 运行时播放并分层混合。**

这样做的好处：动作质量由美术保证，LLM 只做它擅长的离散选择，
不会出现“参数微调导致的扭曲、滑步、穿模”。

## 2. 架构

```
浏览器
├─ catalog    动画目录（id、层、循环、时长、可打断、冷却）
├─ player     AnimationMixer + 分层权重 + 交叉淡出
├─ state      idle / moving / acting
├─ locomotion 位置与朝向、速度匹配
└─ input      点击、拖动、相机

homeserver（后续）
└─ brain      规则导演 → 未来 DeepSeek；记忆与情绪
```

## 3. 分层

| 层 | 覆盖 | 片段 |
|---|---|---|
| base | 全身（不含尾巴） | idle_stand / walk / run / sit_* |
| upper | 肩臂手头颈 | greet / notice / nod / look_* / think |
| tail | `WhaleTail_01..06` | tail_idle / tail_swish |
| face | 形态键 | blink / 表情（依赖修复） |
| gaze | `head.x` 限幅 | 程序化跟随 |

three.js 只影响片段里有轨道的骨骼，所以分层靠**轨道切分**实现，不需要额外遮罩。

## 4. 状态机

```
idle ──play(locomotion)──▶ moving ──到达/stop──▶ idle
  └──play(gesture)──────▶ acting ──播完──────▶ idle
```

- locomotion 占用移动通道；upper 与 base 在手臂上冲突时 upper 优先
- 一次性动作播完自动回 idle，交叉淡出 0.2–0.3s
- 动作有冷却与可打断标记

## 5. LLM 接口

```
list_actions()                  → 可用动作 + 描述 + 约束
play(action_id, params?)        → 播放
move_to(target, style: walk|run)→ 选 locomotion + 移动
say(text)                       → 气泡
stop()                          → 回 idle
```

移动必须走 `locomotion` 类片段；选错类型执行器拒绝。

## 6. 里程碑

| 里程碑 | 内容 |
|---|---|
| N0 | 动画目录 + 播放器 + 状态机（用手上已有片段联调） |
| N1 | locomotion 移动控制器 + 速度匹配 |
| N2 | LLM 工具接口与动作选择 |
| N3 | 服务端大脑 + 部署 |
| N4 | 气泡与自主行为 |

## 7. 资产依赖

- 绑定：`tail_v8/Character_WhaleTail_Attached_v8.blend`（376 骨）
- 动作交付规格与待解决项：[ANIMATION_SPEC.md](./ANIMATION_SPEC.md)
- **脸部形态键目前损坏**，face 层在修复前禁用

## 8. 部署

homeserver `192.168.0.100`，端口 8090，Docker。详见 [INFRA.md](./INFRA.md)。

## 9. 文档

- [ANIMATION_SPEC.md](./ANIMATION_SPEC.md)：动作清单、轨道切分、验收
- [INFRA.md](./INFRA.md)：服务器与排错记录
