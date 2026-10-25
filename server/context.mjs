/** 上下文预算与裁剪（E 批）。无准确 tokenizer，使用保守字符估算。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length * 0.6);
}

export function buildHistory(history, budgetTokens = 1200) {
  const out = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const cost = estimateTokens(item.content);
    if (used + cost > budgetTokens) break;
    out.unshift(item);
    used += cost;
  }
  return { messages: out, tokens: used, dropped: history.length - out.length };
}

export function contextBudget({ history, budgetTokens = 1200 } = {}) {
  const trimmed = buildHistory(history ?? [], budgetTokens);
  return {
    history: trimmed.messages,
    contextTokens: trimmed.tokens,
    droppedMessages: trimmed.dropped,
    estimator: "chars*0.6",
  };
}

/** 整轮请求预算：system + 能力 + 上下文（含历史）一起估算，超限拒绝执行 */
export function estimateRequest({ system = "", capabilities = [], context = {}, maxInputTokens = 8000 } = {}) {
  const parts = {
    system: estimateTokens(system),
    capabilities: estimateTokens(JSON.stringify(capabilities)),
    context: estimateTokens(JSON.stringify(context)),
  };
  const total = parts.system + parts.capabilities + parts.context;
  return { total, parts, maxInputTokens, ok: total <= maxInputTokens, estimator: "chars*0.6" };
}
