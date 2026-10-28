/**
 * 技能注册表：大肥鱼自己写的“经验条目”，用于自我改进。
 *
 * 设计约束（来自用户决定）：
 * - 不写用户确认流程，写好了直接注册启用；
 * - 正文不常驻 system prompt：她按需 list / read；
 * - 她可以 create / revise / disable / enable，但**不能删除**；删除只能由用户在管理界面做；
 * - 启用上限 100，停用不限；
 * - 每次修改留历史版本，便于回滚。
 */
import fs from "node:fs";
import path from "node:path";
import { CAPABILITIES } from "./capabilities.mjs";

export const MAX_ENABLED = 100;
export const LIMITS = { title: 24, trigger: 40, body: 600, tags: 4 };
/** 越权/注入类词：技能正文不许出现，避免她自己改写系统规则 */
const BLOCKED = [
  /忽略(以上|之前|前面|上述)/,
  /你现在是/,
  /系统提示/,
  /系统规则/,
  /system\s*prompt/i,
  /必须以.{0,6}为准/,
  /覆盖.{0,4}(规则|权限)/,
  /api[_\s-]?key/i,
  /密码|密钥|token/i,
  /忽略(所有|一切)/,
];
const KNOWN_ACTIONS = new Set(CAPABILITIES.map((c) => c.id));

const now = () => Date.now();
const id = () => `sk_${Math.random().toString(36).slice(2, 8)}`;
const clamp = (s, n) => String(s ?? "").trim().slice(0, n);

export function validateSkillInput(input = {}) {
  const title = clamp(input.title, LIMITS.title);
  const trigger = clamp(input.trigger, LIMITS.trigger);
  const body = clamp(input.body, LIMITS.body);
  if (title.length < 2) throw Object.assign(new Error("title 太短"), { code: "SKILL_TITLE" });
  if (trigger.length < 2) throw Object.assign(new Error("trigger 太短"), { code: "SKILL_TRIGGER" });
  if (body.length < 6) throw Object.assign(new Error("body 太短，至少写清一个步骤"), { code: "SKILL_BODY" });
  for (const re of BLOCKED) {
    if (re.test(`${title}\n${trigger}\n${body}`)) {
      throw Object.assign(new Error(`技能里不能出现规则类表述（${re.source}）`), { code: "SKILL_BLOCKED" });
    }
  }
  // 正文里如果显式写了 action id，必须是真实存在的能力
  const quoted = [...body.matchAll(/"action"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  for (const action of quoted) {
    if (!KNOWN_ACTIONS.has(action)) {
      throw Object.assign(new Error(`技能引用了不存在的能力：${action}`), { code: "SKILL_UNKNOWN_ACTION" });
    }
  }
  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map((t) => clamp(t, 12))
    .filter(Boolean)
    .slice(0, LIMITS.tags);
  return { title, trigger, body, tags };
}

export class SkillRegistry {
  constructor(file) {
    this.file = file;
    this.state = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const skills = Array.isArray(raw?.skills) ? raw.skills.filter((s) => s && s.id && s.title) : [];
      return { revision: Number(raw?.revision) || 0, skills };
    } catch {
      return { revision: 0, skills: [] };
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("skills save failed", err.message);
    }
  }

  bump() {
    this.state.revision += 1;
    this.save();
  }

  get revision() {
    return this.state.revision;
  }

  all() {
    return this.state.skills;
  }

  get(skillId) {
    return this.state.skills.find((s) => s.id === skillId) ?? null;
  }

  enabled() {
    return this.state.skills.filter((s) => s.status === "enabled");
  }

  stats() {
    return {
      enabled: this.enabled().length,
      disabled: this.state.skills.length - this.enabled().length,
      max: MAX_ENABLED,
      revision: this.state.revision,
    };
  }

  /** 目录：只给标题和触发条件，正文另外 read */
  catalog({ includeDisabled = false, filter = "" } = {}) {
    const q = String(filter ?? "").toLowerCase();
    return this.state.skills
      .filter((s) => includeDisabled || s.status === "enabled")
      .filter((s) => !q || `${s.title} ${s.trigger} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(q))
      .map((s) => ({ id: s.id, title: s.title, trigger: s.trigger, status: s.status, used: s.usage?.injected ?? 0 }));
  }

  /** 读正文：计入“被查阅”次数 */
  read(skillId) {
    const skill = this.get(skillId);
    if (!skill) return null;
    skill.usage = skill.usage ?? { injected: 0, succeeded: 0, failed: 0 };
    skill.usage.injected += 1;
    skill.usage.lastUsedAt = now();
    this.bump();
    return skill;
  }

  /** 记录一次“用了之后结果如何”，用于自动停用 */
  recordOutcome(skillId, ok) {
    const skill = this.get(skillId);
    if (!skill) return;
    skill.usage = skill.usage ?? { injected: 0, succeeded: 0, failed: 0 };
    if (ok) skill.usage.succeeded += 1;
    else skill.usage.failed += 1;
    this.bump();
  }

  create(input = {}, source = null) {
    const data = validateSkillInput(input);
    const enabledCount = this.enabled().length;
    if (enabledCount >= MAX_ENABLED) {
      throw Object.assign(new Error(`已启用 ${enabledCount} 条，达到上限 ${MAX_ENABLED}，先停用一些再说`), { code: "SKILL_LIMIT" });
    }
    // 同名视为重复，直接把已有的还回去
    const duplicate = this.state.skills.find((s) => s.title === data.title && s.status === "enabled");
    if (duplicate) return { skill: duplicate, duplicate: true };
    const skill = {
      id: id(),
      ...data,
      status: "enabled",
      version: 1,
      history: [],
      usage: { injected: 0, succeeded: 0, failed: 0, lastUsedAt: null },
      source: source ?? null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.skills.push(skill);
    this.bump();
    return { skill, duplicate: false };
  }

  revise(skillId, patch = {}) {
    const skill = this.get(skillId);
    if (!skill) throw Object.assign(new Error("没有这条技能"), { code: "SKILL_NOT_FOUND" });
    const merged = validateSkillInput({
      title: patch.title ?? skill.title,
      trigger: patch.trigger ?? skill.trigger,
      body: patch.body ?? skill.body,
      tags: patch.tags ?? skill.tags,
    });
    // 历史里存的是**改之前**的内容，否则回滚会滚回新版本
    const previous = { title: skill.title, trigger: skill.trigger, body: skill.body, tags: skill.tags };
    skill.history = [...(skill.history ?? []), { version: skill.version, ...previous, at: skill.updatedAt }].slice(-5);
    skill.version += 1;
    Object.assign(skill, merged, { updatedAt: now() });
    this.bump();
    return skill;
  }

  /** 回滚到历史版本（历史条目的 version 是它当时的版本号） */
  revert(skillId, version) {
    const skill = this.get(skillId);
    if (!skill) throw Object.assign(new Error("没有这条技能"), { code: "SKILL_NOT_FOUND" });
    const entry = (skill.history ?? []).find((h) => h.version === version);
    if (!entry) throw Object.assign(new Error("没有这个历史版本"), { code: "SKILL_NO_VERSION" });
    skill.history = [...(skill.history ?? []), { version: skill.version, title: skill.title, trigger: skill.trigger, body: skill.body, tags: skill.tags, at: skill.updatedAt }].slice(-5);
    skill.version += 1;
    Object.assign(skill, { title: entry.title, trigger: entry.trigger, body: entry.body, tags: entry.tags, updatedAt: now() });
    this.bump();
    return skill;
  }

  setEnabled(skillId, enabled) {
    const skill = this.get(skillId);
    if (!skill) throw Object.assign(new Error("没有这条技能"), { code: "SKILL_NOT_FOUND" });
    if (enabled && skill.status !== "enabled" && this.enabled().length >= MAX_ENABLED) {
      throw Object.assign(new Error(`已启用 ${MAX_ENABLED} 条，达到上限`), { code: "SKILL_LIMIT" });
    }
    skill.status = enabled ? "enabled" : "disabled";
    skill.updatedAt = now();
    this.bump();
    return skill;
  }

  /** 只有管理界面能删；模型侧没有这个操作 */
  remove(skillId) {
    const before = this.state.skills.length;
    this.state.skills = this.state.skills.filter((s) => s.id !== skillId);
    if (this.state.skills.length === before) return false;
    this.bump();
    return true;
  }

  /** 自动停用：被读了很多次但结果一直不好 */
  autoDisableCandidates({ minInjected = 6, minFailRate = 0.7 } = {}) {
    return this.enabled().filter((s) => {
      const u = s.usage ?? {};
      const total = (u.succeeded ?? 0) + (u.failed ?? 0);
      if ((u.injected ?? 0) < minInjected || total < 4) return false;
      return (u.failed ?? 0) / total >= minFailRate;
    });
  }

  disable(skillId, reason = "auto") {
    const skill = this.get(skillId);
    if (!skill) return null;
    skill.status = "disabled";
    skill.disabledReason = reason;
    skill.updatedAt = now();
    this.bump();
    return skill;
  }
}
