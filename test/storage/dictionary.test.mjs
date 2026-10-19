import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addEntry,
  applyHotwords,
  loadDictionary,
  parseDictionaryCsv,
  removeEntry,
  saveDictionary,
} from "../../src/storage/dictionary.mjs";

test("applyHotwords：长短语优先于它的子串，拉丁文不区分大小写", () => {
  const entries = [
    { wrong: "给哈布", correct: "GitHub" },
    { wrong: "给哈布爱克神", correct: "GitHub Actions" },
    { wrong: "瑞艾克特", correct: "React" },
  ];
  assert.equal(applyHotwords("把给哈布爱克神的流程讲一下", entries), "把 GitHub Actions 的流程讲一下");
  assert.equal(applyHotwords("去给哈布上看 issue", entries), "去 GitHub 上看 issue");
  assert.equal(applyHotwords("用瑞艾克特写个页面", entries), "用 React 写个页面");
});

test("applyHotwords：空词典原样返回", () => {
  assert.equal(applyHotwords("原文不动", []), "原文不动");
});

test("addEntry：wrong 相同的覆盖，边界值拒绝", () => {
  let entries = [];
  entries = addEntry(entries, "给哈布", "GitHub");
  entries = addEntry(entries, "给哈布", "GitHub 改");
  assert.deepEqual(entries, [{ wrong: "给哈布", correct: "GitHub 改" }]);
  assert.throws(() => addEntry(entries, "  ", "x"), TypeError);
  assert.throws(() => addEntry(entries, "x", ""), TypeError);
});

test("removeEntry：删错名字的不存在的条目不报错", () => {
  const entries = [{ wrong: "给哈布", correct: "GitHub" }];
  assert.deepEqual(removeEntry(entries, "不存在的"), entries);
  assert.deepEqual(removeEntry(entries, "给哈布"), []);
});

test("parseDictionaryCsv：跳过表头和残行，中英文表头都认", () => {
  const csv = "wrong,correct\n给哈布,GitHub\n\n只有一半\n";
  assert.deepEqual(parseDictionaryCsv(csv), [{ wrong: "给哈布", correct: "GitHub" }]);
  const zhHeader = "错误写法,正确写法\n瑞艾克特,React";
  assert.deepEqual(parseDictionaryCsv(zhHeader), [{ wrong: "瑞艾克特", correct: "React" }]);
});

test("load/save：绕文件走一圈，坏 JSON 当空表", () => {
  const dir = mkdtempSync(join(tmpdir(), "speakmore-dict-"));
  const file = join(dir, "dictionary.json");
  assert.deepEqual(loadDictionary(file), []);
  saveDictionary(file, addEntry(loadDictionary(file), "给哈布", "GitHub"));
  assert.deepEqual(loadDictionary(file), [{ wrong: "给哈布", correct: "GitHub" }]);
  writeFileSync(file, "{坏了");
  assert.deepEqual(loadDictionary(file), []);
});
