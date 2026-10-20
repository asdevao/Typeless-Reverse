// 结果卡片的渲染层（1:1 复刻原版 interactive-card 的行为）：
// 主进程开窗（贴悬浮条上方、宽 800、随内容长高、最高 800），这里只管画——
// 问题行（两行折叠 + 复制）、答案卡（标题行 + 悬停显形的复制/关闭 + Markdown 正文），
// Esc 关闭；内容高度用 ResizeObserver 量，上报主进程调窗口，就位后渐显（原版 300ms 出场）。

import { mdLikeToHtml } from "../../app/rich-text.mjs";
import { localize, t } from "../shared/i18n.mjs";

localize();

const $root = document.getElementById("root");
/** 折叠的行数上限和行高（原版同款：两行 × 22px） */
const PROMPT_LINES = 2;
const PROMPT_LINE_HEIGHT = 22;
/** 高度上报的最小变化和取值范围（原版同款） */
const HEIGHT_MIN_DELTA = 10;
const HEIGHT_MAX = 32_000;
/** 上报完成后等多久渐显（原版同款 150ms） */
const REVEAL_DELAY_MS = 150;

/** 现在画着的载荷 */
let payload = null;
/** 渲染代数：重画会让上一代的渐显定时器作废 */
let generation = 0;
/** 上次上报过的高度 */
let reportedHeight = 0;

// ---------- 复制按钮（3 秒"已复制"，原版同款） ----------

function wireCopy(button, getText) {
  button.addEventListener("click", async () => {
    const text = getText();
    if (!text) return;
    try {
      await window.speakmore.copyText(text);
      button.classList.add("copied");
      button.textContent = "✓";
      button.title = t("card.copied");
      setTimeout(() => {
        button.classList.remove("copied");
        button.textContent = "⧉";
        button.title = t("card.copy");
      }, 3_000);
    } catch {
      // 复制失败就保持原样：卡片还在，用户可以再点
    }
  });
}

// ---------- 问题行 ----------

/**
 * 问题行：图标 + 问题原文 +（有选区时）选中文本，超过两行折叠，右下角"...更多"。
 * 复制按钮复制 问题 + 换行 + 选区（原版同款）。
 */
function buildPrompt({ userPrompt, selectedText }) {
  const prompt = document.createElement("div");
  prompt.className = "prompt";
  if (!userPrompt) return prompt;

  const toggle = document.createElement("div");
  toggle.className = "prompt-toggle";

  const row = document.createElement("div");
  row.className = "prompt-row";
  const icon = document.createElement("span");
  icon.className = "prompt-icon";
  icon.textContent = "❝";
  const text = document.createElement("span");
  text.className = "prompt-text";
  text.textContent = userPrompt;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "prompt-copy";
  copy.textContent = "⧉";
  copy.title = t("card.copy");
  wireCopy(copy, () => [userPrompt, selectedText].filter(Boolean).join("\n"));
  row.append(icon, text, copy);
  toggle.append(row);

  if (selectedText) {
    const selectionRow = document.createElement("div");
    selectionRow.className = "prompt-row";
    const spine = document.createElement("span");
    spine.className = "prompt-spine";
    const selection = document.createElement("span");
    selection.className = "prompt-selection";
    selection.textContent = selectedText;
    const spacer = document.createElement("span");
    spacer.style.width = "22px";
    spacer.style.flexShrink = "0";
    selectionRow.append(spine, selection, spacer);
    toggle.append(selectionRow);
  }

  prompt.append(toggle);

  // 折叠判定：先放开量，超过两行（44px）才给"...更多"（原版同款的测法）
  const collapsedMax = PROMPT_LINES * PROMPT_LINE_HEIGHT;
  requestAnimationFrame(() => {
    const full = toggle.scrollHeight;
    if (full <= collapsedMax) return;
    const more = document.createElement("div");
    more.className = "prompt-more";
    const fade = document.createElement("span");
    fade.className = "prompt-more-fade";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "prompt-more-button";
    button.textContent = t("card.more");
    button.addEventListener("click", () => {
      prompt.classList.add("expanded");
      more.remove();
      const lessRow = document.createElement("div");
      lessRow.className = "prompt-less-row";
      const spacer = document.createElement("span");
      spacer.className = "prompt-less-spacer";
      const less = document.createElement("button");
      less.type = "button";
      less.className = "prompt-less-button";
      less.textContent = t("card.less");
      less.addEventListener("click", () => {
        lessRow.remove();
        prompt.classList.remove("expanded");
        prompt.append(more);
      });
      lessRow.append(spacer, less);
      prompt.append(lessRow);
    });
    more.append(fade, button);
    prompt.append(more);
  });

  return prompt;
}

// ---------- 答案卡 ----------

function buildCard({ answer }) {
  const card = document.createElement("div");
  card.className = "card";

  const header = document.createElement("div");
  header.className = "card-header";
  const title = document.createElement("span");
  title.className = "card-title";
  const titleIcon = document.createElement("span");
  titleIcon.className = "card-title-icon";
  titleIcon.textContent = "✦";
  const titleText = document.createElement("span");
  titleText.className = "card-title-text";
  titleText.textContent = t("card.answerTitle");
  title.append(titleIcon, titleText);

  const actions = document.createElement("span");
  actions.className = "card-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "header-button";
  copy.textContent = "⧉";
  copy.title = t("card.copy");
  wireCopy(copy, () => answer);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "header-button";
  close.textContent = "✕";
  close.title = `${t("card.close")} Esc`;
  close.addEventListener("click", () => window.speakmore.cardClose());
  actions.append(copy, close);

  header.append(title, actions);

  const body = document.createElement("div");
  body.className = "card-body";
  const markdown = document.createElement("div");
  markdown.className = "answer";
  markdown.innerHTML = mdLikeToHtml(answer);
  body.append(markdown);

  card.append(header, body);
  return card;
}

// ---------- 画 + 量高 + 渐显 ----------

function render(next) {
  const run = ++generation;
  payload = next;
  reportedHeight = 0;

  const stage = document.createElement("div");
  stage.className = "stage";
  const content = document.createElement("div");
  content.style.width = "100%";
  content.style.display = "flex";
  content.style.flexDirection = "column";
  content.style.alignItems = "center";
  content.append(buildPrompt(next), buildCard(next));
  stage.append(content);
  $root.replaceChildren(stage);

  // 内容高度变化 → 上报主进程调窗口；就位后渐显（原版同款：量、报、等 150ms、显）
  const report = () => {
    const height = Math.ceil(content.getBoundingClientRect().height + 24 + 64);
    if (!Number.isFinite(height) || height < 1 || height > HEIGHT_MAX || Math.abs(height - reportedHeight) <= HEIGHT_MIN_DELTA) {
      return;
    }
    reportedHeight = height;
    window.speakmore.cardBounds(height).finally(() => {
      if (run !== generation) return;
      setTimeout(() => {
        if (run === generation) {
          stage.classList.add("shown");
          // 临时诊断：渐显时打印实际画出来的关键样式（排查透明度用，查完撤）
          const painted = getComputedStyle(stage);
          const card = document.querySelector(".card");
          console.warn(
            "card shown:",
            JSON.stringify({
              stageOpacity: painted.opacity,
              cardBackground: card ? getComputedStyle(card).backgroundColor : null,
              cardBorder: card ? getComputedStyle(card).borderColor : null,
              bodyBackground: getComputedStyle(document.body).backgroundColor,
              vars: {
                surfaceSolid: getComputedStyle(document.documentElement).getPropertyValue("--surface-solid"),
                surface: getComputedStyle(document.documentElement).getPropertyValue("--surface"),
                bg: getComputedStyle(document.documentElement).getPropertyValue("--bg"),
              },
            }),
          );
        }
      }, REVEAL_DELAY_MS);
    });
  };
  const observer = new ResizeObserver(report);
  observer.observe(content);
  report();
}

// ---------- 载荷与关闭 ----------

window.speakmore.onCardUpdate((next) => {
  if (next) render(next);
});
window.speakmore.cardPayload().then((next) => {
  if (next) render(next);
});

// Esc 关闭（原版同款；窗口可聚焦，Esc 直接收到）
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.speakmore.cardClose();
});
