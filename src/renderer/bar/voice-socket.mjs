// 和服务端之间的那条 WebSocket。消息名和字段照抄原版（docs/05-network-protocol.md）。
// 只依赖标准的 WebSocket，所以浏览器和 Node 里都能跑，测试直接连真的服务端模块。
// 出错时抛的是 LocalizedError：给人看的那句话（problem）由悬浮条按界面语言翻。

import { LocalizedError, msg } from "../../i18n/index.mjs";

/** 原版听写等成品的超时：VOICE_TRANSCRIPT_REFINE_TIMEOUT_MS */
export const REFINE_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CHUNK_SECONDS = 3;

export class VoiceSocket {
  #url;
  #socket = null;
  /** 当前这次录音：{ audioId, nextIndex, sending, failure, settle } */
  #current = null;
  /** 翻译的那次要翻成哪种语言；普通听写是 null（start_audio / end_audio 的 mode 都要带） */
  #translateTarget = null;
  /** 指令的那次要用的选中文本；普通听写是 null（start_audio 的 command_selected_text 要带） */
  #commandSelectedText = null;
  /** 这次是不是指令会话：没有选区的指令问答也是 true */
  #command = false;

  constructor(url) {
    this.#url = url;
  }

  /** 用的时候才连，连着就复用。原版也是这样：空闲被断开后，下次按键再连 */
  async #connected() {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    const socket = new WebSocket(this.#url);
    socket.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new LocalizedError(msg("voice.connectTimeout")));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new LocalizedError(msg("voice.unreachable", { url: this.#url })));
      });
    });
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.#socket === socket) this.#socket = null;
      this.#fail(new LocalizedError(msg("voice.disconnected")));
    });
    this.#socket = socket;
    return socket;
  }

  /**
   * 开始一次录音。连不上会在这里抛出
   * @param {string} audioId
   * @param {{ translateTarget?: string, commandSelectedText?: string, command?: boolean }} [options]
   *   translateTarget：翻译的那次：要翻成哪种语言。
   *   commandSelectedText：指令的那次：开始前抓好的选中文本（随 start_audio 带给服务端）。
   *   command：这次是不是指令会话（没有选区的指令问答也带 true，mode 用 voice_command）
   */
  async begin(audioId, { translateTarget = null, commandSelectedText = null, command = false } = {}) {
    const socket = await this.#connected();
    this.#current = { audioId, nextIndex: 1, sending: Promise.resolve(), failure: null, settle: null };
    this.#translateTarget = translateTarget;
    this.#commandSelectedText = commandSelectedText;
    this.#command = command || commandSelectedText !== null;
    socket.send(
      JSON.stringify({
        type: "start_audio",
        audio_id: audioId,
        audio_chunk_time: CHUNK_SECONDS,
        audio_metadata: { audio_format: "webm", audio_codec: "opus", audio_channels: 1, need_merge: true },
        // 原版听多种模式（docs/04-voice-pipeline.md）；翻译的目标语言跟着 mode 一起带过去。
        // 指令会话没有选区也算指令（口述直接当问题，答案弹通知）
        mode:
          this.#command
            ? "voice_command"
            : translateTarget === null
              ? "voice_transcript"
              : "voice_translation",
        ...(translateTarget === null ? {} : { translate_target: translateTarget }),
        ...(commandSelectedText === null ? {} : { command_selected_text: commandSelectedText }),
      }),
    );
  }

  /**
   * 指令会话中途补发选中文本（主进程在 Space 按下后抓的）。服务端把它挂到这次录音上，
   * 整理时换指令的提示词。没有进行中的录音、或文本为空时忽略
   * @param {string} text
   */
  setCommandSelection(text) {
    const current = this.#current;
    if (!current || text === null || text === undefined || text === "") return;
    this.#socket.send(JSON.stringify({ type: "set_command_selected_text", audio_id: current.audioId, text }));
  }

  /**
   * 发一块音频。录音器每 3 秒吐一块，这里排队按序发：
   * 取字节数是异步的，不排队的话后一块可能抢到前一块前面。
   * @param {Blob} blob
   */
  sendChunk(blob) {
    const current = this.#current;
    if (!current) throw new Error("还没有开始录音就发了音频块");
    current.sending = current.sending.then(async () => {
      const bytes = await blob.arrayBuffer();
      if (this.#current !== current || current.failure) return;
      const index = current.nextIndex++;
      this.#socket.send(
        JSON.stringify({ type: "set_audio_chunk_info", audio_id: current.audioId, index, size: bytes.byteLength }),
      );
      this.#socket.send(bytes);
    });
    // 发送失败记在这次录音上，finish 时一并报出来，不让它变成没人接的拒绝
    current.sending = current.sending.catch((error) => this.#fail(error));
  }

  /**
   * 结束录音，等成品文字。
   * @param {{ durationSeconds: number, timeoutMs?: number, commandSelectedText?: string | null, command?: boolean }} [options]
   *   commandSelectedText：点 ⌘ 的那次结束时才抓好的选中文本（随 end_audio 带给服务端）。
   *   command：这次是不是指令会话（组合键或 ⌘ 中途转的，start_audio 里还没说清）
   * @returns {Promise<{ text: string, notice: object | null, delivery: string | null, externalTarget: string | null }>}
   *   text 是成品；notice 是服务端带的一句话（一句 msg，比如 private 模式翻不了时说的原因），没有是 null。
   *   没有人声时 text 是空字符串。delivery / externalTarget 只有指令会话可能有值
   */
  async finish({ durationSeconds, timeoutMs = REFINE_TIMEOUT_MS, commandSelectedText = null, command = false } = {}) {
    const current = this.#current;
    if (!current) throw new Error("还没有开始录音就结束了");
    await current.sending;
    if (current.failure) {
      this.#current = null;
      throw current.failure;
    }
    const result = new Promise((resolve, reject) => {
      current.settle = { resolve, reject };
    });
    // ⌘ 的那次选中文本到结束才抓好：先记下再发 end；组合键或 ⌘ 中途转的指令会话在这里把 mode 说清
    if (commandSelectedText !== null) this.#commandSelectedText = commandSelectedText;
    if (command) this.#command = true;
    this.#socket.send(
      JSON.stringify({
        type: "end_audio",
        audio_id: current.audioId,
        total_duration: durationSeconds,
        mode:
          this.#command || this.#commandSelectedText !== null
            ? "voice_command"
            : this.#translateTarget === null
              ? "voice_transcript"
              : "voice_translation",
        ...(this.#commandSelectedText === null ? {} : { command_selected_text: this.#commandSelectedText }),
      }),
    );
    const timer = setTimeout(
      () => this.#fail(new LocalizedError(msg("voice.timeout", { seconds: timeoutMs / 1000 }))),
      timeoutMs,
    );
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      if (this.#current === current) this.#current = null;
    }
  }

  /** 丢弃当前这次录音。服务端在下一个 start_audio 或断开时清掉它那边的状态 */
  abandon() {
    this.#current = null;
  }

  close() {
    this.#current = null;
    this.#socket?.close();
    this.#socket = null;
  }

  #fail(error) {
    const current = this.#current;
    if (!current || current.failure) return;
    current.failure = error;
    current.settle?.reject(error);
  }

  #onMessage(data) {
    const { K: kind, V: value } = JSON.parse(data);
    const current = this.#current;
    // 上一次录音迟到的消息不能算到这一次头上
    if (!current || (value.audio_id && value.audio_id !== current.audioId)) return;
    switch (kind) {
      case "audio_processing_completed":
        // delivery / external_action：指令会话的交付方式（reply 弹通知、external 打开链接），普通听写是 null
        current.settle?.resolve({
          text: value.refined_text,
          notice: value.notice ?? null,
          delivery: value.delivery ?? null,
          externalTarget: value.external_action?.target ?? null,
        });
        break;
      case "audio_processing_error":
      case "error":
        // 服务端说得清的（模型那边的原因）带着 problem；协议层面的毛病只有 code 和 detail
        this.#fail(
          new LocalizedError(value.problem ?? msg("voice.serverError", { code: value.code, detail: value.detail })),
        );
        break;
      // audio_session_started、received_audio_chunk_count、audio_session_ending 只是进度，用不到
    }
  }
}
