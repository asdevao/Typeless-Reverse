// 语音指令"打开应用"的白名单（对齐原版 launchApplicationByName 的意图，Windows 做法）。
// LLM 给的应用名只认这张表：绝不让模型的字符串直接进命令行——那等于把 shell 交给模型。

/** 应用名/别名 → 启动命令（cmd start 的参数）。全是常见系统应用：装了就启动，没装由系统自己报"找不到" */
const APPS = new Map([
  ["chrome", "chrome"],
  ["edge", "msedge"],
  ["notepad", "notepad"],
  ["calc", "calc"],
  ["explorer", "explorer"],
  ["code", "code"],
  ["vscode", "code"],
  ["word", "winword"],
  ["excel", "excel"],
  ["powerpoint", "powerpnt"],
  ["terminal", "wt"],
  ["cmd", "cmd"],
  ["paint", "mspaint"],
  ["settings", "ms-settings:"],
]);

/** 中文别名 → 表里的键。不确定 exe 名的应用（微信等）不收：宁可不启动也不猜 */
const ALIASES = new Map([
  ["浏览器", "chrome"],
  ["谷歌浏览器", "chrome"],
  ["谷歌", "chrome"],
  ["记事本", "notepad"],
  ["计算器", "calc"],
  ["文件管理器", "explorer"],
  ["文件资源管理器", "explorer"],
  ["设置", "settings"],
  ["系统设置", "settings"],
  ["终端", "terminal"],
  ["画图", "paint"],
]);

/**
 * 模型给的应用名 → 白名单里的启动命令。
 * @param {string | null | undefined} name 模型 JSON 里 launch 字段的值
 * @returns {string | null} 启动命令；不认识的是 null（调用方拒绝，绝不落到 shell）
 */
export function launchTargetOf(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (key === "") return null;
  if (APPS.has(key)) return APPS.get(key);
  const aliased = ALIASES.get(key);
  if (aliased !== undefined) return APPS.get(aliased) ?? null;
  return null;
}
