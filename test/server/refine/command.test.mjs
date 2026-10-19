import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommandDelivery } from "../../../src/server/refine/command-prompt.mjs";

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
