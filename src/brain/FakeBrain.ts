/**
 * M1 用的本地假大脑：不联网、不产生假行为。
 * 真实模型在 M4 由服务端适配器替换；接口保持 async。
 */

export interface Reply {
  speech: string;
}

const DELAY_MS = 350;

export class FakeBrain {
  async reply(userText: string): Promise<Reply> {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    const text = userText.trim();
    const short = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    return { speech: `我听到了：“${short}”。现在还不能自己行动，接上大脑后我会真的去做。` };
  }
}
