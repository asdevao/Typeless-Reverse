import { t } from "../shared/i18n.mjs";

// 词典页：专有名词热词表（说成的 → 要写成的），转写完自动纠正。主窗口的一等页面，
// 和 Typeless 的词典对齐。数据在主进程（dictionary.json），每次切到这一页现读——
// CLI（speakmore dict）或别的入口改了词，回到这一页就是最新的。

const $ = (id) => document.getElementById(id);

export function createDictionary() {
  const list = $("dict-entries");
  const empty = $("dict-empty");
  const errorBox = $("dict-error");
  const hint = $("dict-hint");
  const wrongInput = $("dict-wrong");
  const correctInput = $("dict-correct");

  hint.textContent = t("dictionary.hint");

  /** 词条列表现拉现画：词典文件随时可能被 CLI 改，切到这页就重新读 */
  async function refresh() {
    errorBox.hidden = true;
    try {
      const entries = await window.speakmore.dictList();
      empty.hidden = entries.length > 0;
      list.replaceChildren(
        ...entries.map((entry) => {
          const item = document.createElement("li");
          item.className = "entry";
          const spoken = document.createElement("span");
          spoken.className = "entry-time";
          spoken.textContent = entry.wrong;
          const text = document.createElement("p");
          text.className = "entry-text";
          text.textContent = `→ ${entry.correct}`;
          const actions = document.createElement("div");
          actions.className = "entry-actions";
          const button = document.createElement("button");
          button.type = "button";
          button.className = "icon-button";
          button.textContent = "✕";
          button.setAttribute("aria-label", t("preferences.dictDelete"));
          button.addEventListener("click", async () => {
            await window.speakmore.dictRemove(entry.wrong);
            await refresh();
          });
          actions.append(button);
          item.append(spoken, text, actions);
          return item;
        }),
      );
    } catch (error) {
      empty.hidden = true;
      errorBox.hidden = false;
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  /** 操作反馈借那行红色提示位说（加载错误和操作提示不会同时出现） */
  function say(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  async function addFromForm() {
    const wrong = wrongInput.value.trim();
    const correct = correctInput.value.trim();
    if (wrong === "" || correct === "") {
      say(t("preferences.dictNeedBoth"));
      return;
    }
    try {
      await window.speakmore.dictAdd(wrong, correct);
      wrongInput.value = "";
      correctInput.value = "";
      await refresh();
    } catch (error) {
      say(t("preferences.dictFailed", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  async function importCsv() {
    try {
      const result = await window.speakmore.dictImportCsv();
      if (result.canceled) return;
      await refresh();
      say(t("preferences.dictImported", { count: result.imported, total: result.total }));
    } catch (error) {
      say(t("preferences.dictFailed", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  $("dict-add").addEventListener("click", addFromForm);
  $("dict-import").addEventListener("click", importCsv);
  // 两个输入框里按回车直接添加：填表的最顺手路径
  for (const input of [wrongInput, correctInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addFromForm();
    });
  }

  return { shown: refresh };
}
