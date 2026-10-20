// 麦克风音量的测量与显示（对齐原版"选择麦克风"弹窗里的那套，机制反混淆自原版渲染层）。
// 测量（原版的音量钩子）：时域 RMS → dBFS → [-50dB, 0dB] 归一成 0..1 → 乘灵敏度截到 1 →
// 快起慢落的平滑（升 0.5、降 0.1），每 30ms 报一次；分析器 16kHz、fft 1024、自带平滑 0.8。
// 显示（原版那排小竖条）：固定根数、离散点亮——点亮几根 = ceil(音量 × 总根数)，
// 音量低于阈值全灭；颜色过渡交给 CSS（0.15s ease-in-out，原版同款）。

/** 音量（0..1）点亮几根：低于阈值全灭，向上取整，到顶封住。纯函数 */
export function litBarsOf(volume, count, threshold = 0.12) {
  // NaN（还没收过音量）当 0：全灭
  const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
  if (normalized < threshold) return 0;
  return Math.min(count, Math.ceil(normalized * count));
}

/**
 * 一排竖条（原版小竖条组件的固定根数形态：弹窗里是 6 根 6×22、间距 4、胶囊头）。
 * 尺寸和间距写在 CSS（.mic-volume）；这里只管根数和点亮状态
 * @param {{ container: HTMLElement, count?: number, threshold?: number }} options
 * @returns {{ setVolume(volume: number): void }} 点亮根数没变就不动 DOM
 */
export function createVolumeBars({ container, count = 6, threshold = 0.12 }) {
  const bars = Array.from({ length: count }, () => document.createElement("span"));
  container.replaceChildren(...bars);
  let lit = -1;
  return {
    setVolume(volume) {
      const next = litBarsOf(volume, count, threshold);
      if (next === lit) return;
      lit = next;
      bars.forEach((bar, index) => bar.classList.toggle("lit", index < lit));
    },
  };
}

/**
 * 原版音量钩子的移植：测这路流的音量，报给 onVolume。
 * @param {{ stream: MediaStream, sensitivity?: number, updateInterval?: number, onVolume: (volume: number) => void }} options
 *   弹窗里灵敏度是 20（正常说话能推到满格）；首次引导那个界面用的是 1.5
 * @returns {{ stop(): void }} stop：停表、停轨道、关音频
 */
export function createVolumeMeter({ stream, sensitivity = 20, updateInterval = 30, onVolume }) {
  // 原版用全局共享的 16kHz AudioContext；这里每路一个，stop 即回收
  const audioContext = new AudioContext({ sampleRate: 16_000 });
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.8;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.frequencyBinCount);
  let smoothed = 0;
  const timer = setInterval(() => {
    if (audioContext.state !== "running") return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = Math.sqrt(sum / samples.length);
    const db = rms > 0 ? Math.log10(rms) * 20 : -Infinity;
    const floor = -50; // 原版：[-50dB, 0dB] 映到 [0, 1]
    const level = Math.min(1, Math.max(0, (Math.max(floor, db) - floor) / -floor) * sensitivity);
    // 快起慢落：声音来了马上上去，停了慢慢落下来（原版升 0.5、降 0.1）
    smoothed += (level - smoothed) * (level > smoothed ? 0.5 : 0.1);
    if (smoothed < 0.001) smoothed = 0;
    onVolume(smoothed);
  }, updateInterval);
  return {
    stop() {
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      audioContext.close().catch((error) => console.warn("关闭 AudioContext 失败", error));
    },
  };
}
