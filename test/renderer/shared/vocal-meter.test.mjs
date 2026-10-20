import assert from "node:assert/strict";
import { test } from "node:test";
import { responseLevel, vocalBarCount } from "../../../src/renderer/shared/vocal-meter.mjs";

// 曲线带随机抖动：单点结论靠不住，每个档位采一批看上下界（原版系数下各档的期望区间）

/** 一个档位采 count 次，返回最小/最大 */
function band(effective, count = 300) {
  let min = 1;
  let max = 0;
  for (let i = 0; i < count; i++) {
    const level = responseLevel(effective);
    min = Math.min(min, level);
    max = Math.max(max, level);
  }
  return { min, max };
}

test("安静段：有会动的底（呼吸感），不超过过渡段的下沿", () => {
  const silence = band(0);
  // 底 0.15 + 随机 0.04：全部落在 0.15 到 0.19 附近
  assert.ok(silence.min >= 0.15, `最小 ${silence.min}`);
  assert.ok(silence.max <= 0.2, `最大 ${silence.max}`);
  const nearNoise = band(0.029);
  // 接近噪底阈值时爬到 noise 段上沿（0.15 + 0.22 附近）
  assert.ok(nearNoise.max > 0.3, `最大 ${nearNoise.max}`);
  assert.ok(nearNoise.max <= 0.42, `最大 ${nearNoise.max}`);
});

test("过渡段：夹在 0.36 到 0.86 之间，两头都够得着", () => {
  const low = band(0.035);
  assert.ok(low.min >= 0.36, `最小 ${low.min}`);
  assert.ok(low.max <= 0.86, `最大 ${low.max}`);
  const high = band(0.095);
  assert.ok(high.min >= 0.36, `最小 ${high.min}`);
  assert.ok(high.max <= 0.86, `最大 ${high.max}`);
  // 从下沿到上沿总体是抬升的
  assert.ok(high.min >= low.min, `${high.min} >= ${low.min}`);
});

test("说话段：至少 0.52 起，最大不超过 1；越大声越高", () => {
  const talking = band(0.12);
  assert.ok(talking.min >= 0.52, `最小 ${talking.min}`);
  assert.ok(talking.max <= 1, `最大 ${talking.max}`);
  const loud = band(1);
  assert.ok(loud.min >= 0.52, `最小 ${loud.min}`);
  assert.ok(loud.max <= 1, `最大 ${loud.max}`);
  // 满音量的整体区间比刚过阈值的更高
  const mean = (b) => (b.min + b.max) / 2;
  assert.ok(mean(loud) > mean(talking), `${mean(loud)} > ${mean(talking)}`);
});

test("容器宽度换算成竖条数：和原版同一个公式，再窄也保住一根", () => {
  assert.equal(vocalBarCount(200), 50);
  assert.equal(vocalBarCount(7), 2);
  assert.equal(vocalBarCount(3), 1);
  assert.equal(vocalBarCount(0), 1);
});
