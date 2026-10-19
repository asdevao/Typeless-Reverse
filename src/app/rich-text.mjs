// 轻量"润色体"→ HTML 转换：贴进剪贴板的 HTML 格式（Windows 剪贴板 text + html 双格式，
// 目标应用粘贴时自动挑它支持的）。覆盖润色提示词约定的排版：段落、编号列表、破折号列表、
// 粗体、行内代码——超出这个范围的（表格、标题）按普通段落处理，不追求完整 Markdown。
// 先整体转义再只放行我们自己生成的标签，模型输出里夹带的 HTML 不会被当成标签执行。

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 行内标记：**粗体**、`行内代码`（转义之后做，标签是我们自己发的才放行） */
function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

const isBlank = (line) => line.trim() === "";
const isOrdered = (line) => /^\d+[.、)]\s*/.test(line.trim());
const isBullet = (line) => /^[-*•]\s+/.test(line.trim());
const stripMarker = (line) => line.trim().replace(/^\d+[.、)]\s*/, "").replace(/^[-*•]\s+/, "");

/**
 * 润色体的文本 → HTML。
 * @returns {string} 不带外层 <html> 的片段（Electron clipboard.write 的 html 字段吃这个）
 */
export function mdLikeToHtml(text) {
  const lines = escapeHtml(text).split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let ordered = [];
  let bullets = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${inline(paragraph.join("<br>"))}</p>`);
    paragraph = [];
  };
  const flushOrdered = () => {
    if (ordered.length === 0) return;
    blocks.push(`<ol>${ordered.map((line) => `<li>${inline(line)}</li>`).join("")}</ol>`);
    ordered = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(`<ul>${bullets.map((line) => `<li>${inline(line)}</li>`).join("")}</ul>`);
    bullets = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushOrdered();
    flushBullets();
  };

  for (const line of lines) {
    if (isBlank(line)) {
      flushAll();
    } else if (isOrdered(line)) {
      flushParagraph();
      flushBullets();
      ordered.push(stripMarker(line));
    } else if (isBullet(line)) {
      flushParagraph();
      flushOrdered();
      bullets.push(stripMarker(line));
    } else {
      flushOrdered();
      flushBullets();
      paragraph.push(line.trim());
    }
  }
  flushAll();
  return blocks.join("\n");
}
