export const HERO_MOTION = {
  colors: {
    stroke: '#D8D8D8',
    titleLight: '#1a1f24',
    subtitleLight: '#5c4a32',
    titleDark: '#f4f5f7',
    subtitleDark: '#d8c6a0',
  },
  opacity: {
    stroke: 0.3,
    gridLight: 0.2,
    gridDark: 0.3,
    breathMin: 0.94,
    breathMax: 1,
  },
  spacing: {
    gridGap: 'clamp(56px, 6.2vw, 72px)',
  },
  timing: {
    lineStaggerMs: 120,
    lineEnterMs: 900,
    lineEnterEase: 'cubic-bezier(0.22, 1, 0.36, 1)',
    lineBreathMs: 4000,
    strokeDrawMs: 1200,
    gridPanMs: 12000,
  },
  movement: {
    lineEnterOffsetPx: 24,
    lineEnterBlurPx: 6,
    gridDriftXPx: 8,
    gridDriftYPx: 4,
    parallaxMaxDesktopPx: 6,
    parallaxMaxMobilePx: 3,
  },
  mobileBreakpointPx: 768,
};
