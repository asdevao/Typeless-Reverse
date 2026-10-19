// 悬浮条：把按键和点击喂给状态机，按状态机给出的动作去录音、上传、交付。
// 画面不在这里：该是什么样子由 bar-view.mjs 算，画出来由 bar-ui.mjs 管。

import { LocalizedError, msg, problemOf } from "../../i18n/index.mjs";
import { keycapOf, localize, setLocale, t } from "../shared/i18n.mjs";
import { createBarUi } from "./bar-ui.mjs";
import { viewOf } from "./bar-view.mjs";
import { Action, initialState, LONG_PRESS_MS, Phase, transition } from "./machine.mjs";
import { startRecording } from "./recorder.mjs";
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
  barControls,
  barHint,
} = await window.speakmore.config();
/** 现在的热键（id）。提示里写它的短名字，按界面语言写 */
let hotkey = initialHotkey;
// 翻译键和目标语言能在设置里当场换（主进程会推过来），留成可变的
let translateHotkey = initialTranslateHotkey;
let translateTarget = initialTranslateTarget;
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
    ui.show(viewOf(state, previous.phase), t.text(state.message));
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
  const current = { audioId: crypto.randomUUID(), recording: null, cancelled: false, translate: state.translate };
  session = current;
  (async () => {
    // 翻译的那次在 start_audio 里说清要翻成哪种语言（服务端照它换翻译的提示词）
    // 翻译的那次带目标语言；指令的那次带开始时抓好的选中文本（主进程在热键按下时抓的）
    await voice.begin(
      current.audioId,
      current.translate
        ? { translateTarget }
        : current.command
          ? { commandSelectedText: pendingCommandSelection ?? undefined }
          : {},
    );
    pendingCommandSelection = null;
    const recording = await startRecording({
      onChunk: (chunk) => voice.sendChunk(chunk),
      onLevel: ui.level,
      onError: (error) => dispatch({ type: "FAILED", message: describe(error) }),
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
  // 点了 ⌘ 的那次：把抓好的选中文本随 end 带给服务端，换指令的提示词；普通听写是 null
  const commandSelectedText = pendingCommandSelection ?? null;
  pendingCommandSelection = null;
  let recorded = null;
  try {
    recorded = await current.recording.stop();
    if (!recorded.hadSignal) {
      voice.abandon();
      throw new LocalizedError(msg("bar.noSignal"));
    }
    // 指令的答案生成更慢（问答可能要长答案）：超时单独放宽到 30 秒，对齐原版的指令专用超时
    const timeoutMs = commandSelectedText === null ? undefined : 30_000;
    const outcome = await voice.finish({ durationSeconds: recorded.durationSeconds, commandSelectedText, timeoutMs });
    // 指令的那次按服务端定的交付方式分流（对齐原版：怎么投递服务端说了算）；听写和翻译照旧贴字
    if (outcome.delivery === "reply") {
      await window.speakmore.commandReply(outcome.text);
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
  other_key: () => "OTHER_KEY",
  escape: () => "USER_CANCEL",
  click: (event) => ({ cancel: "USER_CANCEL", confirm: "USER_CONFIRM", command: "USER_COMMAND" })[event.id],
};

window.speakmore.onInput((event) => {
  // ⌘ 的那一下要先抓选中文本（异步）再走结束流程，别的输入照旧直接进状态机
  if (event.event === "click" && event.id === "command") return commandFinish();
  const type = Object.hasOwn(INPUT_EVENTS, event.event) ? INPUT_EVENTS[event.event](event) : undefined;
  if (type === undefined) {
    console.warn("不认识的输入事件", event);
    return;
  }
  dispatch({ type });
});

window.speakmore.onBarControls(ui.setControls);

window.speakmore.onNotice((message) => {
  // 权限之类的提醒只在空闲时显示，不打断正在进行的听写
  if (state.phase !== Phase.IDLE && state.phase !== Phase.ERROR) return;
  state = { ...state, message };
  ui.show(viewOf(state, state.phase), t.text(message));
});
