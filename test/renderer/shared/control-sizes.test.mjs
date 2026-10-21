import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// 界面规范的尺寸（docs/desktop-ui-spec.md 第 2 节）：控件高度三档（--control-sm/md/lg），圆角四档（--radius-*）。
// 一行里的按钮、徽标高矮不一，多半是谁顺手写了个 30px，所以由测试守着，做法同字号的测试（type-scale.test.mjs）。

const RENDERER = join(import.meta.dirname, "../../../src/renderer");

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** 一个样式文件里的规则：选择器、声明、起始行号。只拆平铺的规则，@media / @container 里的也照样拆出来 */
function rules(path) {
  const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found = [];
  for (const match of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const line = css.slice(0, match.index).split("\n").length;
    found.push({
      selector: match[1].trim(),
      body: match[2],
      at: `${relative(RENDERER, path).replaceAll("\\", "/")}:${line}`,
    });
  }
  return found;
}

/** 规范里的控件：它们的高度只能是三档之一。只看选择器最后那一段（.button .icon 说的是按钮里的图标，不是按钮） */
const CONTROL = /\.(button|input|select|badge|check|pill|tab|segmented|state-box|toggle|icon-button)(?![\w-])/;
const isControl = (selector) =>
  selector.split(",").some((part) =>
    CONTROL.test(
      part
        .trim()
        .split(/\s*[\s>+~]\s*/)
        .pop(),
    ),
  );

test("控件的高度只用 --control-sm / md / lg", () => {
  const offenders = cssFiles(RENDERER)
    .flatMap(rules)
    .filter(({ selector }) => isControl(selector))
    .flatMap(({ selector, body, at }) =>
      [...body.matchAll(/(?:^|;)\s*height:\s*([^;]+)/g)]
        .map(([, value]) => value.trim())
        .filter((value) => !/^var\(--control-(sm|md|lg)\)$/.test(value))
        .map((value) => `${at}  ${selector} { height: ${value} }`),
    );
  assert.deepEqual(offenders, []);
});

/**
 * 不走圆角四档的例外，各有缘由：都是装饰性的细线、小格子，或者悬浮条自己的形状（它不是普通窗口，不套窗口的规范）
 */
/** 一个角的圆角：token、全圆、直角，或者 token 算出来的 */
const RADIUS_VALUE = /^(50%|0|var\(--radius-[a-z]+\)|calc\(var\(--radius-[a-z]+\)[^)]*\))$/;

const RADIUS_EXCEPTIONS = [
  ["bar/", "悬浮条自己的形状和电平条"],
  ["shared/window.css:.tabs > .indicator", "分类标签下面那条 2px 的下划线"],
  ["hub/hub.css:.cell", "首页活跃度热力图的小格子"],
  ["hub/hub.css:.page-arrow", "热力图翻页的小箭头"],
  ["hub/hub.css:.mic-dialog", "选择麦克风弹窗的 16px 圆角，尺寸对齐原版"],
  ["hub/hub.css:.mic-device", "麦克风设备行的 10px 圆角，对齐原版"],
  ["hub/hub.css:.mic-volume span", "音量竖条的胶囊头（999px），对齐原版"],
  ["hub/hub.css:.mic-save", "保存按钮的胶囊头（999px），对齐原版"],
  ["card/card.css:.card", "结果卡片的 12px 圆角，尺寸对齐原版"],
  ["card/card.css:.prompt-copy", "问题行复制按钮的 4px，对齐原版"],
  ["card/card.css:.header-button", "卡片头部按钮的 4px，对齐原版"],
  ["card/card.css:.prompt-spine::before", "折叠指示器 1px 竖线的胶囊头（999px），对齐原版"],
  ["card/card.css:.answer code", "行内代码的 4px，对齐原版"],
  ["card/card.css:.answer pre", "代码块的 8px，对齐原版"],
  ["hub/hub.css:.history-tabs", "历史页胶囊标签组的 9999px，对齐原版"],
  ["hub/hub.css:.history-tab", "历史页胶囊标签项的 9999px，对齐原版"],
  ["hub/hub.css:.shortcuts", "首页快捷键列表的 20px 圆角，对齐原版"],
];

test("圆角只用 --radius-*（或者全圆的 50%），例外都写明了缘由", () => {
  const offenders = cssFiles(RENDERER)
    .flatMap(rules)
    .flatMap(({ selector, body, at }) =>
      [...body.matchAll(/(?:^|;)\s*border-radius:\s*([^;]+)/g)]
        .map(([, value]) => value.trim())
        .filter((value) => !value.split(/\s+(?![^(]*\))/).every((part) => RADIUS_VALUE.test(part)))
        .map((value) => ({ at, selector, value })),
    )
    .filter(
      ({ at, selector }) =>
        !RADIUS_EXCEPTIONS.some(([where]) =>
          where.endsWith("/") ? at.startsWith(where) : `${at.split(":")[0]}:${selector}` === where,
        ),
    )
    .map(({ at, selector, value }) => `${at}  ${selector} { border-radius: ${value} }`);
  assert.deepEqual(offenders, []);
});

test("查得到违规的写法：控件认得准，写死的圆角认得出", () => {
  assert.ok(isControl(".row .button.block"));
  assert.ok(isControl(".search .input"));
  assert.ok(!isControl(".button .icon"));
  assert.ok(!isControl(".buttons-row"));
  assert.ok(!isControl(".tabs"));
  assert.ok(RADIUS_VALUE.test("var(--radius-card)"));
  assert.ok(!RADIUS_VALUE.test("6px"));
});
