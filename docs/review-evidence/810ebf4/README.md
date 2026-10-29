# 810ebf4 复核证据

2026-10-26。完整代码基线：810ebf4a59895927713d9591acfcbb485f8e91dc。

- tests.log：现有 80 项测试全部通过。tsc.log 为空表示检查通过，build.log 记录构建成功。
- server-audit.json/log：隔离临时数据、独立随机端口与本地模型 stub；不使用生产 Key。预算用例仅将 180000ms 定时器加速为 1400ms，租约实际等待 8.2 秒。
- prop-audit.json/log：读取实际 GLB 的骨架/动作/几何并运行原代码。Node 环境为避免加载图像去掉材质引用，不修改源文件或动画；think 推进 40 秒仍在循环。输出缺陷行为不代表已修复。
- browser-audit.log：隔离 Chrome 与本地临时服务。为隔离恢复逻辑，夹具直接设置真实 BasinProp 为 worn，等恢复握手完成后上报再刷新；不是整套 UI 动画验收。稳定 worn 刷新保持，另复现只读页转身。测试服务已停止。
- Git 环境备份检查只记录变量名与非空布尔值，未复制该文件/值到本地；本目录没有生产凭据或用户聊天记录。

复核源码快照仍在 Codex 工作区 outputs/recheck_2026-10-26_810ebf4/source。清理后它的 node_modules/public 指向 work/validation_toolchain，旧构建目录已删除，可按需重建。不要在本地交接目录重新创建运行工程；代码开发仍在服务器。
