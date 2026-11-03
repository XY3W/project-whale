/**
 * DeepSeek 适配器（M4）。
 * 固定 system 来自 llm-design/SYSTEM_PROMPT.md；请求上下文每次由宿主生成。
 * 只接受结构化 JSON；校验失败返回具体错误码，不伪造回复。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_VERSION, CAPABILITIES, ModelError, outputContract, validatePlan } from "./capabilities.mjs";
import { toolSummary } from "./tools.mjs";

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const readPrompt = (name) => fs.readFileSync(path.join(PROMPT_DIR, name), "utf8");

export { CAPABILITY_VERSION, CAPABILITIES };
export { ModelError };
export { describeCapabilities, describeDisabled } from "./capabilities.mjs";

const API = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/chat/completions";
// 角色固定使用 Flash；环境变量不能将请求切换到其他计费模型。
const MODEL = "deepseek-flash";
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
 * 输出协议：
 * - json（默认，现状）：模型只输出一个 JSON 对象，宿主逐条校验；
 * - tools：原生 tool calling，消息追加成 transcript，模型自己决定下一步。
 * 迁移期间用环境变量切换，两边行为保持可对比。
 */
export const PROTOCOL = (process.env.LLM_PROTOCOL ?? "json").trim() === "tools" ? "tools" : "json";

/**
 * 条件段落：只有对应游戏在进行时才注入它的规则/玩法。
 *   {{#minesweeper}} ... {{/minesweeper}}
 *   {{#gomoku}} ... {{/gomoku}}
 * 没有对局时只留一句“你会玩什么”，避免每轮都把两套规则塞进上下文。
 */
export function renderSections(text, flags = {}) {
  return text
    .replace(/^[ \t]*\{\{#(mine[Ss]weeper|gomoku|xiangqi|xiangqiended|room)\}\}[ \t]*\n?([\s\S]*?)^[ \t]*\{\{\/\1\}\}[ \t]*\n?/gmi, (_, name, body) =>
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
    const tag = item.kind === "script" ? "[脚本] " : "";
    const line = `- ${item.id} ${tag}${item.title}${item.trigger ? ` · ${item.trigger}` : ""}`;
    if (used + line.length > SKILL_INDEX_CHARS) { hidden += 1; continue; }
    lines.push(line);
    used += line.length;
  }
  const more = hidden ? `\n（还有 ${hidden} 条索引没列出，用 skill_tool {"operation":"list","includeDisabled":true} 查看。）` : "";
  return `【我的经验（技能）】
下面是你自己写的技能索引（只有名称和用途，正文不在提示词里）。觉得用得上就先 skill_tool {"operation":"read","skill_id":"…"} 读正文，下一轮照它做；不需要就直接做事。
${lines.join("\n")}${more}
需要结果就 skill_tool {"operation":"run","skill_id":"…","input":…}（只对 [脚本] 技能有效，在沙箱里跑，读不到文件也上不了网）。
你也能新建/修改/停用：修改前先 read，使用读到的版本号 expected_version 和 edits 局部追加或精确替换，保留其他正确内容；不确定先别删除，写完立即生效。
`;
}

export function systemPrompt(flags = {}) {
  const base = renderSections(`${readPrompt("system.txt")}\n\n${readPrompt("persona.txt")}`, flags);
  const section = skillSection(flags.skillIndex ?? []);
  return section ? `${base}\n\n${section}` : base;
}

/** 兼容旧调用：没有对局上下文的静态拼接 */
export const SYSTEM_PROMPT = systemPrompt({});
export const PROMPT_VERSION="prompt-20261103-v5-cache-order";

const OUTPUT_CONTRACT = outputContract();


/**
 * 上下文块的统一包装。用函数替换，避免 JSON 里的 `$&`/`$1` 被 String.replace 当成替换语法。
 */
/**
 * 详细棋规只在"正在下"的时候注入：终局/收起后保留最小结果做一次总结，
 * 不把整套规则和旧合法着法一直挂在提示词里。
 */
const xiangqiLive = (view) => !!view && view.status === "playing";
/** 棋局还没收摊但已经分出胜负：只注入一小段说明，让模型别继续走子、按棋谱复盘 */
const xiangqiEnded = (view) => !!view && view.status !== "playing";

/** 终局后只留最小结果（谁赢、怎么结束、最后一手），不再给整套盘面与候选着法。
 *  棋谱不在这里：它单独成块，排在快照之前（见 moveHistoryBlock / composeUserContent）。 */
function slimXiangqi(view) {
  if (!view) return view;
  const { moveHistory, ...rest } = view;
  if (rest.status === "playing") return rest;
  const { rows, legalMoves, pieces, slots, currentCell, ...minimal } = rest;
  return minimal;
}

/**
 * 棋谱块：整局棋谱是本局最大的一块，只在末尾追加，旧内容是新一轮的前缀。
 * 它放在"上下文 JSON 之前"：缓存按 token 前缀匹配，棋谱追加不打断前缀，
 * 而盘面快照每走一手都变，所以快照必须排在棋谱之后（见 composeUserContent）。
 */
export const MOVE_HISTORY_HEADER = "XIANGQI_MOVE_HISTORY_JSON:";

export function moveHistoryBlock(view) {
  const history = view?.moveHistory;
  return Array.isArray(history) ? `${MOVE_HISTORY_HEADER}\n${JSON.stringify(history)}` : "";
}

const CONTEXT_MARKER = "REQUEST_CONTEXT_JSON:";

/**
 * user 正文的尾部顺序（稳定 → 易变）：
 *   阶段指令 → 输出契约 / 工具说明 → 棋谱（只追加）→ 本轮上下文 JSON（每轮都变）
 * 这样 system + 指令 + 契约 + 整局棋谱都能命中前缀缓存，只有最后一小段快照需要重算。
 */
function composeUserContent({ instructions, contract, history, context }) {
  return [instructions, contract, history, context]
    .map((part) => (typeof part === "string" ? part.trim() : part))
    .filter(Boolean)
    .join("\n\n");
}

/** 把 user 正文拆成 head（指令/契约）、棋谱块、上下文 JSON 三段。 */
function splitUserContent(content) {
  const ctxAt = content.lastIndexOf(CONTEXT_MARKER);
  if (ctxAt < 0) return null;
  const histAt = content.lastIndexOf(MOVE_HISTORY_HEADER);
  const hasHistory = histAt >= 0 && histAt < ctxAt;
  return {
    head: (hasHistory ? content.slice(0, histAt) : content.slice(0, ctxAt)).replace(/\s+$/, ""),
    history: hasHistory ? content.slice(histAt, ctxAt).replace(/\s+$/, "") : "",
    context: content.slice(ctxAt),
  };
}

/** 棋谱只在末尾块里出现一次：历史工具结果里的副本全部剥掉，避免重复占位。
 *  currentView 有值时用它刷新上下文 JSON 与棋谱块（工具循环中途盘面可能已经变化）。 */
export function filterXiangqiHistory(messages, liveGameId, currentView) {
  const strip = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) strip(child); return; }
    if (value.xiangqi && typeof value.xiangqi === "object") delete value.xiangqi.moveHistory;
    for (const child of Object.values(value)) strip(child);
  };
  const patchContext = (content) => {
    const parts = splitUserContent(content);
    if (!parts) return null;
    const start = CONTEXT_MARKER.length + 1;
    const end = parts.context.indexOf("\n", start);
    const lineEnd = end < 0 ? parts.context.length : end;
    try {
      const value = JSON.parse(parts.context.slice(start, lineEnd));
      if (currentView !== undefined) value.xiangqi = currentView ? slimXiangqi(currentView) : null;
      else if (value.xiangqi) delete value.xiangqi.moveHistory;
      const context = `${CONTEXT_MARKER}\n${JSON.stringify(value)}${parts.context.slice(lineEnd)}`;
      // 没有当前棋局（currentView 为 null，或调用方明确说没有 live game）就不发棋谱。
      const history = currentView !== undefined ? moveHistoryBlock(currentView) : (liveGameId ? parts.history : "");
      return composeUserContent({ instructions: parts.head, history, context });
    } catch {
      return null;
    }
  };
  return messages.map((message) => {
    if (typeof message.content !== "string") return message;
    if (message.role === "user") {
      const patched = patchContext(message.content);
      return patched === null ? message : { ...message, content: patched };
    }
    if (message.role !== "tool") return message;
    try {
      const value = JSON.parse(message.content);
      strip(value);
      return { ...message, content: JSON.stringify(value) };
    } catch {
      // A compacted tool result can be truncated JSON. Do not leak a partial
      // stale chess record into a subsequent request after the game ends.
      return message.content.includes('"moveHistory"')
        ? { ...message, content: '[过期棋局的压缩快照已移除]' }
        : message;
    }
  });
}

function contextBlock(ctx) {
  return `REQUEST_CONTEXT_JSON:\n${JSON.stringify(ctx)}`;
}

function render(templateName, ctx) {
  const flags = { room: ctx.world?.scene === "room", minesweeper: !!ctx.board, gomoku: !!ctx.gomoku, xiangqi: xiangqiLive(ctx.xiangqi), xiangqiended: xiangqiEnded(ctx.xiangqi), skillIndex: ctx.skills?.index ?? [] };
  // 索引已经写进 system prompt，就别在上下文 JSON 里再付一遍
  const base = ctx.skills ? { ...ctx, skills: (({ index, ...rest }) => rest)(ctx.skills) } : ctx;
  const contextForJson = ctx.xiangqi ? { ...base, xiangqi: slimXiangqi(ctx.xiangqi) } : base;
  const tpl = renderSections(readPrompt(templateName), flags).replace("{{REQUEST_CONTEXT_JSON}}", "");
  const context = contextBlock({ ...contextForJson, phase: ctx.phase ?? templateName.replace(".txt", "") });
  return [
    { role: "system", content: systemPrompt(flags) },
    {
      role: "user",
      content: composeUserContent({
        instructions: tpl,
        contract: OUTPUT_CONTRACT,
        history: moveHistoryBlock(ctx.xiangqi),
        context,
      }),
    },
  ];
}

/**
 * tools 模式的起始消息：system（含技能索引）+ 任务上下文。
 * 之后的轮次只追加 assistant(tool_calls) / tool(result)，前缀保持稳定以便命中缓存。
 */
export function toolStartMessages(ctx) {
  const flags = { room: ctx.world?.scene === "room", minesweeper: !!ctx.board, gomoku: !!ctx.gomoku, xiangqi: xiangqiLive(ctx.xiangqi), xiangqiended: xiangqiEnded(ctx.xiangqi), skillIndex: ctx.skills?.index ?? [] };
  const { index, ...restSkills } = ctx.skills ?? {};
  const base = ctx.skills ? { ...ctx, skills: restSkills } : ctx;
  const clean = ctx.xiangqi ? { ...base, xiangqi: slimXiangqi(ctx.xiangqi) } : base;
  return [
    { role: "system", content: systemPrompt(flags) },
    {
      role: "user",
      content: composeUserContent({
        contract: toolSummary(),
        history: moveHistoryBlock(ctx.xiangqi),
        context: `REQUEST_CONTEXT_JSON:\n${JSON.stringify(clean)}`,
      }),
    },
  ];
}

export function planningMessages(ctx) {
  return render("planning.txt", { ...ctx, phase: "planning" });
}

export function reviewMessages(ctx) {
  return render("review.txt", { ...ctx, phase: "review" });
}

/**
 * 合并流式 tool_calls 增量：DeepSeek/OpenAI 按 index 分片下发 id、name 和 arguments 片段。
 * 纯函数，方便单测。
 */
export function mergeToolDelta(acc, delta) {
  if (!Array.isArray(delta)) return acc;
  for (const part of delta) {
    const index = Number.isInteger(part?.index) ? part.index : acc.length;
    const slot = acc[index] ?? (acc[index] = { id: "", name: "", arguments: "" });
    if (part.id) slot.id = part.id;
    if (part.function?.name) slot.name = part.function.name;
    if (typeof part.function?.arguments === "string") slot.arguments += part.function.arguments;
  }
  return acc;
}

/** 把累积的调用解析成 {id, name, args}，参数不是合法 JSON 时给 null 让上层报错 */
export function finalizeToolCalls(acc) {
  return (acc ?? []).filter(Boolean).map((call, i) => {
    let args = null;
    try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = null; }
    return { id: call.id || `call_${i}`, name: call.name, argumentsRaw: call.arguments, args };
  });
}

export async function callModel(messages, signal, onReasoning, options = {}) {
  if (!hasKey()) throw new ModelError("NO_KEY", "服务端未配置 DEEPSEEK_API_KEY", 0);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const abort=()=>ctl.abort();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)ctl.abort();
  let reasoningContent = "", content = "", finishReason = null, usage = null, completed = false;
  const toolCalls = [];
  let useTools = false;
  try {
    useTools = options.tools?.length > 0;
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        ...(useTools
          ? { tools: options.tools, tool_choice: "auto" }
          : { response_format: { type: "json_object" } }),
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
      if (typeof choice.delta?.reasoning_content === "string" && choice.delta.reasoning_content) { reasoningContent += choice.delta.reasoning_content; onReasoning?.(choice.delta.reasoning_content); }
      if (typeof choice.delta?.content === "string") content += choice.delta.content;
      if (choice.delta?.tool_calls) mergeToolDelta(toolCalls, choice.delta.tool_calls);
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
  if (useTools) {
    const calls = finalizeToolCalls(toolCalls);
    if (!content && !calls.length) throw new ModelError("EMPTY", "模型既没有内容也没有工具调用", 0);
    return { mode: "tools", content, reasoningContent, calls, usage };
  }
  if (!content) throw new ModelError("EMPTY", "模型返回空内容", 0);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ModelError("INVALID_JSON", "模型返回的不是合法 JSON", 0);
  }
  return validatePlan(parsed);
}
