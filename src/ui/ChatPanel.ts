/** A persistent chat overlay. Showing it never pauses the character. */

export class ChatPanel {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLDivElement;

  readonly open = true;
  busy = false;

  onSend: ((text: string) => void) | null = null;

  constructor() {
    injectStyles();
    this.root = document.createElement("div");
    this.root.className = "chat-panel";
    this.root.innerHTML = `
      <div class="chat-head">
        <span>和鲸鱼娘说话</span>
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
    // Restore the current owner's recent conversation after a page reload.
    void fetch('/api/memory').then(r=>r.ok?r.json():null).then(data=>{
      if(!data||this.list.childElementCount!==0||!Array.isArray(data.recentConversation))return;
      for(const item of data.recentConversation){
        if((item.role==='user'||item.role==='assistant')&&typeof item.content==='string')
          this.addMessage(item.role==='user'?'user':'whale',item.content);
      }
    }).catch(()=>{});
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
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
.chat-head{display:flex;align-items:center;gap:12px;padding:8px 12px;font-size:16px;color:#b6c7e5;text-shadow:0 1px 4px #05070b}
.chat-state{color:#a8bad6;margin-left:auto;font-size:14px}
.chat-list{flex:1;min-height:0;overflow-y:auto;padding:10px 4px;display:flex;flex-direction:column;gap:12px;pointer-events:none;overscroll-behavior:contain}
.chat-msg{max-width:90%;padding:12px 16px;border-radius:20px;font-size:18px;line-height:1.55;white-space:pre-wrap;word-break:break-word;pointer-events:auto}
.chat-user{align-self:flex-end;background:rgba(70,110,190,.88);color:#fff}
.chat-whale{align-self:flex-start;background:rgba(25,39,62,.93);color:#f4f7ff}
.chat-status{display:none;padding:8px 12px;color:#ffd4d4;background:rgba(105,35,45,.9);border-radius:16px;font-size:15px;pointer-events:auto}
.chat-status.show{display:block}
.chat-form{display:flex;gap:8px;padding:8px 0;pointer-events:auto}
.chat-form textarea{min-width:0;flex:1;resize:none;background:rgba(20,30,48,.94);border:0;
  border-radius:20px;color:#f4f7ff;padding:12px 16px;font:17px/1.5 system-ui,sans-serif;outline:none}
.chat-form textarea:focus{outline:2px solid rgba(148,185,250,.8);outline-offset:1px}
.chat-form button{background:rgba(70,110,190,.94);border:0;color:#fff;
  border-radius:20px;padding:0 18px;cursor:pointer;font:17px system-ui,sans-serif}
.chat-form button:disabled{opacity:.5;cursor:default}
@media (max-width:819px){.chat-panel{top:112px;bottom:8px;width:min(390px,calc(100vw - 32px))}}

.speech-bubble{position:fixed;left:0;top:0;max-width:320px;padding:10px 14px;border-radius:18px;
  background:rgba(14,22,36,.94);border:1px solid rgba(120,160,230,.35);color:#e6efff;
  font:16px/1.45 system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .2s;z-index:15;white-space:pre-wrap}
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
