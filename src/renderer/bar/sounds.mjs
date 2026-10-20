// 交互声音：开始录音、拿到成品、失败三个关键节点的短提示音（设置里可关，对齐原版的 interaction sounds）。
// Web Audio 现场合成，不带资源文件：音量克制（0.1 上下），10ms 起音加指数收尾的包络防止爆音。

/** 一声正弦短音：短起音、指数收尾 */
function tone(audio, freq, at, dur, peak) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t = audio.currentTime + at;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/**
 * @param {{ enabled: boolean }} options 设置里的开关（变了调 setEnabled 当场生效）
 */
export function createSounds({ enabled }) {
  let ctx = null;
  const audio = () => {
    if (ctx === null) ctx = new AudioContext();
    // Electron 不拦自动播放，但上下文偶发挂起（系统切音频设备）：叫醒再放
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  };
  return {
    setEnabled(next) {
      enabled = next === true;
    },
    /** 开始录音：两个快上行音（E5→A5） */
    start() {
      if (!enabled) return;
      const a = audio();
      tone(a, 659, 0, 0.09, 0.1);
      tone(a, 880, 0.09, 0.12, 0.1);
    },
    /** 拿到成品：上行叮（A5→E6） */
    done() {
      if (!enabled) return;
      const a = audio();
      tone(a, 880, 0, 0.09, 0.1);
      tone(a, 1319, 0.1, 0.15, 0.09);
    },
    /** 失败：下行低音（E4→G3） */
    failed() {
      if (!enabled) return;
      const a = audio();
      tone(a, 330, 0, 0.1, 0.08);
      tone(a, 196, 0.11, 0.16, 0.08);
    },
  };
}
