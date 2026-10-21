import { DEFAULT_TRANSLATE_TARGET } from "../refine/translate-prompt.mjs";

// 听写协议里本服务端用到的那一部分。
// 消息名和字段名照抄 Typeless 抓包的实测结果（docs/05-network-protocol.md），
// 这样仿刻的两端和逆向文档能一一对上。原版还有上下文、模式配置等消息，这里没有发送方，就不实现。
// 原版听三种模式（voice_transcript / voice_command / voice_translation，docs/04-voice-pipeline.md），
// 三种都实现了：指令会话（voice_command）可以带选中文本，也可以不带（口述直接当问题，答案弹通知）。
// 翻译的目标语言（translate_target）只在这一个模块里认，清单和叫法在 refine/translate-prompt.mjs。

/** 3 秒一块实测 14–15 KB，这里留足余量；也用作 WebSocket 单帧上限 */
export const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_AUDIO_ID_LENGTH = 128;
/** 目标语言的写法：像语言标签（en、zh、pt-BR），别让一段话混进来 */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z]{2,8})?$/;
const MAX_TARGET_LENGTH = 24;

export const ClientType = Object.freeze({
  START: "start_audio",
  CHUNK_INFO: "set_audio_chunk_info",
  END: "end_audio",
  SET: "set_command_selected_text",
});

export const ServerType = Object.freeze({
  STARTED: "audio_session_started",
  CHUNK_RECEIVED: "received_audio_chunk_count",
  ENDING: "audio_session_ending",
  COMPLETED: "audio_processing_completed",
  PROCESSING_ERROR: "audio_processing_error",
  ERROR: "error",
});

/** 客户端发来的东西不合协议。code 给程序判断，detail 给人看 */
export class ProtocolError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "ProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

/** 服务端消息的外壳。T/M/S 在抓包里只见过这一组取值 */
export function envelope(kind, value) {
  return { K: kind, V: value, T: "json", M: false, S: "done" };
}

function audioIdOf(message) {
  const id = message.audio_id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_AUDIO_ID_LENGTH) {
    throw new ProtocolError("invalid_field", `audio_id 要是 1–${MAX_AUDIO_ID_LENGTH} 个字符的字符串`);
  }
  return id;
}

function positiveInteger(message, field, max) {
  const value = message[field];
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ProtocolError("invalid_field", `${field} 要是 1–${max} 之间的整数`);
  }
  return value;
}

// 用 Map 而不是对象字面量：消息类型来自外部输入，不能让 "constructor" 这类原型属性名查到东西
const PARSERS = new Map([
  [
    ClientType.START,
    (message) => ({
      type: ClientType.START,
      audioId: audioIdOf(message),
      // 普通听写是 null；翻译的那次是要翻成的语言。没写 mode 当普通听写（抓包里原版一直发这个字段）
      translateTarget: translateTargetOf(message),
      // 指令的那次：悬浮条在按下指令键时抓好的选中文本；普通听写是 null
      commandSelectedText: startCommandSelectedTextOf(message),
      // 这次是不是指令会话：voice_command 就是（没带选中文本也算，口述直接当问题）
      command: (message.mode ?? "voice_transcript") === "voice_command",
    }),
  ],
  [
    ClientType.CHUNK_INFO,
    (message) => ({
      type: ClientType.CHUNK_INFO,
      audioId: audioIdOf(message),
      index: positiveInteger(message, "index", Number.MAX_SAFE_INTEGER),
      size: positiveInteger(message, "size", MAX_CHUNK_BYTES),
    }),
  ],
  [ClientType.END, (message) => ({ type: ClientType.END, audioId: audioIdOf(message), commandSelectedText: commandSelectedTextOf(message), command: (message.mode ?? "voice_transcript") === "voice_command", translateTarget: endTranslateTargetOf(message) })],
]);

const MAX_COMMAND_TEXT_LENGTH = 100_000;

/** end_audio 上带的翻译目标语言（说到一半在悬浮条上换的那种）：没带就是 null（不换），带了就按语言标签校验 */
function endTranslateTargetOf(message) {
  const value = message.translate_target;
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > MAX_TARGET_LENGTH || !LANGUAGE_TAG.test(value)) {
    throw new ProtocolError("invalid_field", `translate_target 要是语言标签（en、zh、pt-BR），收到 ${String(value).slice(0, 64)}`);
  }
  return value;
}

/** end_audio 上带的选中文本（指令的那次）：没带就是 null */
function commandSelectedTextOf(message) {
  const value = message.command_selected_text;
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_COMMAND_TEXT_LENGTH) {
    throw new ProtocolError(
      "invalid_field",
      `command_selected_text 要是不超过 ${MAX_COMMAND_TEXT_LENGTH} 字的非空文本，收到 ${String(value).slice(0, 64)}`,
    );
  }
  return value;
}

/** start_audio 的 mode / translate_target → 要翻成哪种语言（不用翻是 null） */
function translateTargetOf(message) {
  const mode = message.mode ?? "voice_transcript";
  // 指令会话不翻译；没带 mode 当普通听写
  if (mode === "voice_transcript" || mode === "voice_command") return null;
  if (mode !== "voice_translation") {
    throw new ProtocolError(
      "invalid_field",
      `mode 只认 voice_transcript / voice_translation / voice_command，收到 ${String(mode).slice(0, 64)}`,
    );
  }
  // 没写目标语言用默认的（en）：单独启动服务端调试时少写一个字段
  const target = message.translate_target ?? DEFAULT_TRANSLATE_TARGET;
  if (typeof target !== "string" || target.length > MAX_TARGET_LENGTH || !LANGUAGE_TAG.test(target)) {
    throw new ProtocolError("invalid_field", `translate_target 要是语言标签（en、zh、pt-BR），收到 ${String(target).slice(0, 64)}`);
  }
  return target;
}

/** start_audio 的 mode / command_selected_text → 指令的那次要用的选中文本（不是指令就是 null） */
function startCommandSelectedTextOf(message) {
  const mode = message.mode ?? "voice_transcript";
  const value = message.command_selected_text;
  if (mode !== "voice_command" || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_COMMAND_TEXT_LENGTH) {
    throw new ProtocolError(
      "invalid_field",
      `command_selected_text 要是不超过 ${MAX_COMMAND_TEXT_LENGTH} 字的非空文本，收到 ${String(value).slice(0, 64)}`,
    );
  }
  return value;
}

/** 解析并校验一条文本消息，只留下服务端用得到的字段 */
export function parseClientMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_json", "文本帧不是合法的 JSON");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new ProtocolError("invalid_message", "消息必须是 JSON 对象");
  }
  const parse = PARSERS.get(message.type);
  if (!parse) {
    throw new ProtocolError("unknown_type", `不认识的消息类型：${String(message.type).slice(0, 64)}`);
  }
  return parse(message);
}
