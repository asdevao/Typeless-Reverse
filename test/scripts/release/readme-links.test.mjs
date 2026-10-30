import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { WINDOWS_SETUP } from "../../../scripts/release/release-layout.mjs";

const repoDir = resolve(import.meta.dirname, "../../..");
/** 中文是主页（README.md），英文是切换过去的那一份（README.en.md）：两份都写着安装包的下载链接 */
const READMES = ["README.md", "README.en.md"];

// README 已重写为无图版本（不再引用图片桶和 Mac dmg），只保留 Windows 安装程序的链接与版本一致性检查
for (const name of READMES) {
  test(`${name} 里安装包的下载链接指向 package.json 的这个版本，Windows 安装程序在列`, () => {
    const { version } = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
    const readme = readFileSync(join(repoDir, name), "utf8");
    const link = `https://dl.zephyrxiang.com/speakmore/v${version}/${WINDOWS_SETUP}`;
    assert.ok(readme.includes(link), `${name} 里没有 ${link}：升了版本号要一起改下载链接`);
  });
}

test("两份 README 顶上能互相切换", () => {
  const chinese = readFileSync(join(repoDir, "README.md"), "utf8");
  const english = readFileSync(join(repoDir, "README.en.md"), "utf8");
  assert.ok(chinese.includes('href="README.en.md"'), "README.md 顶上没有切到英文的链接");
  assert.ok(english.includes('href="README.md"'), "README.en.md 顶上没有切回中文的链接");
});
