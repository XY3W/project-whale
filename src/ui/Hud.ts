const LABELS: Record<string, string> = {
  walk: "走",
  greet: "挥手",
  notice: "注意",
  nod: "点头",
  look_left: "左看",
  look_right: "右看",
  think: "思考",
  tail: "摆尾",
};

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly clipEl: HTMLElement;
  private readonly mainEl: HTMLElement;
  private readonly subEl: HTMLElement;

  constructor(onTrigger: (id: string) => void, buttons: string[]) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="hud-title"><span>Project Whale</span><span data-clip>idle</span></div>
      <div class="hud-intent" data-main>待机</div>
      <div class="hud-sub" data-sub>—</div>
      <div class="hud-actions">
        ${buttons.map((id) => `<button data-id="${id}">${LABELS[id] ?? id}</button>`).join("")}
      </div>
    `;
    document.body.appendChild(this.root);

    this.clipEl = this.root.querySelector("[data-clip]")!;
    this.mainEl = this.root.querySelector("[data-main]")!;
    this.subEl = this.root.querySelector("[data-sub]")!;

    this.root.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        onTrigger((btn as HTMLButtonElement).dataset.id!);
      });
    });

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "拖动旋转视角　·　滚轮缩放　·　点击角色互动";
    document.body.appendChild(hint);
  }

  setStatus(main: string, sub: string, clip: string) {
    this.mainEl.textContent = main;
    this.subEl.textContent = sub;
    this.clipEl.textContent = clip;
  }

  toggle() {
    this.root.classList.toggle("hidden");
  }
}
