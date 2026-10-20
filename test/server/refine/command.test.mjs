import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askInput,
  audioAskReminder,
  audioCommandPrompt,
  parseCommandDelivery,
  parseCommandJson,
  polishAskPrompt,
} from "../../../src/server/refine/command-prompt.mjs";

test("没有标记：按 replace 贴回选区，文字原样带回", () => {
  assert.deepEqual(parseCommandDelivery("把这段改成正式语气"), {
    delivery: "replace",
    text: "把这段改成正式语气",
    target: null,
  });
});

test("[reply] 标记：同行和换行都认，答案从标记后取", () => {
  assert.deepEqual(parseCommandDelivery("[reply] 这段的意思是……"), {
    delivery: "reply",
    text: "这段的意思是……",
    target: null,
  });
  assert.deepEqual(parseCommandDelivery("[reply]\n这段的意思是……"), {
    delivery: "reply",
    text: "这段的意思是……",
    target: null,
  });
});

test("[open] 标记：合法网址交给 external，标记后的多余行忽略", () => {
  assert.deepEqual(parseCommandDelivery("[open] https://github.com\n已为你打开"), {
    delivery: "external",
    text: "https://github.com",
    target: "https://github.com",
  });
});

test("[open] 带不放行的协议：降级为 replace 原样贴出", () => {
  const parsed = parseCommandDelivery("[open] javascript:alert(1)");
  assert.equal(parsed.delivery, "replace");
  assert.equal(parsed.target, null);
});

test("[open] 后面跟的不是网址（如“浏览器”）：按 replace 贴出去掉标记后的内容，不把 [open] 字样贴出来", () => {
  const parsed = parseCommandDelivery("[open] 浏览器");
  assert.equal(parsed.delivery, "replace");
  assert.equal(parsed.text, "浏览器");
  assert.equal(parsed.target, null);
});

test("标记不在开头：当成普通文字处理", () => {
  assert.equal(parseCommandDelivery("先说一句 [reply] 在后面").delivery, "replace");
});

test("标记大小写不敏感：[Reply] 也认", () => {
  assert.deepEqual(parseCommandDelivery("[Reply]\n答案"), {
    delivery: "reply",
    text: "答案",
    target: null,
  });
});

test("无选区的问答提示词：口述放标签里，规矩里有 [reply]/[open]/普通听写三分", () => {
  const system = polishAskPrompt();
  assert.ok(system.includes("<口述>"));
  assert.ok(system.includes("[reply]"));
  assert.ok(system.includes("[open]"));
  assert.ok(system.includes("没有选中任何文字"));
  const user = askInput("今天适合穿什么");
  assert.ok(user.startsWith("<口述>\n今天适合穿什么\n</口述>"));
});

test("原生链路的指令提示词：有选区嵌选中文本，没选区换问答的规矩和提醒", () => {
  const withText = audioCommandPrompt("选中的一段话");
  assert.ok(withText.includes("<选中文本>"));
  assert.ok(withText.includes("选中的一段话"));
  const bare = audioCommandPrompt(null);
  assert.ok(!bare.includes("<选中文本>"));
  assert.ok(bare.includes("没有选中任何文字"));
  assert.ok(audioAskReminder().includes("口述"));
});

test("[open] 的目标在下一行也认（模型常把网址换行写）；裸域名自动补 https://", () => {
  const nextLine = parseCommandDelivery("[open]\nhttps://www.google.com");
  assert.equal(nextLine.delivery, "external");
  assert.equal(nextLine.target, "https://www.google.com");
  const bare = parseCommandDelivery("[open] www.google.com");
  assert.equal(bare.delivery, "external");
  assert.equal(bare.target, "https://www.google.com");
});

test("[open] 下一行跟的是词（浏览器）不是网址：剥标记贴回，不吐 [open] 字样", () => {
  const parsed = parseCommandDelivery("[open]\n浏览器");
  assert.equal(parsed.delivery, "replace");
  assert.ok(!parsed.text.includes("[open]"));
});

test("parseCommandJson：reply/open/replace 三值各走各的，url 修裸域名", () => {
  const reply = parseCommandJson('{"delivery":"reply","content":"今天晴。","url":""}');
  assert.deepEqual(reply, { delivery: "reply", text: "今天晴。", target: null });
  const open = parseCommandJson('{"delivery":"open","content":"","url":"www.google.com"}');
  assert.equal(open.delivery, "external");
  assert.equal(open.target, "https://www.google.com");
  const replace = parseCommandJson('{"delivery":"replace","content":"改写结果","url":""}');
  assert.deepEqual(replace, { delivery: "replace", text: "改写结果", target: null });
});

test("parseCommandJson：坏 url 贴 content；坏 JSON 退回首行标记解析", () => {
  const badUrl = parseCommandJson('{"delivery":"open","content":"备用文字","url":"chrome://history"}');
  assert.deepEqual(badUrl, { delivery: "replace", text: "备用文字", target: null });
  const marker = parseCommandJson('[reply]\n标记答案');
  assert.deepEqual(marker, { delivery: "reply", text: "标记答案", target: null });
  const wrapped = parseCommandJson('说明文字 {"delivery":"reply","content":"包着的","url":""} 尾巴');
  assert.equal(wrapped.text, "包着的");
});
