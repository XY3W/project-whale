/** Application input estimate cap: 256 Ki tokens. Output allowance is configured separately. */
export const MAX_INPUT_TOKENS = 256 * 1024;

/** 上下文预算与裁剪（E 批）。无准确 tokenizer，使用保守字符估算。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length * 0.6);
}

export function buildHistory(history, budgetTokens = 1200) {
  const turns=[];
  for(const item of history){if(item.role==='user')turns.push([]);if(turns.length)turns.at(-1).push(item);}
  const out=[];let used=0;
  for(const turn of turns.slice(-12).reverse()){
    const cost=turn.reduce((n,m)=>n+estimateTokens(m.content),0);
    if(used+cost>budgetTokens)break;
    out.unshift(...turn);used+=cost;
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
export function estimateRequest({ messages, system = "", capabilities = [], context = {}, maxInputTokens = 8000 } = {}) {
  if(messages){const total=Math.ceil(estimateTokens(JSON.stringify(messages))*1.15)+64;return {total,parts:{messages:total},maxInputTokens,ok:total<=maxInputTokens,estimator:"chars*0.6 +15% margin"};}
  const parts = {
    system: estimateTokens(system),
    capabilities: estimateTokens(JSON.stringify(capabilities)),
    context: estimateTokens(JSON.stringify(context)),
  };
  const total = parts.system + parts.capabilities + parts.context;
  return { total, parts, maxInputTokens, ok: total <= maxInputTokens, estimator: "chars*0.6" };
}

/** Keep each completed plan's evidence once; the current report already has its own field. */
export function linkCurrentExecution(evidence, currentPlanId, report) {
  return evidence.map(entry => {
    if (!report || entry.planId !== currentPlanId || entry.result !== report) return entry;
    const {result: _result, ...rest}=entry;
    void _result;
    return {...rest,resultRef:'executionReport'};
  });
}
