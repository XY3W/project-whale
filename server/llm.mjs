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
 * 思考模式。DEEPSEEK_THINKING 取 enabled / adaptive / disabled（1|true|on|yes 等同 enabled）。
 * 思考强度用 DEEPSEEK_REASONING_EFFORT 调，默认 minimal；服务端接受的档位：
 * none / minimal / low / medium / high / xhigh / ultra / max。
 * 思考 token 计入 max_tokens，所以打开时同步提高上限与超时。
 */
const THINKING_RAW = (process.env.DEEPSEEK_THINKING ?? "").trim().toLowerCase();
const THINKING_TYPE = ["enabled", "adaptive", "disabled"].includes(THINKING_RAW)
  ? THINKING_RAW
  : /^(1|true|on|yes)$/.test(THINKING_RAW) ? "enabled" : "disabled";
const THINKING = THINKING_TYPE !== "disabled";
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"];
const EFFORT_RAW = (process.env.DEEPSEEK_REASONING_EFFORT ?? "").trim().toLowerCase();
/** 默认强度：minimal。决策输出是结构化 JSON，够用且延迟最低 */
const DEFAULT_EFFORT = "minimal";
const REASONING_EFFORT = EFFORT_LEVELS.includes(EFFORT_RAW) ? EFFORT_RAW : THINKING ? DEFAULT_EFFORT : null;
if (EFFORT_RAW && !REASONING_EFFORT) console.warn(`[llm] 忽略未知的 DEEPSEEK_REASONING_EFFORT=${EFFORT_RAW}`);
/**
 * 思考 token 和 JSON 输出共用 max_tokens。16×16 棋盘上模型有时会思考到 2000+，
 * 2400 的预算会把 JSON 截断成非法输出（表现为 INVALID_JSON），所以默认给到 8000。
 */
const MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS ?? (THINKING ? 8000 : 1200));
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? (THINKING ? 90_000 : 30_000));

export const thinkingEnabled = () => THINKING;
export const thinkingConfig = () => ({ type: THINKING_TYPE, effort: REASONING_EFFORT });

export const hasKey = () => !!process.env.DEEPSEEK_API_KEY;

export const SYSTEM_PROMPT = readPrompt("system.txt") + "\n\n" + readPrompt("persona.txt");
export const PROMPT_VERSION="prompt-20261027-v2";

const OUTPUT_CONTRACT = outputContract();


/**
 * 上下文块的统一包装。用函数替换，避免 JSON 里的 `$&`/`$1` 被 String.replace 当成替换语法。
 */
function contextBlock(ctx) {
  return `REQUEST_CONTEXT_JSON:\n${JSON.stringify(ctx)}`;
}

function render(templateName, ctx) {
  const tpl = readPrompt(templateName).replace("{{REQUEST_CONTEXT_JSON}}", () => contextBlock({ ...ctx, phase: ctx.phase ?? templateName.replace(".txt", "") }));
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: tpl + "\n\n" + OUTPUT_CONTRACT },
  ];
}

export function planningMessages(ctx) {
  return render("planning.txt", { ...ctx, phase: "planning" });
}

export function reviewMessages(ctx) {
  return render("review.txt", { ...ctx, phase: "review" });
}

export async function callModel(messages, signal) {
  if (!hasKey()) throw new ModelError("NO_KEY", "服务端未配置 DEEPSEEK_API_KEY", 0);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const abort=()=>ctl.abort();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)ctl.abort();
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
        ...(THINKING
          ? {
              thinking: { type: THINKING_TYPE },
              ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
            }
          : { temperature: 0.6 }),
      }),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new ModelError("TIMEOUT", "模型请求超时", 0);
    throw new ModelError("NETWORK", `模型连接失败：${err.message}`, 0);
  }
  // Keep the timeout active while reading the response body.
  let data;
  try { data=await res.json(); } finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);}
  if (!res.ok) {
    const text = JSON.stringify(data);
    if (res.status === 401 || res.status === 403) throw new ModelError("AUTH", "API Key 无效或没有权限", res.status);
    if (res.status === 429) throw new ModelError("RATE_LIMIT", "模型限流，请稍后再试", res.status);
    throw new ModelError("API_ERROR", `模型返回 ${res.status}：${text.slice(0, 120)}`, res.status);
  }

  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (THINKING) {

    const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    console.log(
      `[llm] thinking ${THINKING_TYPE}${REASONING_EFFORT ? `/${REASONING_EFFORT}` : ""} · reasoning_tokens=${reasoningTokens}`,
    );
  }
  if (choice?.finish_reason === "length") {
    throw new ModelError("TRUNCATED", `模型输出被 max_tokens=${MAX_TOKENS} 截断（思考与 JSON 共用预算）`, 0);
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
