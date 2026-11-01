/** A persistent chat overlay. Showing it never pauses the character. */
import { mergeChatMessages, type ChatMessage } from './chatHistory';

export class ChatPanel {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLDivElement;
  private reasoningTask = "";
  private reasoningText = "";
  private reasoningRow: HTMLDivElement | null = null;
  private messages: ChatMessage[] = [];
  private readonly olderButton: HTMLButtonElement;
  private before: string | null = null;
  private historyLoaded = false;
  private historyLoading = false;
  private refreshPending = false;
  private hasMore = false;
  readonly ready: Promise<void>;

  readonly open = true;
  busy = false;

  onSend: ((text: string, clientMessageId: string) => boolean | void) | null = null;

  constructor() {
    injectStyles();
    this.root = document.createElement("div");
    this.root.className = "chat-panel";
    this.root.innerHTML = `
      <div class="chat-head">
        <span class="chat-title"><span class="chat-title-icon" aria-hidden="true">✦</span> 和鲸鱼娘说话</span>
        <label class="chat-reasoning-toggle"><input type="checkbox" data-reasoning>显示思考</label>
        <span class="chat-state" data-state>未连接</span>
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

    const toggle = this.root.querySelector<HTMLInputElement>("[data-reasoning]")!;
    try { toggle.checked = localStorage.getItem("whale-show-reasoning") === "1"; } catch {}
    toggle.addEventListener("change", () => {
      try { localStorage.setItem("whale-show-reasoning", toggle.checked ? "1" : "0"); } catch {}
      this.renderReasoning();
    });
    const form = this.root.querySelector("form")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.isComposing) return; // 中文输入法组词时不提交
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.olderButton = document.createElement('button');
    this.olderButton.type = 'button';
    this.olderButton.className = 'chat-load-more';
    this.olderButton.addEventListener('click', () => { void this.loadHistory(this.historyLoaded && this.hasMore); });
    this.ready = this.loadHistory(false);
  }

  refreshHistory() { return this.loadHistory(false); }

  private async loadHistory(older: boolean) {
    if (this.historyLoading) { if (!older) this.refreshPending = true; return; }
    this.historyLoading = true;
    this.olderButton.disabled = true;
    this.olderButton.textContent = older ? '正在加载更早的对话…' : '正在恢复对话…';
    this.olderButton.hidden = false;
    this.list.prepend(this.olderButton);
    const height = this.list.scrollHeight, top = this.list.scrollTop;
    try {
      const known = new Set(this.messages.map(m => m.messageId).filter(Boolean));
      const query = new URLSearchParams({ limit: '100' });
      if (older && this.before) query.set('before', this.before);
      const response = await fetch(`/api/conversation?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('history unavailable');
      let page = await response.json();
      if (page.cursorExpired) { this.resetHistoryCursor(); return; }
      if (!Array.isArray(page.messages)) throw new Error('history unavailable');
      this.messages = mergeChatMessages(this.messages, page.messages);
      // A long disconnect can miss more than one page. Fill the gap back to a
      // known message instead of silently jumping from old chat to the last 100.
      if (!older && this.historyLoaded && known.size) {
        while (page.hasMore && !page.messages.some((m: ChatMessage) => known.has(m.messageId))) {
          const previousCursor = page.before;
          const next = await fetch(`/api/conversation?${new URLSearchParams({ limit: '100', before: previousCursor })}`, { cache: 'no-store' });
          if (!next.ok) throw new Error('history unavailable');
          page = await next.json();
          if (page.cursorExpired) { this.resetHistoryCursor(); return; }
          if (!Array.isArray(page.messages) || page.before === previousCursor) throw new Error('history cursor expired');
          this.messages = mergeChatMessages(this.messages, page.messages);
        }
      }
      if (older || !this.historyLoaded || !known.size) {
        this.before = page.before ?? null;
        this.hasMore = !!page.hasMore;
      }
      this.historyLoaded = true;
      this.olderButton.textContent = '加载更早的对话';
      this.olderButton.hidden = !this.hasMore;
      this.renderMessages(!older);
      if (older) this.list.scrollTop = top + this.list.scrollHeight - height;
    } catch {
      this.olderButton.textContent = '聊天记录恢复失败，点击重试';
      this.olderButton.hidden = false;
    } finally {
      this.historyLoading = false;
      this.olderButton.disabled = false;
      if (this.refreshPending) { this.refreshPending = false; void this.loadHistory(false); }
    }
  }

  private resetHistoryCursor() {
    this.messages = [];
    this.before = null;
    this.hasMore = false;
    this.historyLoaded = false;
    this.refreshPending = true;
    this.renderMessages(false);
  }

  private renderMessages(scrollToBottom: boolean) {
    const rows = this.messages.map(item => {
      const row = document.createElement('div');
      row.className = `chat-msg chat-${item.role === 'assistant' ? 'whale' : item.role}`;
      row.textContent = item.content;
      if (item.messageId) row.dataset.messageId = item.messageId;
      return row;
    });
    this.list.replaceChildren(this.olderButton, ...rows, ...(this.reasoningRow ? [this.reasoningRow] : []));
    if (scrollToBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  receiveMessage(message: ChatMessage) {
    this.messages = mergeChatMessages(this.messages, [message]);
    this.renderMessages(true);
  }

  get showReasoning() { return this.root.querySelector<HTMLInputElement>("[data-reasoning]")!.checked; }

  startReasoning(taskId: string) {
    this.reasoningTask = taskId;
    this.reasoningText = "";
    this.renderReasoning();
  }

  appendReasoning(taskId: string, text: string) {
    if (taskId !== this.reasoningTask) return;
    this.reasoningText = (this.reasoningText + text).slice(-12000);
    this.renderReasoning();
  }

  endReasoning(taskId?: string) {
    if (taskId && taskId !== this.reasoningTask) return;
    this.reasoningTask = "";
    this.reasoningText = "";
    this.reasoningRow?.remove();
    this.reasoningRow = null;
  }

  private renderReasoning() {
    if (!this.reasoningTask || !this.showReasoning) {
      this.reasoningRow?.remove();
      this.reasoningRow = null;
      return;
    }
    if (!this.reasoningRow) {
      this.reasoningRow = document.createElement("div");
      this.reasoningRow.className = "chat-msg chat-reasoning";
      this.list.appendChild(this.reasoningRow);
    }
    this.reasoningRow.textContent = this.reasoningText || "正在思考…";
    this.reasoningRow.scrollTop = this.reasoningRow.scrollHeight;
    this.list.scrollTop = this.list.scrollHeight;
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    const clientMessageId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    this.addMessage("user", text, { clientMessageId });
    if (this.onSend?.(text, clientMessageId) === false) this.input.value = text;
  }

  /** 系统提示行：技能新建/更新/停用这类事件，不占角色台词 */
  addNote(text: string) {
    const sequence = Math.floor(this.messages.reduce((n, m) => Math.max(n, m.sequence ?? 0), 0)) + 0.5;
    this.messages.push({ role: 'note', content: text, createdAt: Date.now(), sequence });
    this.renderMessages(true);
  }

  addMessage(role: "user" | "whale", text: string, meta: Partial<ChatMessage> = {}) {
    this.receiveMessage({ ...meta, role: role === 'whale' ? 'assistant' : 'user', content: text, createdAt: meta.createdAt ?? Date.now() });
  }

  setThinking(on: boolean) {
    this.busy = on;
    // New user messages may supersede an ongoing task.
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
.chat-panel{position:fixed;right:16px;top:68px;bottom:16px;width:min(420px,calc(100vw - 32px));display:flex;flex-direction:column;
  background:transparent;border:0;color:#e7efff;font:17px/1.55 system-ui,sans-serif;z-index:25;pointer-events:none}
.chat-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:16px;background:rgba(12,26,45,.76);border:1px solid rgba(147,187,240,.2);backdrop-filter:blur(14px);font-size:15px;color:#c7d9ef;text-shadow:0 1px 4px #05070b}.chat-title{font-weight:650;color:#f3f8ff;white-space:nowrap}.chat-title-icon{color:#8cc8ff}
.chat-reasoning-toggle{pointer-events:auto;display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:14px;cursor:pointer}
.chat-state{color:#a8bad6;margin-left:auto;font-size:14px}
.chat-list{flex:1;min-height:0;overflow-y:auto;padding:10px 4px;display:flex;flex-direction:column;gap:12px;pointer-events:none;overscroll-behavior:contain}
.chat-load-more{align-self:center;pointer-events:auto;border:1px solid #6b91c855;border-radius:14px;background:#14243bdb;color:#c4dcff;padding:7px 14px;cursor:pointer;font:14px system-ui}
.chat-load-more[hidden]{display:none}.chat-load-more:disabled{opacity:.65;cursor:wait}
.chat-msg{max-width:90%;padding:12px 16px;border-radius:20px;font-size:18px;line-height:1.55;white-space:pre-wrap;word-break:break-word;pointer-events:auto}
.chat-user{align-self:flex-end;background:linear-gradient(135deg,rgba(72,125,198,.96),rgba(61,92,166,.96));color:#fff;box-shadow:0 4px 18px #07142644}
.chat-whale{align-self:flex-start;background:rgba(20,38,62,.93);border:1px solid rgba(153,191,239,.14);color:#f4f7ff;box-shadow:0 4px 18px #07142644}
.chat-reasoning{align-self:flex-start;background:rgba(25,39,62,.85);color:#b8c8df;font-size:15px;line-height:1.55;height:calc(9.3em + 24px);box-sizing:border-box;flex-shrink:0;overflow-y:auto;overscroll-behavior:contain}
.chat-status{display:none;padding:8px 12px;color:#ffd4d4;background:rgba(105,35,45,.9);border-radius:16px;font-size:15px;pointer-events:auto}
.chat-status.show{display:block}
.chat-form{display:flex;gap:8px;padding:8px 0;pointer-events:auto}
.chat-form textarea{min-width:0;flex:1;resize:none;background:rgba(20,30,48,.94);border:0;
  border-radius:20px;color:#f4f7ff;padding:12px 16px;font:17px/1.5 system-ui,sans-serif;outline:none}
.chat-form textarea:focus{outline:2px solid rgba(148,185,250,.8);outline-offset:1px}
.chat-form button{background:rgba(70,110,190,.94);border:0;color:#fff;
  border-radius:20px;padding:0 18px;cursor:pointer;font:17px system-ui,sans-serif}
.chat-form button:disabled{opacity:.5;cursor:default}
@media (max-width:819px){.chat-panel{top:auto;bottom:max(8px,env(safe-area-inset-bottom));right:8px;width:min(390px,calc(100vw - 16px));height:min(42vh,380px)}.chat-head{padding:8px 10px;gap:6px;font-size:13px}.chat-reasoning-toggle,.chat-state{font-size:12px}.chat-msg{font-size:16px;padding:9px 13px}.chat-form textarea,.chat-form button{font-size:16px}}

.speech-bubble{position:fixed;left:0;top:0;max-width:320px;padding:10px 14px;border-radius:18px;
  background:rgba(14,22,36,.94);border:1px solid rgba(120,160,230,.35);color:#e6efff;
  font:18px/1.45 system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .2s;z-index:15;white-space:pre-wrap}
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
