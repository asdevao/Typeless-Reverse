import assert from "node:assert/strict";
import { test } from "node:test";
import { mdLikeToHtml } from "../../src/app/rich-text.mjs";

test("单行纯文本：一个段落，无格式标记", () => {
  assert.equal(mdLikeToHtml("今天下午三点开会"), "<p>今天下午三点开会</p>");
});

test("多行不空行分隔：一行一个 <br>", () => {
  assert.equal(mdLikeToHtml("第一行\n第二行"), "<p>第一行<br>第二行</p>");
});

test("空行分段：每段一个 <p>", () => {
  assert.equal(mdLikeToHtml("第一段\n\n第二段"), "<p>第一段</p>\n<p>第二段</p>");
});

test("编号列表：转 <ol><li>，序号符号剥掉", () => {
  assert.equal(
    mdLikeToHtml("有两个重点：\n1. 性能要过压测\n2. 回滚方案要有"),
    "<p>有两个重点：</p>\n<ol><li>性能要过压测</li><li>回滚方案要有</li></ol>",
  );
});

test("破折号列表：转 <ul><li>", () => {
  assert.equal(mdLikeToHtml("采购清单：\n- 苹果\n- 香蕉"), "<p>采购清单：</p>\n<ul><li>苹果</li><li>香蕉</li></ul>");
});

test("粗体和行内代码：转 <strong>/<code>", () => {
  assert.equal(mdLikeToHtml("**加粗** 和 `code()`"), "<p><strong>加粗</strong> 和 <code>code()</code></p>");
});

test("HTML 特殊字符先转义：模型输出带标签也不会被执行", () => {
  assert.equal(mdLikeToHtml("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

test("编号列表和段落混排：各归各的块", () => {
  assert.equal(
    mdLikeToHtml("结论如下：\n1. 先上线\n2. 再观察\n\n以上。"),
    "<p>结论如下：</p>\n<ol><li>先上线</li><li>再观察</li></ol>\n<p>以上。</p>",
  );
});
