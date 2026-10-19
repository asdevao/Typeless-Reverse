import assert from "node:assert/strict";
import { test } from "node:test";
import {
  envelope,
  MAX_CHUNK_BYTES,
  ProtocolError,
  parseClientMessage,
} from "../../../src/server/protocol/protocol.mjs";

const rejects = (text, code) =>
  assert.throws(
    () => parseClientMessage(text),
    (error) => error instanceof ProtocolError && error.code === code,
  );

test("服务端消息的外壳是 K/V/T/M/S 五个字段", () => {
  assert.deepEqual(envelope("audio_session_started", { audio_id: "a" }), {
    K: "audio_session_started",
    V: { audio_id: "a" },
    T: "json",
    M: false,
    S: "done",
  });
});

test("start_audio：只取用得到的字段，多余的字段不报错", () => {
  const message = parseClientMessage(
    JSON.stringify({ type: "start_audio", audio_id: "abc", audio_chunk_time: 3, mode: "voice_transcript" }),
  );
  assert.deepEqual(message, {
    type: "start_audio",
    audioId: "abc",
    translateTarget: null,
    commandSelectedText: null,
    command: false,
  });
});

test("start_audio：翻译的模式（voice_translation）带出目标语言，没写用默认的", () => {
  const said = parseClientMessage(
    JSON.stringify({ type: "start_audio", audio_id: "a1", mode: "voice_translation", translate_target: "ja" }),
  );
  assert.deepEqual(said, {
    type: "start_audio",
    audioId: "a1",
    translateTarget: "ja",
    commandSelectedText: null,
    command: false,
  });
  const silent = parseClientMessage(JSON.stringify({ type: "start_audio", audio_id: "a2", mode: "voice_translation" }));
  assert.equal(silent.translateTarget, "en");
  // 普通听写带了目标语言也不算数：mode 说了才算
  const plain = parseClientMessage(
    JSON.stringify({ type: "start_audio", audio_id: "a3", mode: "voice_transcript", translate_target: "ja" }),
  );
  assert.equal(plain.translateTarget, null);
});

test("start_audio：指令的模式（voice_command）带不带选中文本都算指令会话", () => {
  // 没有选区：口述直接当问题（command 是 true，选中文本是 null）
  const bare = parseClientMessage(JSON.stringify({ type: "start_audio", audio_id: "c1", mode: "voice_command" }));
  assert.deepEqual(bare, {
    type: "start_audio",
    audioId: "c1",
    translateTarget: null,
    commandSelectedText: null,
    command: true,
  });
  // 带选中文本：随 start 一起带到
  const withText = parseClientMessage(
    JSON.stringify({ type: "start_audio", audio_id: "c2", mode: "voice_command", command_selected_text: "选中的内容" }),
  );
  assert.equal(withText.commandSelectedText, "选中的内容");
  assert.equal(withText.command, true);
  // 带了空的选中文本：报错（要么不带，要么带非空文本）
  rejects(
    JSON.stringify({ type: "start_audio", audio_id: "c3", mode: "voice_command", command_selected_text: "" }),
    "invalid_field",
  );
});

test("start_audio：不认识的模式、写错的目标语言分别报错", () => {
  rejects(JSON.stringify({ type: "start_audio", audio_id: "a1", mode: "voice_cmmmand" }), "invalid_field");
  rejects(JSON.stringify({ type: "start_audio", audio_id: "a1", mode: 1 }), "invalid_field");
  rejects(
    JSON.stringify({ type: "start_audio", audio_id: "a1", mode: "voice_translation", translate_target: 3 }),
    "invalid_field",
  );
  rejects(
    JSON.stringify({ type: "start_audio", audio_id: "a1", mode: "voice_translation", translate_target: "x".repeat(25) }),
    "invalid_field",
  );
});

test("set_audio_chunk_info：序号和字节数必须是正整数", () => {
  const ok = { type: "set_audio_chunk_info", audio_id: "abc", index: 1, size: 14000, duration: 3 };
  assert.deepEqual(parseClientMessage(JSON.stringify(ok)), {
    type: "set_audio_chunk_info",
    audioId: "abc",
    index: 1,
    size: 14000,
  });
  rejects(JSON.stringify({ ...ok, index: 0 }), "invalid_field");
  rejects(JSON.stringify({ ...ok, index: 1.5 }), "invalid_field");
  rejects(JSON.stringify({ ...ok, size: 0 }), "invalid_field");
  rejects(JSON.stringify({ ...ok, size: "14000" }), "invalid_field");
  rejects(JSON.stringify({ ...ok, size: MAX_CHUNK_BYTES + 1 }), "invalid_field");
});

test("end_audio：要有 audio_id", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "end_audio", audio_id: "abc", total_duration: 12.8 })), {
    type: "end_audio",
    audioId: "abc",
    commandSelectedText: null,
    command: false,
  });
  // 组合键或 ⌘ 中途转成指令的会话：end_audio 用 mode 说清（选中文本有就带上）
  const flipped = parseClientMessage(
    JSON.stringify({ type: "end_audio", audio_id: "abc", total_duration: 1, mode: "voice_command" }),
  );
  assert.equal(flipped.command, true);
  assert.equal(flipped.commandSelectedText, null);
  rejects(JSON.stringify({ type: "end_audio" }), "invalid_field");
  rejects(JSON.stringify({ type: "end_audio", audio_id: "" }), "invalid_field");
  rejects(JSON.stringify({ type: "end_audio", audio_id: "x".repeat(129) }), "invalid_field");
});

test("不是 JSON、不是对象、类型不认识，分别报不同的错", () => {
  rejects("{not json", "invalid_json");
  rejects("[]", "invalid_message");
  rejects("null", "invalid_message");
  rejects(JSON.stringify({ audio_id: "abc" }), "unknown_type");
  rejects(JSON.stringify({ type: "ping" }), "unknown_type");
  // 对象原型上的属性名不能被当成消息类型
  rejects(JSON.stringify({ type: "constructor", audio_id: "abc" }), "unknown_type");
});
