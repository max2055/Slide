/**
 * 主题管理器
 * 支持主题切换、圆度调节、系统跟随
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type Roundness = 'none' | 'slight' | 'default' | 'round' | 'full';

export interface ThemeConfig {
  mode: ThemeMode;
  roundness: Roundness;
}

const THEME_STORAGE_KEY = 'app-theme-mode';
const ROUNDNESS_STORAGE_KEY = 'app-roundness';

/**
 * 检测系统是否偏好暗色主题
 */
export function prefersDarkScheme(): boolean {
  if (typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 解析当前主题模式
 */
export function getThemeMode(): ThemeMode {
  let stored: string | null = null;
  try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch { return 'light'; }
  if (stored && ['system', 'light', 'dark'].includes(stored)) {
    return stored as ThemeMode;
  }
  return 'light';
}

/**
 * 解析当前圆度设置
 */
export function getRoundness(): Roundness {
  let stored: string | null = null;
  try { stored = localStorage.getItem(ROUNDNESS_STORAGE_KEY); } catch { return 'default'; }
  if (stored && ['none', 'slight', 'default', 'round', 'full'].includes(stored)) {
    return stored as Roundness;
  }
  return 'default';
}

/**
 * 设置主题模式
 */
export function setThemeMode(mode: ThemeMode): void {
  try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch { /* Persistence is best effort. */ }
  applyThemeMode(mode);
}

/**
 * 设置圆度
 */
export function setRoundness(roundness: Roundness): void {
  try { localStorage.setItem(ROUNDNESS_STORAGE_KEY, roundness); } catch { /* Persistence is best effort. */ }
  applyRoundness(roundness);
}

/**
 * 应用主题模式到 DOM
 */
export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;

  if (mode === 'system') {
    const isDark = prefersDarkScheme();
    root.setAttribute('data-theme-mode', isDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme-mode', mode);
  }
}

/**
 * 应用圆度到 DOM
 */
export function applyRoundness(roundness: Roundness): void {
  const root = document.documentElement;
  root.setAttribute('data-roundness', roundness);
}

/**
 * 应用主题变换动画
 */
export function applyThemeTransition(origin: { x: number; y: number }): void {
  const root = document.documentElement;
  root.style.setProperty('--theme-switch-x', `${origin.x}px`);
  root.style.setProperty('--theme-switch-y', `${origin.y}px`);
  root.classList.add('theme-transition');

  // 动画结束后移除类
  setTimeout(() => {
    root.classList.remove('theme-transition');
  }, 400);
}

/**
 * 初始化主题系统
 */
export function initTheme(): ThemeConfig {
  const mode = getThemeMode();
  const roundness = getRoundness();

  applyThemeMode(mode);
  applyRoundness(roundness);

  // 监听系统主题变化
  if (typeof window.matchMedia !== 'function') {
    return { mode, roundness };
  }

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    if (getThemeMode() === 'system') {
      applyThemeMode('system');
    }
  });

  return { mode, roundness };
}

/**
 * 获取当前配置
 */
export function getThemeConfig(): ThemeConfig {
  return {
    mode: getThemeMode(),
    roundness: getRoundness(),
  };
}
