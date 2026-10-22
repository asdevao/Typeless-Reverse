// 钴蓝：照着 Windows 11 的深浅色配的——炭灰底、白字、系统蓝做强调。喜欢系统原生观感的人选它。
// 浅色那组也是 Windows 浅色的排法：浅灰底、黑字、深一点的蓝。悬浮条只有一组：深色浮层配系统蓝的完成按钮。

export default {
  id: "cobalt",
  bar: {
    surface: "oklch(0.3 0 0)",
    edge: "oklch(0.45 0 0)",
    ink: "oklch(0.98 0 0)",
    muted: "oklch(0.78 0 0)",
    ghost: "oklch(0.4 0 0)",
    live: "oklch(0.85 0.09 245)",
    working: "oklch(0.85 0.09 245)",
    go: "oklch(0.62 0.12 245)",
    onGo: "oklch(0.98 0 0)",
    problem: "oklch(0.8 0.13 25)",
  },
  window: {
    light: {
      bg: "oklch(0.955 0 0)",
      raised: "oklch(1 0 0)",
      border: "oklch(0.86 0 0)",
      ink: "oklch(0.18 0 0)",
      ink2: "oklch(0.46 0 0)",
      primary: "oklch(0.52 0.15 250)",
      onPrimary: "oklch(1 0 0)",
      ok: "oklch(0.48 0.13 150)",
      problem: "oklch(0.5 0.16 25)",
      glow: "oklch(0.45 0.12 250)",
      aura: "oklch(0.9 0.02 250)",
      aura2: "oklch(0.93 0.01 245)",
    },
    dark: {
      bg: "oklch(0.25 0 0)",
      raised: "oklch(0.31 0 0)",
      border: "oklch(0.4 0 0)",
      ink: "oklch(0.98 0 0)",
      ink2: "oklch(0.75 0 0)",
      primary: "oklch(0.72 0.11 245)",
      onPrimary: "oklch(0.2 0 0)",
      ok: "oklch(0.78 0.13 150)",
      problem: "oklch(0.8 0.13 25)",
      glow: "oklch(0.68 0.1 245)",
      aura: "oklch(0.32 0.03 250)",
      aura2: "oklch(0.28 0.02 245)",
    },
  },
};
