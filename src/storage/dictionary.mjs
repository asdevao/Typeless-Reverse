// 个人词典：专有名词的"错误写法 → 正确写法"对照表。本机 JSON 文件存，不进任何云端。
// 机器转写常把专有名词听成音近的词（"瑞艾克特"→React、"给哈布"→GitHub），用户在词典里教一次，
// 之后每次听写转写完都自动改回来（applyHotwords）。CSV 导入对齐原版的 pick-and-parse-dictionary-csv。
import { readFileSync, writeFileSync } from "node:fs";

/** @returns {{ wrong: string, correct: string }[]} 文件不存在或内容不是合法 JSON 时是空表；其他读盘错误往上抛 */
export function loadDictionary(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.wrong === "string" && typeof entry.correct === "string")
      .map(({ wrong, correct }) => ({ wrong, correct }));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export function saveDictionary(file, entries) {
  // 原子一点：先写临时文件再替换，写一半被杀也不会把词典弄丢
  writeFileSync(file, JSON.stringify(entries, null, 2));
}

/** 加一条（wrong 相同的视为改正确写法，覆盖旧的），返回去重后的全表 */
export function addEntry(entries, wrong, correct) {
  const w = String(wrong).trim();
  const c = String(correct).trim();
  if (w === "" || c === "") throw new TypeError("词典条目的两边都得是非空文字");
  const rest = entries.filter((entry) => entry.wrong !== w);
  return [...rest, { wrong: w, correct: c }];
}

export function removeEntry(entries, wrong) {
  return entries.filter((entry) => entry.wrong !== String(wrong).trim());
}

/**
 * 解析词典 CSV：每行 `错误写法,正确写法`（第一列空缺的行跳过）。
 * 第一行如果是表头（含 "wrong"/"错误" 字样）跳过。
 */
export function parseDictionaryCsv(text) {
  const entries = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const [wrong = "", correct = ""] = line.split(",").map((cell) => cell.trim());
    if (wrong === "" || correct === "") continue;
    if (/wrong|错误/i.test(wrong) && entries.length === 0) continue; // 表头
    entries.push({ wrong, correct });
  }
  return entries;
}

/** 没有人声标记的同款空串约定：模型输出空时词典无事可做（prompt.mjs 的 NO_SPEECH_MARK 转空串后才到这里） */
const CJK_BEFORE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const LATIN = /[A-Za-z0-9]/;

/** 按润色链路的排版惯例：拉丁词和中文相邻时补一个空格（只在替换位周围动，不碰原文其他地方） */
function withSpacing(inserted, source, offset, length) {
  const before = source[offset - 1] ?? "";
  const after = source[offset + length] ?? "";
  const left = CJK_BEFORE.test(before) && LATIN.test(inserted[0] ?? "") ? " " : "";
  const right = LATIN.test(inserted.at(-1) ?? "") && CJK_BEFORE.test(after) ? " " : "";
  return `${left}${inserted}${right}`;
}

/**
 * 转写原文过一遍词典：长的先替换（"GitHub Actions" 要赶在 "GitHub" 之前），
 * 拉丁文不区分大小写（用户教的是 "GitHub"，转写成 "github" 也算命中）。
 */
export function applyHotwords(transcript, entries) {
  let text = transcript;
  const sorted = [...entries].sort((a, b) => b.wrong.length - a.wrong.length);
  for (const { wrong, correct } of sorted) {
    const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/[a-z]/i.test(wrong)) {
      const pattern = new RegExp(escape(wrong), "gi");
      text = text.replace(pattern, (match, offset) => withSpacing(correct, text, offset, match.length));
    } else {
      text = text.replaceAll(wrong, (match, offset) => withSpacing(correct, text, offset, match.length));
    }
  }
  return text;
}
