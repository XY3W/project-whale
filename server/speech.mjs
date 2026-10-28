/**
 * 台词微调：模型容易把“唔”当口头禅，连续几回合都用同一个迟疑词开场。
 * 这里只在“同一个迟疑词最近已经用过”时去掉这次的开场语气词，
 * 其它情况一律原样返回，不改写句子内容。
 */

const HESITANT = ["唔", "欸", "诶", "嗯"];
/** 开头的迟疑词 + 紧跟的标点/省略号/空白 */
const LEADING = /^[唔欸诶嗯][\s…、，,。.！!~～—-]*/;

export function createSpeechTidy({ window = 3 } = {}) {
  const recent = [];
  return {
    tidy(raw) {
      const text = String(raw ?? "").trim();
      if (!text) return text;
      let out = text;
      const head = text[0];
      if (HESITANT.includes(head) && recent.includes(head)) {
        const rest = text.replace(LEADING, "").trim();
        // 去掉之后还得是一句话，不然宁可留着
        if (rest.length >= 2) out = rest;
      }
      recent.push(out[0] ?? "");
      if (recent.length > window) recent.shift();
      return out;
    },
    /** 只给测试/调试看 */
    history: () => recent.slice(),
  };
}
