/** 最小长期偏好（E 批）：模型只能提案，服务端校验来源与白名单。 */
export const MEMORY_KEYS = new Set(["nickname", "style", "interest"]);
const MAX_ITEMS = 20;
const MAX_VALUE_LEN = 60;

export function validateProposals(proposals, sourceMessageId) {
  if (!Array.isArray(proposals)) return { accepted: [], rejected: [] };
  const accepted = [];
  const rejected = [];
  for (const p of proposals) {
    if (accepted.length >= 2) break;
    if (!p || typeof p !== "object") { rejected.push({ reason: "not_object" }); continue; }
    const key = String(p.key ?? "");
    const value = String(p.value ?? "").trim();
    if (!MEMORY_KEYS.has(key)) { rejected.push({ reason: "key_not_allowed", key }); continue; }
    if (!value || value.length > MAX_VALUE_LEN) { rejected.push({ reason: "bad_value", key }); continue; }
    if (!sourceMessageId) { rejected.push({ reason: "missing_source", key }); continue; }
    accepted.push({ key, value, sourceMessageId, status: "candidate", createdAt: Date.now() });
  }
  return { accepted, rejected };
}

export function addCandidates(existing, accepted) {
  const out = Array.isArray(existing) ? [...existing] : [];
  for (const item of accepted) {
    const dup = out.find((m) => m.key === item.key && m.value === item.value);
    if (dup) continue;
    if (out.length >= MAX_ITEMS) break;
    out.push({ id: `m${out.length + 1}-${Date.now()}`, ...item });
  }
  return out;
}

export function confirmedMemories(all) {
  return (Array.isArray(all) ? all : []).filter((m) => m.status === "confirmed");
}
