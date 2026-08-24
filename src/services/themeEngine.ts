/**
 * 主题加载引擎
 *
 * 核心职责：
 * 1. 加载主题 → 深合并到 DARK_THEME → 扁平化为 CSS 变量 → 注入 DOM
 * 2. 自适应遮罩（亮度检测 + 最低遮罩保证）
 * 3. 用户自定义 CSS 注入
 * 4. 首屏快速加载（同步模式）
 *
 * 合并自 spiderman-theme.ts 的全部功能（亮度检测、自适应遮罩、CSS 变量同步）
 */

import type { ThemeDefinition, ThemeId } from '@/types/theme';
import { BUILT_IN_THEME_IDS } from '@/types/theme';
import { getTheme, getActiveThemeId } from '@/services/themeService';
import { mergeThemes } from '@/services/themeMerger';
import { DARK_THEME } from '@/data/builtInThemes';

// ============ 亮度检测（从 spiderman-theme.ts 迁移） ============

const BRIGHTNESS_KEY = 'spiderman-brightness';

function getCachedBrightness(): number | null {
  try {
    const v = window.localStorage.getItem(BRIGHTNESS_KEY);
    return v ? Number(v) : null;
  } catch { return null; }
}

function setCachedBrightness(value: number): void {
  try { window.localStorage.setItem(BRIGHTNESS_KEY, String(Math.round(value))); } catch { /* ignore */ }
}

/** 使用 canvas 检测图片平均亮度（0-255），缩放到 32×32 */
export function detectImageBrightness(url: string): Promise<number> {
  return new Promise((resolve) => {
    if (!url) { resolve(0); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32; canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(128); return; }
        ctx.drawImage(img, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          total += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        }
        resolve(total / (data.length / 4));
      } catch { resolve(128); }
    };
    img.onerror = () => resolve(128);
    img.src = url;
  });
}

/** 检测并缓存亮度 */
export async function detectAndCacheBrightness(url: string): Promise<number> {
  const brightness = await detectImageBrightness(url);
  setCachedBrightness(brightness);
  return brightness;
}

/** 计算自适应遮罩强度 */
export function computeAdaptiveOverlay(userOpacity: number, imageBrightness: number | null): number {
  const userOverlay = 1 - userOpacity;
  if (imageBrightness === null) return userOverlay;
  const minOverlay = 0.15 + (imageBrightness / 255) * 0.5;
  return Math.max(userOverlay, Math.min(minOverlay, 0.95));
}

// ============ CSS 变量扁平化 ============

/**
 * 将 ThemeDefinition 扁平化为 CSS 变量键值对
 * 同时注入新名（--theme-*）和旧名（--spiderman-*）实现过渡兼容
 */
export function flattenThemeToCSSVars(theme: ThemeDefinition): Record<string, string> {
  const vars: Record<string, string> = {};
  const c = theme.colors;

  // ===== L0 颜色变量 =====
  const colorMap: Record<string, string> = {
    '--c-primary': c.primary.base,
    '--c-primary-hover': c.primary.hover,
    '--c-primary-50': c.primary['50'],
    '--c-primary-100': c.primary['100'],
    '--c-primary-200': c.primary['200'],
    '--c-primary-300': c.primary['300'],
    '--c-primary-400': c.primary['400'],
    '--c-primary-500': c.primary['500'],
    '--c-primary-600': c.primary['600'],
    '--c-primary-700': c.primary['700'],
    '--c-bg-base': c.background.base,
    '--c-bg-elevated': c.background.elevated,
    '--c-bg-surface': c.background.surface,
    '--c-bg-hover': c.background.hover,
    '--c-bg-active': c.background.active,
    '--c-bg-tertiary': c.background.tertiary,
    '--c-bg-secondary': c.background.secondary,
    '--c-border': c.border.base,
    '--c-text-primary': c.text.primary,
    '--c-text-secondary': c.text.secondary,
    '--c-text-tertiary': c.text.tertiary,
    '--c-text-muted': c.text.muted,
    '--c-status-warning': c.status.warning,
    '--c-status-success': c.status.success,
    '--c-status-danger': c.status.danger,
    '--c-status-info': c.status.info,
    '--c-status-done': c.status.done,
    '--c-status-failed': c.status.failed,
    '--c-status-neutral': c.status.neutral,
    '--c-priority-low': c.priority.low,
    '--c-priority-normal': c.priority.normal,
    '--c-priority-high': c.priority.high,
    '--c-priority-urgent': c.priority.urgent,
    '--c-accent-ai': c.accent.ai,
    '--c-accent-prototype': c.accent.prototype,
    '--c-accent-workspace': c.accent.workspace,
    '--c-overlay': c.misc.overlay,
    '--c-on-primary': c.misc.onPrimary,
    '--c-canvas': c.misc.canvas,
    '--c-tag-bg': c.misc.tagBg,
    '--c-shadow': c.misc.shadow,
  };
  Object.assign(vars, colorMap);

  // ===== L1 排版变量 =====
  const t = theme.typography;
  vars['--font-sans'] = t.fontSans;
  vars['--font-mono'] = t.fontMono;
  vars['--font-size-base'] = t.fontSizeBase;
  vars['--font-weight-normal'] = t.fontWeightNormal;
  vars['--font-weight-medium'] = t.fontWeightMedium;
  vars['--font-weight-semibold'] = t.fontWeightSemibold;
  vars['--letter-spacing'] = t.letterSpacing;
  // 聊天排版变量（与 index.css --chat-* 对齐）
  vars['--chat-font-family'] = t.chatFontFamily ?? t.fontSans;
  vars['--chat-font-size'] = `${t.chatFontSize}px`;
  vars['--chat-line-height'] = String(t.chatLineHeight);
  vars['--chat-code-font-size'] = `${t.chatCodeFontSize}px`;
  vars['--chat-input-font-size'] = `${t.chatInputFontSize}px`;

  // ===== L2 形状变量 =====
  const s = theme.shape;
  vars['--radius-sm'] = s.radiusSm;
  vars['--radius-md'] = s.radiusMd;
  vars['--radius-lg'] = s.radiusLg;
  vars['--radius-xl'] = s.radiusXl;
  vars['--radius-full'] = s.radiusFull;
  vars['--chat-bubble-radius'] = s.chatBubbleRadius;
  vars['--border-width'] = s.borderWidth;
  vars['--border-style'] = s.borderStyle;
  vars['--chat-bubble-padding-x'] = s.chatBubblePaddingX;
  vars['--chat-bubble-padding-y'] = s.chatBubblePaddingY;

  // ===== L3 动效变量（可选） =====
  if (theme.motion) {
    const m = theme.motion;
    vars['--transition-fast'] = m.transitionFast;
    vars['--transition-normal'] = m.transitionNormal;
    vars['--transition-slow'] = m.transitionSlow;
    vars['--ease-default'] = m.easeDefault;
    vars['--ease-in'] = m.easeIn;
    vars['--ease-out'] = m.easeOut;
    vars['--ease-in-out'] = m.easeInOut;
  }

  // ===== L5 布局变量 =====
  vars['--window-opacity'] = String(theme.layout.windowOpacity.normal / 100);
  vars['--chat-message-gap'] = `${theme.layout.chatMessageGap}px`;
  vars['--chat-block-gap'] = `${theme.layout.chatBlockGap}px`;
  vars['--chat-paragraph-spacing'] = `${theme.layout.chatParagraphSpacing}px`;

  // ===== L4 沉浸变量 =====
  if (theme.immersive?.enabled) {
    const im = theme.immersive;

    // 壁纸
    if (im.wallpaper.image) {
      vars['--theme-bg-image'] = `url('${im.wallpaper.image}')`;
      vars['--theme-bg-position'] = `${im.wallpaper.positionX}% ${im.wallpaper.positionY}%`;
      vars['--theme-bg-size'] = im.wallpaper.size;
    }

    // 计算自适应遮罩
    const bgOpacity = im.wallpaper.opacity;
    const imgBrightness = getCachedBrightness();
    const adaptiveOverlay = computeAdaptiveOverlay(bgOpacity, imgBrightness);

    vars['--theme-bg-overlay'] = String(adaptiveOverlay);
    vars['--theme-panel-opacity'] = String(im.layerOpacity.panel);
    vars['--theme-panel-blur'] = im.effects.panelBlur > 0 ? `blur(${im.effects.panelBlur}px)` : 'none';
    vars['--theme-surface-opacity'] = String(im.layerOpacity.surface);
    vars['--theme-child-opacity'] = String(im.layerOpacity.child);
    vars['--theme-web-opacity'] = String(im.effects.webTexture);
    vars['--theme-hover-opacity'] = String(im.effects.hoverOpacity);
    vars['--theme-blue-accent'] = String(im.effects.blueAccent);

    if (im.avatar?.url) {
      vars['--theme-avatar-url'] = `url('${im.avatar.url}')`;
    }

    // ===== 兼容旧名（过渡期后移除） =====
    vars['--spiderman-bg-image'] = vars['--theme-bg-image'] ?? '';
    vars['--spiderman-bg-overlay'] = vars['--theme-bg-overlay'] ?? '0.8';
    vars['--spiderman-bg-position'] = vars['--theme-bg-position'] ?? 'center';
    vars['--spiderman-bg-size'] = vars['--theme-bg-size'] ?? 'cover';
    vars['--spiderman-panel-opacity'] = vars['--theme-panel-opacity'] ?? '0.55';
    vars['--spiderman-panel-blur'] = vars['--theme-panel-blur'] ?? 'blur(8px)';
    vars['--spiderman-surface-opacity'] = vars['--theme-surface-opacity'] ?? '0.27';
    vars['--spiderman-chat-tool-opacity'] = vars['--theme-child-opacity'] ?? '0.55';
    vars['--spiderman-hover-opacity'] = vars['--theme-hover-opacity'] ?? '0.5';
    vars['--spiderman-web-opacity'] = vars['--theme-web-opacity'] ?? '0';
    vars['--spiderman-blue-accent'] = vars['--theme-blue-accent'] ?? '0.5';
    if (vars['--theme-avatar-url']) {
      vars['--spiderman-avatar-url'] = vars['--theme-avatar-url'];
    }
  }

  return vars;
}

// ============ DOM 注入 ============

/** 注入 CSS 变量到 document.documentElement */
export function injectCSSVars(vars: Record<string, string>): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;

  // 批量写入（单次重排）
  for (const [key, value] of Object.entries(vars)) {
    el.style.setProperty(key, value);
  }
}

/** 清除沉浸变量（主题切换时清理旧值） */
export function clearImmersiveVars(): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  const immersiveVars = [
    '--spiderman-bg-image', '--spiderman-bg-overlay', '--spiderman-bg-position', '--spiderman-bg-size',
    '--spiderman-panel-opacity', '--spiderman-panel-blur', '--spiderman-surface-opacity',
    '--spiderman-chat-tool-opacity', '--spiderman-hover-opacity', '--spiderman-web-opacity',
    '--spiderman-blue-accent', '--spiderman-avatar-url',
    '--theme-bg-image', '--theme-bg-overlay', '--theme-bg-position', '--theme-bg-size',
    '--theme-panel-opacity', '--theme-panel-blur', '--theme-surface-opacity', '--theme-child-opacity',
    '--theme-web-opacity', '--theme-hover-opacity', '--theme-blue-accent', '--theme-avatar-url',
  ];
  for (const v of immersiveVars) {
    el.style.removeProperty(v);
  }
}

// ============ 用户自定义 CSS 注入 ============

/** 应用用户自定义 CSS */
export function applyCustomCss(cssText: string): void {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById('theme-custom-css') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'theme-custom-css';
    document.head.appendChild(styleEl); // head 末尾，最高优先级
  }
  styleEl.textContent = cssText;
}

/** 清除用户自定义 CSS */
export function clearCustomCss(): void {
  const styleEl = document.getElementById('theme-custom-css') as HTMLStyleElement | null;
  if (styleEl) {
    styleEl.textContent = '';
  }
}

// ============ 主题加载 ============

/** 加载并应用主题（同步版本，用于首屏内联脚本） */
export function applyThemeSync(id: ThemeId = BUILT_IN_THEME_IDS.DARK): void {
  if (typeof document === 'undefined') return;

  const theme = getTheme(id);
  if (!theme) {
    // 回退到 dark
    const dark = DARK_THEME;
    injectCSSVars(flattenThemeToCSSVars(dark));
    document.documentElement.setAttribute('data-theme', BUILT_IN_THEME_IDS.DARK);
    document.documentElement.removeAttribute('data-theme-immersive');
    return;
  }

  // 深合并到 DARK_THEME（确保完整回退）
  const merged = mergeThemes(theme);

  // 扁平化 + 注入
  const vars = flattenThemeToCSSVars(merged);
  injectCSSVars(vars);

  // 设置 data-* 属性
  document.documentElement.setAttribute('data-theme', id);
  if (theme.immersive?.enabled) {
    document.documentElement.setAttribute('data-theme-immersive', 'true');
  } else {
    document.documentElement.removeAttribute('data-theme-immersive');
  }
}

/** 异步加载并应用主题（含亮度检测） */
export async function applyTheme(id: ThemeId): Promise<void> {
  applyThemeSync(id);

  const theme = getTheme(id);
  if (!theme) return;

  // 沉浸主题：异步亮度检测 + 自适应遮罩更新
  if (theme.immersive?.enabled && theme.immersive.wallpaper.image) {
    await detectAndCacheBrightness(theme.immersive.wallpaper.image);
    const merged = mergeThemes(theme);
    const vars = flattenThemeToCSSVars(merged);
    // 重新注入（亮度已知后遮罩重新计算）
    injectCSSVars(vars);
  }
}

// ============ 首屏加载（供 main.tsx 内联脚本使用） ============

/** 首屏同步加载（零异步，零 FOUC） */
export function bootstrapTheme(): void {
  if (typeof window === 'undefined') return;
  try {
    // 使用 getActiveThemeId() 而非直接 getItem：activeThemeId 以 JSON.stringify
    // 写入 localStorage，直接 getItem 会拿到带引号的 ID（如 `"0000...0003"`），
    // 传给 applyThemeSync 后 getTheme 匹配失败，导致首屏回退到 Dark 主题。
    const id = getActiveThemeId();
    applyThemeSync(id);
  } catch {
    applyThemeSync(BUILT_IN_THEME_IDS.DARK);
  }

  // 异步更新亮度检测
  const currentId = document.documentElement.getAttribute('data-theme') || BUILT_IN_THEME_IDS.DARK;
  const theme = getTheme(currentId);
  if (theme?.immersive?.enabled && theme.immersive?.wallpaper.image) {
    requestAnimationFrame(() => {
      detectAndCacheBrightness(theme.immersive!.wallpaper.image!).then(() => {
        const merged = mergeThemes(theme);
        const vars = flattenThemeToCSSVars(merged);
        injectCSSVars(vars);
      });
    });
  }
}

/** 从 localStorage 读取旧版 spiderman-theme 配置（兼容） */
export function readLegacySpiderManConfig(): Record<string, unknown> {
  try {
    const stored = window.localStorage.getItem('spiderman-theme');
    return stored ? JSON.parse(stored) : {};
  } catch { return {}; }
}

/** 保存旧版 spiderman-theme 配置到 localStorage（兼容） */
export function saveLegacySpiderManConfig(config: Record<string, unknown>): void {
  try { window.localStorage.setItem('spiderman-theme', JSON.stringify(config)); } catch { /* ignore */ }
}