import { formatSeconds, formatTokens, formatUsd } from "../../usage/format.mjs";
import { keycapOf, t } from "../shared/i18n.mjs";

// 历史记录（1:1 复刻原版）：胶囊标签页筛选（全部/听写/问任何事）、
// 保留期下拉和删除全部在头部、按天分组的卡片列表（条目文字+悬停操作）。
// 保留期和删除全部走设置里已有的 historyRetentionDays 通道。

const $ = (id) => document.getElementById(id);

const clock = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDay = new Intl.DateTimeFormat(t.locale, { month: "long", day: "numeric", weekday: "long" });
const longDayWithYear = new Intl.DateTimeFormat(t.locale, {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** 分组的标题：今天、昨天，再往前写几月几日星期几（不是今年的带上年份） */
function dayTitle(day, now) {
  const today = startOfDay(now);
  const days = Math.round((today - day) / 86_400_000);
  if (days === 0) return t("history.today");
  if (days === 1) return t("history.yesterday");
  return (day.getFullYear() === now.getFullYear() ? longDay : longDayWithYear).format(day);
}

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  return whole < 60
    ? t("units.seconds", { value: whole })
    : t("units.minutesSeconds", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

/** 详情：录音多长、等了模型多久、花了多少，token 细节 */
function detailsOf(row) {
  const lines = [t("history.recording", { duration: formatDuration(row.duration) })];
  if (row.usage) {
    const cost = row.usage.costUsd === null ? t("history.unpriced") : formatUsd(row.usage.costUsd);
    lines.push(t("history.model", { latency: formatSeconds(row.usage.latencyMs, t), cost }));
    const tokens = { input: formatTokens(row.usage.inputTokens), output: formatTokens(row.usage.outputTokens) };
    lines.push(
      row.usage.calls > 1
        ? t("history.tokensCalls", { ...tokens, calls: row.usage.calls })
        : t("history.tokens", tokens),
    );
  }
  return lines.join("\n");
}

/** 标签页筛选：all 全部 | dictations 听写 | commands 问任何事（对齐原版的三分） */
function matchesTab(row, tab) {
  if (tab === "all") return true;
  if (tab === "commands") return row.command === true;
  return row.command !== true;
}

export function createHistory() {
  const dayTemplate = $("history-day");
  const rowTemplate = $("history-row");

  /** 现在选的标签页 */
  let activeTab = "all";
  /** 最近一次拿到的全部条目（标签页筛选在渲染前做，不用重新拉） */
  let allRows = [];

  function renderRow(row) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const time = node.querySelector("time");
    time.dateTime = row.createdAt;
    time.textContent = clock.format(new Date(row.createdAt));

    const text = node.querySelector(".entry-text");
    const copy = node.querySelector(".copy");
    if (row.status === "failed") {
      node.dataset.kind = "failed";
      // 失败的原因是当时界面上的那句话，记在历史里，不随语言再变
      text.dataset.prefix = t("history.failed");
      text.textContent = row.error;
      copy.hidden = true;
    } else if (row.refinedText === "") {
      node.dataset.kind = "silent";
      text.textContent = t("history.silent");
      copy.hidden = true;
    } else {
      text.textContent = row.refinedText;
      copy.addEventListener("click", async () => {
        try {
          await window.speakmore.copyText(row.refinedText);
          copy.dataset.done = "";
          copy.title = t("history.copied");
        } catch (error) {
          console.error("复制失败", error);
          copy.title = t("history.copyFailed");
        }
        setTimeout(() => {
          delete copy.dataset.done;
          copy.title = t("history.copy");
        }, 1500);
      });
    }

    // 失败重试
    const retry = node.querySelector(".retry");
    retry.hidden = row.status !== "failed" || row.audioLocalPath === null;
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        await window.speakmore.historyRetry(row.id);
      } catch (error) {
        retry.title = error instanceof Error ? error.message : String(error);
      } finally {
        retry.disabled = false;
      }
    });

    const details = node.querySelector(".details");
    details.title = detailsOf(row);
    details.setAttribute("aria-label", details.title);
    return node;
  }

  /** 画当前标签页下的条目（按天分组） */
  function renderList() {
    // 临时诊断：看前端收到的 command 字段和标签筛选结果
    console.warn("renderList:", JSON.stringify({
      total: allRows.length,
      tab: activeTab,
      commands: allRows.filter((r) => r.command === true).length,
      dictations: allRows.filter((r) => r.command !== true).length,
      sample: allRows.slice(0, 2).map((r) => ({ command: r.command, text: (r.refinedText ?? "").slice(0, 15) })),
    }));
    const rows = allRows.filter((row) => matchesTab(row, activeTab));
    $("history-error").hidden = true;
    $("history-empty").hidden = rows.length > 0;

    const now = new Date();
    const groups = [];
    for (const row of rows) {
      const day = startOfDay(new Date(row.createdAt));
      const last = groups.at(-1);
      if (last && last.day.getTime() === day.getTime()) last.rows.push(row);
      else groups.push({ day, rows: [row] });
    }
    $("history-days").replaceChildren(
      ...groups.map(({ day, rows: dayRows }) => {
        const node = dayTemplate.content.firstElementChild.cloneNode(true);
        node.querySelector(".day-title").textContent = dayTitle(day, now);
        node.querySelector(".entries").replaceChildren(...dayRows.map(renderRow));
        return node;
      }),
    );
  }

  /** 标签页切换 */
  for (const tab of document.querySelectorAll(".history-tab")) {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      for (const el of document.querySelectorAll(".history-tab")) el.classList.toggle("active", el === tab);
      renderList();
    });
  }

  /** 删除全部：对齐原版的自定义确认弹窗（不是 window.confirm） */
  const deleteDialog = $("history-delete-dialog");
  let deleting = false;

  $("history-delete-all").addEventListener("click", () => {
    if (!deleteDialog.open) deleteDialog.showModal();
  });
  $("history-delete-cancel").addEventListener("click", () => deleteDialog.close());
  deleteDialog.addEventListener("click", (event) => {
    // 点弹窗外面的暗底也关掉（和设置对话框同一个规矩）
    if (event.target !== deleteDialog) return;
    const box = deleteDialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) deleteDialog.close();
  });

  $("history-delete-confirm").addEventListener("click", async () => {
    if (deleting) return;
    deleting = true;
    $("history-delete-confirm").disabled = true;
    try {
      await window.speakmore.historyDeleteAll();
      deleteDialog.close();
    } catch (error) {
      deleteDialog.close();
      $("history-error").textContent = t("history.deleteAllError", { reason: String(error?.message ?? error) });
      $("history-error").hidden = false;
    } finally {
      deleting = false;
      $("history-delete-confirm").disabled = false;
    }
  });

  /** 保留期下拉：复用设置里的 historyRetentionDays 通道（值和选项照搬） */
  function renderRetention(setup) {
    const select = $("history-retention");
    const choices = ["forever", "1", "7", "30", "90", "365"];
    const current = setup.historyRetentionDays?.value ?? "forever";
    select.replaceChildren(
      ...choices.map((id) => new Option(t(`preferences.retention.${id}`), id, false, id === current)),
    );
  }

  $("history-retention").addEventListener("change", async (event) => {
    try {
      await window.speakmore.setHistoryRetention(event.target.value);
    } catch {
      // 改不了就什么都不说——设置页里还能改
    }
  });

  return {
    /**
     * @param {{ rows: object[], app: { hotkey: string } }} data
     */
    render({ rows, app }) {
      allRows = rows;
      renderList();
    },

    renderSetup(setup) {
      renderRetention(setup);
    },

    showError(message) {
      $("history-error").textContent = t("history.loadError", { reason: message });
      $("history-error").hidden = false;
    },
  };
}
