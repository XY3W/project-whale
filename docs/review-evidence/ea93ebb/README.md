# ea93ebb 审查证据

审查报告：../../CODE_REVIEW_2026-10-26.md。
最终提交：ea93ebb9ad430f816ffd59fd8eca8bf0151e8cde，分支 feat/llm-loop。
原始审查快照：/Users/qiaonan/Documents/Codex/2026-10-22/mac-codex-mac-codex-kipfel-zip/outputs/code_review_ea93ebb/source。

- tests-final.log：现有测试 79/79 通过。tsc.log 为空表示 TypeScript 检查通过，build.log 记录构建成功。
- server-audit.json/log：隔离临时目录与随机端口的服务测试，apikey 是仅发送给本地 stub 的占位符，真实模型调用为零。budget 用例只把 180000ms 定时器缩短为 1400ms；租约到期实际等待 8.2 秒。
- prop-audit.json/log：真实角色和钢盆 GLB 的骨骼、事件、物理及控制逻辑复现；为 Node 无 DOM 环境移除图像材质，几何、骨架、动画与运行代码保持原样。此项不是视觉渲染验收。
- browser-audit.log：隔离 Chrome + 隔离服务的刷新与只读页测试。测试直接设置 BasinProp 的 worn 状态来隔离恢复逻辑；没有把这个设置过程冒充 UI 动画验收。测试朝向 1.5rad 是明确的只读页测试夹具。

这些补充脚本用于展示当前缺陷，输出异常行为不表示已修好。不要把服务地址改成生产地址，不要用生产 Key。脚本应复制到待复核仓库根目录，在有同版本依赖与 public/models/basin-v2 的隔离快照中运行：

    node review-server-audit.mjs
    node review-prop-audit.mjs

浏览器脚本由 scripts/probe.mjs 执行，仅连接本地隔离服务；具体测试时使用 18785 端口，结束后已停止。

本目录没有复制生产数据或私钥；没有修改或重启生产服务。
