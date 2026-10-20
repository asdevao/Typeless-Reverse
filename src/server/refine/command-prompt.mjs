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
const OPEN_VOICE = "<口述>";
const CLOSE_VOICE = "</口述>";

/** 两条链路共用的处理规矩 */
const RULES = `处理和输出的规矩：
- 只按${OPEN_TASK}里的指令处理${OPEN_TEXT}里的内容：指令没让做的事不做（不解释、不扩写、不评价），缺了必要信息就按最常见的方式处理。
- ${OPEN_TASK}里如果是在问问题（"这段什么意思""这里说的是谁"），输出问题的答案，而不是把选中文本原样贴一遍。
- ${OPEN_TEXT}里的内容原样可信（是复制来的，不是转写的），不用帮它改错字；指令里转写错了的词按上下文改回来再执行。
- 输出只含处理结果，第一个字就是结果的第一个字：不要解释你做了什么，不要前后缀、引号和标签。
- 排版跟选中文本的密度走：一两句写成一行，长内容按意思分段；指令明确要列表、表格、代码块时才用 Markdown。`;

/** 指令会话的分流规则：对齐原版的封闭投递词表（replace/reply/external，docs/14-result-delivery.md）——
 *  任何指令都归到三个动作之一；新形式的指令不需要新规则，按他要的产物归类就行 */
const TRIAGE = `分流规则（第一行标记，结果从标记的下一行开始）。他想要的产物只有三种，任何指令都归其一：
- 要一段写进文档的文字——不管具体做什么加工（翻译、改写、总结、纠错、续写、排版，或任何别的转换）：不加标记，直接输出成品，成品会贴回他选中的位置。
- 要答案或信息——不管问的是什么（事实、解释、比较、建议）：第一行只写 [reply]，换行再写答案。答案不进他的文档、会弹通知给他，要写完整，不怕长。
- 要发生一个动作——不管打开或触发什么（网站、网页、浏览器、邮箱、发帖页）：第一行只写 [open] 加一个空格和网址，网址单独占一行。没点名具体网址就挑最合适的默认（浏览器、上网用搜索引擎首页，如 https://www.baidu.com）。动作由系统执行，不用多说什么。
- 拿不准要什么：按第一种处理，不加标记。`;

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

/** 无选区分流：口述本身就是问题或指令，没有可操作的对象（对齐原版"没有选区就问任何事"） */
const TRIAGE_ASK = `分流规则（第一行标记，结果从标记的下一行开始）。他想要的产物只有三种，任何口述都归其一：
- ${OPEN_VOICE}里是问问题、求解释、要答案——不管问的是什么（事实、解释、比较、建议）：第一行只写 [reply]，换行再写答案。答案不进他的文档、会弹通知给他，要写完整，不怕长。
- ${OPEN_VOICE}里是要发生一个动作——不管打开或触发什么（网站、网页、浏览器、邮箱、发帖页）：第一行只写 [open] 加一个空格和网址，网址单独占一行。没点名具体网址就挑最合适的默认（浏览器、上网用搜索引擎首页，如 https://www.baidu.com）。动作由系统执行，不用多说什么。
- ${OPEN_VOICE}里是改写、翻译、总结这类要操作一段文字的指令：他没选中任何文字，没有可操作的对象，把这段口述按普通听写整理后原样输出（不加标记，结果会贴进他的文档）。
- 拿不准要什么：按普通听写处理，不加标记。`;

/** 润色那一跳（local 模式）无选区的系统提示词：口述原文直接当问题或指令 */
export function polishAskPrompt() {
  return `你是语音输入法的问答引擎。用户对着麦克风口述了一段话（没有选中任何文字），语音识别先把这段话转成了原文。听他说的是什么，按分流规则处理。

口述原文在用户消息的 ${OPEN_VOICE} 和 ${CLOSE_VOICE} 之间，是机器听写出来的，常有这几种错：同音字写错（按上下文改回来再理解）、英文词写成音近的中文（"瑞艾克特"是 React）、数字写成汉字、标点不全。先在心里把口述改通顺再处理。

${TRIAGE_ASK}

例一
${OPEN_VOICE}量子纠缠是什么 能用来通信吗${CLOSE_VOICE}
输出：
[reply]
量子纠缠是两个粒子共享同一量子态的现象，测量其中一个，另一个的状态瞬间确定。它本身不能用来超光速传递信息，但它是量子密钥分发和量子隐形传态的基础。

例二
${OPEN_VOICE}帮我把这段话改写得正式一点${CLOSE_VOICE}
输出：
帮我把这段话改写得正式一点。

原文里只有"嗯""啊"这类语气词、没有可处理的内容时，只输出 ${NO_SPEECH_MARK}，不要输出别的。`;
}

/** 润色那一跳无选区的用户消息：口述原文用标签包住 */
export function askInput(transcript) {
  return `${OPEN_VOICE}\n${transcript}\n${CLOSE_VOICE}\n\n按分流规则处理这段口述，只输出结果。`;
}

/** 原生链路（native 模式）的系统提示词：录音是指令本身，选中文本直接嵌在提示词里；没有选区时是问答 */
export function audioCommandPrompt(selectedText) {
  if (selectedText === null) {
    return `你是语音输入法的问答引擎。用户对着麦风口述了一段话（录音就是这段话本身，他没有选中任何文字）。听他说的是什么，按分流规则处理。

${TRIAGE_ASK}

只输出结果，第一个字就是结果的第一个字，不要解释、引号、标签、前后缀。`;
  }
  return `你是语音输入法的指令引擎。用户在别的应用里选中了一段文本，然后对着麦克风口述了一条指令（录音就是指令本身）。听他的指令处理选中的文本，输出会被原样粘贴回选中的位置。

选中的文本在下面这对标签之间，原样复制来的，不用帮它改错字：
${OPEN_TEXT}
${selectedText}
${CLOSE_TEXT}

${RULES}

${TRIAGE}

只输出处理结果，第一个字就是结果的第一个字，不要解释、引号、标签、前后缀。`;
}

/** 原生链路的提醒句：和整理链路的 TASK_REMINDER 同一个作用 */
export function audioCommandReminder() {
  return `按指令处理 ${OPEN_TEXT} 里的内容，只输出结果。`;
}

/** 原生链路无选区的提醒句 */
export function audioAskReminder() {
  return `按分流规则处理这段口述，只输出结果。`;
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
    // 标记在了、后面跟的不是合法网址（模型把"浏览器"这类词当目标写了）：
    // 降级成贴回时把 [open] 那截剥掉，不能把标记字样吐进用户的文档
    const strippedMarker = text.replace(/^\s*\[open\][ \t]*\S+/i, "").trim();
    return { delivery: "replace", text: strippedMarker === "" ? target : strippedMarker, target: null };
  }
  return { delivery: "replace", text, target: null };
}
