// 页面能调用的全部主进程能力都列在这里。页面本身拿不到 Node 和 Electron 的接口。
// 沙箱里的预加载脚本只能用 CommonJS。
const { contextBridge, ipcRenderer, webFrame } = require("electron");

// 主题：页面的样式只用 var(--…) 引用颜色，值由主进程按现在的主题给（src/themes）。
// 同步取、马上注入，赶在页面画出第一帧之前。之后换主题时主进程会再发一份过来：先放上新的再撤掉旧的，
// 中间不会有哪一帧是没有颜色的。
let themeKey = webFrame.insertCSS(ipcRenderer.sendSync("theme:get"));
ipcRenderer.on("theme:changed", (_event, css) => {
  const previous = themeKey;
  themeKey = webFrame.insertCSS(css);
  webFrame.removeInsertedCSS(previous);
});

// 界面语言：同样同步取，页面一加载就按它写字（src/renderer/shared/i18n.mjs）。设置里换了语言，
// 主窗口和首次引导整页重新加载；悬浮条不重新加载（可能正在听写），收到新的语言换掉翻译
const locale = ipcRenderer.sendSync("locale:get");

contextBridge.exposeInMainWorld("speakmore", {
  locale,
  // 哪个系统：按系统说法不同的文案（src/i18n）、按系统摆的窗口元素（html 上的 data-platform）用它
  platform: process.platform,
  onLocaleChanged: (callback) => ipcRenderer.on("locale:changed", (_event, next) => callback(next)),
  config: () => ipcRenderer.invoke("config:get"),

  // 悬浮条
  onInput: (callback) => ipcRenderer.on("input", (_event, payload) => callback(payload)),
  onNotice: (callback) => ipcRenderer.on("notice", (_event, message) => callback(message)),
  onBarControls: (callback) => ipcRenderer.on("bar:controls", (_event, enabled) => callback(enabled)),
  setBarVisible: (visible) => ipcRenderer.send("bar:set-visible", visible),
  captureBarInput: (regions) => ipcRenderer.send("bar:capture", regions),
  deliver: (payload) => ipcRenderer.invoke("dictation:deliver", payload),
  reportFailure: (payload) => ipcRenderer.invoke("dictation:failed", payload),
  // 指令会话要用的选中文本：主进程模拟复制抓当前选区（悬浮条在 Space 按下和点 ⌘ 时调）
  captureSelection: () => ipcRenderer.invoke("dictation:capture-selection"),

  onHotkeyChanged: (callback) => ipcRenderer.on("bar:hotkey", (_event, hotkey) => callback(hotkey)),
  onTranslateHotkeyChanged: (callback) =>
    ipcRenderer.on("bar:translate-hotkey", (_event, translateHotkey) => callback(translateHotkey)),
  onTranslateTargetChanged: (callback) =>
    ipcRenderer.on("bar:translate-target", (_event, translateTarget) => callback(translateTarget)),
  onMicrophoneDeviceChanged: (callback) =>
    ipcRenderer.on("bar:microphone-device", (_event, deviceId) => callback(deviceId)),
  onBarHint: (callback) => ipcRenderer.on("bar:hint", (_event, value) => callback(value)),
  onInteractionSoundsChanged: (callback) => ipcRenderer.on("bar:interaction-sounds", (_event, value) => callback(value)),

  // 结果卡片（语音指令 reply 交付的独立窗口）
  cardPayload: () => ipcRenderer.invoke("card:get-payload"),
  onCardUpdate: (callback) => ipcRenderer.on("card:update", (_event, payload) => callback(payload)),
  cardClose: () => ipcRenderer.invoke("card:close"),
  cardBounds: (height) => ipcRenderer.invoke("card:update-bounds", height),

  // 主窗口：首页、历史记录
  appInfo: () => ipcRenderer.invoke("app:info"),
  listHistory: () => ipcRenderer.invoke("history:list"),
  usageReport: () => ipcRenderer.invoke("usage:report"),
  insights: () => ipcRenderer.invoke("insights:get"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  onHistoryChanged: (callback) => ipcRenderer.on("history:changed", () => callback()),
  onNavigate: (callback) => ipcRenderer.on("hub:navigate", (_event, target) => callback(target)),

  // 主窗口：设置
  getSetup: () => ipcRenderer.invoke("setup:get"),
  onSetupChanged: (callback) => ipcRenderer.on("setup:changed", () => callback()),
  // provider 不写是正在用的那家；给别家存时 changes 是要一起换成的设置，拿它们验证
  saveKey: (key, provider, changes) => ipcRenderer.invoke("setup:save-key", key, provider, changes),
  forgetKey: (provider) => ipcRenderer.invoke("setup:forget-key", provider),
  // 删除自定义服务：key、地址、参数一起清，润色用的不是它就只清配置
  openHomepage: () => ipcRenderer.invoke("app:open-homepage"),
  removeCustomService: () => ipcRenderer.invoke("setup:remove-custom"),
  // 某种模式按改后的设置能不能用：拿那家的 key 发一个最小的请求，不换掉正在用的
  checkModel: (mode, changes) => ipcRenderer.invoke("setup:check-model", mode, changes),
  // 模式这一层，和各模式里的模型（src/app/modes.mjs）
  setMode: (mode, changes) => ipcRenderer.invoke("setup:set-mode", mode, changes),
  setModel: (model) => ipcRenderer.invoke("setup:set-model", model),
  setTranscriber: (id) => ipcRenderer.invoke("setup:set-transcriber", id),
  // custom：自定义服务的 { customUrl, customParams }，和模型一起换
  setPolish: (polish, custom) => ipcRenderer.invoke("setup:set-polish", polish, custom),
  setModelSource: (id) => ipcRenderer.invoke("setup:set-model-source", id),
  setAcceleration: (id) => ipcRenderer.invoke("setup:set-acceleration", id),
  // 本机模型：用户点了才下载；取消、删除（正在用的删不了）
  downloadModel: (id) => ipcRenderer.invoke("setup:download-model", id),
  cancelDownload: (id) => ipcRenderer.invoke("setup:cancel-download", id),
  deleteModel: (id) => ipcRenderer.invoke("setup:delete-model", id),
  // 检查本机模型：念一句交给它转，看能不能正常出字
  checkTranscriber: (id) => ipcRenderer.invoke("setup:check-transcriber", id),
  readClipboard: () => ipcRenderer.invoke("setup:read-clipboard"),
  openKeyPage: (provider) => ipcRenderer.invoke("setup:open-key-page", provider),
  openPrivacySettings: (permission) => ipcRenderer.invoke("setup:open-privacy", permission),
  recheckPermissions: () => ipcRenderer.invoke("setup:recheck"),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke("setup:set-open-at-login", enabled),
  setHotkey: (hotkey) => ipcRenderer.invoke("setup:set-hotkey", hotkey),
  setTranslateHotkey: (translateHotkey) => ipcRenderer.invoke("setup:set-translate-hotkey", translateHotkey),
  setTranslateTarget: (translateTarget) => ipcRenderer.invoke("setup:set-translate-target", translateTarget),
  setMicrophoneDevice: (deviceId) => ipcRenderer.invoke("setup:set-microphone-device", deviceId),
  commandReply: (answer) => ipcRenderer.invoke("command:reply", answer),
  openExternalTarget: (target) => ipcRenderer.invoke("command:open-external", target),
  dictList: () => ipcRenderer.invoke("dict:list"),
  dictAdd: (wrong, correct) => ipcRenderer.invoke("dict:add", wrong, correct),
  dictRemove: (wrong) => ipcRenderer.invoke("dict:remove", wrong),
  dictImportCsv: () => ipcRenderer.invoke("dict:import-csv"),
  setBarHint: (value) => ipcRenderer.invoke("setup:set-bar-hint", value),
  setInteractionSounds: (value) => ipcRenderer.invoke("setup:set-interaction-sounds", value),
  setHistoryRetention: (value) => ipcRenderer.invoke("setup:set-history-retention", value),
  historyRetry: (audioId) => ipcRenderer.invoke("history:retry", audioId),
  historyDeleteAll: () => ipcRenderer.invoke("history:delete-all"),

  // 首次引导
  captureHotkey: (capturing) => ipcRenderer.send("onboarding:capture-hotkey", capturing),
  onOnboardingHotkey: (callback) => ipcRenderer.on("onboarding:hotkey", (_event, key) => callback(key)),
  finishOnboarding: () => ipcRenderer.invoke("onboarding:finish"),
  setTheme: (theme) => ipcRenderer.invoke("setup:set-theme", theme),
  setThemeMode: (mode) => ipcRenderer.invoke("setup:set-theme-mode", mode),
  setLanguage: (language) => ipcRenderer.invoke("setup:set-language", language),
});
