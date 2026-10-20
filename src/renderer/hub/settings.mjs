import { LOCALES, SYSTEM_LOCALE } from "../../i18n/index.mjs";
import { t } from "../shared/i18n.mjs";
import { createVolumeBars, createVolumeMeter } from "../shared/volume-bars.mjs";
import { describeError, keyMissing, permissionDenied, permissionText } from "../shared/setup-text.mjs";

// 设置对话框：原版的"设置中心"，左边一列菜单。我们的三页：通用（热键、主题、语言、本机模型的下载源、开机启动）、
// 权限、关于。
// 识别方式、模型和 key 不在这里：在侧栏的"模型"一页（models.mjs）。
// 状态都在主进程，这里只负责画出来和转达用户的操作。

const $ = (id) => document.getElementById(id);

const PANES = ["general", "permissions", "about"];

/**
 * 还差的东西在哪补：key 在侧栏"模型"一页的密钥表，其余是设置的权限页（小帮手停了也是，重新检查在那页）；
 * 两样都差时先补 key
 * @returns {{ route: "models", tab: "keys" } | { pane: string }}
 */
export function fixTarget(setup) {
  if (keyMissing(setup)) return { route: "models", tab: "keys" };
  return { pane: permissionDenied(setup) || setup.helper === "stopped" ? "permissions" : "general" };
}

/**
 * @param {{ refresh: () => Promise<object> }} options refresh：重新问主进程要一份状态，并让整个窗口跟着更新
 */
export function createSettings({ refresh }) {
  const dialog = $("settings");

  function showPane(pane) {
    const name = PANES.includes(pane) ? pane : "general";
    for (const section of dialog.querySelectorAll(".pane")) section.hidden = section.dataset.pane !== name;
    for (const item of dialog.querySelectorAll(".menu-item")) {
      if (item.dataset.pane === name) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    }
  }

  // ---------- 通用：热键、主题、语言、开机启动 ----------

  /** 一组选项：[值, 写什么]，选中现在的那个 */
  const options = (choices, current) =>
    choices.map(([value, label]) => new Option(label, value, false, value === current));

  function renderGeneral(setup) {
    // 全部防御式读取：任何键缺失就渲染空控件，不炸整页（渲染层的 setup 理论上恒有这些键）
    $("hotkey").replaceChildren(
      ...options(
        (setup.hotkey?.choices ?? []).map((id) => [id, t(`hotkeys.${id}.name`)]),
        setup.hotkey?.value,
      ),
    );
    $("translate-hotkey").replaceChildren(
      ...options(
        (setup.translateHotkey?.choices ?? []).map((id) => [id, t(`hotkeys.${id}.name`)]),
        setup.translateHotkey?.value,
      ),
    );
    $("translate-target").replaceChildren(
      ...options(
        (setup.translateTarget?.choices ?? []).map((id) => [id, t(`translate.targets.${id}`)]),
        setup.translateTarget?.value,
      ),
    );
    $("theme").replaceChildren(
      ...options(
        (setup.theme?.choices ?? []).map((id) => [id, t(`themes.${id}.name`)]),
        setup.theme?.value,
      ),
    );
    // 跟随系统，再列出每种语言（名字用它自己的语言写）
    $("language").replaceChildren(
      ...options(
        [[SYSTEM_LOCALE, t("language.system")], ...LOCALES.map(({ id, name }) => [id, name])],
        setup.language?.value,
      ),
    );
    $("model-source").replaceChildren(
      ...options(
        (setup.local?.source?.choices ?? []).map((id) => [id, t(`modelSources.${id}`)]),
        setup.local?.source?.value,
      ),
    );
    $("acceleration").replaceChildren(
      ...options(
        (setup.acceleration?.choices ?? []).map((id) => [id, t(`accelerations.${id}`)]),
        setup.acceleration?.value,
      ),
    );
    $("history-retention").replaceChildren(
      ...options(
        (setup.historyRetentionDays?.choices ?? []).map((id) => [id, t(`preferences.retention.${id}`)]),
        setup.historyRetentionDays?.value,
      ),
    );
      $("bar-hint").checked = setup.barHint === "on";
      $("interaction-sounds").checked = setup.interactionSounds === "on";
    $("open-at-login").checked = setup.openAtLogin?.enabled === true;
    $("open-at-login-row").hidden = setup.openAtLogin?.supported !== true;
  }

  function showNote(id, message, tone = "") {
    $(id).textContent = t.text(message);
    $(id).dataset.tone = tone;
    $(id).hidden = !message;
  }

  $("hotkey").addEventListener("change", async (event) => {
    showNote("hotkey-note", null);
    try {
      const result = await window.speakmore.setHotkey(event.target.value);
      showNote("hotkey-note", result.note ?? null);
    } catch (error) {
      showNote("hotkey-note", t("preferences.hotkeyFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("translate-hotkey").addEventListener("change", async (event) => {
    showNote("translate-hotkey-note", null);
    try {
      const result = await window.speakmore.setTranslateHotkey(event.target.value);
      showNote("translate-hotkey-note", result.note ?? null);
    } catch (error) {
      showNote(
        "translate-hotkey-note",
        t("preferences.translateHotkeyFailed", { reason: describeError(error) }),
        "problem",
      );
    }
    await refresh();
  });

  $("translate-target").addEventListener("change", async (event) => {
    showNote("translate-target-note", null);
    try {
      const result = await window.speakmore.setTranslateTarget(event.target.value);
      showNote("translate-target-note", result.note ?? null);
    } catch (error) {
      showNote(
        "translate-target-note",
        t("preferences.translateTargetFailed", { reason: describeError(error) }),
        "problem",
      );
    }
    await refresh();
  });

  $("theme").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("theme-note", null);
    try {
      const result = await window.speakmore.setTheme(event.target.value);
      showNote("theme-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.themeFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  // 换了语言：主进程把这个窗口按新的语言重新加载，回到这一页；被环境变量盖着时语言不变，留在这里说一句
  $("language").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("language-note", null);
    try {
      const result = await window.speakmore.setLanguage(event.target.value);
      showNote("language-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.languageFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("model-source").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("source-note", null);
    try {
      const result = await window.speakmore.setModelSource(event.target.value);
      showNote("source-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.sourceFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("acceleration").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("acceleration-note", null);
    try {
      const result = await window.speakmore.setAcceleration(event.target.value);
      showNote("acceleration-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.accelerationFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("history-retention").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("history-retention-note", null);
    try {
      const result = await window.speakmore.setHistoryRetention(event.target.value);
      showNote("history-retention-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.historyRetentionFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  // ---------- 通用·麦克风：选择麦克风弹窗（对齐原版的调试体验，尺寸同原版） ----------

  const micDialog = $("microphone-dialog");
  let micMeter = null;
  /** 第几次开麦：换设备、关弹窗都加一，等麦克风回来时对不上号的就是过时了的 */
  let micRun = 0;

  function stopMicMeter() {
    micRun += 1;
    micMeter?.stop();
    micMeter = null;
  }

  /** 用生效的那台开一路只测音量，点亮选中行上的竖条（原版调试流是带降噪的） */
  async function startMicMeter(deviceId) {
    // 先停上一路：弹窗里换设备、设置变更刷新都会重开，不停旧的会漏一路一直开着的麦克风
    stopMicMeter();
    const run = ++micRun;
    let opened;
    try {
      // 原版调试这一路开了降噪（和听写不同：听写要把未加工的声音交给模型）
      opened = await navigator.mediaDevices.getUserMedia({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), noiseSuppression: true },
      });
    } catch {
      return; // 打不开（设备刚拔了）就熄着竖条：弹窗文案已经教了换一台
    }
    // 等麦克风的这一小会儿里人可能已经走开了：那一趟有自己的一路，这一路关掉
    if (run !== micRun) {
      for (const track of opened.getTracks()) track.stop();
      return;
    }
    // 选定的设备已经不在列表里（拔了/休眠消失）：弹窗里没有选中行，也就没有竖条可画，光测不画
    const container = $("microphone-volume");
    if (!container) {
      micMeter = createVolumeMeter({ stream: opened, onVolume: () => {} });
      return;
    }
    const bars = createVolumeBars({ container });
    micMeter = createVolumeMeter({ stream: opened, onVolume: (volume) => bars.setVolume(volume) });
  }

  /** 设备的徽标（对齐原版分类）：蓝牙 → 蓝牙麦克风；括号里带冒号 → 外部；内置 → 推荐；其余不标 */
  function micBadgeOf(label) {
    const detail = label.match(/\(([^)]+)\)$/)?.[1] ?? "";
    if (/bluetooth|蓝牙|无线/i.test(`${label} ${detail}`)) return "bluetooth";
    if (detail.includes(":")) return "external";
    if (/built[- ]?in|内置/i.test(detail)) return "recommended";
    return null;
  }

  /** 弹窗里的设备清单：自动检测排最前（原版第一项），推荐其次，其余跟系统顺序 */
  async function micDevicesOf() {
    let inputs = [];
    try {
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) =>
          device.kind === "audioinput" && device.deviceId !== "default" && device.deviceId !== "communications",
      );
    } catch {
      // 枚举不出就只剩自动检测一项
    }
    const order = { recommended: 0, bluetooth: 1, external: 2 };
    const devices = inputs
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || t("preferences.microphoneUnknown"),
        badge: micBadgeOf(device.label),
      }))
      .sort((a, b) => (order[a.badge] ?? 3) - (order[b.badge] ?? 3));
    devices.unshift({ deviceId: "", label: t("preferences.microphoneAutoDetect"), badge: "usesSystemDefault" });
    return { devices, hasInputs: inputs.length > 0 };
  }

  /** 弹窗内容：设备行一列，选中行的右侧是实时音量竖条（对齐原版布局） */
  async function renderMicrophoneDialog(setup) {
    const list = $("microphone-list");
    const { devices, hasInputs } = await micDevicesOf();
    if (!hasInputs) {
      const title = document.createElement("p");
      title.className = "mic-empty-title";
      title.textContent = t("preferences.microphoneEmptyTitle");
      const description = document.createElement("p");
      description.className = "mic-empty-description";
      description.textContent = t("preferences.microphoneEmptyDescription");
      const empty = document.createElement("div");
      empty.className = "mic-empty";
      empty.replaceChildren(title, description);
      list.replaceChildren(empty);
      stopMicMeter();
      return;
    }
    const saved = setup.microphoneDeviceId ?? "";
    const badgeText = {
      usesSystemDefault: t("preferences.microphoneUsesSystemDefault"),
      recommended: t("preferences.microphoneRecommended"),
      bluetooth: t("preferences.microphoneBluetooth"),
      external: t("preferences.microphoneExternal"),
    };
    list.replaceChildren(
      ...devices.map((device) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "mic-device";
        const selected = (device.deviceId || "") === saved;
        row.setAttribute("aria-current", selected ? "true" : "false");
        const text = document.createElement("span");
        text.className = "mic-device-text";
        const name = document.createElement("span");
        name.className = "mic-device-name";
        name.textContent = device.label;
        text.append(name);
        if (device.badge) {
          const badge = document.createElement("span");
          badge.className = `mic-device-badge${device.badge === "recommended" ? " recommended" : ""}`;
          badge.textContent = badgeText[device.badge];
          text.append(badge);
        }
        row.append(text);
        if (selected) {
          const volume = document.createElement("span");
          volume.className = "mic-volume";
          volume.id = "microphone-volume";
          row.append(volume);
        }
        row.addEventListener("click", () => chooseMicrophone(device.deviceId));
        return row;
      }),
    );
    if (micDialog.open) startMicMeter(saved);
  }

  /** 点一个设备：存下来并立即按它测（原版点选即保存），刷新会重排行和触发行上的名字 */
  async function chooseMicrophone(deviceId) {
    showNote("general-problem", null);
    stopMicMeter();
    try {
      await window.speakmore.setMicrophoneDevice(deviceId);
      await refresh();
    } catch (error) {
      showNote("general-problem", t("preferences.microphoneFailed", { reason: describeError(error) }), "problem");
    }
  }

  /** 设置页那一行上的名字：系统默认，或选定设备的名字 */
  async function renderMicrophone(setup) {
    const saved = setup.microphoneDeviceId ?? "";
    let name = t("preferences.microphoneDefault");
    if (saved !== "") {
      try {
        const found = (await navigator.mediaDevices.enumerateDevices()).find(
          (device) => device.kind === "audioinput" && device.deviceId === saved,
        );
        if (found?.label) name = found.label;
      } catch {
        // 枚举不到名字就先叫"系统默认"，不影响使用
      }
    }
    $("microphone-current").textContent = name;
    if (micDialog.open) await renderMicrophoneDialog(setup);
  }

  $("microphone-open").addEventListener("click", () => {
    micDialog.showModal();
    refresh();
  });
  $("microphone-close").addEventListener("click", () => micDialog.close());
  $("microphone-save").addEventListener("click", () => micDialog.close());
  micDialog.addEventListener("close", stopMicMeter);

  $("bar-hint").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("bar-hint-note", null);
    try {
      const result = await window.speakmore.setBarHint(event.target.checked ? "on" : "off");
      showNote("bar-hint-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.barHintFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("interaction-sounds").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("interaction-sounds-note", null);
    try {
      const result = await window.speakmore.setInteractionSounds(event.target.checked ? "on" : "off");
      showNote("interaction-sounds-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.interactionSoundsFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("open-at-login").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    try {
      await window.speakmore.setOpenAtLogin(event.target.checked);
    } catch (error) {
      showNote("general-problem", t("preferences.loginFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  // ---------- 权限 ----------

  function renderPermissions(setup) {
    for (const row of dialog.querySelectorAll("[data-permission]")) {
      const name = row.dataset.permission;
      const [label, tone, action] = permissionText(name, setup.permissions[name], t);
      const granted = row.querySelector(".granted");
      granted.textContent = label;
      granted.dataset.tone = tone;
      row.querySelector("button").textContent = action;
    }
  }

  for (const row of dialog.querySelectorAll("[data-permission]")) {
    row
      .querySelector("button")
      .addEventListener("click", () => window.speakmore.openPrivacySettings(row.dataset.permission));
  }
  $("recheck").addEventListener("click", () => window.speakmore.recheckPermissions());

  // ---------- 关于 ----------

  $("open-homepage").addEventListener("click", () => window.speakmore.openHomepage());

  // ---------- 对话框本身 ----------

  for (const item of dialog.querySelectorAll(".menu-item")) {
    item.addEventListener("click", () => showPane(item.dataset.pane));
  }
  $("settings-close").addEventListener("click", () => dialog.close());
  // 点对话框外面的那层暗底也关掉
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });

  return {
    /** @param {string} [pane] 打开哪一页 */
    open(pane = "general") {
      showPane(pane);
      if (!dialog.open) dialog.showModal();
      // 麦克风调试跟着对话框走：开着才测（关掉时 close 事件里停）
      startMicMeter();
    },

    render(setup) {
      renderGeneral(setup);
      renderMicrophone(setup);
      renderPermissions(setup);
      $("about-version").textContent = `v${setup.version}`;
      $("about-home").textContent = setup.home;
      // 菜单上标个红点：这一页里有东西要补
      const flagged = { permissions: permissionDenied(setup) };
      for (const dot of dialog.querySelectorAll(".menu-dot")) dot.hidden = !flagged[dot.dataset.for];
    },
  };
}
