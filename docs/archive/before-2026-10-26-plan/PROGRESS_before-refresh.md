# 开发进度与服务器现状

> 交接文档，用于下一阶段规划。日期：2026-10-24
> 相关文档：[DESIGN.md](../../DESIGN.md)（方向与架构）、[ANIMATION_SPEC.md](../../ANIMATION_SPEC.md)（动作规格）、[INFRA.md](../../INFRA.md)（服务器环境）

---

## 1. 目标与方向

做一个 DeepSeek 鲸鱼娘 3D 桌宠。核心方向在 2026-10-24 调整为：

**预生成动画 + LLM 选择 + 分层叠加。**

不再由代码实时求解骨骼，LLM 只从动作库中选择“现在做什么”，动作质量由美术保证。

一期范围：单角色、固定场地、固定相机（可旋转缩放）、8–10 个动作、点击移动与互动、气泡说话、内网部署。

---

## 2. 当前可用状态

浏览器打开 **http://192.168.0.100:8090** 即可看到。

| 能力 | 状态 |
|---|---|
| V9 模型加载（83 骨烘焙骨架，16 个分层片段） | ✅ |
| 待机 / 慢走 / 起步 / 收步 | ✅ |
| 挥手 / 注意 / 点头 / 左看 / 右看 / 思考 | ✅ |
| 大小摆尾（独立层） | ✅ |
| 点击地面移动（世界位移只来自片段） | ✅ |
| 平滑转身（先停稳，再缓入缓出转向，再起步） | ✅ |
| 固定场地 8×8 米，0.5 米网格 | ✅ |
| 相机：透视 32°，整场完整入画，可旋转 + 滚轮缩放 | ✅ |
| 阴影（覆盖全场，主光偏侧） | ✅ |
| 跑步 / 坐下 / 跳跃 / 转弯片段 | ❌ 未制作 |
| 眨眼 / 表情 | ❌ 形态键损坏，禁用 |
| LLM 接入 | ❌ 未开始 |
| 服务端大脑 | ❌ 未开始 |

---

## 3. 运行端实现

```
src/
├── main.ts                      入口：加载 V9、场景、移动/转身状态机、输入、HUD
├── core/Stage.ts                渲染器、透视相机、场地、灯光与阴影
├── character/
│   ├── LayeredMotionPlayer.ts   分层播放（base/upper/tail）、手势过渡、慢走起停
│   ├── multiWeight.ts           完整蒙皮权重、法线、切线、阴影材质
│   ├── Character.ts             V4 旧模型（仅 lab 调试页使用）
│   └── V8Character.ts           V8 静态模型（旧方案，主场景不再引用）
├── brain/Director.ts            旧规则导演（主场景已停用）
└── ui/Hud.ts                    HUD 与按钮
```

### 3.1 移动与转身状态机

`main.ts` 内部维护四个阶段：

```
idle ⇄ walking
  ↑        ↓
turning ← stopping
```

- 点击地面 → `requestMove`：走路中先 `setWalking(false)` 进入 `stopping`
- `stopping` 会等待 `walk_stop` 收步完成（`base === 'idle_stand'`）
- `idle` 计算朝向差，超过 0.09 rad 进入 `turning`
- `turning` 用 smoothstep 插值根节点朝向，时长 `0.3 + |Δθ| * 0.45`，上限 1.15 秒
- 转向期间不推进位移；转完再 `setWalking(true)`

实测转向曲线（0 → −2.17 rad，约 1.2 秒）：起步慢、中段快、收尾缓。

### 3.2 场景

- 场地 8×8 米，台座 0.14 米厚，顶面网格 0.5 米一格（16×16）
- 相机：透视 32°，距离按场地外接圆反算（约 23 米），保证整场完整入画
- 轨道控制：可旋转，俯仰限制 0.35–1.25 rad，滚轮缩放 0.55×–1.7×，禁用平移
- 主光：偏侧（3.8, 2.2, 1.9），阴影相机覆盖 ±4.2 米，2048 阴影贴图
- 环境光 0.55、轮廓光 1.6，保证投影对比

### 3.3 输入

- 左键拖动：旋转相机
- 滚轮：缩放
- 点击地面：移动角色
- 点击角色：触发 `notice`
- 拖动与点击用 6 像素阈值 + 400ms 分流，避免误触

---

## 4. 资产

### 4.1 V9 动作库（当前使用）

路径：`public/models/animation-v9/`

| 文件 | 说明 |
|---|---|
| `character_v9.glb` | 34 MB，83 骨烘焙骨架，身体 + 尾巴两个网格 |
| `catalog.json` | 动作元数据（层、时长、循环、可打断、冷却） |
| `tracks.json` | 节点与属性归属 |
| `manifest.json` | 版本与 SHA-256 |

16 个播放片段：`idle_stand`、`walk_start/walk/walk_stop`（各拆 lower/upperBase）、`greet`、`notice`、`nod`、`look_left`、`look_right`、`think`、`tail_idle`、`tail_swish`。

### 4.2 旧资产（保留但主场景不再加载）

- `public/models/character.glb`：V4 旧模型
- `public/models/dev/v8-provisional/`、`public/models/dev/v8-attachment-provisional/`、`public/models/dev/v7-provisional/`：历史中间产物
- `public/models/dev/motion_samples.glb`、`motions_v8.glb`：V4 动作与失败的重定向结果

---

## 5. 验证状态

| 检查 | 结果 |
|---|---|
| `pnpm build` | 通过 |
| `node scripts/animation-v9/validate-runtime.mjs` | 通过，支撑脚滑移 1.7e-5 米量级 |
| 蒙皮权重归一 | 三组身体材质误差 < 2e-7 |
| 浏览器加载 | 4 个网格，`idle_stand`，无控制台错误 |

未做：跨浏览器测试、长时间运行稳定性、内存与显存占用统计。

---

## 6. 服务器现状

| 项 | 值 |
|---|---|
| 地址 | `192.168.0.100`（内网） |
| 用户 | `xy3w`（SSH 密钥登录） |
| 系统 | openSUSE Tumbleweed |
| Node | v26.8.2 |
| pnpm | 9.15.9（全局安装） |
| 项目路径 | `~/whale-app` |
| 进程 | `screen` 会话 `whale` |
| 端口 | 8090（Vite dev server，`--host 0.0.0.0`） |
| 日志 | `~/whale.log` |
| 防火墙 | 8090/tcp 已永久放行 |

### 6.1 常用命令

```bash
# 看日志
tail -f ~/whale.log

# 查看/进入会话
screen -ls
screen -r whale

# 重启
screen -S whale -X quit
screen -dmS whale bash -lc "cd ~/whale-app && pnpm dev --host 0.0.0.0 --port 8090 --strictPort > ~/whale.log 2>&1"

# 同步本地改动到服务器
rsync -az --exclude node_modules --exclude dist --exclude assets \
  ./ xy3w@192.168.0.100:~/whale-app/
```

### 6.2 环境说明

- **Docker 不可用**：该服务器无法访问 Docker Hub（拉镜像超时），已放弃容器方案，改为原生 Node + screen
- 旧的 `~/whale/` 目录是早期 Docker 尝试的残留，可以删除
- `pnpm-workspace.yaml` 中补了 `packages: ["."]`，以兼容 pnpm 9
- 项目未接入 systemd，重启机器后需要手动拉起（后续可做 systemd 服务）

---

## 7. 已知问题与限制

1. **脸部形态键损坏**：眨眼、表情全部禁用，需要模型侧重做
2. **无转身片段**：转身是根节点旋转，脚底有轻微滑动
3. **动作库不含跑步、坐下、跳跃**：移动只有慢走一种速度
4. **角色相对场地偏小**：8×8 场地 + 1.1 米角色，需要滚轮放大看细节
5. **LLM 未接入**：目前所有动作由鼠标或 HUD 触发
6. **无持久化**：刷新页面状态重置
7. **观察模式未实现**：设计中的“禁止自动转身”尚不存在

---

## 8. 下一阶段待规划（交给 GPT）

### 8.1 大脑接入

- DeepSeek API 由服务端代理（Key 不进浏览器）
- 工具接口：`list_actions` / `play` / `move_to` / `say` / `stop`
- 动作选择策略：什么情况下选哪个动作、冷却、打断优先级
- 会话记忆：短期上下文、情绪状态

### 8.2 动作扩展

- 跑步、坐下、跳跃、转身片段
- 表情与眨眼（依赖形态键修复）
- 是否需要“动作组合包”而非单一动作

### 8.3 运行端

- 观察模式（相机与交互分离，禁止自动转身）
- 气泡 UI（文本、位置、生命周期）
- 状态持久化（位置、情绪、时间）

### 8.4 部署

- systemd 服务化，开机自启
- 反向代理与访问控制（内网）
- 资源缓存与首屏优化（34 MB 模型）

---

## 9. 本地开发环境（备用）

- macOS，Node 由 DSH 运行时提供
- `pnpm dev` 默认 5178 端口
- 本地改动通过 rsync 同步到服务器，或直接在服务器上编辑
