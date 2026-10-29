# 55220a4 复核证据

本目录不包含密钥、生产数据或真实模型请求。源码来自服务器git archive的只读快照，未带.env。

- tests-final.log：110/110通过；tsc.log为空表示成功；build.log记录构建及大chunk提示。
- server-audit：8项旧问题重新隔离复测，假模型只监听本机随机端口；180s预算测试只在子进程用定时器夹具压为1400ms。
- new-audit：无任务/无勺dig、实例重发/错误关联、手动暂停被覆盖、并行通道/方向/短步边界。
- layer-audit：实际角色GLB，移除图像材质以便Node读取，保留骨骼/动画；dig持物层数值对比、think循环。
- observer-audit：实际BrainClient类，模拟WebSocket消息，确认game:null未分发。不属于真实浏览器验收。

脚本需要在同版源码根目录运行（其相对导入依赖server/src），不是独立可执行素材。环境依赖复用本地validation_toolchain。新审查脚本输出到源码根目录的上一级；不在服务器生产目录运行。

只读源码快照：[source](/Users/qiaonan/Documents/Codex/2026-10-22/mac-codex-mac-codex-kipfel-zip/outputs/review_55220a4/source)。原始测试缺依赖的中间日志留在工作输出目录，不作为最终测试结果。

服务器public和dist中以下四件与本地交付一致：

| 文件 | SHA256 |
| --- | --- |
| character_minesweeper.glb | 5c1a21db8aa6af718e9af68179b01d491d5f74d3553dbd5072497fd0e66191b8 |
| rice_scoop_straight_v3.glb | 59a49b02f5302ca6be3b2e9156909909be94219dbebb59d57306e70950358655 |
| catalog.json | 4a7caa55a769521b26e6b15c53097534712570b7b2188533927b5cf801676cae |
| prop_motion.json | 1263f4eea895f90879e27e922474878bdb7af8b4e52023cf8d0088cf5b7668e8 |

没有重做生产页面视觉/真实API/双客户端/长时压力验证；过去开发报告中的浏览器结果属于开发方历史证据。
