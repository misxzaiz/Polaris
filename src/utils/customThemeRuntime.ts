/**
 * 自定义主题运行时应用引擎
 *
 * 职责：把一份 CustomTheme 转换为对 DOM 的副作用——
 * 1. 颜色：`documentElement.style.setProperty('--c-xxx', 'R G B')` 覆盖内置变量
 * 2. 非颜色（背景/圆角/字体/特效）：注入/更新一段全局 <style id="polaris-custom-theme">
 *
 * 设计要点：
 * - 幂等：重复 apply 同一主题结果一致；apply 新主题会先清除旧覆盖。
 * - 无框架依赖：可在 main.tsx 的 FOUC 预执行脚本、themeStore、设置面板预览中复用。
 * - clear 只清除本引擎注入的内容，不影响内置 data-theme 切换。
 */

import type {
  CustomTheme,
  ThemeColorKey,
  RgbTriple,
} from '@/types/theme';
import {
  RADIUS_SCALE_VALUES,
  UI_FONT_FAMILY_VALUES,
  BACKDROP_BLUR_VALUES,
  SHADOW_SCALE_VALUES,
  THEME_COLOR_KEYS,
} from '@/types/theme';

const STYLE_ELEMENT_ID = 'polaris-custom-theme';

/** 记录当前已注入的颜色变量键，切换主题时精确清除 */
let injectedColorKeys: ThemeColorKey[] = [];

/** 批量写入颜色变量 */
function applyColors(colors: Partial<Record<ThemeColorKey, RgbTriple>>): void {
  const root = document.documentElement;
  // 先清除上一次注入但本次不再存在的键，避免残留
  const nextKeys = Object.keys(colors) as ThemeColorKey[];
  for (const key of injectedColorKeys) {
    if (!(key in colors)) {
      root.style.removeProperty(`--c-${key}`);
    }
  }
  for (const key of nextKeys) {
    const value = colors[key];
    if (value) {
      root.style.setProperty(`--c-${key}`, value);
    }
  }
  injectedColorKeys = nextKeys;
}

/** 清除所有注入的颜色变量 */
function clearColors(): void {
  const root = document.documentElement;
  for (const key of THEME_COLOR_KEYS) {
    root.style.removeProperty(`--c-${key}`);
  }
  injectedColorKeys = [];
}

/** 生成非颜色类 CSS 文本 */
function buildDecorationCss(theme: CustomTheme): string {
  const rules: string[] = [];
  const bg = theme.background;
  const sizing = theme.sizing;
  const effects = theme.effects;

  // === 背景 ===
  if (bg && bg.type !== 'none') {
    if (bg.type === 'solid' && bg.solidColor) {
      rules.push(`body { background-color: rgb(${bg.solidColor} / var(--window-opacity, 1)) !important; }`);
    } else if (bg.type === 'gradient' && bg.gradient && bg.gradient.stops.length >= 2) {
      const stops = bg.gradient.stops
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s) => `rgb(${s.color}) ${s.position}%`)
        .join(', ');
      rules.push(`body { background: linear-gradient(${bg.gradient.direction}, ${stops}) fixed !important; }`);
    } else if (bg.type === 'image' && bg.image?.url) {
      const img = bg.image;
      // 背景图铺在 body::before，避免遮挡内容；透明度/模糊独立控制
      const safeUrl = img.url.replace(/["\\]/g, '');
      rules.push(
        `body::before {`,
        `  content: '';`,
        `  position: fixed;`,
        `  inset: 0;`,
        `  z-index: -1;`,
        `  background-image: url("${safeUrl}");`,
        `  background-size: ${img.size};`,
        `  background-position: ${img.position};`,
        `  background-repeat: ${img.repeat};`,
        `  opacity: ${clamp(img.opacity, 0, 1)};`,
        `  filter: blur(${clamp(img.blur, 0, 40)}px);`,
        `  pointer-events: none;`,
        `}`,
      );
      // 让根容器背景半透明，露出背景图
      rules.push(`body { background-color: transparent !important; }`);
    }
  }

  // === 圆角档位 ===
  // 通过属性选择器批量覆盖常见 Tailwind 圆角类（务实方案，非像素级重构）
  if (sizing?.radius) {
    const r = RADIUS_SCALE_VALUES[sizing.radius];
    if (r) {
      rules.push(`.rounded-sm { border-radius: ${r.sm} !important; }`);
      rules.push(`.rounded { border-radius: ${r.md} !important; }`);
      rules.push(`.rounded-md { border-radius: ${r.md} !important; }`);
      rules.push(`.rounded-lg { border-radius: ${r.lg} !important; }`);
      rules.push(`.rounded-xl { border-radius: ${r.xl} !important; }`);
      rules.push(`.rounded-2xl { border-radius: ${r['2xl']} !important; }`);
      rules.push(`.rounded-3xl { border-radius: ${r['3xl']} !important; }`);
      // 单边圆角常用组合
      rules.push(`.rounded-l-xl { border-top-left-radius: ${r.xl} !important; border-bottom-left-radius: ${r.xl} !important; }`);
      rules.push(`.rounded-t-xl { border-top-left-radius: ${r.xl} !important; border-top-right-radius: ${r.xl} !important; }`);
    }
  }

  // === 界面字体 ===
  if (sizing?.fontFamily) {
    const ff = UI_FONT_FAMILY_VALUES[sizing.fontFamily];
    if (ff) {
      rules.push(`body { font-family: ${ff} !important; }`);
    }
  }

  // === 玻璃拟态模糊 ===
  if (effects?.backdropBlur && effects.backdropBlur !== 'none') {
    const blur = BACKDROP_BLUR_VALUES[effects.backdropBlur];
    // 作用于主要浮层容器（elevated/surface 背景），营造毛玻璃质感
    rules.push(
      `.bg-background-elevated, .bg-background-surface { backdrop-filter: blur(${blur}); -webkit-backdrop-filter: blur(${blur}); }`,
    );
  }

  return rules.join('\n');
}

/** 应用非颜色装饰样式 */
function applyDecorations(theme: CustomTheme): void {
  const css = buildDecorationCss(theme);
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!css) {
    if (el) el.textContent = '';
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/** 清除非颜色装饰样式 */
function clearDecorations(): void {
  const el = document.getElementById(STYLE_ELEMENT_ID);
  if (el) el.textContent = '';
}

/** 应用窗口透明度 + 阴影强度（作用于全局变量） */
function applyEffectVars(theme: CustomTheme): void {
  const root = document.documentElement;
  const effects = theme.effects;
  if (effects?.windowOpacity !== undefined) {
    root.style.setProperty('--window-opacity', String(clamp(effects.windowOpacity, 0.3, 1)));
  }
  if (effects?.shadow) {
    root.style.setProperty('--c-shadow-scale', String(SHADOW_SCALE_VALUES[effects.shadow]));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 应用一份完整自定义主题到 DOM。
 * @param theme 自定义主题定义
 */
export function applyCustomThemeToDom(theme: CustomTheme): void {
  if (typeof document === 'undefined') return;
  applyColors(theme.colors || {});
  applyEffectVars(theme);
  applyDecorations(theme);
}

/**
 * 清除所有自定义主题副作用，回退到内置 data-theme 主题。
 */
export function clearCustomThemeFromDom(): void {
  if (typeof document === 'undefined') return;
  clearColors();
  clearDecorations();
  document.documentElement.style.removeProperty('--window-opacity');
  document.documentElement.style.removeProperty('--c-shadow-scale');
}
