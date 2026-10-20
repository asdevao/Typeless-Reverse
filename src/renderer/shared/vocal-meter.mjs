// 麦克风调试的指示条（对齐 Typeless 设置里"选择麦克风"的那排竖条，机制反混淆自原版渲染层）。
// 和时域峰值（level-meter.mjs，录音"有没有信号"的判定）是两回事：这一套只管看着灵敏、看着活——
// 安静时轻微呼吸，说话时从中间向两侧起波，说完慢慢落回。常量和分阶段的结构与原版一一对应。

/** 原版常量（Windows 平台那一套；平台差异只有响应曲线的系数，这里取本机平台的值） */
const C = {
  updateInterval: 50, // UI 节拍（ms）
  diffusionDelay: 80, // 一次脉冲到出发波之间的最小间隔
  fftSize: 2048,
  smoothingTimeConstant: 0.7, // analyser 自带的帧间平滑
  volumeBufferSize: 3, // 人声段均值的滑动窗
  vocalStartIndex: 14, // 人声频段（48kHz 采样下约 328Hz–3.3kHz）
  vocalEndIndex: 140,
  minHeight: 2, // 竖条最小高度（px）
  maxHeight: 24, // 最大高度（px）
  noiseThreshold: 0.03, // 有效电平低于它算安静：条只轻微呼吸
  voiceThreshold: 0.1, // 高于它算说话：指数放大 + 抖动
  noiseResponse: { base: 0.15, range: 0.22, random: 0.04 },
  transitionResponse: { base: 0.42, range: 0.46, mediumNoise: 0.12, min: 0.36, max: 0.86 },
  voiceResponse: {
    exponentialFactor: 0.25,
    minRandomFactor: 0.18,
    volumeBasedFactor: 0.3,
    highBoost: 1.6,
    highBoostThreshold: 0.4,
    baseFinalVolume: 0.62,
    finalVolumeRange: 0.35,
    finalRandomness: 0.12,
    minFinalVolume: 0.52,
  },
  minEnhancedVolume: 0.15, // 显示电平下限：安静时也有个底
  smoothingFactor: 0.85, // 目标高度的 EMA：越大越稳、越不跟手
  noiseFloor: { initial: 0, followMargin: 0.01, fastUpdate: 0.06, slowUpdate: 0.002, visualMargin: 0.006, max: 0.35 },
  diffusion: {
    centerVariation: [0.95, 1.05],
    maxCenterOffsetRatio: 0.15,
    maxCenterOffsetLimit: 3,
    decayBase: 0.65,
    decayRandom: 0.08,
    minDecay: 0.12,
    volumeVariation: [0.9, 1.1],
    baseDelayFactor: 0.15,
    delayRandom: 0.05,
    randomDelay: 15,
    blending: [0.65, 0.75],
    ageIncrement: 0.7,
    ageDouble: 0.95,
    maxAgeBase: 50,
    maxAgeRandom: 15,
    baseDecayRate: [0.98, 0.995],
    positionFactor: 0.3,
    minEffectiveDecay: 0.95,
    volumeRandomFactor: [0.95, 1.05],
  },
  trigger: { thresholdFactor: 0.5, maxProbability: 0.8, probabilityMultiplier: 2, volumeVariation: [0.9, 1.1] },
  barWidth: 2,
  barGap: 2,
};

const rand = (range) => range[0] + Math.random() * (range[1] - range[0]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** 容器宽度能放几根竖条（和原版同一个公式） */
export function vocalBarCount(containerWidth, barWidth = C.barWidth, barGap = C.barGap) {
  return Math.max(1, Math.floor((containerWidth + barGap) / (barWidth + barGap)));
}

/**
 * 三段响应曲线：扣除噪底后的有效电平（0..1）→ 显示电平（0.15..1）。纯函数。
 * 安静段给个会动的底（呼吸感），过渡段线性爬坡，说话段指数放大加随机抖动
 */
export function responseLevel(effective) {
  const N = C.noiseThreshold;
  const V = C.voiceThreshold;
  if (effective < N) {
    return C.noiseResponse.base + (effective / N) * C.noiseResponse.range + Math.random() * C.noiseResponse.random;
  }
  if (effective < V) {
    const t = (effective - N) / (V - N);
    const level =
      C.transitionResponse.base +
      t * C.transitionResponse.range +
      (Math.random() * 2 - 1) * C.transitionResponse.mediumNoise;
    return clamp(level, C.transitionResponse.min, C.transitionResponse.max);
  }
  const t = (effective - V) / (1 - V);
  let shaped =
    Math.pow(t, C.voiceResponse.exponentialFactor) +
    (Math.random() * 2 - 1) * Math.max(C.voiceResponse.minRandomFactor, C.voiceResponse.volumeBasedFactor * t);
  if (t > C.voiceResponse.highBoostThreshold) {
    shaped = Math.min(1, shaped * (C.voiceResponse.highBoost + (Math.random() * 0.4 - 0.2)));
  }
  shaped = clamp(shaped, 0, 1);
  const level =
    C.voiceResponse.baseFinalVolume +
    C.voiceResponse.finalVolumeRange * shaped +
    (Math.random() * 2 - 1) * C.voiceResponse.finalRandomness;
  return clamp(level, C.voiceResponse.minFinalVolume, 1);
}

/**
 * 把一路麦克风画成 container 里的一排竖条。条数跟着容器宽度走（ResizeObserver）。
 * @param {{ stream: MediaStream, container: HTMLElement }} options
 * @returns {{ stop(): void }} stop：停帧、清定时器、断音频、清空容器
 */
export function createVocalMeter({ stream, container }) {
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = C.fftSize;
  analyser.smoothingTimeConstant = C.smoothingTimeConstant;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);

  /** 每根条的状态：volume 是高度（px），active 决定颜色（高亮/半透明），age 驱动衰减 */
  let bars = [];
  let elements = [];
  let buffer = []; // 人声段均值的滑动窗
  let floor = C.noiseFloor.initial; // 自适应噪底
  let smoothed = C.minHeight; // 高度的 EMA
  let spikes = []; // 待出发的脉冲 { volume, timestamp }
  let lastUi = 0;
  let rafId = 0;
  const timeouts = new Set();

  function rebuild() {
    const count = vocalBarCount(container.clientWidth);
    if (count === bars.length) return;
    bars = Array.from({ length: count }, () => ({ volume: C.minHeight, active: false, age: 0 }));
    const center = Math.floor(count / 2);
    elements = bars.map((_, index) => {
      const span = document.createElement("span");
      // 高亮的过渡从中心向两侧阶梯延迟（原版的 diffusion 视觉）：离中心越远越晚变色
      span.style.transitionDelay = `${((Math.abs(index - center) / count) * 0.5).toFixed(3)}s`;
      return span;
    });
    container.replaceChildren(...elements);
  }

  /** 把一根条混合到目标高度：宁可更高不更低（波要显眼），混合系数取原版区间 */
  function blend(index, target) {
    const b = rand(C.diffusion.blending);
    bars[index] = {
      volume: Math.max(target, Math.round(bars[index].volume * (1 - b) + target * b)),
      active: true,
      age: Math.floor(Math.random() * 2),
    };
  }

  /** 一根条的延迟更新（出发波的一步） */
  function schedule(index, target, delay) {
    if (index < 0 || index >= bars.length) return;
    const timer = setTimeout(() => {
      timeouts.delete(timer);
      blend(index, target);
    }, delay);
    timeouts.add(timer);
  }

  /** 脉冲出发：落在中心附近的一根上，左右两侧按距离衰减、按距离延迟铺开 */
  function processSpikes(now) {
    while (spikes.length > 0 && now - spikes[0].timestamp >= C.diffusionDelay) {
      const spike = spikes.shift();
      if (bars.length === 0) continue;
      const center = Math.floor(bars.length / 2);
      const offset = Math.round(
        (Math.random() - 0.5) * Math.min(bars.length * C.diffusion.maxCenterOffsetRatio, C.diffusion.maxCenterOffsetLimit),
      );
      const at = clamp(center + offset, 0, bars.length - 1);
      bars[at] = { volume: Math.round(spike.volume * rand(C.diffusion.centerVariation)), active: true, age: 0 };
      const leftDistance = at;
      const rightDistance = bars.length - 1 - at;
      for (let step = 1; step <= Math.max(leftDistance, rightDistance); step++) {
        const decayLeft = Math.max(
          C.diffusion.minDecay,
          1 - (step / Math.max(leftDistance, 1)) * (C.diffusion.decayBase + Math.random() * C.diffusion.decayRandom),
        );
        const decayRight = Math.max(
          C.diffusion.minDecay,
          1 - (step / Math.max(rightDistance, 1)) * (C.diffusion.decayBase + Math.random() * C.diffusion.decayRandom),
        );
        const volumeLeft = Math.max(C.minHeight, Math.round(spike.volume * decayLeft * rand(C.diffusion.volumeVariation)));
        const volumeRight = Math.max(C.minHeight, Math.round(spike.volume * decayRight * rand(C.diffusion.volumeVariation)));
        const delay = step * C.diffusionDelay * (C.diffusion.baseDelayFactor + Math.random() * C.diffusion.delayRandom);
        schedule(at - step, volumeLeft, delay + Math.random() * C.diffusion.randomDelay);
        schedule(at + step, volumeRight, delay + Math.random() * C.diffusion.randomDelay);
      }
    }
  }

  /** 出过波的条按年龄衰减：越老越矮，离中心越远衰减越快，衰减到 2px 就回安静态 */
  function ageBars() {
    const center = Math.floor(bars.length / 2);
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index];
      if (!bar.active) continue;
      const increment = Math.random() > C.diffusion.ageIncrement ? 1 : Math.random() > C.diffusion.ageDouble ? 2 : 0;
      bar.age += increment;
      const maxAge = C.diffusion.maxAgeBase + Math.floor(Math.random() * C.diffusion.maxAgeRandom);
      const decayRate = rand(C.diffusion.baseDecayRate);
      const positionFactor = 1 + (Math.abs(index - center) / bars.length) * C.diffusion.positionFactor;
      const effectiveDecay = Math.max(C.diffusion.minEffectiveDecay, decayRate / positionFactor);
      const volume = bar.volume * Math.pow(effectiveDecay, bar.age / 12) * rand(C.diffusion.volumeRandomFactor);
      if (bar.age > maxAge || Math.round(volume) <= C.minHeight) {
        bars[index] = { volume: C.minHeight, active: false, age: 0 };
      } else {
        bars[index] = { volume: Math.max(C.minHeight, Math.round(volume)), active: true, age: bar.age };
      }
    }
  }

  function render() {
    for (let index = 0; index < bars.length; index++) {
      elements[index].style.height = `${bars[index].volume}px`;
      elements[index].classList.toggle("active", bars[index].active);
    }
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    analyser.getByteFrequencyData(bins);
    // 人声频段均值 → 滑动窗
    const end = Math.min(C.vocalEndIndex, bins.length - 1);
    let sum = 0;
    let counted = 0;
    for (let index = C.vocalStartIndex; index <= end; index++) {
      sum += bins[index];
      counted++;
    }
    buffer.push(counted > 0 ? sum / counted : 0);
    if (buffer.length > C.volumeBufferSize) buffer.shift();
    const movingAverage = buffer.reduce((total, value) => total + value, 0) / Math.max(1, buffer.length);

    if (now - lastUi < C.updateInterval) return;
    lastUi = now;
    // 噪底：贴着安静时的水平慢慢跟上（快系数），被声音抬高时几乎不动（慢系数）
    const normalized = movingAverage / 255;
    const factor =
      normalized <= floor + C.noiseFloor.followMargin ? C.noiseFloor.fastUpdate : C.noiseFloor.slowUpdate;
    floor = clamp(floor * (1 - factor) + normalized * factor, 0, C.noiseFloor.max);
    const effective = Math.max(0, normalized - floor - C.noiseFloor.visualMargin);
    // 响应曲线 → 目标高度 → EMA 平滑
    const display = clamp(responseLevel(effective), C.minEnhancedVolume, 1);
    const target = C.minHeight + Math.round((C.maxHeight - C.minHeight) * display);
    smoothed = smoothed * (1 - C.smoothingFactor) + target * C.smoothingFactor;
    // 有效电平够高时按概率触发一次脉冲（说话越响越频繁）
    const triggerThreshold = Math.max(
      C.noiseThreshold * C.trigger.thresholdFactor,
      C.voiceThreshold * 0.7,
    );
    if (effective > triggerThreshold && Math.random() < Math.min(C.trigger.maxProbability, effective * C.trigger.probabilityMultiplier)) {
      const variation = rand(C.trigger.volumeVariation);
      spikes.push({ volume: clamp(Math.round(smoothed * variation), 2, 20), timestamp: now });
    }
    processSpikes(now);
    ageBars();
    render();
  }

  rebuild();
  const observer = new ResizeObserver(rebuild);
  observer.observe(container);
  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      for (const timer of timeouts) clearTimeout(timer);
      timeouts.clear();
      observer.disconnect();
      for (const track of stream.getTracks()) track.stop();
      audioContext.close().catch((error) => console.warn("关闭 AudioContext 失败", error));
      container.replaceChildren();
    },
  };
}
