import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repoDir = resolve(import.meta.dirname, "../../..");

// README 已精简为纯使用说明（无图片、无外链下载）：只确认安装方式和产物名还对得上
test("README 提到 Windows 安装包的文件名", () => {
  const readme = readFileSync(join(repoDir, "README.md"), "utf8");
  assert.ok(readme.includes("Utterly-Setup-x64.exe"), "README 里没有提到 Utterly-Setup-x64.exe");
  assert.ok(!readme.includes("http"), "README 不应该有外链（发布产物由分发渠道提供）");
});
