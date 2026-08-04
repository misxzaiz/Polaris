/**
 * 主题合并器 — 深合并 + 回退链
 *
 * 回退链：用户主题 → Dark 主题 → CSS var() fallback
 * 用户主题未提供字段时，使用 Dark 主题对应值。
 * 确保任意字段都有兜底，即使 JS 引擎失败仍可读。
 */

import type { ThemeDefinition } from '@/types/theme';
import { DARK_THEME } from '@/data/builtInThemes';

/** 深合并两个主题定义（target 优先，缺失字段从 source 补） */
export function mergeThemes(
  target: Partial<ThemeDefinition>,
  source: ThemeDefinition = DARK_THEME,
): ThemeDefinition {
  return {
    ...source,
    ...target,
    colors: mergeColors(target.colors, source.colors),
    typography: { ...source.typography, ...target.typography },
    shape: { ...source.shape, ...target.shape },
    motion: target.motion || source.motion ? { ...(source.motion ?? undefined), ...target.motion } : undefined,
    layout: mergeLayout(target.layout, source.layout),
    immersive: mergeImmersive(target.immersive, source.immersive),
  } as ThemeDefinition;
}

function mergeColors(
  target?: Partial<ThemeDefinition['colors']>,
  source?: ThemeDefinition['colors'],
): ThemeDefinition['colors'] {
  if (!source) return target as ThemeDefinition['colors'];
  if (!target) return source;

  return {
    primary: { ...source.primary, ...target.primary },
    background: { ...source.background, ...target.background },
    border: { ...source.border, ...target.border },
    text: { ...source.text, ...target.text },
    status: { ...source.status, ...target.status },
    priority: { ...source.priority, ...target.priority },
    accent: { ...source.accent, ...target.accent },
    misc: { ...source.misc, ...target.misc },
  };
}

function mergeLayout(
  target?: Partial<ThemeDefinition['layout']>,
  source?: ThemeDefinition['layout'],
): ThemeDefinition['layout'] {
  if (!source) return target as ThemeDefinition['layout'];
  if (!target) return source;

  return {
    ...source,
    ...target,
    windowOpacity: { ...source.windowOpacity, ...target.windowOpacity },
  };
}

function mergeImmersive(
  target?: Partial<ThemeDefinition['immersive']>,
  source?: ThemeDefinition['immersive'],
): ThemeDefinition['immersive'] | undefined {
  if (!target && !source) return undefined;
  if (!target) return source;
  if (!source || !target.enabled) return target.enabled ? target as ThemeDefinition['immersive'] : undefined;

  return {
    ...source,
    ...target,
    wallpaper: { ...source.wallpaper, ...target.wallpaper },
    layerOpacity: { ...source.layerOpacity, ...target.layerOpacity },
    effects: { ...source.effects, ...target.effects },
    avatar: target.avatar ?? source.avatar,
  };
}