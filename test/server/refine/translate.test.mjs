import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, msg } from "../../../src/i18n/index.mjs";
import { createLocalRefiner } from "../../../src/server/refine/local.mjs";
import { POLISH_PROMPT, polishInput } from "../../../src/server/refine/polish-prompt.mjs";
import { createPolisher } from "../../../src/server/refine/polisher.mjs";
import { NO_SPEECH_MARK, SYSTEM_PROMPT, TASK_REMINDER } from "../../../src/server/refine/prompt.mjs";
import { createRefiner } from "../../../src/server/refine/refiner.mjs";
import {
  audioTranslatePrompt,
  audioTranslateReminder,
  DEFAULT_TRANSLATE_TARGET,
  polishTranslateInput,
  polishTranslatePrompt,
  TRANSLATE_TARGETS,
  translateName,
} from "../../../src/server/refine/translate-prompt.mjs";

// 翻译这一条：翻译热键的听写在润色那一跳换成翻译的提示词（对齐原版 voice_translation）。
// 提示词、润色器、原生 refiner、private 回退各测各的；协议层的分流在 protocol/server 的测试里。

const zh = createTranslator("zh-CN");
const quiet = { info() {}, warn() {}, error() {} };
const USAGE = {
  model: "deepseek-flash",
  inputTokens: 1043,
  audioTokens: 0,
  cachedTokens: 0,
  outputTokens: 14,
  thinkingTokens: 0,
  costUsd: 0.0001,
};

test("目标语言的清单带默认值，每个都叫得出写进提示词的名字", () => {
  assert.ok(TRANSLATE_TARGETS.includes("en"));
  assert.equal(DEFAULT_TRANSLATE_TARGET, "en");
  for (const id of TRANSLATE_TARGETS) {
    const name = translateName(id);
    assert.equal(typeof name, "string", id);
    assert.match(name, /^[A-Z]/, id);
  }
  // 两种语言的文案里都要写得出每个目标的名字（悬浮条和设置里用）
  for (const locale of ["en", "zh-CN"]) {
    const t = createTranslator(locale);
    for (const id of TRANSLATE_TARGETS) assert.ok(!t(`translate.targets.${id}`).includes("translate.targets"), id);
  }
});

test("两份翻译提示词都点名目标语言，也带着无人声标记的规矩", () => {
  for (const prompt of [polishTranslatePrompt("ja"), audioTranslatePrompt("ja")]) {
    assert.ok(prompt.includes(translateName("ja")));
    assert.ok(prompt.includes(NO_SPEECH_MARK));
  }
  assert.ok(!polishTranslatePrompt("en").includes(POLISH_PROMPT.slice(0, 20)));
  assert.ok(!audioTranslatePrompt("en").includes(SYSTEM_PROMPT.slice(0, 20)));
  assert.ok(audioTranslateReminder("fr").includes(translateName("fr")));
});

test("发给模型的那条用户消息：原文放在标签里，提醒点名目标语言", () => {
  const user = polishTranslateInput("明天开会", "en");
  assert.ok(user.includes("<原文>\n明天开会\n</原文>"));
  assert.ok(user.includes(translateName("en")));
  assert.ok(user.includes("只输出译文"));
});

// ---------- 润色那一跳（local 模式） ----------

function fakeClient(reply) {
  const requests = [];
  return {
    requests,
    async ping() {
      return { usage: USAGE };
    },
    async complete(request) {
      requests.push(request);
      return reply;
    },
  };
}

const polisherWith = (client) => createPolisher({ endpoint: { id: "deepseek", name: "DeepSeek" }, client, log: quiet });

test("带了目标语言的润色：系统提示词和用户消息都换成翻译的那套", async () => {
  const client = fakeClient({ text: "We'll meet tomorrow.", problem: null, usage: USAGE });
  assert.equal(
    await polisherWith(client).polish("嗯那个明天开会", { audioId: "a1", translateTarget: "en" }),
    "We'll meet tomorrow.",
  );
  assert.equal(client.requests[0].system, polishTranslatePrompt("en"));
  assert.equal(client.requests[0].user, polishTranslateInput("嗯那个明天开会", "en"));
});

test("不带目标语言的润色照旧：还是整理的那套提示词", async () => {
  const client = fakeClient({ text: "明天开会。", problem: null, usage: USAGE });
  await polisherWith(client).polish("明天开会", {});
  assert.equal(client.requests[0].system, POLISH_PROMPT);
  assert.equal(client.requests[0].user, polishInput("明天开会"));
});

// ---------- 原生链路（native 模式） ----------

test("原生链路带上目标语言：收音频的模型收到的也是翻译的提示词和提醒", async () => {
  const calls = [];
  const client = {
    async ping() {
      return { usage: USAGE };
    },
    async generate(request) {
      calls.push(request);
      return { text: "We'll meet tomorrow.", problem: null, usage: USAGE };
    },
  };
  const refiner = createRefiner({
    provider: { id: "openai", name: "OpenAI" },
    client,
    audioTypes: ["audio/webm"],
    log: quiet,
  });
  const outcome = await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", translateTarget: "en" });
  assert.equal(outcome, "We'll meet tomorrow.");
  assert.equal(calls[0].systemPrompt, audioTranslatePrompt("en"));
  assert.equal(calls[0].reminder, audioTranslateReminder("en"));
});

test("原生链路不带目标语言照旧：整理的提示词和提醒", async () => {
  const calls = [];
  const client = {
    async ping() {
      return { usage: USAGE };
    },
    async generate(request) {
      calls.push(request);
      return { text: "明天开会。", problem: null, usage: USAGE };
    },
  };
  const refiner = createRefiner({
    provider: { id: "openai", name: "OpenAI" },
    client,
    audioTypes: ["audio/webm"],
    log: quiet,
  });
  await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" });
  assert.equal(calls[0].systemPrompt, SYSTEM_PROMPT);
  assert.equal(calls[0].reminder, TASK_REMINDER);
});

// ---------- private 模式：没有润色那一跳，翻不了 ----------

/** 假的解码和转写：解码回空样本，转写回给定的原文 */
function localParts({ transcript }) {
  return {
    decode: async () => new Float32Array(1_000),
    transcriber: {
      async transcribe() {
        return { text: transcript };
      },
    },
  };
}

test("private 模式的翻译：原文照给，带一句话说清翻不了的原因", async () => {
  const { decode, transcriber } = localParts({ transcript: "明天下午开会" });
  const refiner = createLocalRefiner({ transcriber, polisher: null, log: quiet, decode });
  const outcome = await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm", translateTarget: "en" });
  assert.deepEqual(outcome, { text: "明天下午开会", notice: msg("translate.privateFallback") });
  assert.match(zh.text(outcome.notice), /数据隐私|翻译/);
});

test("private 模式的翻译没转出字时：和普通听写一样只给空字符串，不说翻不了", async () => {
  const { decode, transcriber } = localParts({ transcript: "  " });
  const refiner = createLocalRefiner({ transcriber, polisher: null, log: quiet, decode });
  assert.equal(await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm", translateTarget: "en" }), "");
});

test("local 模式把目标语言交给润色那一跳", async () => {
  const { decode, transcriber } = localParts({ transcript: "明天开会" });
  const seen = [];
  const polisher = {
    async warmUp() {},
    async polish(text, options) {
      seen.push({ text, options });
      return "We'll meet tomorrow.";
    },
  };
  const refiner = createLocalRefiner({ transcriber, polisher, log: quiet, decode });
  assert.deepEqual(
    await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm", audioId: "a9", translateTarget: "en" }),
    { text: "We'll meet tomorrow.", userPrompt: "明天开会" },
  );
  assert.deepEqual(seen, [{ text: "明天开会", options: { signal: undefined, audioId: "a9", translateTarget: "en" } }]);
});
