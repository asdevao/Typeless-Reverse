import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { Action, initialState, Phase, transition } from "../../../src/renderer/bar/machine.mjs";

const zh = createTranslator("zh-CN");

/** 依次喂事件，返回最后的状态和每一步的动作 */
function run(...events) {
  let state = initialState;
  const steps = [];
  for (const event of events) {
    const result = transition(state, typeof event === "string" ? { type: event } : event);
    state = result.state;
    steps.push(result.actions);
  }
  return { state, steps };
}

test("单击开始，再单击结束，收到成品回到空闲", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", "KEY_UP", "RESULT");
  assert.deepEqual(steps, [
    [Action.START, Action.ARM_HOLD_TIMER],
    [],
    [Action.CLEAR_HOLD_TIMER],
    [Action.STOP],
    [],
    [],
  ]);
  assert.deepEqual(state, initialState);
});

test("松开比麦克风就绪早，也照常进入录音", () => {
  const { state } = run("KEY_DOWN", "KEY_UP", "MIC_READY");
  assert.deepEqual(state, { phase: Phase.RECORDING, held: false, translate: false, command: false, message: null });
});

test("按住超过时限：取消，并告诉用户不支持按住说话", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "LONG_HOLD");
  assert.equal(state.phase, Phase.IDLE);
  assert.match(zh.text(state.message), /不支持按住说话/);
  assert.deepEqual(steps.at(-1), [Action.CANCEL]);
  // 取消之后才松手，不能再触发任何事
  assert.deepEqual(transition(state, { type: "KEY_UP" }), { state, actions: [] });
});

test("已经松开之后，迟到的长按定时器不起作用", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "LONG_HOLD");
  assert.equal(state.phase, Phase.RECORDING);
  assert.deepEqual(steps.at(-1), []);
});

test("热键加别的键是组合键：悄悄取消，不提示", () => {
  const { state, steps } = run("KEY_DOWN", "OTHER_KEY");
  assert.deepEqual(state, initialState);
  assert.deepEqual(steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);
});

test("听写键按住时按了 Space：切成指令会话继续录（对齐原版 RightAlt+Space）", () => {
  const { state, steps } = run("KEY_DOWN", { type: "OTHER_KEY", vk: 0x20 }, "MIC_READY");
  assert.equal(state.phase, Phase.RECORDING);
  assert.equal(state.command, true);
  // 清掉了长按计时：之后说多久都不会被 600ms 的长按判定取消
  assert.deepEqual(steps.at(-1), []);
});

test("翻译键按住时按 Space 不算指令：照旧当组合键取消", () => {
  const held = run("TRANSLATE_KEY_DOWN", { type: "OTHER_KEY", vk: 0x20 });
  assert.deepEqual(held.state, initialState);
});

test("别的键（非 Space）照旧是组合键取消", () => {
  const { state } = run("KEY_DOWN", { type: "OTHER_KEY", vk: 0x41 }, "MIC_READY");
  assert.equal(state.phase, Phase.IDLE);
});

test("录音中正常打字不影响录音", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "OTHER_KEY");
  assert.equal(state.phase, Phase.RECORDING);
  assert.deepEqual(steps.at(-1), []);
});

test("松开的事件丢了，再按一下照样能结束；迟到的长按定时器不会把它取消", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_DOWN", "LONG_HOLD");
  assert.equal(state.phase, Phase.FINISHING);
  assert.deepEqual(steps.slice(-2), [[Action.STOP], []]);
});

test("麦克风没就绪就按了第二下：作罢", () => {
  const { state, steps } = run("KEY_DOWN", "KEY_UP", "KEY_DOWN");
  assert.deepEqual(state, initialState);
  assert.deepEqual(steps.at(-1), [Action.CANCEL]);
});

test("等成品时再按热键不会开始新的一次", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", "KEY_UP", "KEY_DOWN");
  assert.equal(state.phase, Phase.FINISHING);
  assert.deepEqual(steps.at(-1), []);
});

test("录音到上限自动结束", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "MAX_DURATION");
  assert.equal(state.phase, Phase.FINISHING);
  assert.deepEqual(steps.at(-1), [Action.STOP]);
});

test("成品可以带一句提示回到空闲", () => {
  const { state } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", { type: "RESULT", message: "没有听到声音" });
  assert.deepEqual(state, { phase: Phase.IDLE, held: false, translate: false, command: false, message: "没有听到声音" });
});

test("出错：录音阶段要收掉麦克风，等成品阶段不用；之后按热键能重新开始", () => {
  const starting = run("KEY_DOWN", { type: "FAILED", message: "麦克风打不开" });
  assert.deepEqual(starting.state, { phase: Phase.ERROR, held: false, translate: false, command: false, message: "麦克风打不开" });
  assert.deepEqual(starting.steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);

  const finishing = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", { type: "FAILED", message: "服务端没有回应" });
  assert.equal(finishing.state.phase, Phase.ERROR);
  assert.deepEqual(finishing.steps.at(-1), []);

  const retry = transition(finishing.state, { type: "KEY_DOWN" });
  assert.equal(retry.state.phase, Phase.STARTING);
  assert.equal(retry.state.message, null);
});

test("录音中取消（点 ✕ 或按 esc）：丢掉这次录音回到空闲，不提示；麦克风还没就绪时也能取消", () => {
  const recording = run("KEY_DOWN", "MIC_READY", "KEY_UP", "USER_CANCEL");
  assert.deepEqual(recording.state, initialState);
  assert.deepEqual(recording.steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);

  const starting = run("KEY_DOWN", "USER_CANCEL");
  assert.deepEqual(starting.state, initialState);
  assert.deepEqual(starting.steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);
  // 取消之后才松开热键，不能再触发任何事
  assert.deepEqual(transition(starting.state, { type: "KEY_UP" }), { state: starting.state, actions: [] });
});

test("取消只在说话的时候管用：等成品时取消不了，空闲和出错之后按了也没事", () => {
  const finishing = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", "USER_CANCEL");
  assert.equal(finishing.state.phase, Phase.FINISHING);
  assert.deepEqual(finishing.steps.at(-1), []);
  assert.deepEqual(run("USER_CANCEL").state, initialState);
  const failed = run("KEY_DOWN", { type: "FAILED", message: "麦克风打不开" }, "USER_CANCEL");
  assert.equal(failed.state.phase, Phase.ERROR);
  assert.deepEqual(failed.steps.at(-1), []);
});

test("点完成等于再按一下热键：结束录音、要成品；麦克风没就绪或已经在等成品时点了不算", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "USER_CONFIRM");
  assert.deepEqual(state, { phase: Phase.FINISHING, held: false, translate: false, command: false, message: null });
  assert.deepEqual(steps.at(-1), [Action.STOP]);

  const starting = run("KEY_DOWN", "KEY_UP", "USER_CONFIRM");
  assert.equal(starting.state.phase, Phase.STARTING);
  assert.deepEqual(starting.steps.at(-1), []);
  const twice = run("KEY_DOWN", "MIC_READY", "KEY_UP", "USER_CONFIRM", "USER_CONFIRM");
  assert.equal(twice.state.phase, Phase.FINISHING);
  assert.deepEqual(twice.steps.at(-1), []);
  assert.deepEqual(run("USER_CONFIRM").state, initialState);
});

test("空闲时来的成品和报错都忽略；不认识的事件直接报错", () => {
  assert.deepEqual(run("RESULT").state, initialState);
  assert.deepEqual(run({ type: "FAILED", message: "x" }).state, initialState);
  assert.throws(() => transition(initialState, { type: "NOPE" }), /不认识的事件/);
});

test("翻译键（TRANSLATE_KEY_DOWN）开始的是翻译的那一次：状态里记下翻译，走法同热键", () => {
  const { state, steps } = run("TRANSLATE_KEY_DOWN", "MIC_READY", "KEY_UP");
  assert.deepEqual(state, { phase: Phase.RECORDING, held: false, translate: true, command: false, message: null });
  assert.deepEqual(steps[0], [Action.START, Action.ARM_HOLD_TIMER]);

  // 再按翻译键（或听写热键）都结束；等成品时状态还带着翻译，悬浮条照它写"翻译中"
  const stopped = transition(state, { type: "TRANSLATE_KEY_DOWN" });
  assert.deepEqual(stopped.state, { phase: Phase.FINISHING, held: false, translate: true, command: false, message: null });
  assert.deepEqual(stopped.actions, [Action.STOP]);
  const byDictation = transition(state, { type: "KEY_DOWN" });
  assert.equal(byDictation.state.phase, Phase.FINISHING);
  assert.equal(byDictation.state.translate, true);
});

test("翻译的那次拿到成品或失败后回到空闲，状态里不再带着翻译", () => {
  const done = run("TRANSLATE_KEY_DOWN", "MIC_READY", "KEY_UP", "TRANSLATE_KEY_DOWN", "RESULT");
  assert.equal(done.state.phase, Phase.IDLE);
  assert.equal(done.state.translate, false);
  const failed = run("TRANSLATE_KEY_DOWN", "MIC_READY", "KEY_UP", "TRANSLATE_KEY_DOWN", {
    type: "FAILED",
    message: "服务端没有回应",
  });
  assert.equal(failed.state.phase, Phase.ERROR);
  assert.equal(failed.state.translate, false);
  // 出错之后按听写热键重新开始的是普通听写
  const retry = transition(failed.state, { type: "KEY_DOWN" });
  assert.equal(retry.state.translate, false);
});

test("翻译键上的其余事件和热键同样对待：松开、长按取消、组合键取消", () => {
  assert.deepEqual(run("TRANSLATE_KEY_DOWN", "KEY_UP").state.phase, Phase.STARTING);
  const held = run("TRANSLATE_KEY_DOWN", "MIC_READY", "LONG_HOLD");
  assert.equal(held.state.phase, Phase.IDLE);
  assert.match(zh.text(held.state.message), /不支持按住说话/);
  const combo = run("TRANSLATE_KEY_DOWN", "OTHER_KEY");
  assert.deepEqual(combo.state, initialState);
});

test("指令失败散场时 command 标记一并清掉", () => {
  const failed = run("KEY_DOWN", "MIC_READY", { type: "OTHER_KEY", vk: 0x20 }, "FAILED");
  assert.equal(failed.state.command, false);
});
