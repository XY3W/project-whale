# 基础设施备忘

> 这份文件用于跨会话保留环境事实。每次涉及部署时先看这里。

## homeserver

| 项 | 值 |
|---|---|
| IP | `192.168.0.100`（内网） |
| SSH | 已验证：`ssh xy3w@192.168.0.100`（密钥 `~/.ssh/id_ed25519`），别名 `ssh homeserver` |
| 系统 | openSUSE Tumbleweed，x86_64 |
| Docker | 29.4.0-ce，Compose 5.1.4 |
| 部署方式 | Docker（用户确认可用） |
| 访问范围 | 仅内网 |
| 8080 | **已被占用**：TowerChart/1.0，Python 3.11.15 |
| 80 / 443 | 关闭 |
| 本项目端口 | **8090**（已验证空闲） |

## 本机（开发）

- macOS，Node v26（系统）/ v24（DSH 运行时）
- 包管理：pnpm（DSH 运行时路径）
- Blender 5.2.2 LTS：`/Applications/Blender.app/Contents/MacOS/Blender`
- Chrome：`/Applications/Google Chrome.app`

## 验证工具

- `scripts/shoot.mjs`：无头 Chrome 连拍 + 控制台捕获
  - `node scripts/shoot.mjs <url> <plan.json>`
  - plan 里可设 `deviceScaleFactor`（Retina 用 2）
- `scripts/build_glb.py`：FBX → GLB
- `scripts/inspect_fbx.py` / `build_glb.py`：骨架与动画检查

## 已确认

- 可通过 SSH 直接部署，无需你手动执行命令
- 端口 8090 空闲，可直接使用
- 不触碰 8080 上的 TowerChart

## 待确认

- 无（部署相关）

## 排错记录

- **v7 姿态套用后手臂塌陷**：局部 TRS 分解时用了父骨的静止矩阵，导致父级旋转被计算两次。
  必须用父骨的当前姿态矩阵。用“静止姿态（T-pose）对比”可快速隔离：静止正常 → 问题在姿态应用，不在导出/权重。
  修复后 4 个地标骨（head/hand.l/hand.r/WhaleTail_06）世界坐标与 Blender 换算值完全一致。
- `scripts/shoot.mjs` 的就绪条件已支持 `plan.waitExpr`，验证非主应用的页面（如 lab.html）时必设，否则会白等 60 秒。
