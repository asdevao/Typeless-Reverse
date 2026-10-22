import { h, svg } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { providerIcon } from "../shared/provider-icons.mjs";
import { describeError } from "../shared/setup-text.mjs";

// 首次引导"准备"那一步里选哪家、填密钥的一块。一块只管一种方式的几家（原生收音频的，或者转写 + 润色里润色的）。
// 一家一行（几家都排得齐，不按列数换行）；选中的那一行就地展开，填密钥、检测都在那一行里，样子同主窗口的密钥表。
// 选哪家是引导的打算（plan.mjs），这里只画出来、转达点了哪家；换不换过去由引导看还差什么再定，这里不换。
// 状态都在主进程，密钥只从这里往主进程走一趟，不会从主进程回到页面上。
// 下载模型时状态一秒变好几次：各行和输入框只建一次，之后只改字和属性，正在输入的字和焦点不会丢。

/**
 * 服务没拿着它的 key：只有来自环境变量时要多说一句（主进程只报来源，不解密）。
 * 配没配行头已经写着，展开的那一行不再重复，是 null
 */
function otherKeyText(vendor) {
  return vendor.key === "env" ? [t("keyPanel.other.env", { variable: vendor.keyEnv }), "ok"] : null;
}

/** 服务正拿着它的 key：说那把 key 的状态。还没配的行头已经写着，是 null */
function keyText(key, vendor) {
  // 启动时够不着的话先用着，如实说还没验证
  const unverified = key.verified === false;
  const named = { variable: vendor.keyEnv, provider: vendor.name, problem: key.problem };
  switch (key.state) {
    case "ready":
      if (key.source === "env")
        return [t(unverified ? "keyPanel.state.envUnverified" : "keyPanel.state.env", named), "ok"];
      if (key.source === "external") return [t("keyPanel.state.external"), "ok"];
      return unverified ? [t("keyPanel.state.savedUnverified", named), "pending"] : [t("keyPanel.state.saved"), "ok"];
    case "checking":
      return [t("keyPanel.state.checking"), "pending"];
    case "rejected":
      // 三种情况要做的事不一样：只有最后一种是在下面换一把就能解决的
      if (key.cause === "other") return [t("keyPanel.state.checkFailed", named), "problem"];
      if (key.source === "env") return [t("keyPanel.state.envRejected", named), "problem"];
      return [t("keyPanel.state.rejected", named), "problem"];
    case "unreadable":
      return [t.text(key.problem), "problem"];
    default:
      return null;
  }
}

/**
 * 把这一块放进 container。
 * @param {HTMLElement} container
 * @param {object} options
 * @param {"native" | "local"} options.mode 哪种方式的几家；检测时按这种方式查
 * @param {string} options.label 读屏软件念的这一组叫什么
 * @param {(setup: object) => object[]} options.vendors 列哪几家（plan.mjs 的 vendorsFor）
 * @param {(setup: object, id: string) => boolean} options.hasKey 这家有没有能用的 key（plan.mjs 的 hasKey）
 * @param {() => string} options.picked 引导打算用哪家
 * @param {(id: string) => void} options.pick 点了一家
 * @param {(id: string) => object} options.checkChanges 检测这家时连带的设置（还没换过去的）
 * @param {() => Promise<unknown>} options.refresh 存完、删完以后让整个窗口重新问一遍状态
 * @param {() => void} options.onSaved 存好了一把 key（引导看齐了没有，齐了就换过去）
 * @returns {{ render: (setup: object) => void }}
 */
export function createKeyPanel(
  container,
  { mode, label, vendors, hasKey, picked, pick, checkChanges, refresh, onSaved },
) {
  /** 正在保存时不让重复提交，也不让别处的刷新把按钮重新点亮 */
  let saving = false;
  /** 最近一次拿到的状态 */
  let latest = null;
  /** 有 key 的那家点了"更换"：摆出输入框。换一家看、换好了就收起 */
  let replacing = false;
  /** 每家最近一次检测：{ tone, text, ticket }。ticket 认是哪一次，查到一半又查了一次的，先回来的旧结果不要 */
  const checks = new Map();
  /** 每家一行：{ row, head, state }，按 id；几家变了才重建 */
  const rows = new Map();

  // ---------- 展开的那一块：只建一次，选了哪家就挪到那一行底下 ----------

  const input = h("input", {
    type: "password",
    class: "key-input",
    autocomplete: "off",
    spellcheck: "false",
  });
  // 自定义服务比别家多两格：服务地址和模型名（额外参数不进引导，去模型页改）。预填只在切到它时做一次，
  // 用户改过就不动（render 每次都来，照值重摆会打字打到一半被换掉）
  const customUrl = h("input", {
    type: "url",
    class: "key-input",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: t("plaza.custom.urlPlaceholder"),
    "aria-label": t("plaza.custom.url"),
  });
  const customModel = h("input", {
    class: "key-input",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: t("plaza.custom.modelPlaceholder"),
    "aria-label": t("plaza.custom.model"),
  });
  const customFields = h(
    "div",
    { class: "custom-fields", hidden: true },
    h("label", { class: "key-field" }, svg("i-cloud"), customUrl),
    h("label", { class: "key-field" }, svg("i-letter-text"), customModel),
  );
  const pasteButton = h(
    "button",
    {
      type: "button",
      class: "icon-button paste-key",
      title: t("keyPanel.paste"),
      "aria-label": t("keyPanel.paste"),
      onclick: paste,
    },
    svg("i-clipboard-paste"),
  );
  const saveButton = h("button", { type: "submit", class: "button primary save-key", text: t("plaza.keys.save") });
  const form = h(
    "form",
    { class: "key-form", novalidate: true, onsubmit: save },
    // 自定义服务：地址和模型名在上，key 独占下一行（框里还有粘贴按钮，挤一行提示文字显示不完）
    customFields,
    h("label", { class: "key-field" }, svg("i-key-round"), input, pasteButton),
    saveButton,
  );
  const state = h("p", { class: "state" });
  const checkButton = h("button", {
    type: "button",
    class: "button small",
    text: t("keyPanel.check.button"),
    onclick: () => check(),
  });
  const checkResult = h("p", { class: "check-result", role: "status" });
  const keyProblem = h("p", { class: "callout key-problem", role: "alert" });
  const keyNote = h("p", { class: "hint key-note" });
  const keyPage = h(
    "button",
    { type: "button", class: "key-link", onclick: () => window.speakmore.openKeyPage(picked()) },
    h("span", { text: t("plaza.keys.get") }),
    svg("i-external-link"),
  );
  const replaceButton = h("button", { type: "button", class: "key-link", onclick: toggleReplace });
  const stateRow = h("div", { class: "key-state-row" }, state, checkButton);
  const body = h(
    "div",
    { class: "vendor-body" },
    stateRow,
    checkResult,
    form,
    keyProblem,
    keyNote,
    h("p", { class: "links" }, keyPage, replaceButton),
  );
  const list = h("div", { class: "vendor-list", role: "radiogroup", "aria-label": label });
  container.replaceChildren(list);

  /** 显示一句话：msg 按界面语言翻，现成的字照写；空的就藏起来 */
  const show = (node, message) => {
    node.textContent = t.text(message);
    node.hidden = !message;
  };
  show(keyProblem, null);
  show(keyNote, null);

  const nameOf = (id) => t(`providers.${id}.name`);

  /** 几家变了（换了方式）才重建各行 */
  function buildRows(ids) {
    if (ids.join() === [...rows.keys()].join()) return;
    rows.clear();
    list.replaceChildren(
      ...ids.map((id) => {
        const keyState = h("span", { class: "vendor-key" });
        const head = h(
          "button",
          {
            type: "button",
            class: "vendor-head",
            role: "radio",
            onclick: () => choose(id),
          },
          h("span", { class: "logo-tile" }, providerIcon(id) ?? svg("i-cloud")),
          h("span", { class: "vendor-name", text: nameOf(id) }),
          keyState,
          h("span", { class: "radio-mark" }, svg("i-check")),
        );
        const row = h("div", { class: "vendor" }, head);
        rows.set(id, { row, head, keyState });
        return row;
      }),
    );
  }

  function choose(id) {
    if (id === picked()) return;
    replacing = false;
    input.value = "";
    show(keyProblem, null);
    show(keyNote, null);
    // 切到自定义服务：两格先摆上设置里存的（没有就空着），改过字就不重摆
    if (id === "custom") prefillCustom(latest);
    pick(id);
    // 点选了一家：有 key 就当场查一次它现在能不能用
    if (hasKey(latest, id)) check();
  }

  /** 设置里存的自定义服务（没配过是空串）。照 model-plaza 的 plaza.chosen 切出来 */
  function storedCustom(setup) {
    const { polish, customUrl: url, customParams: params } = setup?.plaza?.chosen ?? {};
    return { model: polish?.startsWith("custom/") ? polish.slice("custom/".length) : "", url: url ?? "", params: params ?? "" };
  }

  /** 自定义服务那两格现在写的字 */
  const customTyped = () => ({ url: customUrl.value.trim(), model: customModel.value.trim() });

  /** 自定义服务连地址、模型名一起交的设置（polish 写成 custom/模型名；额外参数不进引导，没给的照设置里的）。
   *  格子里没填的回退设置里存的（检测一把已存的服务时不用重新抄一遍地址和模型名）；两处都没有就是 {} */
  function customChanges() {
    const typed = customTyped();
    const stored = storedCustom(latest);
    const model = typed.model || stored.model;
    const url = typed.url || stored.url;
    if (model === "") return {};
    return { polish: `custom/${model}`, ...(url === "" ? {} : { customUrl: url }) };
  }

  function prefillCustom(setup) {
    const stored = storedCustom(setup);
    // 只填空着的格子：填了一半切走又切回来的，自己写的内容不能被预填冲掉
    if (customUrl.value === "") customUrl.value = stored.url;
    if (customModel.value === "") customModel.value = stored.model;
  }

  /** 查一次选中的那家：拿它的 key 发一个最小的请求，不换掉正在用的。自定义服务连两格里的地址、模型名一起验 */
  async function check() {
    const id = picked();
    const ticket = {};
    checks.set(id, { tone: "pending", text: t("keyPanel.check.running"), ticket });
    render(latest);
    let result;
    try {
      if (id === "custom") {
        const extra = customChanges();
        // 地址和模型名一处都没有：检测无从发起，提示去填，不发非法请求
        if (extra.polish === undefined) {
          checks.set(id, { tone: "problem", text: t("plaza.custom.modelMissing"), ticket });
          render(latest);
          return;
        }
        result = await window.speakmore.checkModel(mode, { ...checkChanges(id), ...extra });
      } else {
        result = await window.speakmore.checkModel(mode, checkChanges(id));
      }
    } catch (error) {
      result = { ok: false, problem: t("keyPanel.failed", { reason: describeError(error) }) };
    }
    if (checks.get(id)?.ticket !== ticket) return;
    checks.set(
      id,
      result.ok
        ? { tone: "ok", text: t("keyPanel.check.ok"), ticket }
        : { tone: "problem", text: t("keyPanel.check.failed", { problem: t.text(result.problem) }), ticket },
    );
    render(latest);
  }

  function render(setup) {
    latest = setup;
    const all = vendors(setup);
    buildRows(all.map(({ id }) => id));
    const vendor = all.find(({ id }) => id === picked()) ?? all[0];
    const name = nameOf(vendor.id);
    // 服务手里正拿着它的 key（正在用的方式要的就是它）：说那把 key 的状态；别的只说有没有
    const holding = vendor.id === setup.provider?.id;
    for (const [id, { row, head, keyState }] of rows) {
      const selected = id === vendor.id;
      head.setAttribute("aria-checked", String(selected));
      row.toggleAttribute("data-open", selected);
      const keyed = hasKey(setup, id);
      keyState.textContent = t(keyed ? "plaza.keys.stored" : "plaza.keys.none");
      keyState.dataset.tone = keyed ? "ok" : "";
    }
    // 只在换了一家时挪：挪动会让输入框丢掉焦点
    const { row } = rows.get(vendor.id);
    if (body.parentNode !== row) row.append(body);

    input.setAttribute("aria-label", t("plaza.keys.label", { platform: name }));
    input.placeholder = t("plaza.keys.placeholder", { platform: name });
    keyPage.hidden = !vendor.hasKeyPage;
    // 行头已经写着配没配：展开的这一行只在多说了点什么时出来（被拒了、在验证、来自环境变量）
    const said = holding ? keyText(setup.key, { ...vendor, name }) : otherKeyText(vendor);
    state.hidden = said === null;
    state.textContent = said?.[0] ?? "";
    state.dataset.tone = said?.[1] ?? "";
    // 环境变量和外部服务端的 key 不归这里管，不提供"删除"
    const editable = setup.key.source !== "external";
    // 有 key 的不摆输入框，点"更换"才出来；没有或者不能用的直接摆出来
    const keyed = hasKey(setup, vendor.id);
    form.hidden = !editable || (keyed && !replacing);
    // 自定义服务多一组（地址、模型名）；保存中一并锁住
    customFields.hidden = vendor.id !== "custom";
    customUrl.disabled = !editable || saving;
    customModel.disabled = !editable || saving;
    replaceButton.hidden = !editable || !keyed;
    replaceButton.textContent = t(replacing ? "plaza.keys.cancel" : "plaza.keys.replace");
    input.disabled = !editable || saving;
    pasteButton.disabled = !editable || saving;
    saveButton.disabled = saving || !editable;
    // 检测：有 key 才能查；服务启动时正在验的那把等它验完
    const checked = checks.get(vendor.id);
    checkButton.hidden = !editable || !keyed;
    checkButton.disabled = saving || checked?.tone === "pending" || (holding && setup.key.state === "checking");
    checkResult.hidden = checkButton.hidden || !checked;
    stateRow.hidden = state.hidden && checkButton.hidden;
    checkResult.textContent = checked?.text ?? "";
    checkResult.dataset.tone = checked?.tone ?? "";
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const id = picked();
    const value = input.value;
    // 自定义服务：地址和模型名一起交（模型名写在 polish 里）；引导里 key 必填，改地址不重贴 key 的走模型页
    if (id === "custom") {
      const typed = customTyped();
      if (value.trim() === "") {
        show(keyProblem, t("keyPanel.customKeyRequired"));
        return;
      }
      if (typed.model === "") {
        show(keyProblem, t("plaza.custom.modelMissing"));
        return;
      }
    }
    const holding = id === latest.provider?.id;
    saving = true;
    saveButton.replaceChildren(svg("i-loader-circle", "icon spin"), t("keyPanel.verifying"));
    show(keyProblem, null);
    show(keyNote, null);
    render(latest);
    try {
      const changes = id === "custom" ? customChanges() : {};
      const result = await (holding ? window.speakmore.saveKey(value) : window.speakmore.saveKey(value, id, changes));
      if (result.ok) {
        input.value = "";
        replacing = false;
        // 换了 key：之前查的那次说的是旧的那把
        checks.delete(id);
        show(keyNote, result.note ?? null);
        // 自定义服务：key 存下了，再把地址、模型一起换上（润色当场切到它，别只存着不用）
        if (id === "custom" && changes.polish) {
          await window.speakmore.setPolish(changes.polish, { customUrl: changes.customUrl });
        }
        onSaved();
      } else show(keyProblem, result.problem);
    } catch (error) {
      show(keyProblem, t("keyPanel.failed", { reason: describeError(error) }));
    } finally {
      saving = false;
      saveButton.replaceChildren(t("plaza.keys.save"));
      await refresh();
    }
  }

  async function paste() {
    const text = (await window.speakmore.readClipboard()).trim();
    if (text === "") {
      show(keyProblem, t("keyPanel.clipboardEmpty"));
      return;
    }
    show(keyProblem, null);
    input.value = text;
    input.focus();
  }

  function toggleReplace() {
    replacing = !replacing;
    input.value = "";
    show(keyProblem, null);
    render(latest);
    if (replacing) input.focus();
  }

  return { render };
}
