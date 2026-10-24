/**
 * 右侧聊天面板。
 * 规则来自 NEXT_PHASE_LLM_PLAN.md §4：
 * - 默认隐藏，未打开不能发送
 * - 只有键盘/输入法活动重置 2 分钟计时，鼠标与相机拖动不算
 * - 超时关闭不清空记录；未发送草稿保留
 * - 文本一律用 textContent 写入，不碰 innerHTML
 */

const IDLE_MS = 120_000;

export class ChatPanel {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLDivElement;
  private readonly sendBtn: HTMLButtonElement;

  open = false;
  busy = false;
  private deadline = 0;
  private draft = "";

  onSend: ((text: string) => void) | null = null;
  onTimeout: (() => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    injectStyles();
    this.root = document.createElement("div");
    this.root.className = "chat-panel";
    this.root.innerHTML = `
      <div class="chat-head">
        <span>和鲸鱼娘说话</span>
        <span class="chat-state" data-state>未连接</span>
        <button type="button" class="chat-close" data-close title="关闭">×</button>
      </div>
      <div class="chat-list" data-list></div>
      <div class="chat-status" data-status></div>
      <form class="chat-form">
        <textarea data-input rows="2" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button type="submit" data-send>发送</button>
      </form>
    `;
    document.body.appendChild(this.root);

    this.list = this.root.querySelector("[data-list]")!;
    this.input = this.root.querySelector("[data-input]")!;
    this.status = this.root.querySelector("[data-status]")!;
    this.sendBtn = this.root.querySelector("[data-send]")!;

    this.root.querySelector("[data-close]")!.addEventListener("click", () => {
      this.close("manual");
      this.onClose?.();
    });

    const form = this.root.querySelector("form")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener("keydown", (e) => {
      this.markActivity();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    for (const ev of ["input", "compositionstart", "compositionupdate", "compositionend"] as const) {
      this.input.addEventListener(ev, () => this.markActivity());
    }

    const check = () => this.checkTimeout();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    window.setInterval(check, 1000);
  }

  private markActivity() {
    if (!this.open) return;
    this.deadline = performance.now() + IDLE_MS;
  }

  private checkTimeout() {
    if (!this.open) return;
    if (performance.now() <= this.deadline) return;
    this.draft = this.input.value; // 保留草稿到下次打开
    this.close("timeout");
    this.onTimeout?.();
  }

  openPanel() {
    if (this.open) {
      this.input.focus();
      return;
    }
    this.open = true;
    this.root.classList.add("open");
    this.input.value = this.draft;
    this.deadline = performance.now() + IDLE_MS;
    requestAnimationFrame(() => this.input.focus());
    this.setState("就绪");
  }

  close(reason: "timeout" | "manual" = "manual") {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("open");
    this.draft = this.input.value;
    this.setState(reason === "timeout" ? "已超时关闭" : "已关闭");
    this.input.blur();
  }

  private submit() {
    if (!this.open) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.draft = "";
    this.markActivity();
    this.addMessage("user", text);
    this.onSend?.(text);
  }

  addMessage(role: "user" | "whale", text: string) {
    const row = document.createElement("div");
    row.className = `chat-msg chat-${role}`;
    row.textContent = text;
    this.list.appendChild(row);
    this.list.scrollTop = this.list.scrollHeight;
  }

  setThinking(on: boolean) {
    this.busy = on;
    this.sendBtn.disabled = on;
    this.setState(on ? "思考中…" : "就绪");
  }

  setError(text: string | null) {
    this.status.textContent = text ?? "";
    this.status.classList.toggle("show", !!text);
  }

  private setState(text: string) {
    const el = this.root.querySelector("[data-state]");
    if (el) el.textContent = text;
  }
}

const CSS = `
.chat-panel{position:fixed;right:16px;top:16px;bottom:16px;width:320px;display:none;flex-direction:column;
  background:rgba(12,18,30,.92);border:1px solid rgba(120,160,230,.25);border-radius:12px;
  color:#dbe7ff;font:13px/1.5 system-ui,sans-serif;backdrop-filter:blur(8px);z-index:20;overflow:hidden}
.chat-panel.open{display:flex}
.chat-head{display:flex;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(120,160,230,.18);
  font-size:12px;letter-spacing:.08em;color:#8fa8cc}
.chat-state{color:#5f7a9e;margin-left:auto}
.chat-close{background:none;border:0;color:#8fa8cc;font:18px/1 system-ui,sans-serif;cursor:pointer;padding:0 2px}
.chat-list{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.chat-msg{max-width:88%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.chat-user{align-self:flex-end;background:rgba(70,110,190,.35);border:1px solid rgba(120,160,230,.3)}
.chat-whale{align-self:flex-start;background:rgba(30,45,70,.9);border:1px solid rgba(120,160,230,.16)}
.chat-status{display:none;padding:8px 12px;color:#ff8d8d;font-size:12px}
.chat-status.show{display:block}
.chat-form{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(120,160,230,.18)}
.chat-form textarea{flex:1;resize:none;background:rgba(20,30,48,.9);border:1px solid rgba(120,160,230,.25);
  border-radius:8px;color:#e6efff;padding:8px;font:inherit;outline:none}
.chat-form button{background:rgba(70,110,190,.5);border:1px solid rgba(120,160,230,.4);color:#e6efff;
  border-radius:8px;padding:0 14px;cursor:pointer;font:inherit}
.chat-form button:disabled{opacity:.5;cursor:default}
.speech-bubble{position:fixed;left:0;top:0;max-width:320px;padding:8px 12px;border-radius:10px;
  background:rgba(14,22,36,.94);border:1px solid rgba(120,160,230,.35);color:#e6efff;
  font:13px/1.45 system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .2s;z-index:15;white-space:pre-wrap}
.speech-bubble.show{opacity:1}
.net-error{position:fixed;left:0;top:0;width:64px;height:64px;border-radius:50%;display:none;
  align-items:center;justify-content:center;background:#e23b3b;color:#fff;font:700 34px/1 system-ui,sans-serif;
  box-shadow:0 0 24px rgba(226,59,59,.55);border:2px solid rgba(255,180,180,.8);pointer-events:none;z-index:30}
.net-error.show{display:flex}
`;

function injectStyles() {
  if (document.getElementById("chat-styles")) return;
  const el = document.createElement("style");
  el.id = "chat-styles";
  el.textContent = CSS;
  document.head.appendChild(el);
}
