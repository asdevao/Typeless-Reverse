import assert from "node:assert/strict";
import { test } from "node:test";
import { litBarsOf } from "../../../src/renderer/shared/volume-bars.mjs";

test("点亮根数：低于阈值全灭，过了阈值向上取整", () => {
  assert.equal(litBarsOf(0, 6), 0);
  assert.equal(litBarsOf(0.119, 6), 0);
  // 恰好到阈值：ceil(0.12 × 6) = ceil(0.72) = 1
  assert.equal(litBarsOf(0.12, 6), 1);
  assert.equal(litBarsOf(0.2, 6), 2);
  assert.equal(litBarsOf(0.5, 6), 3);
});

test("点亮根数：到顶封住、负数归零（音量先夹到 0..1）", () => {
  assert.equal(litBarsOf(1, 6), 6);
  assert.equal(litBarsOf(1.5, 6), 6);
  assert.equal(litBarsOf(-1, 6), 0);
  assert.equal(litBarsOf(NaN, 6), 0);
});

test("阈值和根数都跟着参数走", () => {
  // 根数多一颗就多一档
  assert.equal(litBarsOf(0.5, 10), 5);
  // 阈值抬高：小音量全灭
  assert.equal(litBarsOf(0.3, 6, 0.4), 0);
  assert.equal(litBarsOf(0.4, 6, 0.4), 3);
});
