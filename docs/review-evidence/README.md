复核基线：93ed3eb。

lease-restart-audit.mjs 是隔离复现脚本，测试故意展示修复前错误，不是期待全部成功的正式回归测试。以服务器仓库为 cwd，通过 Node 标准输入运行（node --input-type=module），这样 ws 从仓库依赖解析。脚本创建随机端口/临时目录、清空子进程模型 Key、清理子进程，不要把地址改为生产服务。结果见 results-93ed3eb.txt。
