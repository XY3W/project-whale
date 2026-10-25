/**
 * DeepSeek 适配器（M4）。
 * 固定 system 来自 llm-design/SYSTEM_PROMPT.md；请求上下文每次由宿主生成。
 * 只接受结构化 JSON；校验失败返回具体错误码，不伪造回复。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_VERSION, CAPABILITIES, ModelError, validatePlan } from "./capabilities.mjs";

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const readPrompt = (name) => fs.readFileSync(path.join(PROMPT_DIR, name), "utf8");

export { CAPABILITY_VERSION, CAPABILITIES };
export { ModelError };
export { describeCapabilities, describeDisabled } from "./capabilities.mjs";

const API = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const TIMEOUT_MS = 30_000;

export const hasKey = () => !!process.env.DEEPSEEK_API_KEY;

export const SYSTEM_PROMPT = readPrompt("system.txt");

const OUTPUT_CONTRACT = `输出 JSON，二选一：
{"type":"execute_plan","speech":"string","steps":[...]}
{"type":"finish_task","outcome":"completed|cannot_complete|cancelled","speech":"string"}
steps 允许的动作：
{"action":"turn","angle_deg":number}
{"action":"walk","distance_m":0.09+0.18n}
{"action":"play","action_id":"greet|notice|nod|look_left|look_right"}
{"action":"tail","style":"tail_idle|tail_swish","duration_s":number}
{"action":"wait","duration_s":number}
{"action":"parallel","items":[...]}
最多 6 个步骤；只输出 JSON。
可选字段：{"memory_proposals":[{"key":"preferred_name|response_language|response_style|ordinary_interest","value":"string","source_quote":"用户原话片段"}]}
每轮最多 2 条；只记录用户明确表达的称呼、语言、风格偏好或普通兴趣，不要记录敏感信息。`;

function contextBlock(ctx) {
  return `REQUEST_CONTEXT_JSON:\n${JSON.stringify(ctx)}`;
}

export function planningMessages(ctx) {
  const tpl = readPrompt("planning.txt").replace("{{REQUEST_CONTEXT_JSON}}", JSON.stringify({ ...ctx, phase: "planning" }, null, 0));
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: tpl + "\n\n" + OUTPUT_CONTRACT },
  ];
}

export function reviewMessages(ctx) {
  const tpl = readPrompt("review.txt").replace("{{REQUEST_CONTEXT_JSON}}", JSON.stringify({ ...ctx, phase: "review" }, null, 0));
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: tpl + "\n\n" + OUTPUT_CONTRACT },
  ];
}

export async function callModel(messages) {
  if (!hasKey()) throw new ModelError("NO_KEY", "服务端未配置 DEEPSEEK_API_KEY", 0);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, response_format: { type: "json_object" }, temperature: 0.6, max_tokens: 800 }),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new ModelError("TIMEOUT", "模型请求超时", 0);
    throw new ModelError("NETWORK", `模型连接失败：${err.message}`, 0);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new ModelError("AUTH", "API Key 无效或没有权限", res.status);
    if (res.status === 429) throw new ModelError("RATE_LIMIT", "模型限流，请稍后再试", res.status);
    throw new ModelError("API_ERROR", `模型返回 ${res.status}：${text.slice(0, 120)}`, res.status);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ModelError("EMPTY", "模型返回空内容", 0);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ModelError("INVALID_JSON", "模型返回的不是合法 JSON", 0);
  }
  return validatePlan(parsed);
}
