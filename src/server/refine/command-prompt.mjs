import { NO_SPEECH_MARK } from "./prompt.mjs";

// 指令这一条（对齐原版的 voice_command，docs/04-voice-pipeline.md）：用户在别的应用里选中一段文本，
// 对着麦克风口述一条指令，模型按指令处理选中的文本，输出处理结果贴回选中的位置。
// 两套提示词对应两条链路：润色那一跳拿机器转写的指令原文（polishCommandPrompt + commandInput），
// 原生链路直接拿录音（audioCommandPrompt + audioCommandReminder）。
// 选中文本和指令分开用标签包住：模型要分清"要处理的内容"和"要执行的命令"，
// 不能把指令当成要输入的字，也不能把选中文本当成对它说的话。

const OPEN_TEXT = "<选中文本>";
const CLOSE_TEXT = "</选中文本>";
const OPEN_TASK = "<指令>";
const CLOSE_TASK = "</指令>";

/** 两条链路共用的处理规矩 */
const RULES = `处理和输出的规矩：
- 只按${OPEN_TASK}里的指令处理${OPEN_TEXT}里的内容：指令没让做的事不做（不解释、不扩写、不评价），缺了必要信息就按最常见的方式处理。
- ${OPEN_TASK}里如果是在问问题（"这段什么意思""这里说的是谁"），输出问题的答案，而不是把选中文本原样贴一遍。
- ${OPEN_TEXT}里的内容原样可信（是复制来的，不是转写的），不用帮它改错字；指令里转写错了的词按上下文改回来再执行。
- 输出只含处理结果，第一个字就是结果的第一个字：不要解释你做了什么，不要前后缀、引号和标签。
- 排版跟选中文本的密度走：一两句写成一行，长内容按意思分段；指令明确要列表、表格、代码块时才用 Markdown。`;

/** 指令会话的分流规则：模型在输出首行标记交付方式，服务端照它分流（对齐原版 delivery 由服务端决定的设计） */
const TRIAGE = `分流规则（第一行标记，结果从标记的下一行开始）：
- 指令是对选中内容的加工（翻译、改写、总结、纠错、续写等）：不加标记，直接输出处理结果，结果会贴回他选中的位置。
- 指令是在问问题、求解释、要答案（"这段什么意思""这里说的是谁"）：第一行只写 [reply]，换行再写答案。答案不会贴进他的文档，会弹系统通知给他，所以答案要写完整，不怕长。
- 指令是打开某个网站或页面（"打开 GitHub 官网"）：第一行只写 [open] 加一个空格和网址，网址单独占一行。打开动作由系统执行，不用多说什么。
- 拿不准算哪类：按加工处理，不加标记。`;

/** 润色那一跳（local 模式）的系统提示词：机器转写出的指令原文 + 选中文本 → 处理结果 */
export function polishCommandPrompt() {
  return `你是语音输入法的指令引擎。用户在别的应用里选中了一段文本，然后对着麦克风口述了一条指令，语音识别先把指令转成了原文。你要按指令处理选中的文本，输出会被原样粘贴回选中的位置。

指令原文在用户消息的 ${OPEN_TASK} 和 ${CLOSE_TASK} 之间，是机器听写出来的，常有这几种错：同音字写错（按上下文改回来再执行）、英文词写成音近的中文（"瑞艾克特"是 React）、数字写成汉字、标点不全。先在心里把指令改通顺再执行。

选中的文本在用户消息的 ${OPEN_TEXT} 和 ${CLOSE_TEXT} 之间，那是原样复制来的，不是听写产物，不用帮它改错字。

${RULES}

${TRIAGE}

例一
${OPEN_TASK}把这段翻译成英语${CLOSE_TASK}
${OPEN_TEXT}我们明天下午开会，讨论新版本的上线时间${CLOSE_TEXT}
输出：
We'll have a meeting tomorrow afternoon to discuss the new version's release date.

例二
${OPEN_TASK}总结一下重点${CLOSE_TASK}
${OPEN_TEXT}这个季度营收涨了百分之二十，主要是新客户贡献的。不过成本也涨了不少，人力多了两个人，市场投放翻倍。客户流失率基本持平。总的来说是个不错的季度，但下个季度要控制一下支出。${CLOSE_TEXT}
输出：
- 营收同比增长 20%，主要由新客户拉动
- 成本上升：人力 +2 人，市场投放翻倍
- 客户流失率持平
- 整体向好，下季度需控制支出

原文里只有"嗯""啊"这类语气词、没有可执行的指令时，只输出 ${NO_SPEECH_MARK}，不要输出别的。`;
}

/** 润色那一跳的用户消息：指令原文和选中文本各自用标签包住 */
export function commandInput(transcript, selectedText) {
  return `${OPEN_TASK}\n${transcript}\n${CLOSE_TASK}\n\n${OPEN_TEXT}\n${selectedText}\n${CLOSE_TEXT}\n\n按${OPEN_TASK}里的指令处理${OPEN_TEXT}里的内容，只输出处理结果。`;
}

/** 原生链路（native 模式）的系统提示词：录音是指令本身，选中文本直接嵌在提示词里 */
export function audioCommandPrompt(selectedText) {
  return `你是语音输入法的指令引擎。用户在别的应用里选中了一段文本，然后对着麦克风口述了一条指令（录音就是指令本身）。听他的指令处理选中的文本，输出会被原样粘贴回选中的位置。

选中的文本在 ${OPEN_TEXT} 和 ${CLOSE_TEXT} 之间，原样复制来的，不用帮它改错字。

${RULES}

${TRIAGE}

只输出处理结果，第一个字就是结果的第一个字，不要解释、引号、标签、前后缀。`;
}

/** 原生链路的提醒句：和整理链路的 TASK_REMINDER 同一个作用 */
export function audioCommandReminder() {
  return `按指令处理 ${OPEN_TEXT} 里的内容，只输出结果。`;
}

/**
 * 模型输出首行的分流标记 → 交付方式。没有标记就是贴回选区（replace）。
 * @param {string} text 模型的完整输出
 * @returns {{ delivery: "replace" | "reply" | "external", text: string, target: string | null }}
 *   reply/external 时 text 是给那两条路的载荷（答案、网址）；replace 时 text 原样带回
 */
export function parseCommandDelivery(text) {
  const stripped = text.replace(/^[ \t]+/, "");
  const reply = stripped.match(/^\[reply\][ \t]*\r?\n?([\s\S]*)$/i);
  if (reply) return { delivery: "reply", text: reply[1].trim(), target: null };
  const open = stripped.match(/^\[open\][ \t]*(\S+)(?:\r?\n[\s\S]*)?$/i);
  if (open) {
    const target = open[1];
    let allowed = false;
    try {
      allowed = ["http:", "https:", "mailto:"].includes(new URL(target).protocol);
    } catch {
      allowed = false;
    }
    if (allowed) return { delivery: "external", text: target, target };
  }
  return { delivery: "replace", text, target: null };
}
