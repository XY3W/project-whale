# LLM 提示词交付包

2026-10-25，本地待评审。供 DeepSeek 在服务器实现时引用，当前未上传服务器、未修改运行代码。

- SYSTEM_PROMPT.md：固定系统提示词，分隔线后的正文可以直接作为 system。
- PLANNING_PROMPT.md：首次规划模板。
- REVIEW_PROMPT.md：执行后检查模板。
- OUTPUT_SCHEMA.json：原基础动作 Schema 模板。
- BASIN_OUTPUT_SCHEMA.json：钢盆阶段扩展模板，增加 pickup/wear/unwear/throw，四种交互动作只允许串行；运行时依据验收后的 enabled 能力注册表生成，不能把模板当已全部上线。
- EXAMPLE_CONTEXT.json：完整请求上下文示例，仅测试数据。
- CONTEXT_MEMORY.md：能力、场景、记忆、存储、预算、隔离与 MCP 接入边界。

占位符 REQUEST_CONTEXT_JSON 必须由程序对上下文对象 JSON.stringify 生成；不使用 eval，不把用户输入拼接为 system 指令。模型供应商的模板/工具调用接口由适配器负责，不改这些业务约定。

新增记忆候选 memory_proposals 为可选字段，不是动作。服务器独立验证，不影响已通过校验的行为执行。
本包是下一阶段方案的一部分，需与 NEXT_PHASE_LLM_PLAN.md 一起阅读；与旧文档“第一版完全不做长期记忆”冲突处，以此处最小偏好记忆设计为准。复杂情绪和长期故事记忆仍不在本轮范围。

2026-10-25 钢盆规则追加：system/planning/review 已同步自主交互决策、必须先走近再拾取、手持与戴头互换、从手中投掷。详见 ../BASIN_INTERACTION_IMPLEMENTATION.md；不新增闲置定时调用。

## 2026-10-27 用户确认的人设与记忆修订

- [PERSONA_V2.md](PERSONA_V2.md)：安静蠢萌的表达正文；替换生产人设段，不覆盖整个行为system。少说话、不过分卖萌，实际推理和动作检查保持准确。
- [PERSONA_TAG_RESEARCH.md](PERSONA_TAG_RESEARCH.md)：网上标签的普通语义、公开注入实现与本项目取舍，不依赖未证实的厂商人格接口。
- [本轮实现方案](../PERSONA_MEMORY_V2_PLAN.md)：来源核验、确认/纠正/删除、实际回喂、ownerScope、会话摘要、累计任务证据与整请求预算。

上方2026-10-25的模板是早期交付记录，不能据其“未上传/未修改”推断当前生产状态。服务器当前已有自己的prompts；本轮只在本地交付修订，生产接入由DeepSeek实施。
