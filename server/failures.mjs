/**
 * 失败档案：给“写技能”提供地面真相。
 *
 * 只记结构化事实（做了什么、系统怎么判、差多少、当时的判断），不存整条思考链。
 * 定长环形缓冲，进程内即可，重启丢失不影响可用性。
 */

const MAX_ACTUAL = 600;

/** actual 可能很大（棋盘、格子列表），压到能进上下文为止 */
function compactActual(actual) {
  if (actual === undefined || actual === null) return null;
  let text;
  try {
    text = JSON.stringify(actual);
  } catch {
    return null;
  }
  if (text.length <= MAX_ACTUAL) return actual;
  return { truncated: true, preview: text.slice(0, MAX_ACTUAL) };
}

export function createFailureLog({ limit = 30 } = {}) {
  const items = [];
  return {
    record(entry = {}) {
      if (!entry.signature) return null;
      const record = {
        signature: entry.signature,
        taskId: entry.taskId ?? null,
        at: entry.at ?? Date.now(),
        action: entry.action ?? null,
        reasonCode: entry.reasonCode ?? null,
        requested: entry.requested ?? null,
        actual: compactActual(entry.actual),
        planSteps: Array.isArray(entry.planSteps) ? entry.planSteps.slice(0, 6) : [],
        note: entry.note ? String(entry.note).slice(0, 80) : null,
        state: entry.state ?? null,
      };
      items.push(record);
      while (items.length > limit) items.shift();
      return record;
    },
    forSignature(signature, count = 3) {
      return items.filter((i) => i.signature === signature).slice(-count);
    },
    all: () => items.slice(),
    size: () => items.length,
  };
}

/** 把档案渲染成几行给模型看的话；只用结构化事实，不做推测 */
export function describeFailures(signature, records = []) {
  if (!records.length) return `${signature} 失败过几次，但没有留下详细记录。`;
  const lines = records.map((r, i) => {
    const bits = [];
    const a = r.actual ?? {};
    if (Number.isFinite(a.distance_m)) bits.push(`离目标 ${a.distance_m}m`);
    if (Number.isFinite(a.tolerance_m)) bits.push(`要求 ≤${a.tolerance_m}m`);
    if (a.error) bits.push(a.error);
    if (a.reason) bits.push(a.reason);
    if (Array.isArray(r.planSteps) && r.planSteps.length) bits.push(`计划：${r.planSteps.join("→")}`);
    if (r.requested) bits.push(`目标：${JSON.stringify(r.requested)}`);
    if (r.note) bits.push(`你当时的判断：“${r.note}”`);
    return `${i + 1}) ${bits.join("；")}`;
  });
  return `最近 ${records.length} 次「${signature}」：\n${lines.join("\n")}`;
}
