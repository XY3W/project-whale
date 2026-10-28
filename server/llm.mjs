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
 * 思考与最终输出共用接口的输出预算；思考模式使用较长超时。
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
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? (THINKING ? 90_000 : 30_000));

export const thinkingEnabled = () => THINKING;
export const thinkingConfig = () => ({ type: THINKING_TYPE, effort: REASONING_EFFORT });

export const hasKey = () => !!process.env.DEEPSEEK_API_KEY;

/**
 * 条件段落：只有对应游戏在进行时才注入它的规则/玩法。
 *   {{#minesweeper}} ... {{/minesweeper}}
 *   {{#gomoku}} ... {{/gomoku}}
 * 没有对局时只留一句“你会玩什么”，避免每轮都把两套规则塞进上下文。
 */
export function renderSections(text, flags = {}) {
  return text
    .replace(/^[ \t]*\{\{#(mine[Ss]weeper|gomoku)\}\}[ \t]*\n?([\s\S]*?)^[ \t]*\{\{\/\1\}\}[ \t]*\n?/gm, (_, name, body) =>
      flags[name.toLowerCase()] ? body : "",
    )
    .replace(/\n{3,}/g, "\n\n");
}

/** system 提示词：通用规则 + 人格 + 当前对局相关的部分 */
/** 索引预算：100 条技能约 5–6k 字符，超过这个数才截断（正常不会触发） */
const SKILL_INDEX_CHARS = 7000;

/**
 * 技能索引：只列「编号 · 名称 · 什么时候用」，正文不进提示词。
 * 她按需 skill_tool{op:"read"} 取全文。
 */
function skillSection(index = []) {
  if (!index.length) return "";
  const lines = [];
  let used = 0;
  let hidden = 0;
  for (const item of index) {
    const line = `- ${item.id} ${item.title}${item.trigger ? ` · ${item.trigger}` : ""}`;
    if (used + line.length > SKILL_INDEX_CHARS) { hidden += 1; continue; }
    lines.push(line);
    used += line.length;
  }
  const more = hidden ? `\n（还有 ${hidden} 条索引没列出，用 skill_tool {"operation":"list","includeDisabled":true} 查看。）` : "";
  return `【我的经验（技能）】
下面是你自己写的技能索引（只有名称和用途，正文不在提示词里）。觉得用得上就先 skill_tool {"operation":"read","skill_id":"…"} 读正文，下一轮照它做；不需要就直接做事。
${lines.join("\n")}${more}
你也能新建/修改/停用：{"operation":"create"|"revise"|"disable"|"enable", ...}；写完立即生效。
`;
}

export function systemPrompt(flags = {}) {
  const base = renderSections(`${readPrompt("system.txt")}\n\n${readPrompt("persona.txt")}`, flags);
  const section = skillSection(flags.skillIndex ?? []);
  return section ? `${base}\n\n${section}` : base;
}

/** 兼容旧调用：没有对局上下文的静态拼接 */
export const SYSTEM_PROMPT = systemPrompt({});
export const PROMPT_VERSION="prompt-20261027-v4-persistent-chat";

const OUTPUT_CONTRACT = outputContract();


/**
 * 上下文块的统一包装。用函数替换，避免 JSON 里的 `$&`/`$1` 被 String.replace 当成替换语法。
 */
function contextBlock(ctx) {
  return `REQUEST_CONTEXT_JSON:\n${JSON.stringify(ctx)}`;
}

function render(templateName, ctx) {
  const flags = { minesweeper: !!ctx.board, gomoku: !!ctx.gomoku, skillIndex: ctx.skills?.index ?? [] };
  // 索引已经写进 system prompt，就别在上下文 JSON 里再付一遍
  const contextForJson = ctx.skills ? { ...ctx, skills: (({ index, ...rest }) => rest)(ctx.skills) } : ctx;
  const tpl = renderSections(readPrompt(templateName), flags).replace("{{REQUEST_CONTEXT_JSON}}", () => contextBlock({ ...contextForJson, phase: ctx.phase ?? templateName.replace(".txt", "") }));
  return [
    { role: "system", content: systemPrompt(flags) },
    { role: "user", content: tpl + "\n\n" + OUTPUT_CONTRACT },
  ];
}

export function planningMessages(ctx) {
  return render("planning.txt", { ...ctx, phase: "planning" });
}

export function reviewMessages(ctx) {
  return render("review.txt", { ...ctx, phase: "review" });
}

export async function callModel(messages, signal, onReasoning) {
  if (!hasKey()) throw new ModelError("NO_KEY", "服务端未配置 DEEPSEEK_API_KEY", 0);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const abort=()=>ctl.abort();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)ctl.abort();
  let content = "", finishReason = null, usage = null, completed = false;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: MODEL, messages, response_format: { type: "json_object" },
        stream: true, stream_options: { include_usage: true },
        ...(THINKING ? { thinking: { type: THINKING_TYPE }, ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}) } : { temperature: 0.6 }),
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const data = await res.json();
      if (res.status === 401 || res.status === 403) throw new ModelError("AUTH", "API Key 无效或没有权限", res.status);
      if (res.status === 429) throw new ModelError("RATE_LIMIT", "模型限流，请稍后再试", res.status);
      throw new ModelError("API_ERROR", `模型返回 ${res.status}：${JSON.stringify(data).slice(0, 120)}`, res.status);
    }
    if (!res.body) throw new ModelError("EMPTY", "模型未返回数据流", 0);
    const decoder = new TextDecoder();
    let buffer = "";
    const handleEvent = (event) => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) return;
      if (data.trim() === "[DONE]") { completed = true; return; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { throw new ModelError("INVALID_STREAM", "模型数据流格式错误", 0); }
      if (chunk.error) throw new ModelError("API_ERROR", "模型数据流返回错误", 0);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (typeof choice.delta?.reasoning_content === "string" && choice.delta.reasoning_content) onReasoning?.(choice.delta.reasoning_content);
      if (typeof choice.delta?.content === "string") content += choice.delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };
    for await (const bytes of res.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        handleEvent(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
    if (!completed || !finishReason) throw new ModelError("INCOMPLETE_STREAM", "模型数据流中断，请重试", 0);
  } catch (err) {
    if (err instanceof ModelError) throw err;
    if (err.name === "AbortError") throw new ModelError(signal?.aborted ? "CANCELLED" : "TIMEOUT", signal?.aborted ? "模型请求已取消" : "模型请求超时", 0);
    throw new ModelError("NETWORK", `模型连接失败：${err.message}`, 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  if (Number.isFinite(usage?.prompt_tokens)) console.log(`[llm] prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens ?? 'unknown'}`);
  if (THINKING) console.log(`[llm] thinking ${THINKING_TYPE}${REASONING_EFFORT ? `/${REASONING_EFFORT}` : ""} · reasoning_tokens=${usage?.completion_tokens_details?.reasoning_tokens ?? 0}`);
  if (finishReason === "length") throw new ModelError("TRUNCATED", "模型输出被接口截断（思考与 JSON 共用输出预算）", 0);
  if (!content) throw new ModelError("EMPTY", "模型返回空内容", 0);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ModelError("INVALID_JSON", "模型返回的不是合法 JSON", 0);
  }
  return validatePlan(parsed);
}
