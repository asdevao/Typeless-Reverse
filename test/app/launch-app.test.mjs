import assert from "node:assert/strict";
import { test } from "node:test";
import { launchTargetOf } from "../../src/app/launch-app.mjs";

test("白名单内的应用名和中文别名解析成启动命令", () => {
  assert.equal(launchTargetOf("chrome"), "chrome");
  assert.equal(launchTargetOf("Chrome"), "chrome");
  assert.equal(launchTargetOf("谷歌浏览器"), "chrome");
  assert.equal(launchTargetOf("记事本"), "notepad");
  assert.equal(launchTargetOf("设置"), "ms-settings:");
  assert.equal(launchTargetOf("vscode"), "code");
});

test("白名单外的一律拒绝：模型的字符串绝不进命令行", () => {
  assert.equal(launchTargetOf("format c:"), null);
  assert.equal(launchTargetOf("cmd /c del"), null);
  assert.equal(launchTargetOf("微信"), null);
  assert.equal(launchTargetOf("notepad.exe && calc"), null);
  assert.equal(launchTargetOf(""), null);
  assert.equal(launchTargetOf(null), null);
  assert.equal(launchTargetOf(undefined), null);
});
