/**
 * DeepSeek 适配器（M4）。
 * 固定 system 来自 llm-design/SYSTEM_PROMPT.md；请求上下文每次由宿主生成。
 * 只接受结构化 JSON；校验失败返回具体错误码，不伪造回复。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_VERSION, CAPABILITIES, ModelError, outputContract, validatePlan } from "./capabilities.mjs";

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const readPrompt = (name) => fs.readFileSync(path.join(PROMPT_DIR, name), "utf8");

export { CAPABILITY_VERSION, CAPABILITIES };
export { ModelError };
export { describeCapabilities, describeDisabled } from "./capabilities.mjs";

const API = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
/**
 * 思考模式开关。默认关闭：决策只需要结构化 JSON，开思考主要增加延迟与 token。
 * 打开方式：.env 里加 DEEPSEEK_THINKING=1（或 DEEPSEEK_MODEL=deepseek-reasoner）。
 * 思考 token 计入 max_tokens，所以打开时同步提高上限与超时。
 */
const THINKING = /^(1|true|on|yes)$/i.test(process.env.DEEPSEEK_THINKING ?? "");
const MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS ?? (THINKING ? 2400 : 800));
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? (THINKING ? 90_000 : 30_000));

export const thinkingEnabled = () => THINKING;

export const hasKey = () => !!process.env.DEEPSEEK_API_KEY;

export const SYSTEM_PROMPT = readPrompt("system.txt");

const OUTPUT_CONTRACT = outputContract();


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
      body: JSON.stringify({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
        max_tokens: MAX_TOKENS,
        // 思考模式下 temperature 不生效，部分模型还会报参数冲突，就不传了
        ...(THINKING ? { thinking: { type: "enabled" } } : { temperature: 0.6 }),
      }),
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
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (THINKING) {
    const reasoning = choice?.message?.reasoning_content;
    const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    console.log(`[llm] thinking on · reasoning_tokens=${reasoningTokens} · ${String(reasoning ?? "").slice(0, 80).replace(/\s+/g, " ")}`);
  }
  if (typeof content !== "string") throw new ModelError("EMPTY", "模型返回空内容", 0);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ModelError("INVALID_JSON", "模型返回的不是合法 JSON", 0);
  }
  return validatePlan(parsed);
}
