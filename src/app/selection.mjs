// 选中文本抓取：往焦点窗口注入一次 Ctrl+C，读回剪贴板文本，再把剪贴板放回去。
// 注入用 koffi 调 user32 的 keybd_event——和 Go 小帮手贴字时的 Ctrl+V 走同一条系统路，
// 主进程自己就能发，不用麻烦小帮手再开一个口。
// 剪贴板只还原文字段：抓之前是文字就原样还原；是图片/文件这些非文字的，v1 还原不了
// （readText 读回是空，按"没选中"处理）。

import koffi from "koffi";
import { clipboard } from "electron";

// 惰性加载：koffi 万一装不上了，别拖累应用启动——抓不到选中文本只是指令功能回退成普通听写
let keybdEvent = null;

function injector() {
  if (keybdEvent === null) {
    const user32 = koffi.load("user32.dll");
    keybdEvent = user32.func(
      "void keybd_event(unsigned char bVk, unsigned char bScan, uint32 dwFlags, uintptr_t dwExtraInfo)",
    );
  }
  return keybdEvent;
}

const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11;
const VK_C = 0x43;
const VK_V = 0x56;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 往焦点窗口注入一次 Ctrl+V（富文本贴字用：剪贴板由调用方先写好 text + html 双格式） */
export function pressCtrlV() {
  const inject = injector();
  inject(VK_CONTROL, 0, 0, 0);
  inject(VK_V, 0, 0, 0);
  inject(VK_V, 0, KEYEVENTF_KEYUP, 0);
  inject(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
}

/**
 * 抓当前焦点窗口里选中的文本。
 * @returns {Promise<string | null>} 选中的文字；没有选中、选中的不是文字、或抓取前后剪贴板没变化时是 null
 */
export async function captureSelectedText({ copyDelayMs = 200 } = {}) {
  const inject = injector();
  const before = clipboard.readText();
  inject(VK_CONTROL, 0, 0, 0);
  inject(VK_C, 0, 0, 0);
  inject(VK_C, 0, KEYEVENTF_KEYUP, 0);
  inject(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  await wait(copyDelayMs);
  const captured = clipboard.readText();
  // 先把剪贴板放回去，再返回抓到的东西：调用方拿到的是副本，剪贴板不留我们的痕迹
  clipboard.writeText(before);
  // 前后一样：多半是没选中（也可能选中的恰好和剪贴板里的一字不差，这种巧合按没选中处理）
  return captured === before ? null : captured;
}
