// 悬浮条：把按键和点击喂给状态机，按状态机给出的动作去录音、上传、交付。
// 画面不在这里：该是什么样子由 bar-view.mjs 算，画出来由 bar-ui.mjs 管。

import { LocalizedError, msg, problemOf } from "../../i18n/index.mjs";
import { keycapOf, localize, setLocale, t } from "../shared/i18n.mjs";
import { createBarUi } from "./bar-ui.mjs";
import { viewOf, View } from "./bar-view.mjs";
import { Action, initialState, LONG_PRESS_MS, Phase, transition } from "./machine.mjs";
import { startRecording } from "./recorder.mjs";
import { createSounds } from "./sounds.mjs";
import { VoiceSocket } from "./voice-socket.mjs";

/** 原版的单次录音上限：9 分钟 */
const MAX_DURATION_MS = 540_000;

// 页面的 lang 跟着界面语言：提示是 aria-live 的，读屏软件按它挑用哪种语言念
localize();
const {
  serverUrl,
  hotkey: initialHotkey,
  translateHotkey: initialTranslateHotkey,
  translateTarget: initialTranslateTarget,
  microphoneDeviceId: initialMicrophoneDeviceId,
  barControls,
  barHint,
  interactionSounds,
} = await window.speakmore.config();
/** 现在的热键（id）。提示里写它的短名字，按界面语言写 */
let hotkey = initialHotkey;
// 翻译键和目标语言能在设置里当场换（主进程会推过来），留成可变的
let translateHotkey = initialTranslateHotkey;
let translateTarget = initialTranslateTarget;
// 设置里选的麦克风同理：换掉只是记下来，下一次开麦就用新的
let microphoneDeviceId = initialMicrophoneDeviceId ?? null;
const voice = new VoiceSocket(serverUrl);
const ui = createBarUi({
  document,
  host: { setVisible: window.speakmore.setBarVisible, capture: window.speakmore.captureBarInput },
  keycap: keycapOf(hotkey),
  t,
});
// 翻译的那次：提示里写翻译键的短名字和目标语言的名字（都按界面语言）
ui.setTranslateKeycap(keycapOf(translateHotkey));
ui.setTarget(t(`translate.targets.${translateTarget}`));
ui.setControls(barControls);
ui.setHintShown(barHint === "on");
window.speakmore.onBarHint((value) => ui.setHintShown(value === "on"));
// 交互声音：设置里换开关节点，悬浮条当场跟着变
const sounds = createSounds({ enabled: interactionSounds === "on" });
window.speakmore.onInteractionSoundsChanged((value) => sounds.setEnabled(value === "on"));
window.speakmore.onHotkeyChanged((next) => {
  hotkey = next;
  ui.setKeycap(keycapOf(hotkey));
});
window.speakmore.onTranslateHotkeyChanged((next) => {
  translateHotkey = next;
  ui.setTranslateKeycap(keycapOf(translateHotkey));
});
window.speakmore.onTranslateTargetChanged((next) => {
  translateTarget = next;
  ui.setTarget(t(`translate.targets.${translateTarget}`));
});
window.speakmore.onMicrophoneDeviceChanged((next) => {
  microphoneDeviceId = next ?? null;
});
// 设置里换了语言：悬浮条不重新加载（可能正在听写），换掉翻译，下一句就是新的语言
window.speakmore.onLocaleChanged((locale) => {
  setLocale(locale);
  ui.setTranslator(t, t.text(state.message));
  ui.setKeycap(keycapOf(hotkey));
  ui.setTranslateKeycap(keycapOf(translateHotkey));
  ui.setTarget(t(`translate.targets.${translateTarget}`));
});

let state = initialState;
/** 正在进行的那一次：{ audioId, recording, cancelled, translate }。translate：是不是翻译的那次 */
let session = null;
/** 点了 ⌘ 的那一次：结束前抓好的选中文本（没抓到是 null） */
let pendingCommandSelection = null;
let holdTimer = null;
let maxDurationTimer = null;

function dispatch(event) {
  const previous = state;
  const result = transition(state, event);
  state = result.state;
  // 状态没动（比如空闲时松开热键）就不重画
  if (state !== previous) {
    ui.setTranslate(state.translate);
    ui.setCommand(state.command === true);
    ui.show(viewOf(state, previous.phase), t.text(state.message));
    // 交互声音（设置可关）：开始录音一声、拿到成品一声、失败一声
    if (state.phase === Phase.STARTING) sounds.start();
    else if (event.type === "RESULT") sounds.done();
    else if (event.type === "FAILED") sounds.failed();
  }
  for (const action of result.actions) ACTIONS[action]();
}

const ACTIONS = {
  [Action.START]: start,
  [Action.CANCEL]: cancel,
  [Action.STOP]: stop,
  [Action.ARM_HOLD_TIMER]: () => {
    holdTimer = setTimeout(() => dispatch({ type: "LONG_HOLD" }), LONG_PRESS_MS);
  },
  [Action.CLEAR_HOLD_TIMER]: () => clearTimeout(holdTimer),
};

/** 一个错误给人看的那句话：一句 msg（到画出来时才按界面语言翻），或者现成的字 */
const describe = problemOf;

function start() {
  const current = {
    audioId: crypto.randomUUID(),
    recording: null,
    cancelled: false,
    translate: state.translate,
    // 指令热键直接开始的指令会话（组合键转的指令要到 Space 那一刻状态机才置位，这里还看不到）
    command: state.command === true,
  };
  session = current;
  (async () => {
    // 翻译的那次在 start_audio 里说清要翻成哪种语言（服务端照它换翻译的提示词）；
    // 指令热键开始的这次直接以指令会话开场（没有选区也算，口述当问题）
    await voice.begin(
      current.audioId,
      current.translate
        ? { translateTarget }
        : current.command
          ? { command: true, commandSelectedText: pendingCommandSelection ?? undefined }
          : {},
    );
    pendingCommandSelection = null;
    const recording = await startRecording({
      onChunk: (chunk) => voice.sendChunk(chunk),
      onLevel: ui.level,
      onError: (error) => dispatch({ type: "FAILED", message: describe(error) }),
      deviceId: microphoneDeviceId,
    });
    // 等麦克风的这一小段时间里用户可能已经取消了
    if (current.cancelled) {
      recording.cancel();
      return;
    }
    current.recording = recording;
    maxDurationTimer = setTimeout(() => dispatch({ type: "MAX_DURATION" }), MAX_DURATION_MS);
    dispatch({ type: "MIC_READY" });
  })().catch((error) => {
    console.error("开始录音失败", error);
    if (!current.cancelled) dispatch({ type: "FAILED", message: describeStartError(error) });
  });
}

function describeStartError(error) {
  if (error?.name === "NotAllowedError") return msg("bar.noMicPermission");
  if (error?.name === "NotFoundError") return msg("bar.noMicrophone");
  return describe(error);
}

function cancel() {
  clearTimeout(maxDurationTimer);
  if (!session) return;
  session.cancelled = true;
  session.recording?.cancel();
  session = null;
  voice.abandon();
}

/** 指令的那次：点 ⌘ 时先把选中文本抓下来（焦点还在目标窗口，选区还活着），再走结束流程 */
async function commandFinish() {
  if (state.phase !== Phase.RECORDING) return;
  try {
    pendingCommandSelection = await window.speakmore.captureSelection();
  } catch (error) {
    // 抓不到选中文本（剪贴板被占、权限拦了）就按普通听写收场，别卡住这次录音
    console.warn("抓取选中文本失败", error);
    pendingCommandSelection = null;
  }
  dispatch({ type: "USER_COMMAND" });
}

async function stop() {
  clearTimeout(maxDurationTimer);
  const current = session;
  session = null;
  // 组合键或 ⌘ 转成的指令会话：状态机在 state.command 里记着；点 ⌘ 的那次把抓好的选中文本随 end 带给服务端
  const isCommand = state.command === true;
  const commandSelectedText = isCommand ? (pendingCommandSelection ?? null) : null;
  pendingCommandSelection = null;
  let recorded = null;
  let stillThinking = null; // 整理慢时的"还在想"提示定时器
  try {
    recorded = await current.recording.stop();
    if (!recorded.hadSignal) {
      voice.abandon();
      throw new LocalizedError(msg("bar.noSignal"));
    }
    // 指令的答案生成更慢（Agnes 带推理实测 29 秒，差点撞线）：超时放宽到 60 秒，
    // 否则稍长的答案客户端先超时报错，卡片永远弹不出来
    const timeoutMs = isCommand ? 60_000 : undefined;
    // 整理慢时说一声"还在想"（对齐原版按时长算的 taking longer 提示）：10 秒还在等就换提示
    stillThinking = setTimeout(() => {
      if (state.phase === Phase.FINISHING) ui.show(View.FINISHING, t.text(msg("bar.stillThinking")));
    }, 10_000);
    const outcome = await voice.finish({ durationSeconds: recorded.durationSeconds, commandSelectedText, command: isCommand, timeoutMs });
    clearTimeout(stillThinking);
    // 指令的那次按服务端定的交付方式分流（对齐原版：怎么投递服务端说了算）；听写和翻译照旧贴字
    // 无选区的指令：所有回答都进结果卡片（不再往文档里贴——往文档里贴必须是自己选了文字要改写）。
    // 有选区的照旧按模型的分流：reply 卡片、replace 贴回选区、external 打开
    const toCard =
      outcome.delivery === "reply" ||
      (isCommand && commandSelectedText === null && outcome.text.trim() !== "" && outcome.delivery !== "external");
    if (toCard) {
      // 答案进结果卡片（载荷带上问的问题和当时的选区，原版卡片同款）
      await window.speakmore.commandReply({
        answer: outcome.text,
        userPrompt: outcome.userPrompt ?? null,
        selectedText: commandSelectedText,
      });
      dispatch({ type: "RESULT", message: msg("bar.commandReplied") });
      return;
    }
    if (outcome.delivery === "external") {
      await window.speakmore.openExternalTarget(outcome.externalTarget);
      dispatch({ type: "RESULT", message: msg("bar.commandOpened") });
      return;
    }
    const { notice } = await window.speakmore.deliver({
      audioId: current.audioId,
      text: outcome.text,
      durationSeconds: recorded.durationSeconds,
      command: state.command === true,
      audio: await recorded.blob.arrayBuffer(),
    });
    // 服务端带话时（比如 private 模式翻不了、贴的是原文）它比"贴好了"那句更要紧
    dispatch({ type: "RESULT", message: outcome.notice ?? notice });
  } catch (error) {
    if (stillThinking !== null) clearTimeout(stillThinking);
    console.error("这次听写失败", error);
    const message = describe(error);
    // 录音还在的话交给主进程存下来，失败了话也不会白说。历史里记的是这一刻界面上的那句话
    if (recorded) {
      await window.speakmore
        .reportFailure({
          audioId: current.audioId,
          error: t.text(message),
          durationSeconds: recorded.durationSeconds,
          audio: await recorded.blob.arrayBuffer(),
        })
        .catch((saveError) => console.error("失败记录没有存上", saveError));
    }
    dispatch({ type: "FAILED", message });
  }
}

// ---------- 来自主进程的事件 ----------

/** 小帮手报上来的事 → 状态机的事件。click 的 id 是条上被点的那个按钮；翻译热键的按下走 TRANSLATE_KEY_DOWN */
const INPUT_EVENTS = {
  hotkey: (event) => (event.down ? "KEY_DOWN" : "KEY_UP"),
  translate_hotkey: (event) => (event.down ? "TRANSLATE_KEY_DOWN" : "KEY_UP"),
  command_hotkey: (event) => (event.down ? "COMMAND_KEY_DOWN" : "KEY_UP"),
  // 带上键码（小帮手报的字段叫 key）：状态机靠它认"热键按住时按了 Space"的指令组合
  other_key: (event) => ({ type: "OTHER_KEY", vk: event.key }),
  escape: () => "USER_CANCEL",
  click: (event) => ({ cancel: "USER_CANCEL", confirm: "USER_CONFIRM", command: "USER_COMMAND" })[event.id],
};

window.speakmore.onInput((event) => {
  // 临时诊断：收到的原始事件 + 转换后的状态（排查组合键链路用，查完撤）
  console.warn("bar onInput:", JSON.stringify(event));
  // ⌘ 的那一下要先抓选中文本（异步）再走结束流程，别的输入照旧直接进状态机
  if (event.event === "click" && event.id === "command") return commandFinish();
  // 组合键的 Space：状态机会把这次会话转成指令；趁焦点还在目标窗口，异步抓选中文本补挂给服务端。
  // 抓不到（没有选区、剪贴板被占）就当无选区的指令问答，不耽误
  if (
    event.event === "other_key" &&
    event.key === 0x20 &&
    state.held &&
    !state.translate &&
    (state.phase === Phase.STARTING || state.phase === Phase.RECORDING)
  ) {
    captureChordSelection();
  }
  const type = Object.hasOwn(INPUT_EVENTS, event.event) ? INPUT_EVENTS[event.event](event) : undefined;
  if (type === undefined) {
    console.warn("不认识的输入事件", event);
    return;
  }
  dispatch(typeof type === "string" ? { type } : type);
  console.warn("bar dispatched:", JSON.stringify({ type: typeof type === "string" ? type : type.type, phase: state.phase, command: state.command, held: state.held }));
});

/** 组合键转指令时的选中文本抓取：fire-and-forget，抓到就补挂，抓不到拉倒（当无选区问答） */
function captureChordSelection() {
  window.speakmore
    .captureSelection()
    .then((text) => voice.setCommandSelection(text))
    .catch((error) => console.warn("组合键抓取选中文本失败", error));
}

window.speakmore.onBarControls(ui.setControls);

window.speakmore.onNotice((message) => {
  // 权限之类的提醒只在空闲时显示，不打断正在进行的听写
  if (state.phase !== Phase.IDLE && state.phase !== Phase.ERROR) return;
  state = { ...state, message };
  ui.show(viewOf(state, state.phase), t.text(message));
});
