import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { ALREADY_RUNNING_EXIT_CODE, startControlServer } from "../control.mjs";
import { createTranslator, LocalizedError, msg, problemOf, resolveLocale } from "../i18n/index.mjs";
import { alsoLogTo, log } from "../log.mjs";
import { chipOf, downloadSize, MODELS, makerOf, measuredOn, SOURCES, tagsOn } from "../models/catalog.mjs";
import { createLocalModels, freeBytesAt } from "../models/library.mjs";
import { presetsFor } from "../models/presets.mjs";
import { CHAT_VENDORS, formatChatChoice } from "../server/chat/vendors.mjs";
import { describeRoute, keyVendorOf, MODES } from "../server/modes.mjs";
import { TRANSLATE_TARGETS } from "../server/refine/translate-prompt.mjs";
import { formatModelChoice, PROVIDERS } from "../server/providers/index.mjs";
import { findVendor, VENDORS } from "../server/vendors.mjs";
import { mdLikeToHtml } from "./rich-text.mjs";
import { launchTargetOf } from "./launch-app.mjs";
import {
  addEntry,
  loadDictionary,
  parseDictionaryCsv,
  removeEntry,
  saveDictionary,
} from "../storage/dictionary.mjs";
import { adoptAppKeys } from "../storage/app-keys.mjs";
import { openHistory } from "../storage/history.mjs";
import { migrateLegacyData } from "../storage/legacy.mjs";
import { ensureHome, installedHomeOf, keyFile, oldAppKeyFile, resolvePaths } from "../storage/paths.mjs";
import {
  ACCELERATIONS,
  HOTKEY_IDS,
  hotkeyName,
  overridingEnv,
  patchSettings,
  resolveSettings,
  routeOf,
  saveSetting,
  SETTINGS as SETTING_SCHEMA,
} from "../storage/settings.mjs";
import { toHex } from "../themes/color.mjs";
import { themeCss } from "../themes/contract.mjs";
import { findTheme, THEMES } from "../themes/index.mjs";
import { estimateTime } from "../usage/estimate.mjs";
import { insights } from "../usage/insights.mjs";
import { usageReport } from "../usage/report.mjs";
import { createDelivery } from "./delivery.mjs";
import { helperPaths, startHelper } from "./helper.mjs";
import { createKeyManager } from "./keys/key-manager.mjs";
import { createKeyStore } from "./keys/key-store.mjs";
import { describePlaza, loadPriceBook } from "./model-plaza.mjs";
import { createModeSwitch } from "./modes.mjs";
import { startService } from "./service.mjs";
import { summarizeSetup, summaryAsText } from "./setup-state.mjs";

// 后台应用的主进程：两个窗口（悬浮条、主窗口）、菜单栏图标、原生小帮手、内置的听写服务，
// 以及页面和命令行要它代办的事。窗口用什么颜色由主题定（src/themes），这里负责把它交给每个窗口。
// 平时由 speakmore 命令启动（src/cli），也可以打成应用双击启动。
// 结构对应原版的"主进程 + 悬浮条 + 主窗口（hub）+ 键盘子进程"（targets/typeless/docs/03-process-architecture.md）。

/** 调试用：设了就连这个地址上单独启动的服务端，不启动内置的那个 */
const EXTERNAL_SERVER_URL = process.env.SPEAKMORE_SERVER_URL ?? null;
/** 是 speakmore 命令启动的：日志由它接到文件里，缺什么也由它在终端里说，这边不自己弹主窗口 */
const LAUNCHED_BY_CLI = process.env.SPEAKMORE_CLI === "1";

let PATHS;
let SETTINGS;
/** 启动时走哪条路线（server/modes.mjs）。之后切模式、换模型时当场换（keys.switchRoute），正在走的以 service.route 为准 */
let ROUTE;
/** 本机模型用不用显卡（设置里的 acceleration）。在设置里换了当场生效（service.setAcceleration） */
let acceleration;
// Windows 上从开始菜单、开机启动起的没有 SPEAKMORE_HOME：家目录照程序装在哪找回来（装在默认位置时两者一样）
if (process.platform === "win32" && !process.env.SPEAKMORE_HOME) {
  const home = installedHomeOf(process.execPath, existsSync);
  if (home) process.env.SPEAKMORE_HOME = home;
}

try {
  PATHS = resolvePaths(process.env);
  SETTINGS = resolveSettings({ file: PATHS.settingsFile, env: process.env });
  ROUTE = routeOf(SETTINGS);
  acceleration = SETTINGS.acceleration.value;
} catch (error) {
  // 路径或设置写错是使用上的问题，说一句人话就退出，不留一个按了热键没反应的进程
  console.error(error.message);
  process.exit(2);
}
/** 现在用哪个键。设置里可以当场换（setup:set-hotkey），换的时候重启小帮手 */
let hotkey = SETTINGS.hotkey.value;
/** 翻译用哪个键（说母语、贴译文）。和听写热键相同时翻译键不生效（两个小帮手会抢同一个键），只在改设置重启后重新看 */
let translateHotkey = SETTINGS.translateHotkey.value;
let translateTarget = SETTINGS.translateTarget.value;
/**
 * 启动时用谁家的 key：原生链路是收音频的那家，本地转写链路是润色的那家；数据隐私模式不用 key，是 null。
 * 正在用的以 keys.provider 为准
 */
const PROVIDER = keyVendorOf(ROUTE) ?? null;
/** 思考档位只有 Gemini 有；别家用不上时是 null，状态里也不报 */
const thinkingFor = (provider) => (provider?.thinkingLevels ? SETTINGS.thinking.value : null);
const WINDOWS = process.platform === "win32";
/**
 * 菜单栏图标：印章上的五道声波。macOS 上文件名带 Template，系统按菜单栏的深浅反色，@2x 那张由系统自己挑；
 * Windows 的通知区域不会反色，用带颜色的应用图标，.ico 里各个尺寸都有（scripts/build/make-icon.sh）
 */
const TRAY_ICON = join(import.meta.dirname, "../../assets", WINDOWS ? "icon.ico" : "trayTemplate.png");
/** Windows 上窗口和任务栏的图标（macOS 上是应用包自己的图标） */
const WINDOW_ICON = join(import.meta.dirname, "../../assets/icon.ico");
/**
 * Windows 上标题栏藏起来以后，系统的最小化、最大化、关闭三个按钮叠在页面右上角这么高的一条里。
 * 和主窗口内容区最上面那条拖动区（hub.css 的 .content::before，2.75rem）一样高
 */
const HOMEPAGE = "https://github.com/zephyr4123/speakmore";
const CAPTION_HEIGHT = 44;
/** 这台机器是哪类芯片：本地模型的实测按它挑（models/catalog.mjs 的 CHIPS） */
const CHIP = chipOf();
/** 主窗口的大小，照原版（targets/typeless 的 hub 窗口：1080×750，最小 988×685） */
const HUB_SIZE = { width: 1080, height: 750, minWidth: 988, minHeight: 685 };
/** 悬浮条的窗口。比条本身大一圈：上面要放一行提示，四周要留出阴影，报错时条会变宽变高 */
const BAR_SIZE = { width: 380, height: 124 };
/**
 * 系统设置里各项权限的页面。Windows 只有麦克风这一项：没有"输入监控""辅助功能"，
 * 小帮手装上钩子就能听键、能模拟按键（报上来的 listen、trusted 总是 true）
 */
const PRIVACY_PANES = WINDOWS
  ? { microphone: "ms-settings:privacy-microphone" }
  : {
      microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      listen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
      trusted: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    };

/**
 * 问一下麦克风权限。macOS 上没问过时会弹系统的授权框；Windows 没有这种框（在系统设置里统一开关），照实报现在的状态
 * @returns {Promise<boolean>} 能不能用
 */
async function askMicrophone() {
  if (WINDOWS) return systemPreferences.getMediaAccessStatus("microphone") === "granted";
  return systemPreferences.askForMediaAccess("microphone");
}

// Windows 认应用靠这个 id：任务栏把窗口归到一起、通知写谁发的。和 macOS 应用包的标识一样
if (WINDOWS) app.setAppUserModelId("com.zephyrxiang.speakmore");

// 所有东西都放在 paths.mjs 定的那一个目录里，命令行和这里用同一处。Electron 默认会按应用名在
// ~/Library/Application Support 下另开一个目录放 Chromium 的缓存和状态，把它也收进来，和我们的数据分开放
app.setPath("userData", PATHS.cacheDir);

/**
 * Windows 上装好的那一份：程序在家目录 versions 下某一个版本里。没有单独的"应用"：命令行起的、开始菜单起的都是它，
 * 用的是同一套 key 和设置（不像 macOS 的 SpeakMore.app 有自己的一套权限）
 */
const INSTALLED_ON_WINDOWS =
  WINDOWS && process.execPath.toLowerCase().startsWith(`${PATHS.versionsDir.toLowerCase()}\\`);
/**
 * 开机启动登记的是这个可执行文件加上程序目录（Windows 上没有应用包，要把参数也记下来）。
 * 装了新版本时 install.ps1 把这一项改指到新版本的程序上（Electron 认开没开只比程序路径）
 */
const LOGIN_ITEM = WINDOWS ? { path: process.execPath, args: [app.getAppPath()], name: "SpeakMore" } : {};

/**
 * 开机启动开着没有。Windows 上 openAtLogin 只认以 AppUserModelId 为名的那一项，我们写的名字是 SpeakMore，
 * 读回来永远是 false（真机上试过）：看 executableWillLaunchAtLogin，Run 里有指向这个程序、这些参数的一项，
 * 并且没在任务管理器里被停用
 */
function loginItemEnabled() {
  const settings = app.getLoginItemSettings(LOGIN_ITEM);
  return WINDOWS ? settings.executableWillLaunchAtLogin : settings.openAtLogin;
}

// 打成应用后没有终端，日志自己写文件。由命令启动时标准输出已经被接到同一个文件里了。
// Windows 上从开始菜单起的（不是命令行起的）也没有终端
if (app.isPackaged || (INSTALLED_ON_WINDOWS && !LAUNCHED_BY_CLI)) alsoLogTo(PATHS.logFile);

// 同一个家目录只跑一个。这里给的数据会随 second-instance 事件送到已经在运行的那一个手里
const isOnlyInstance = app.requestSingleInstanceLock({ byCli: LAUNCHED_BY_CLI });
if (!isOnlyInstance) {
  console.error("已经有一个在运行了");
  // 约定的退出码：启动它的 speakmore 命令据此知道"不是没起来，是有别的先起来了"，接着等那一个
  app.exit(ALREADY_RUNNING_EXIT_CODE);
}

const sourceDir = join(app.getAppPath(), "src");
const webPreferences = { preload: join(sourceDir, "preload", "preload.cjs"), sandbox: true, contextIsolation: true };
// 窗口里只放我们自己的页面。几个窗口共用一份预加载脚本：拖进窗口的文件、页面里的链接要是把窗口带走了，
// 那个页面也能调到存 key、读历史、读剪贴板这些接口。开新窗口同理
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    log.warn("navigation_blocked", { url: url.slice(0, 200) });
  });
  contents.setWindowOpenHandler(({ url }) => {
    log.warn("window_open_blocked", { url: url.slice(0, 200) });
    return { action: "deny" };
  });
});

// 不能写成顶层的 await app.whenReady()：Electron 要等主模块加载完才会就绪，
// 而顶层 await 让模块一直加载不完，两边互相等（Electron 44.7 实测如此）。
// 没抢到锁的那个正在退出，不往下走：家目录里的东西（进程号、控制通道）都是先到的那个的
if (isOnlyInstance) {
  app
    .whenReady()
    .then(main)
    .catch((error) => {
      // 启动失败时没有窗口可以报错，记下来并以非零码退出，不留一个什么都不干的进程
      log.error("startup_failed", { error: String(error?.stack ?? error) });
      app.exit(1);
    });
}

async function main() {
  app.dock?.hide();

  ensureHome(PATHS);
  // 记下进程号：万一卡住了不答话，speakmore stop 靠它找到这个进程。要赶在控制通道开始听之前写好，
  // 这样只要通道连得上，文件里记的就一定是通道那头的进程
  writeFileSync(PATHS.pidFile, `${process.pid}\n`);
  // 0.1 版的数据在别处。平时是 speakmore 命令在启动之前搬好的；直接双击应用启动时由这里搬
  await migrateLegacyData({ paths: PATHS, log });
  // 0.7.0 及以前 App 另存的那份 key 搬进 App 和命令行共用的文件
  adoptAppKeys({ paths: PATHS, log });

  const startedAt = new Date().toISOString();
  // 录音回放：把 Recordings 下的录音通过只读协议喂给主窗口的 <audio>。id 校验防止路径穿越
  protocol.handle("speakmore-audio", (request) => {
    const id = new URL(request.url).hostname.replace(/\.webm$/, "");
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) {
      return new Response("bad id", { status: 400 });
    }
    const file = join(PATHS.recordingsDir, `${id}.webm`);
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    const { size } = statSync(file);
    const stream = createReadStream(file);
    // 流上挂个 error 监听免得未处理事件炸进程；响应断了由 Electron 收尾
    stream.on("error", () => {});
    return new Response(Readable.toWeb(stream), {
      headers: { "content-type": "audio/webm", "content-length": String(size) },
    });
  });

  const history = openHistory(PATHS.historyDb);

  // 保留期清理：启动时跑一遍，之后每 6 小时一次（设置 historyRetentionDays；forever 不删）。
  // 删的是过期条目和它们的记账；录音文件一并清掉
  const RETENTION_DAYS = { forever: null, "1": 1, "7": 7, "30": 30, "90": 90, "365": 365 };
  async function cleanupHistoryRetention() {
    try {
      const { value } = resolveSettings({ file: PATHS.settingsFile, env: process.env }).historyRetentionDays;
      const days = RETENTION_DAYS[value];
      if (days === undefined || days === null) return 0;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const removedPaths = history.purgeOlderThan(cutoff);
      for (const path of removedPaths) rmSync(path, { force: true });
      if (removedPaths.length > 0) {
        log.info("history_retention_purged", { count: removedPaths.length, days });
        historyChanged();
      }
      return removedPaths.length;
    } catch (error) {
      // 清理失败不连累听写：记日志，下一轮定时器再试
      log.error("history_retention_failed", { error: String(error?.stack ?? error) });
      return 0;
    }
  }
  cleanupHistoryRetention();
  setInterval(() => cleanupHistoryRetention(), 6 * 60 * 60_000).unref();

  // 模型广场上的标价、推荐组合的月成本：各家的价目模块启动时加载一次
  const prices = await loadPriceBook();
  // 每家一把 key，各存一个文件。正在用的那家之外的也要在：speakmore key openai、model check 要用
  const keyStores = Object.fromEntries(
    VENDORS.map(({ id }) => [
      id,
      createKeyStore({ file: keyFile(PATHS, id), oldFile: oldAppKeyFile(PATHS, id), safeStorage }),
    ]),
  );
  /** 本地模型的状态一变，菜单栏和主窗口跟着更新。菜单栏建好之前变的不用管：建的时候读的就是最新的 */
  let localModelChanged = () => {};
  // 本机的模型库：下载、取消、删除都由用户点。下好了、删了，服务按路线装上或卸掉
  const localModels = createLocalModels({
    dir: PATHS.modelsDir,
    source: SETTINGS.modelSource.value,
    log,
    // 只在用户点了下载、取消、删除之后才会来，那时服务早就建好了
    onChange: () => {
      service?.modelsChanged();
      localModelChanged();
    },
  });
  // 每次调模型记一笔账，开着的历史窗口跟着更新花费（记账出错由整理流程写日志，不连累听写）
  const service = EXTERNAL_SERVER_URL
    ? null
    : await startService({
      dictionary: () => loadDictionary(PATHS.dictionaryFile),
        log,
        route: ROUTE,
        modelsDir: PATHS.modelsDir,
        models: localModels,
        onModelCall: (call) => {
          history.addCall(call);
          historyChanged();
        },
        onLocalModel: () => localModelChanged(),
        acceleration,
      });
  const serverUrl = EXTERNAL_SERVER_URL ?? service.url;
  const e2e = process.env.SPEAKMORE_E2E_OUT ? await import("./e2e.mjs") : null;

  const keys = createKeyManager({
    service,
    provider: PROVIDER,
    keyStores,
    env: process.env,
    log,
    onChange: () => setupChanged(),
    // 给不是正在用的那一家存 key 时拿哪条路线验证，由模式那一层说
    routeFor: (id) => modes.routeForVendor(id),
  });
  /** 切模式、换各模式里的模型（app/modes.mjs）。连着单独启动的服务端时这些都归那边，是 null */
  const modes = service
    ? createModeSwitch({ service, keys, models: localModels, settingsFile: PATHS.settingsFile, env: process.env, log })
    : null;
  /** 按键监听的小帮手：starting（还没报上来）/ running / stopped（退出了，或者根本没起来） */
  let helperState = "starting";
  /** 小帮手报上来的两项权限；它没在 running 时是 null */
  let helperPermissions = null;
  /** 控制通道，启动到后面才开；端到端测试时一直是 null */
  let control = null;
  /** 启动时对麦克风和 key 的检查做完了没有 */
  let startupChecked = false;
  let hubWindow = null;
  let onboardingWindow = null;
  /** 首次引导正在测快捷键：热键送到引导窗口，不去开悬浮条 */
  let hotkeyToOnboarding = false;

  // ---------- 界面语言 ----------

  /** 设置里的语言（system 是跟随系统）和这次实际用的那种。设置里改了当场换，不用重启 */
  let languageSetting = SETTINGS.language.value;
  let locale = resolveLocale(languageSetting, app.getPreferredSystemLanguages());
  /** 菜单栏用它；窗口里的页面各自按 locale 翻（预加载脚本一上来就同步来取） */
  let t = createTranslator(locale);
  ipcMain.on("locale:get", (event) => {
    event.returnValue = locale;
  });

  log.info("started", {
    version: app.getVersion(),
    hotkey,
    translateHotkey,
    translateTarget: SETTINGS.translateTarget.value,
    route: describeRoute(ROUTE),
    thinking: ROUTE.mode === "native" ? thinkingFor(PROVIDER) : null,
    theme: SETTINGS.theme.value,
    acceleration,
    language: languageSetting,
    locale,
    system_languages: app.getPreferredSystemLanguages(),
    home: PATHS.home,
    server_url: serverUrl,
    packaged: app.isPackaged,
    by_cli: LAUNCHED_BY_CLI,
    e2e: Boolean(e2e),
  });

  // ---------- 能不能用、还差什么 ----------

  /** 一家的名字，按界面语言写（文案 providers.<id>.name）；没有那一家（数据隐私模式）是 null */
  const vendorTitle = (vendor) => (vendor ? msg(`providers.${vendor.id}.name`) : null);

  /** 正在用的那一家：连着单独启动的服务端时是设置里那家（用哪个由那边定，这里只是个名字） */
  const provider = () => (service ? keys.provider : PROVIDER);

  const currentSetup = () => ({
    // 缺的是路线里另一家的 key（第一跳交给云端）时点名那一家。按界面语言写它的名字（阿里云百炼，不是日志里的 Bailian）
    providerName: vendorTitle(keys.current.vendor ?? provider()),
    key: keys.current,
    localModel: service?.localModel ?? null,
    helper: helperState,
    permissions: {
      microphone: systemPreferences.getMediaAccessStatus("microphone"),
      listen: helperPermissions?.listen ?? null,
      trusted: helperPermissions?.trusted ?? null,
    },
  });

  let offeredSettings = LAUNCHED_BY_CLI;
  /**
   * 还缺东西就打开首次引导，第一次启动的人不用猜下一步该干什么。只主动弹一次。
   * 由命令启动时不弹：那个人正看着终端，突然冒出一个窗口还会把他正要粘贴 key 的焦点抢走。
   * 几样检查是先后到的（key 要验证、小帮手要启动），都有了结论才判断，免得刚启动就误报。
   */
  function offerSettingsIfIncomplete() {
    const setup = currentSetup();
    if (offeredSettings || !startupChecked || setup.key.state === "checking" || setup.permissions.listen === null)
      return;
    const summary = summarizeSetup(setup);
    // settings.json 还没建立 = 从来没配置过：哪怕环境变量里恰好有一把能用的 key，也要走一遍引导——
    // 装完第一次打开就被扔进主窗口的人不知道该干什么。引导每一步都能跳过，跳过就是原来的样子
    const firstRunEver = !existsSync(PATHS.settingsFile);
    if (summary.missing.length === 0 && summary.degraded === null && !firstRunEver) return;
    offeredSettings = true;
    log.info("settings_offered", {
      missing: summary.missing,
      degraded: summary.degraded !== null,
      firstRunEver,
    });
    // 缺的是路线里另一家（第一跳交给的云端）的 key：首次引导只认正在用的那一家，在那里填会填错。去模型页的密钥表
    if (setup.key.vendor && !firstRunEver) showHub({ pane: "auto" });
    else showOnboarding();
  }

  /** 上面任何一样变了都调一次：菜单栏和主窗口跟着更新 */
  function setupChanged() {
    refreshTrayMenu();
    hubWindow?.webContents.send("setup:changed");
    onboardingWindow?.webContents.send("setup:changed");
  }

  // ---------- 主题 ----------

  let theme = findTheme(SETTINGS.theme.value);
  // 每个窗口的预加载脚本一上来就同步来取，赶在页面画出第一帧之前
  ipcMain.on("theme:get", (event) => {
    event.returnValue = themeCss(theme);
  });
  /** 重新读一遍设置里的主题，开着的窗口当场换。别的设置要重启才生效，主题不用 */
  function reloadTheme() {
    theme = findTheme(resolveSettings({ file: PATHS.settingsFile, env: process.env }).theme.value);
    const css = themeCss(theme);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("theme:changed", css);
    recolorCaptionButtons();
    log.info("theme_changed", { theme: theme.id });
    return { theme: theme.id };
  }
  const windowColors = () => theme.window[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
  /** 窗口还没画出页面时的底色：和页面的底一样，免得深色模式下先闪一下白 */
  const windowBackground = () => toHex(windowColors().bg);
  /** Windows 右上角那三个系统按钮：底透明（透出页面），符号用正文的颜色，跟着主题和深浅色换 */
  const captionButtons = () => ({ color: "#00000000", symbolColor: toHex(windowColors().ink), height: CAPTION_HEIGHT });
  /**
   * 主窗口和首次引导的标题栏：都藏起来，页面画到最顶上。macOS 的红绿灯放到 trafficLight 那里；
   * Windows 留下系统的三个按钮叠在右上角，再给窗口挂上图标（不然任务栏上是 Electron 的）
   */
  const frame = (trafficLight) =>
    WINDOWS
      ? { titleBarStyle: "hidden", titleBarOverlay: captionButtons(), icon: WINDOW_ICON }
      : { titleBarStyle: "hidden", trafficLightPosition: trafficLight };
  /** 换了主题、系统换了深浅色：Windows 上那三个按钮的颜色跟着换 */
  function recolorCaptionButtons() {
    if (!WINDOWS) return;
    for (const window of [hubWindow, onboardingWindow]) {
      if (window && !window.isDestroyed()) window.setTitleBarOverlay(captionButtons());
    }
  }
  nativeTheme.on("updated", recolorCaptionButtons);

  // ---------- 悬浮条 ----------

  function createBar() {
    const { workArea } = screen.getPrimaryDisplay();
    const bar = new BrowserWindow({
      ...BAR_SIZE,
      x: Math.round(workArea.x + (workArea.width - BAR_SIZE.width) / 2),
      // 贴着屏幕可用区域的底边。条离底边多远由 bar.css 定
      y: workArea.y + workArea.height - BAR_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 不能抢焦点：焦点一旦离开用户正在用的输入框，文字就贴不进去了
      focusable: false,
      webPreferences,
    });
    // 整个窗口都点不到，鼠标事件原样落到它下面的应用上。条上的两个按钮不靠这个窗口收点击：
    // 点击一旦落在我们的窗口上，系统就会把我们切到最前面（面板类型的窗口也一样，实测过），输入框照样丢焦点。
    // 所以点击是原生小帮手在事件到达任何窗口之前截下来的，见下面的 bar:capture
    bar.setIgnoreMouseEvents(true);
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    bar.loadFile(join(sourceDir, "renderer", "bar", "bar.html"));
    // 临时诊断：把悬浮条渲染层的话转进主日志（排查组合键链路用，查完撤）
    bar.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      log.warn("bar_console", { level, message: String(message).slice(0, 300), line, source: String(sourceId).slice(-80) });
    });
    return bar;
  }

  const bar = createBar();
  /** 给悬浮条的页面发消息。退出途中窗口已经销毁，这时再发会抛错 */
  const tellBar = (channel, payload) => {
    if (!bar.isDestroyed()) bar.webContents.send(channel, payload);
  };

  // ---------- 结果卡片窗（1:1 复刻原版 interactive-card）----------
  // 宽 800、贴着工作区底边上方 20px（悬浮条正上方）、随内容向上长高（最高 800，初始 500）、
  // panel 型无边框透明置顶；光标挪到哪块屏卡片跟到哪块屏；渲染层量好内容高度报上来调窗口。

  const CARD_WIDTH = 800;
  const CARD_MAX_HEIGHT = 800;
  const CARD_INITIAL_HEIGHT = 500;
  const CARD_BOTTOM_MARGIN = 20;
  const CARD_BOUNDS_DEBOUNCE_MS = 80;
  const CARD_BOUNDS_EPSILON = 2;
  let cardWindow = null;
  let cardPending = null;
  let cardBoundsTimer = null;
  let cardPendingHeight = null;
  let cardMouseTimer = null;
  let cardDisplayId = null;
  // 卡片显示期间全局截 Esc（复用小帮手的 esc 截获，焦点在哪都能关卡片，对齐原版的全局键盘监听）。
  // 条在截（录音中）时以条为准：esc 先取消录音；条不截而卡片开着时只截 esc（空区域，点击照常放行）
  let barHoldingCapture = false;
  const syncEscapeCapture = () => {
    if (barHoldingCapture) return;
    if (cardWindow && !cardWindow.isDestroyed()) helper.capture([]);
    else helper.release();
  };

  function cardTargetDisplay() {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  function cardBoundsFor(display, height) {
    const work = display.workArea;
    const max = Math.max(1, work.height - CARD_BOTTOM_MARGIN);
    const h = Math.min(Math.max(Math.round(height), 1), max);
    const x = Math.max(
      work.x,
      Math.min(work.x + Math.floor(work.width / 2) - Math.floor(CARD_WIDTH / 2), work.x + work.width - CARD_WIDTH),
    );
    let y = work.y + work.height - CARD_BOTTOM_MARGIN - h;
    if (y < work.y) y = work.y;
    return { x, y, width: CARD_WIDTH, height: h };
  }

  function stopCardMouseTracking() {
    if (cardMouseTimer !== null) {
      clearInterval(cardMouseTimer);
      cardMouseTimer = null;
    }
    cardDisplayId = null;
  }

  function createCardWindow() {
    const display = cardTargetDisplay();
    const max = Math.max(1, display.workArea.height - CARD_BOTTOM_MARGIN);
    const initial = max >= CARD_MAX_HEIGHT ? CARD_MAX_HEIGHT : Math.min(CARD_INITIAL_HEIGHT, max);
    cardDisplayId = display.id;
    cardWindow = new BrowserWindow({
      ...cardBoundsFor(display, initial),
      type: "panel",
      title: "AI result",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      maximizable: false,
      minimizable: false,
      resizable: false,
      fullscreenable: false,
      focusable: true,
      show: false,
      alwaysOnTop: true,
      webPreferences,
    });
    cardWindow.setAlwaysOnTop(true, "screen-saver", 1);
    cardWindow.setFullScreenable(false);
    cardWindow.loadFile(join(sourceDir, "renderer", "card", "card.html"));
    // 页面就绪再亮窗：建窗时 show:false 防闪白（原版同款），基类会在就绪后补 show——
    // 漏了这步窗口就永远藏着，卡片"开了却看不见"
    cardWindow.once("ready-to-show", () => {
      if (cardWindow && !cardWindow.isDestroyed()) cardWindow.show();
    });
    // 临时诊断：把卡片渲染层的话转进主日志（排查透明度用，查完撤）
    cardWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      log.warn("card_console", { level, message: String(message).slice(0, 300), line, source: String(sourceId).slice(-80) });
    });
    // 光标挪到哪块屏，卡片跟到哪块屏（原版同款 100ms 轮询）
    cardMouseTimer = setInterval(() => {
      if (!cardWindow || cardWindow.isDestroyed()) return;
      const next = cardTargetDisplay();
      if (next.id !== cardDisplayId) {
        cardDisplayId = next.id;
        cardWindow.setBounds(cardBoundsFor(next, cardWindow.getBounds().height));
      }
    }, 100);
    cardWindow.on("closed", () => {
      cardWindow = null;
      stopCardMouseTracking();
      syncEscapeCapture();
    });
  }

  /** 打开（或更新）结果卡片。answer 是必须的；没有就不开 */
  function openCard(payload) {
    if (typeof payload?.answer !== "string" || payload.answer.trim() === "") return false;
    cardPending = payload;
    if (cardWindow && !cardWindow.isDestroyed()) {
      cardWindow.webContents.send("card:update", payload);
      cardWindow.show();
    } else {
      createCardWindow();
    }
    syncEscapeCapture();
    return true;
  }

  function closeCard() {
    if (cardBoundsTimer !== null) {
      clearTimeout(cardBoundsTimer);
      cardBoundsTimer = null;
    }
    cardPendingHeight = null;
    cardPending = null;
    stopCardMouseTracking();
    if (cardWindow && !cardWindow.isDestroyed()) cardWindow.close();
    cardWindow = null;
    syncEscapeCapture();
  }

  handle("card:get-payload", () => cardPending);
  handle("card:close", () => {
    closeCard();
    return true;
  });
  handle("card:update-bounds", (_event, height) => {
    if (!Number.isFinite(height)) return false;
    cardPendingHeight = Math.min(Math.max(Math.round(height), 1), CARD_MAX_HEIGHT);
    if (cardBoundsTimer !== null) clearTimeout(cardBoundsTimer);
    cardBoundsTimer = setTimeout(() => {
      cardBoundsTimer = null;
      const next = cardPendingHeight;
      cardPendingHeight = null;
      if (!cardWindow || cardWindow.isDestroyed() || !Number.isFinite(next)) return;
      const bounds = cardBoundsFor(cardTargetDisplay(), next);
      const current = cardWindow.getBounds();
      if (
        Math.abs(current.height - bounds.height) > CARD_BOUNDS_EPSILON ||
        Math.abs(current.x - bounds.x) > CARD_BOUNDS_EPSILON ||
        Math.abs(current.y - bounds.y) > CARD_BOUNDS_EPSILON
      ) {
        cardWindow.setBounds(bounds);
      }
    }, CARD_BOUNDS_DEBOUNCE_MS);
    return true;
  });

  // ---------- 结果卡片窗结束 ----------

  const notify = (message) => tellBar("notice", message);
  /** 悬浮条上方的操作提示开不开（设置里的 barHint，on / off）。每次现读：被环境变量盖着时是环境变量里的 */
  const currentBarHint = () => resolveSettings({ file: PATHS.settingsFile, env: process.env }).barHint.value;
  ipcMain.on("bar:set-visible", (_event, visible) => {
    if (visible) {
      bar.showInactive();
      return;
    }
    bar.hide();
    // 条不在屏幕上时什么都不该截着。页面自己会说"不截了"，这里再说一遍是保险：
    // 万一它漏说了，esc 会一直被吞掉，在哪个应用里都按不出来
    barHoldingCapture = false;
    syncEscapeCapture();
  });
  // 页面崩了就更没人说"不截了"
  bar.webContents.on("render-process-gone", (_event, details) => {
    log.error("bar_gone", { reason: details.reason });
    barHoldingCapture = false;
    syncEscapeCapture();
  });
  // 听写进行中，页面让小帮手把 esc 和条上两个按钮的点击截下来（null 是不截了）。
  // 页面给的是按钮在窗口里的位置，小帮手要的是在屏幕上的位置
  ipcMain.on("bar:capture", (_event, regions) => {
    if (regions === null) {
      barHoldingCapture = false;
      syncEscapeCapture();
      return;
    }
    if (!Array.isArray(regions)) {
      log.error("bar_capture_invalid", { type: typeof regions });
      return;
    }
    barHoldingCapture = true;
    const origin = bar.getBounds();
    const onScreen = regions.map(({ id, x, y, width, height }) => {
      const rect = { x: origin.x + x, y: origin.y + y, width, height };
      // Windows 的鼠标钩子报的是物理像素，窗口的位置是按缩放换算过的：换成那块屏上的物理像素再交过去
      return { id, ...(WINDOWS ? screen.dipToScreenRect(bar, rect) : rect) };
    });
    // "点了按钮没反应"时先看这条：位置对不对得上屏幕上画的那两个圆
    log.info("bar_capture", { regions: onScreen });
    helper.capture(onScreen);
  });

  // ---------- 按键和贴字 ----------

  let helper = null;
  /** 每启动一个小帮手加一；旧的那个退出时发来的事件靠它认出来并丢掉 */
  let helperGeneration = 0;
  /** 小帮手截不截得住 esc 和点击（要辅助功能权限）。截不住时悬浮条不画那两个按钮 */
  let barControls = false;
  function setBarControls(enabled) {
    barControls = enabled;
    tellBar("bar:controls", enabled);
  }

  /**
   * @param {{ prompt: boolean }} options prompt：两项权限没给时让不让系统弹授权框。只在应用启动时弹一次；
   *   之后重新检查权限靠的是重启小帮手，那时再弹的话每查一次弹一次
   */
  function launchHelper({ prompt }) {
    const generation = ++helperGeneration;
    helperPermissions = null;
    helperState = "starting";
    setBarControls(false);
    helper = startHelper(helperPaths(app.getAppPath()).binary, {
      args: ["--key", hotkey, ...(prompt ? [] : ["--no-prompt"])],
      onEvent: (event) => {
        if (generation === helperGeneration) onHelperEvent(event);
      },
      log,
    });
  }

  function onHelperEvent(event) {
    switch (event.event) {
      case "ready":
        helperState = "running";
        helperPermissions = { listen: event.listen, trusted: event.trusted };
        log.info("helper_ready", { ...helperPermissions, capture: event.capture });
        setBarControls(event.capture === true);
        setupChanged();
        offerSettingsIfIncomplete();
        break;
      case "hotkey":
      case "other_key": {
        // 首次引导正在测快捷键、人也正看着它：热键只送到引导窗口。
        // 切到别的应用了就照常听写，不然热键在哪都按不出来，还没有任何提示；
        // 悬浮条在屏幕上（切出去开了一段听写又切回来）时也给条，不然这一段停不下来
        if (event.event === "hotkey" && hotkeyToOnboarding && onboardingWindow?.isFocused() && !bar.isVisible()) {
          log.info("key_event", { event: event.event, down: event.down, to: "onboarding" });
          onboardingWindow.webContents.send("onboarding:hotkey", { down: event.down });
          break;
        }
        // 热键不灵时先看这条日志有没有：没有就是小帮手没收到按键（权限或键选错了）。
        // key：组合键那次按的是哪个键（Space 是 32）
        log.info("key_event", { event: event.event, down: event.down, key: event.key });
        const { blocker } = summarizeSetup(currentSetup());
        if (blocker === null) tellBar("input", event);
        else if (event.event === "hotkey" && event.down) notify(blocker);
        break;
      }
      case "escape":
      case "click":
        // 卡片开着且条没在录音：Esc 直接关卡片（不用焦点，对齐原版的全局键盘监听）；
        // 条在录音时以条为准（esc 先取消录音）
        if (event.event === "escape" && !barHoldingCapture && cardWindow && !cardWindow.isDestroyed()) {
          closeCard();
          break;
        }
        // 只在听写进行中才会有：那时页面让小帮手把它们截下来了
        // 字段不能叫 event：日志这一条的名字就记在 event 里，会被盖掉
        log.info("bar_input", { input: event.event, id: event.id });
        tellBar("input", event);
        break;
      case "exit":
        helperState = "stopped";
        helperPermissions = null;
        setBarControls(false);
        log.error("helper_exited", { code: event.code, signal: event.signal });
        setupChanged();
        notify(msg("bar.helperStopped", { hotkey: hotkeyName(hotkey) }));
        break;
      default:
        log.warn("helper_unknown_event", { event: event.event });
    }
  }

  // ---------- 翻译热键的小帮手 ----------
  // 同一个可执行文件再起一个、听翻译那个键（native 小帮手一次只认一个键）。它报的 hotkey 事件换成
  // translate_hotkey 发给悬浮条：录音、上传都同一条路，差的只是给服务端的消息。
  // 它停了只影响翻译（听写不受连累），所以不进 setup 的状态，只记日志、在条上说一声。

  let translateHelper = null;
  /** 每启动一个翻译小帮手加一；旧的那个退出时发来的事件靠它认出来并丢掉 */
  let translateHelperGeneration = 0;

  function launchTranslateHelper() {
    if (e2e) {
      translateHelper = e2e.fakeHelper;
      return;
    }
    // 和听写热键撞了就不起：两个钩子会把一次按键报成两次，翻译和听写都乱。说清楚怎么办
    if (translateHotkey === hotkey) {
      log.warn("translate_hotkey_conflicts", { hotkey, translateHotkey });
      notify(msg("bar.translateHotkeyConflicts", { hotkey: hotkeyName(hotkey) }));
      return;
    }
    const generation = ++translateHelperGeneration;
    translateHelper = startHelper(helperPaths(app.getAppPath()).binary, {
      args: ["--key", translateHotkey, "--no-prompt"],
      onEvent: (event) => {
        if (generation !== translateHelperGeneration) return;
        onTranslateHelperEvent(event);
      },
      log,
    });
  }

  function onTranslateHelperEvent(event) {
    switch (event.event) {
      case "ready":
        log.info("translate_helper_ready", { hotkey: translateHotkey });
        break;
      case "hotkey":
        log.info("key_event", { event: "translate_hotkey", down: event.down });
        {
          const { blocker } = summarizeSetup(currentSetup());
          if (blocker === null) tellBar("input", { event: "translate_hotkey", down: event.down });
          else if (event.down) notify(blocker);
        }
        break;
      case "other_key":
        // 翻译键按着又按了别的键：组合键，不是翻译
        tellBar("input", { event: "other_key" });
        break;
      case "exit":
        log.error("translate_helper_exited", { code: event.code, signal: event.signal });
        notify(msg("bar.translateHelperStopped", { hotkey: hotkeyName(translateHotkey) }));
        break;
      default:
        log.warn("translate_helper_unknown_event", { event: event.event });
    }
  }

  // 端到端测试时不启动小帮手：不听真键盘，也绝不往用户当前的窗口里贴字
  if (e2e) helper = e2e.fakeHelper;
  else launchHelper({ prompt: true });
  // 翻译键的小帮手：e2e 时同样用假的（它的事件由测试自己编）
  launchTranslateHelper();

  // ---------- 页面要主进程代办的事 ----------

  const delivery = createDelivery({
    recordingsDir: PATHS.recordingsDir,
    history,
    paste: (text) => helper.paste(text),
    // 富文本贴：剪贴板写 text + html 双格式（目标应用粘贴时自动挑支持的），再模拟 Ctrl+V；完事把剪贴板还原成贴之前的文字
    pasteRich: async (text, html) => {
      // 存剪贴板用安全的读：这个 Electron 的 readText 偶发参数转换错，读不了就跳过还原
      let previous = null;
      try {
        previous = clipboard.readText();
      } catch {
        // 读不了就不还原了，贴完让成品留在剪贴板里
      }
      // 这个 Electron 的 clipboard.write 装双格式对象会因参数转换失败炸（和 readHTML 缺失同源的
      // 版本差异）：炸了就退纯文本，粘贴绝不能因为富格式失败
      try {
        clipboard.write({ text, html });
      } catch (error) {
        log.warn("rich_clipboard_failed", { error: String(error?.message ?? error).slice(0, 200) });
        clipboard.writeText(text);
      }
      // Ctrl+V 由原生小帮手注入：Electron 的主进程里用 koffi 模拟按键会因参数转换失败必炸
      const result = await helper.pasteClipboard();
      // 贴成了才还原；没贴成把成品留在剪贴板里，让用户自己按 Ctrl+V
      if (result.ok && previous !== null) clipboard.writeText(previous);
      return result;
    },
    writeClipboard: (text) => clipboard.writeText(text),
    log,
  });
  function historyChanged() {
    hubWindow?.webContents.send("history:changed");
  }

  /**
   * 页面调用主进程。出错时 Electron 只把 message 带给页面，problem 丢了，而 LocalizedError 的 message 是英文：
   * 这种错在这边按界面语言翻好再抛（比如设置文件坏了时改热键，中文界面要说中文）
   */
  function handle(channel, listener) {
    ipcMain.handle(channel, async (...args) => {
      try {
        return await listener(...args);
      } catch (error) {
        if (error instanceof LocalizedError) throw new Error(t.text(error.problem), { cause: error });
        throw error;
      }
    });
  }

  handle("config:get", () => ({
    serverUrl,
    hotkey,
    // 悬浮条翻译的那次要用：哪个键、翻成哪种（都是 id，页面按界面语言写名字）
    translateHotkey,
    translateTarget,
    // 设置里选定的麦克风（null = 系统默认）：悬浮条开麦用这一台
    microphoneDeviceId: resolveSettings({ file: PATHS.settingsFile, env: process.env }).microphoneDeviceId.value,
    barControls,
    barHint: currentBarHint(),
    // 交互声音：关键操作的短提示音，悬浮条在开始/成品/失败时放
    interactionSounds: resolveSettings({ file: PATHS.settingsFile, env: process.env }).interactionSounds.value,
  }));
  handle("dictation:capture-selection", async () => {
    // 模拟 Ctrl+C 抓当前选区：按键由原生小帮手注入（Electron 里 koffi 会炸），
    // 等目标应用复制、读完还原。这个 Electron 的 clipboard.readText 偶发参数转换错：
    // 读不了就当没有选区（无选区指令本来就走问答卡片），不让它炸整个抓取
    const readClipboard = () => {
      try {
        return clipboard.readText();
      } catch {
        return null;
      }
    };
    const before = readClipboard();
    const sent = await helper.sendCopy();
    if (!sent.ok) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const captured = readClipboard();
    if (before !== null && captured !== null) clipboard.writeText(before);
    // 前后一样（或读不了剪贴板）：按没选中处理
    return captured === null || captured === before ? null : captured;
  });
  // 失败条目的重试：把存下来的录音按当前链路再跑一遍，成品更新进这条历史并贴出
  handle("history:retry", async (_event, audioId) => {
    if (typeof audioId !== "string" || !/^[0-9a-f-]{36}$/.test(audioId)) throw new TypeError("audioId 不是 UUID");
    const row = history.get(audioId);
    if (row === null) throw new TypeError(`历史里没有这一条：${audioId}`);
    if (row.audioLocalPath === null || !existsSync(row.audioLocalPath)) {
      throw new TypeError("这条的录音文件已经不在了，没法重试");
    }    if (service === null) throw new TypeError("服务还没起来");
    const raw = readFileSync(row.audioLocalPath);
    const audio = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const outcome = await service.refineAudio(audio, { mimeType: "audio/webm", audioId });
    const text = typeof outcome === "string" ? outcome : outcome.text;
    history.updateRefinedText(audioId, text);
    historyChanged();
    await helper.paste(text);
    return { text };
  });
  // 历史页的"删除所有"：全部条目和记账清空，录音文件一并删掉
  handle("history:delete-all", () => {
    const recordings = history.deleteAll();
    for (const path of recordings) {
      try {
        rmSync(path, { force: true });
      } catch {
        // 删不掉就留着：数据库里已经没了，孤儿文件不碍事
      }
    }
    historyChanged();
    return { deleted: true };
  });
  // 设置页的个人词典：列表、增删、CSV 导入（文件选择框在主进程开，读文本交给词典模块解析）
  handle("dict:list", () => loadDictionary(PATHS.dictionaryFile));
  handle("dict:add", (_event, wrong, correct) => {
    saveDictionary(PATHS.dictionaryFile, addEntry(loadDictionary(PATHS.dictionaryFile), wrong, correct));
  });
  handle("dict:remove", (_event, wrong) => {
    saveDictionary(PATHS.dictionaryFile, removeEntry(loadDictionary(PATHS.dictionaryFile), wrong));
  });
  handle("dict:import-csv", async () => {
    const picked = await dialog.showOpenDialog({
      filters: [{ name: "CSV", extensions: ["csv", "txt"] }],
      properties: ["openFile"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
    const imported = parseDictionaryCsv(readFileSync(picked.filePaths[0], "utf8"));
    let merged = loadDictionary(PATHS.dictionaryFile);
    for (const entry of imported) merged = addEntry(merged, entry.wrong, entry.correct);
    saveDictionary(PATHS.dictionaryFile, merged);
    return { imported: imported.length, total: merged.length };
  });
  // 指令的 reply 交付：答案进结果卡片（1:1 复刻原版 interactive-card），同时复制到剪贴板（卡片关了答案也不丢）
  handle("command:reply", (_event, payload) => {
    const answer = typeof payload === "string" ? payload : payload?.answer;
    if (typeof answer !== "string" || answer.trim() === "") throw new TypeError("要展示的答案是一段非空文字");
    clipboard.writeText(answer);
    openCard({
      answer,
      userPrompt: (payload && typeof payload === "object" && payload.userPrompt) || null,
      selectedText: (payload && typeof payload === "object" && payload.selectedText) || null,
      webMetadata: null,
    });
    return { copied: true };
  });
  // 指令的 external 交付：只放行网页和邮件链接，其余协议一律不开
  handle("command:open-external", (_event, target) => {
    if (typeof target !== "string") throw new TypeError("要打开的目标是一个网址");
    // 启动应用（对齐原版 launchApplicationByName）：目标形如 app:chrome。
    // 只认白名单（launch-app.mjs）——模型的字符串绝不直接进命令行
    if (target.startsWith("app:")) {
      const name = target.slice(4);
      const launch = launchTargetOf(name);
      if (launch === null) throw new TypeError(`不认识要启动的应用：${name}`);
      spawn("cmd", ["/c", "start", "", launch], { detached: true, stdio: "ignore" }).unref();
      log.info("app_launched", { app: name });
      return { launched: true };
    }
    const protocol = new URL(target).protocol;
    if (!["http:", "https:", "mailto:"].includes(protocol)) throw new TypeError(`不放行 ${protocol} 协议的目标`);
    shell.openExternal(target);
  });
  handle("dictation:deliver", async (_event, payload) => {
    // 指令的那次（点过 ⌘）：成品转成 HTML，贴字走 text + html 双格式——目标应用支持就用它的排版
    const html = payload.command === true ? mdLikeToHtml(payload.text) : undefined;
    const result = await delivery.completed(payload, { html });
    // 只记长度：成品是用户说的话，不进日志
    log.info("delivered", { audio_id: payload.audioId, text_length: payload.text.length, notice: result.notice });
    historyChanged();
    e2e?.onFinished({ delivered: payload.text, notice: result.notice });
    return result;
  });
  handle("dictation:failed", (_event, payload) => {
    delivery.failed(payload);
    log.warn("dictation_failed", { audio_id: payload.audioId, error: payload.error });
    historyChanged();
    e2e?.onFinished({ failed: payload.error });
  });
  handle("history:list", () => history.list());
  handle("usage:report", () => usageReport(history, { now: new Date() }));
  handle("insights:get", () => insights(history.dictations(), { now: new Date() }));
  handle("app:info", () => ({ version: app.getVersion(), hotkey, translateHotkey, translateTarget }));
  handle("app:open-homepage", () => shell.openExternal(HOMEPAGE));
  handle("clipboard:write", (_event, text) => {
    if (typeof text !== "string") throw new TypeError("要复制的不是文字");
    clipboard.writeText(text);
  });

  // ---------- 主窗口的设置要主进程代办的事 ----------

  handle("setup:get", () => {
    const setup = currentSetup();
    return {
      ...setup,
      summary: summarizeSetup(setup),
      // 叫什么由页面按界面语言写，这里只给 id
      hotkey: { value: hotkey, choices: HOTKEY_IDS },
      translateHotkey: { value: translateHotkey, choices: HOTKEY_IDS },
      historyRetentionDays: {
        value: resolveSettings({ file: PATHS.settingsFile, env: process.env }).historyRetentionDays.value,
        choices: ["forever", "1", "7", "30", "90", "365"],
      },
      // 设置页的麦克风调试：选定的是哪台（null = 系统默认），设备清单由页面自己枚举
      microphoneDeviceId: resolveSettings({ file: PATHS.settingsFile, env: process.env }).microphoneDeviceId.value,
      // 设置页的交互声音开关
      interactionSounds: resolveSettings({ file: PATHS.settingsFile, env: process.env }).interactionSounds.value,
      translateTarget: { value: translateTarget, choices: TRANSLATE_TARGETS },
      theme: { value: theme.id, choices: THEMES.map(({ id }) => id) },
      barHint: currentBarHint(),
      language: { value: languageSetting, locale },
      // 开机启动登记的是"这个应用"；从终端启动时登记上去的会是 Electron 本身，所以只在装成应用后开放
      openAtLogin: {
        supported: app.isPackaged || INSTALLED_ON_WINDOWS,
        enabled: loginItemEnabled(),
      },
      home: PATHS.home,
      version: app.getVersion(),
      // 正在用 key 的那一家；数据隐私模式不用 key，是 null
      provider: provider() ? describeVendor(provider()) : null,
      ...describeModes(),
      // 侧栏"模型"一页：三排货架和密钥表（model-plaza.mjs）
      plaza: describePlazaNow(),
      // 连着单独启动的服务端时用哪种模式、哪家由那边定，这里换不了
      switchable: Boolean(service),
    };
  });

  /** 模型广场按现在的设置、key、本机模型的状态拼出来 */
  function describePlazaNow() {
    const settings = resolveSettings({ file: PATHS.settingsFile, env: process.env });
    let freeBytes = null;
    try {
      freeBytes = freeBytesAt(PATHS.modelsDir);
    } catch (error) {
      log.warn("disk_space_unknown", { error: String(error) });
    }
    return describePlaza({
      mode: service?.route.mode ?? ROUTE.mode,
      chosen: {
        native: settings.model.value,
        transcriber: settings.transcriber.value,
        privateTranscriber: settings.privateTranscriber.value,
        polish: settings.polish.value,
        customUrl: settings.customUrl.value,
        customParams: settings.customParams.value,
      },
      keys: service ? keys.sources() : {},
      status: Object.fromEntries(MODELS.map(({ id }) => [id, localModels.status(id)])),
      chip: CHIP,
      freeBytes,
      prices,
      routes: Object.fromEntries(MODES.map(({ id }) => [id, routeOrProblem(settings, id)])),
      presets: presetsFor(CHIP).map((preset) => ({
        preset,
        route: routeOrProblem(settings, preset.mode, preset.settings),
      })),
      at: estimateTime(new Date()),
    });
  }

  /**
   * 某种方式按设置（再换上 changes 那几项）走的路线；拼不出路线时（比如自定义服务没写模型名）交出原因，
   * 首页的选单、模型页的推荐组合照实说
   */
  function routeOrProblem(settings, mode, changes = {}) {
    try {
      return routeOf(patchSettings(settings, changes), mode);
    } catch (error) {
      return { problem: problemOf(error) };
    }
  }

  /** 设置里要的一家的说明，带着它的 key 在哪（env / stored / null，不解密） */
  function describeVendor(found) {
    const sources = service ? keys.sources() : {};
    return {
      id: found.id,
      name: found.name,
      keyEnv: found.keyEnv,
      key: sources[found.id] ?? null,
      hasKeyPage: Boolean(found.keyPage),
      defaultModel: found.defaultModel ?? null,
      // 能挑的模型：{ id, name, maker }
      models: found.models ?? [],
    };
  }

  /**
   * 三种模式各自的设置：正在用的是哪种，native 选了哪个模型，local 两跳各选了什么，private 选了哪个本机模型。
   * 没在用的那种模式也要列：设置里可以先改好它，切过去时就用上
   */
  function describeModes() {
    const settings = resolveSettings({ file: PATHS.settingsFile, env: process.env });
    let freeBytes = null;
    try {
      freeBytes = freeBytesAt(PATHS.modelsDir);
    } catch (error) {
      log.warn("disk_space_unknown", { error: String(error) });
    }
    return {
      mode: { value: service?.route.mode ?? ROUTE.mode, choices: MODES.map(({ id }) => id) },
      native: { model: settings.model.value, providers: PROVIDERS.map(describeVendor) },
      private: { transcriber: settings.privateTranscriber.value },
      local: {
        transcriber: settings.transcriber.value,
        transcribers: MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          // 出自哪家，界面按它配图标
          maker: makerOf(model),
          license: model.license.name,
          bytes: downloadSize(model),
          // 下好了没有、正在下到哪、下过一半的有多少、上次为什么没下下来
          ...localModels.status(model.id),
          tags: tagsOn(model, CHIP),
          // 在这类芯片上的实测，跑得快的在前；没测过是空的
          measured: measuredOn(model, CHIP),
        })),
        chip: CHIP,
        // 模型目录那块磁盘还剩多少，查不了是 null
        freeBytes,
        // 本地模型从哪下：哪种模式里都能换
        source: { value: settings.modelSource.value, choices: SOURCES.map(({ id }) => id) },
        // 本机模型用不用显卡：正在用的那个（被环境变量盖着时是环境变量里的）
        acceleration: { value: acceleration, choices: ACCELERATIONS },
        polish: settings.polish.value,
        customUrl: settings.customUrl.value,
        customParams: settings.customParams.value,
        vendors: CHAT_VENDORS.map(describeVendor),
      },
    };
  }

  /** 这几件事归模式那一层管；连着单独启动的服务端时做不了 */
  const viaModes = (action) => (modes ? action(modes) : { ok: false, problem: msg("key.externalModel") });

  // 设置里和 speakmore key 存 key、删 key，走的是同一处。
  // 给别家存 key 时可以带上要一起换成的设置（changes），拿它们验证：自定义服务没有默认模型，要连模型名一起给
  handle("setup:save-key", (_event, value, id, changes) =>
    keys.save(value, {
      provider: id ?? keys.provider?.id,
      ...(id && changes && modes ? { route: modes.routeForVendor(id, changes) } : {}),
    }),
  );
  handle("setup:forget-key", (_event, id) => keys.forget({ provider: id ?? keys.provider?.id }));
  // 删除自定义服务：key、地址、额外参数一并清；润色正在用它时换回默认的润色模型（不然货架清了、设置还指着它）
  handle("setup:remove-custom", () => {
    keys.forget({ provider: "custom" });
    saveSetting(PATHS.settingsFile, "customUrl", "");
    saveSetting(PATHS.settingsFile, "customParams", "");
    const settings = resolveSettings({ file: PATHS.settingsFile, env: process.env });
    if (settings.polish.value.startsWith("custom/")) {
      // 默认值在 schema 里（SETTINGS.polish.default）；resolveSettings 给的每项只有 value/source，没有 default
      saveSetting(PATHS.settingsFile, "polish", SETTING_SCHEMA.polish.default);
    }
    setupChanged();
    return {};
  });
  // 设置里的"检查"：哪种模式里都能查，按页面上选的（还没换过去的）设置查
  handle("setup:check-model", (_event, mode, changes) => viaModes((m) => m.check(mode, changes ?? {})));
  // 模式这一层，和各模式里的模型：分开的几件事
  // 切模式时可以连带那种模式自己的设置（changes），比如第一次进 local 就用自定义服务。
  // 选了就当场换上，还差什么（key、下载）记在状态里，不拦着（app/modes.mjs）
  handle("setup:set-mode", (_event, mode, changes) => viaModes((m) => m.switchMode(mode, changes ?? {})));
  handle("setup:set-model", (_event, model) => viaModes((m) => m.setModel(model)));
  handle("setup:set-transcriber", (_event, id) => viaModes((m) => m.setTranscriber(id)));
  // 自定义服务的地址和额外参数（custom）和模型一起换，没给的照设置里的
  handle("setup:set-polish", (_event, polish, custom) => viaModes((m) => m.setPolish(polish, custom ?? {})));
  // 本机模型：下载、取消、删除都由用户点；正在用的不能删（模式那一层管）
  handle("setup:download-model", (_event, id) => localModels.download(id));
  handle("setup:cancel-download", (_event, id) => {
    localModels.cancel(id);
    return { ok: true };
  });
  handle("setup:delete-model", (_event, id) => viaModes((m) => m.removeModel(id)));
  // 检查本机模型：按界面语言念一句交给它转
  handle("setup:check-transcriber", (_event, id) => viaModes((m) => m.checkTranscriber(id, { locale })));
  handle("setup:read-clipboard", () => clipboard.readText());
  handle("setup:open-key-page", (_event, id) => {
    // 自定义服务没有申请 key 的页面
    const { keyPage } = findVendor(id) ?? provider() ?? {};
    if (!keyPage) throw new TypeError(`${id} 没有申请 key 的页面`);
    return shell.openExternal(keyPage);
  });

  handle("setup:open-privacy", async (_event, permission) => {
    if (!Object.hasOwn(PRIVACY_PANES, permission)) throw new TypeError(`不认识的权限：${permission}`);
    // 麦克风从没问过时，系统设置的列表里还没有这个应用，要先让系统弹一次授权框（只有 macOS 有这种框）
    if (
      !WINDOWS &&
      permission === "microphone" &&
      systemPreferences.getMediaAccessStatus("microphone") === "not-determined"
    ) {
      await systemPreferences.askForMediaAccess("microphone");
      setupChanged();
      return;
    }
    await shell.openExternal(PRIVACY_PANES[permission]);
  });
  /** 两项系统权限是小帮手启动时查的，授权之后要重启它才看得到。它停了的话，这也是把它重新拉起来的办法 */
  function recheckPermissions() {
    if (!e2e) {
      helper.stop();
      launchHelper({ prompt: false });
    }
    setupChanged();
  }
  /** 启动时没连上网、先用着的 key，在后台再验一次。不等结果：没网时一等就是几十秒 */
  function reverifyKeyInBackground() {
    keys.reverify().catch((error) => log.error("key_reverify_failed", { error: String(error?.stack ?? error) }));
  }
  handle("setup:recheck", () => {
    recheckPermissions();
    reverifyKeyInBackground();
  });
  handle("setup:set-open-at-login", (_event, enabled) => {
    if (!app.isPackaged && !INSTALLED_ON_WINDOWS) throw new Error("从终端启动时不能设置开机启动");
    app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: Boolean(enabled) });
    log.info("open_at_login", { enabled: Boolean(enabled) });
    setupChanged();
  });
  handle("setup:set-hotkey", (_event, wanted) => setHotkey(wanted));
  handle("setup:set-translate-hotkey", (_event, wanted) => setTranslateHotkey(wanted));
  handle("setup:set-history-retention", (_event, wanted) => setHistoryRetention(wanted));
  handle("setup:set-translate-target", (_event, wanted) => setTranslateTarget(wanted));
  handle("setup:set-microphone-device", (_event, wanted) => setMicrophoneDevice(wanted));
  handle("setup:set-theme", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "theme", wanted);
    reloadTheme();
    setupChanged();
    // 和热键一样：被环境变量盖着时，存是存下了，眼前不会变，要交代一句
    const variable = overridingEnv("theme", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-model-source", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "modelSource", wanted);
    reloadModelSource();
    const variable = overridingEnv("modelSource", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-acceleration", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "acceleration", wanted);
    acceleration = resolveSettings({ file: PATHS.settingsFile, env: process.env }).acceleration.value;
    log.info("acceleration_changed", { acceleration });
    // 装着本机模型的话按新的设置重装一遍
    service?.setAcceleration(acceleration);
    setupChanged();
    const variable = overridingEnv("acceleration", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  // 悬浮条上方的操作提示开不开：存下来，开着的悬浮条当场跟着变
  handle("setup:set-bar-hint", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "barHint", wanted);
    const barHint = currentBarHint();
    log.info("bar_hint_changed", { barHint });
    tellBar("bar:hint", barHint);
    setupChanged();
    const variable = overridingEnv("barHint", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });

  // 交互声音开不开：存下来，悬浮条当场跟着变
  handle("setup:set-interaction-sounds", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "interactionSounds", wanted);
    const interactionSounds = resolveSettings({ file: PATHS.settingsFile, env: process.env }).interactionSounds.value;
    log.info("interaction_sounds_changed", { interactionSounds });
    tellBar("bar:interaction-sounds", interactionSounds);
    setupChanged();
    const variable = overridingEnv("interactionSounds", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-language", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "language", wanted);
    // 是在设置的"通用"那一页换的：主窗口换好语言后回到这一页
    reloadLanguage({ hubTarget: { pane: "general" } });
    const variable = overridingEnv("language", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });

  /**
   * 重新读一遍设置里的下载源，交给模型库：正在下的从新的源接着下，以后的下载也用它。不用重启
   * @returns {{ modelSource: string }} 实际用的那个（被环境变量盖着时是环境变量里的）
   */
  function reloadModelSource() {
    const { value } = resolveSettings({ file: PATHS.settingsFile, env: process.env }).modelSource;
    localModels.setSource(value);
    setupChanged();
    return { modelSource: value };
  }

  /**
   * 重新读一遍设置里的语言，变了就当场换：菜单栏重画，主窗口和首次引导重新加载（页面上的字都按新的语言写），
   * 悬浮条换掉翻译，下一句提示就是新的语言。不用重启
   * @param {{ hubTarget?: object }} [options] 主窗口重新加载后去哪一页；不给就留在原地
   */
  function reloadLanguage({ hubTarget } = {}) {
    languageSetting = resolveSettings({ file: PATHS.settingsFile, env: process.env }).language.value;
    const next = resolveLocale(languageSetting, app.getPreferredSystemLanguages());
    if (next !== locale) {
      locale = next;
      t = createTranslator(locale);
      refreshTrayMenu();
      tellBar("locale:changed", locale);
      if (hubWindow !== null) {
        if (hubTarget) hubWindow.loadFile(join(sourceDir, "renderer", "hub", "hub.html"), { query: hubTarget });
        else hubWindow.webContents.reload();
      }
      if (onboardingWindow) {
        // 重新加载后从头开始：正停在测快捷键那一步的话，热键别再交给它，到那一步时它会再要
        hotkeyToOnboarding = false;
        onboardingWindow.webContents.reload();
      }
      log.info("language_changed", { language: languageSetting, locale });
    }
    return { language: languageSetting, locale };
  }

  /**
   * 当场换热键：记进设置，重启小帮手让它听新的键，悬浮条的提示、菜单栏跟着换。不用重启整个应用
   * @returns {{ note?: object }} 有话要交代时（被环境变量盖着）带一句（msg）
   */
  function setHotkey(wanted) {
    if (!HOTKEY_IDS.includes(wanted)) throw new TypeError(`不认识的热键：${wanted}`);
    saveSetting(PATHS.settingsFile, "hotkey", wanted);
    if (wanted !== hotkey) {
      hotkey = wanted;
      log.info("hotkey_changed", { hotkey });
      // 和重新检查权限一样：先停旧的再起新的，旧的那个退出时的事件靠代数作废
      if (!e2e) {
        helper.stop();
        launchHelper({ prompt: false });
      }
      tellBar("bar:hotkey", hotkey);
      historyChanged();
      setupChanged();
    }
    // 听写键换成了和翻译键相同/不再相同时，翻译小帮手跟着起或停
    syncTranslateHelper();
    const variable = overridingEnv("hotkey", process.env);
    return variable === null ? {} : { note: msg("notes.envNextLaunch", { variable }) };
  }

  /**
   * 翻译小帮手现在该在不在：听写热键和翻译热键撞了就不在（launchTranslateHelper 说过原因）；
   * 之前因为撞了没起的，听写键换开了就补上
   */
  function syncTranslateHelper() {
    if (e2e) return;
    if (translateHotkey === hotkey) {
      if (translateHelper !== null) {
        translateHelperGeneration++;
        translateHelper.stop();
        translateHelper = null;
        log.warn("translate_helper_stopped", { reason: "和听写热键相同", hotkey });
      }
      return;
    }
    if (translateHelper === null) launchTranslateHelper();
  }

  /** 换翻译热键：存下来，只听这一个键的小帮手整个换掉（撞键的起停 syncTranslateHelper 里处理） */
  function setTranslateHotkey(wanted) {
    if (!HOTKEY_IDS.includes(wanted)) throw new TypeError(`不认识的翻译热键：${wanted}`);
    saveSetting(PATHS.settingsFile, "translateHotkey", wanted);
    if (wanted !== translateHotkey) {
      translateHotkey = wanted;
      log.info("translate_hotkey_changed", { translateHotkey });
      syncTranslateHelper();
      tellBar("bar:translate-hotkey", translateHotkey);
      setupChanged();
    }
    const variable = overridingEnv("translateHotkey", process.env);
    return variable === null ? {} : { note: msg("notes.envNextLaunch", { variable }) };
  }

  /** 换历史保留：存下来，当场按新的保留期清一遍（forever/更长保留期的选择不会删任何东西） */
  function setHistoryRetention(wanted) {
    if (!["forever", "1", "7", "30", "90", "365"].includes(wanted)) {
      throw new TypeError(`不认识的历史保留：${wanted}`);
    }
    saveSetting(PATHS.settingsFile, "historyRetentionDays", wanted);
    cleanupHistoryRetention();
    const variable = overridingEnv("historyRetentionDays", process.env);
    return variable === null ? {} : { note: msg("notes.envNextLaunch", { variable }) };
  }

  /** 换翻译的目标语言：存下来，悬浮条和下一次翻译立刻按新的来 */
  function setTranslateTarget(wanted) {
    const target = String(wanted).trim().toLowerCase();
    if (!TRANSLATE_TARGETS.includes(target)) throw new TypeError(`不认识的翻译目标语言：${wanted}`);
    saveSetting(PATHS.settingsFile, "translateTarget", target);
    if (target !== translateTarget) {
      translateTarget = target;
      log.info("translate_target_changed", { translateTarget });
      tellBar("bar:translate-target", translateTarget);
      setupChanged();
    }
    const variable = overridingEnv("translateTarget", process.env);
    return variable === null ? {} : { note: msg("notes.envNextLaunch", { variable }) };
  }

  /** 换麦克风：存下来并推给悬浮条，下一次开麦就用新的。空串/null 当系统默认 */
  /** 换麦克风：存下来并推给悬浮条，下一次开麦就用新的。空串/null 都当系统默认存成空串（存储层只收文本） */
  function setMicrophoneDevice(wanted) {
    const deviceId = wanted === null || wanted === undefined ? "" : String(wanted);
    if (deviceId.length > 256) throw new TypeError("deviceId 要是不超过 256 字的文本");
    saveSetting(PATHS.settingsFile, "microphoneDeviceId", deviceId);
    log.info("microphone_changed", { device: deviceId === "" ? "default" : "custom" });
    tellBar("bar:microphone-device", deviceId);
    setupChanged();
    return {};
  }

  // ---------- 菜单栏、主窗口和首次引导 ----------

  /**
   * 打开主窗口（已经开着就亮出来），可以顺带指定去哪一页。
   * @param {{ route?: "home" | "history", pane?: string }} [target] pane：设置里的哪一页，"auto" 是还差东西的那一页
   */
  function showHub(target = {}) {
    if (hubWindow === null) {
      hubWindow = createHub(target);
    } else if (target.route || target.pane) {
      hubWindow.webContents.send("hub:navigate", target);
    }
    hubWindow.show();
    // 这是个没有程序坞图标的应用，不主动要一下焦点的话窗口会开在别的应用后面
    app.focus({ steal: true });
  }

  function createHub(target) {
    const window = new BrowserWindow({
      ...HUB_SIZE,
      title: "Utterly",
      backgroundColor: windowBackground(),
      // 和原版一样把标题栏藏起来，红绿灯放进侧栏的左上角
      ...frame({ x: 26, y: 24 }),
      webPreferences,
    });
    // 第一次打开时去哪一页写在地址里：页面加载完之前发消息是收不到的
    const query = Object.fromEntries(Object.entries(target).filter(([, value]) => value));
    window.loadFile(join(sourceDir, "renderer", "hub", "hub.html"), { query });
    // 临时诊断：把渲染层的报错转进主日志（排查页面异常用，查完撤）
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      log.warn("hub_console", { level, message: String(message).slice(0, 300), line, source: String(sourceId).slice(-80) });
    });
    window.on("focus", () => {
      // 切回来时重读一遍：窗口开着过了夜，"今天"要换成新的一天；用户去系统设置里改完权限再切回来，状态跟着刷新
      window.webContents.send("history:changed");
      window.webContents.send("setup:changed");
    });
    window.on("closed", () => {
      hubWindow = null;
    });
    return window;
  }

  /** 首次引导（原版的 onboarding 窗口）：和主窗口一样大，红绿灯的位置照原版 */
  function showOnboarding() {
    if (onboardingWindow === null) {
      onboardingWindow = new BrowserWindow({
        ...HUB_SIZE,
        title: "Utterly",
        backgroundColor: windowBackground(),
        ...frame({ x: 20, y: 16 }),
        webPreferences,
      });
      onboardingWindow.loadFile(join(sourceDir, "renderer", "onboarding", "onboarding.html"));
      onboardingWindow.on("focus", () => {
        // 用户多半是去系统设置里打开了开关再切回来：两项权限要重启小帮手才看得到。
        // 都给了就不重启，免得测快捷键、说话时小帮手平白断一下
        const { listen, trusted } = helperPermissions ?? {};
        if (listen !== true || trusted !== true) recheckPermissions();
        else setupChanged();
      });
      onboardingWindow.on("closed", () => {
        onboardingWindow = null;
        hotkeyToOnboarding = false;
      });
      // 页面崩了就没人说"测完了"
      onboardingWindow.webContents.on("render-process-gone", (_event, details) => {
        log.error("onboarding_gone", { reason: details.reason });
        hotkeyToOnboarding = false;
      });
    }
    onboardingWindow.show();
    app.focus({ steal: true });
  }

  ipcMain.on("onboarding:capture-hotkey", (_event, capturing) => {
    hotkeyToOnboarding = capturing === true;
  });
  handle("onboarding:finish", () => {
    log.info("onboarding_finished");
    onboardingWindow?.close();
    showHub({ route: "home" });
  });

  /** 菜单栏、双击图标要打开 SpeakMore 时：引导还没走完就回到引导，走完了是主窗口 */
  const showMain = () => (onboardingWindow ? showOnboarding() : showHub());

  const trayIcon = nativeImage.createFromPath(TRAY_ICON);
  const tray = new Tray(trayIcon);
  tray.setToolTip("Utterly");
  // 图标读不出来时菜单栏上会是空的一格，找不到入口。退回写两个字，并记下来
  if (trayIcon.isEmpty()) {
    log.error("tray_icon_missing", { path: TRAY_ICON });
  }

  function refreshTrayMenu() {
    if (trayIcon.isEmpty()) tray.setTitle(t("tray.fallbackTitle"));
    const summary = summarizeSetup(currentSetup());
    const headline = summary.ready
      ? t("tray.ready", { keycap: t(`hotkeys.${hotkey}.keycap`) })
      : summary.missing.length > 0
        ? t("tray.missing", { items: t.list(summary.missing) })
        : t("tray.preparing");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: headline, enabled: false },
        ...(summary.degraded ? [{ label: t.text(summary.degraded), enabled: false }] : []),
        { type: "separator" },
        // 下面几项照原版菜单栏的菜单（tray_menu__*）
        { label: t("tray.open"), click: () => showHub({ route: "home" }) },
        { label: t("tray.history"), click: () => showHub({ route: "history" }) },
        { type: "separator" },
        { label: t("tray.settings"), accelerator: "CmdOrCtrl+,", click: () => showHub({ pane: "general" }) },
        { type: "separator" },
        { label: t("tray.version", { version: app.getVersion() }), enabled: false },
        { label: t("tray.quit"), accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ]),
    );
  }
  // Windows 上点通知区域的图标是打开主窗口（右键才是菜单），macOS 上点它就是菜单
  if (WINDOWS) tray.on("click", () => showMain());
  refreshTrayMenu();
  localModelChanged = () => setupChanged();

  // 没有窗口时也继续待在菜单栏里
  app.on("window-all-closed", () => {});
  // 已经开着时又启动了一次。双击图标来的：把主窗口亮出来，让人知道它在哪。
  // speakmore 命令来的（两条命令同时启动，后到的那个）：那个人正看着终端，不弹窗口
  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    if (!additionalData?.byCli) showMain();
  });
  app.on("before-quit", () => {
    rmSync(PATHS.pidFile, { force: true });
    // 先让小帮手的事件作废：它接下来的退出是我们自己关的，不该再报"按键监听停了"
    helperGeneration++;
    helper.stop();
    translateHelperGeneration++;
    translateHelper?.stop();
    history.close();
    localModels.close();
    // 应用正在退出，这两样关不干净也不拦着；记一笔方便排查
    service?.close().catch((error) => log.warn("service_close_failed", { error: String(error?.message ?? error) }));
    control?.close().catch((error) => log.warn("control_close_failed", { error: String(error?.message ?? error) }));
  });

  // ---------- 命令行要主进程代办的事 ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 等小帮手把两项权限报上来，或者确定它起不来；最多等 3 秒 */
  async function helperReported() {
    for (let waited = 0; helperState === "starting" && waited < 3_000; waited += 50) await sleep(50);
  }

  /** 命令行说了它用哪种语言就按它的翻，没说（0.5 及以前的命令行）就按界面的 */
  const translatorFor = (wanted) => (wanted ? createTranslator(wanted) : t);
  /** 回给命令行的结果里那句 problem 翻成字：命令行（含旧版本的）和 --json 的读者都只认字 */
  const withProblemText = (result, say) => {
    if (!result) return result;
    const translated = { ...result };
    if (result.problem) translated.problem = say.text(result.problem);
    if (result.note) translated.note = say.text(result.note);
    return translated;
  };

  /** 交给命令行的状态。要给人看的话都按 say 的语言翻成字，原因见 summaryAsText */
  function describeStatus(say) {
    const setup = currentSetup();
    const route = service?.route ?? null;
    const native = route?.mode === "native";
    return {
      pid: process.pid,
      version: app.getVersion(),
      startedAt,
      // 启动时要等 key 验证完、麦克风的授权框有了回应，才算准备好
      starting: !startupChecked,
      hotkey,
      // 0.5 及以前的命令行靠它说热键叫什么
      hotkeyLabel: say(`hotkeys.${hotkey}.name`),
      // 翻译的那一键（说母语、贴译文）。旧版本的命令行不认这两项，报不报都不碍事
      translateHotkey,
      translateHotkeyLabel: say(`hotkeys.${translateHotkey}.name`),
      translateTarget,
      // 连着单独启动的服务端时，用哪个模型由那边定
      provider: service ? (keys.provider?.id ?? null) : null,
      // 每家的 key 在哪。装成应用的那个各存各的，命令行要靠这一项才知道
      keys: service ? keys.sources() : null,
      // 哪种模式、各用什么。model、thinking 只说 native 的：0.6 及以前的命令行把 model 当收音频的那家来读
      mode: route?.mode ?? null,
      model: native ? formatModelChoice(route.model) : null,
      thinking: native ? thinkingFor(keys.provider) : null,
      // local 的第一跳、private 的那一个本机模型
      transcriber: route?.mode === "local" || route?.mode === "private" ? route.transcriber : null,
      polish: route?.mode === "local" ? formatChatChoice(route.polish) : null,
      theme: theme.id,
      acceleration,
      // 设置里的语言（system 是跟随系统）和实际用的那种
      language: languageSetting,
      locale,
      // 装成应用的和命令启动的，权限和 key 各是一套：命令行据此决定该不该代它重启
      packaged: app.isPackaged,
      ...setup,
      key: withProblemText(setup.key, say),
      localModel: setup.localModel && withProblemText(setup.localModel, say),
      // 每个本机模型下好了没有、正在下到哪（命令行看下载进度用）
      localModels: localModels.list().map((model) => withProblemText(model, say)),
      summary: summaryAsText(summarizeSetup(setup), say),
    };
  }

  // 端到端测试不开控制通道：它自己驱动整个流程，没有命令行参与
  control = e2e
    ? null
    : await startControlServer({
        socketPath: PATHS.controlSocket,
        log,
        handlers: {
          /** recheck：把会自己变的几样重新看一遍再回答（用户刚去系统设置里改过、网刚连上时用） */
          async status({ recheck = false, locale: wanted }) {
            if (recheck) {
              const denied = Object.values(helperPermissions ?? {}).includes(false);
              if (denied || helperState === "stopped") recheckPermissions();
              reverifyKeyInBackground();
            }
            await helperReported();
            return describeStatus(translatorFor(wanted));
          },
          // provider 不给就是正在用的那一家（0.3 的命令行不给）。changes：要一起换成的设置（先存 key 再切模式、
          // 换模型时给），拿它们验证；自定义服务没有默认模型，不给就验证不了
          "set-key": async ({ key, provider, changes, locale: wanted }) => {
            const say = translatorFor(wanted);
            let route;
            try {
              route = provider && changes && modes ? modes.routeForVendor(provider, changes) : undefined;
            } catch (error) {
              return { ok: false, problem: say.text(problemOf(error)) };
            }
            return withProblemText(await keys.save(key, { provider, route }), say);
          },
          // 模式这一层，和各模式里的模型。都是当场换，不用重启
          "set-mode": async ({ mode, changes, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.switchMode(mode, changes ?? {})), translatorFor(wanted)),
          "set-model": async ({ model, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.setModel(model)), translatorFor(wanted)),
          "set-transcriber": async ({ transcriber, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.setTranscriber(transcriber)), translatorFor(wanted)),
          "set-polish": async ({ polish, customUrl, customParams, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.setPolish(polish, { customUrl, customParams })),
              translatorFor(wanted),
            ),
          "forget-key": ({ provider } = {}) => keys.forget({ provider }),
          // native 的模型、local 第二跳的润色，各查各的
          "check-model": async ({ model, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.check("native", { model })), translatorFor(wanted)),
          // 某种模式按改后的设置能不能用（云端的第一跳、数据隐私模式）
          "check-mode": async ({ mode, changes, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.check(mode, changes ?? {})), translatorFor(wanted)),
          "check-polish": async ({ polish, customUrl, customParams, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.checkPolish(polish, { customUrl, customParams })),
              translatorFor(wanted),
            ),
          "reload-theme": reloadTheme,
          "reload-language": () => reloadLanguage(),
          "reload-model-source": () => reloadModelSource(),
          // 本机模型：下载在后台下，进度看 status 的 localModels
          "download-model": async ({ id, locale: wanted }) =>
            withProblemText(await localModels.download(id), translatorFor(wanted)),
          "cancel-download": ({ id }) => {
            localModels.cancel(id);
            return { ok: true };
          },
          "delete-model": async ({ id, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.removeModel(id)), translatorFor(wanted)),
          // 念的那句跟着命令行的语言走
          "check-transcriber": async ({ id, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.checkTranscriber(id, { locale: wanted ?? locale })),
              translatorFor(wanted),
            ),
          // 命令行的名字沿用窗口还分开时的叫法：show-settings 打开设置里还差东西的那一页，
          // 第一次启动时命令行会带上 onboarding，打开首次引导
          "show-settings": ({ onboarding = false }) => (onboarding ? showOnboarding() : showHub({ pane: "auto" })),
          "show-history": () => showHub({ route: "history" }),
          // 先把这次的回答发出去再退出
          quit: () => void setImmediate(() => app.quit()),
        },
      });

  // ---------- 启动时的检查 ----------

  const keyLoaded = keys.loadAtStartup();
  if (e2e) {
    const loaded = await keyLoaded;
    if (loaded.state !== "ready")
      throw new Error(`端到端测试需要能用的 key：${t.text(loaded.problem) || loaded.state}`);
    await e2e.run({
      bar,
      history,
      localModel: () => service?.localModel,
      downloadModel: (id) => localModels.download(id),
      quit: (code) => app.exit(code),
    });
    return;
  }

  const granted = await askMicrophone();
  log.info("microphone_access", { granted });
  await keyLoaded;
  startupChecked = true;
  setupChanged();
  offerSettingsIfIncomplete();
  // 已经开着时又去双击应用图标，系统不会再起一个，而是"重新打开"这一个：同样把主窗口亮出来。
  // 等启动检查做完才挂上，免得把启动本身也当成一次重新打开
  app.on("activate", showMain);
}
