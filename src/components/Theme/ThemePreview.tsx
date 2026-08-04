/**
 * 主题微缩预览组件
 *
 * 在编辑器内展示当前 draft 的真实视觉效果。
 * 通过容器 style 注入 CSS 变量，子元素用 var() 引用，
 * 实现"编辑器内可见的真实主题预览"。
 *
 * 包含：侧栏、顶栏、聊天气泡、按钮、标签、状态条、代码块
 */

import * as React from 'react';
import type { ThemeDefinition } from '@/types/theme';
import { flattenThemeToCSSVars } from '@/services/themeEngine';

interface ThemePreviewProps {
  theme: ThemeDefinition;
}

/** 将 RGB 三元组转为 CSS color 值 */
function rgb(rgbStr: string): string {
  return `rgb(${rgbStr})`;
}

export function ThemePreview({ theme }: ThemePreviewProps) {
  // 获取扁平化的 CSS 变量映射
  const cssVars = React.useMemo(() => flattenThemeToCSSVars(theme), [theme]);

  // 预览容器样式：注入所有 CSS 变量
  const containerStyle: React.CSSProperties = {
    ...cssVars,
    background: theme.immersive?.enabled && theme.immersive.wallpaper.image
      ? `linear-gradient(rgb(${theme.colors.background.base} / ${cssVars['--theme-bg-overlay'] ?? 0.8}), rgb(${theme.colors.background.base} / ${cssVars['--theme-bg-overlay'] ?? 0.8})), url('${theme.immersive.wallpaper.image}')`
      : rgb(theme.colors.background.base),
    color: rgb(theme.colors.text.primary),
    fontFamily: theme.typography.chatFontFamily ?? theme.typography.fontSans,
    fontSize: theme.typography.chatFontSize,
    lineHeight: theme.typography.chatLineHeight,
    borderRadius: theme.shape.radiusLg,
    backdropFilter: theme.immersive?.enabled && theme.immersive.effects.panelBlur > 0
      ? `blur(${theme.immersive.effects.panelBlur}px)`
      : undefined,
  } as React.CSSProperties;

  const c = theme.colors;

  return (
    <div
      className="rounded-xl border overflow-hidden shadow-lg"
      style={{
        ...containerStyle,
        borderColor: `rgb(${c.border} / 0.15)`,
      } as React.CSSProperties}
    >
      {/* 顶栏 */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b"
        style={{
          background: `rgb(${c.background.elevated} / ${theme.immersive?.enabled ? theme.immersive.layerOpacity.panel : 1})`,
          borderColor: `rgb(${c.border} / 0.1)`,
        }}
      >
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: `rgb(${c.status.danger})` }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: `rgb(${c.status.warning})` }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: `rgb(${c.status.success})` }} />
        </div>
        <span
          className="text-[11px] font-medium ml-1"
          style={{ color: rgb(c.text.secondary) }}
        >
          Polaris
        </span>
        <span
          className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
          style={{ background: `rgb(${c.accent.workspace} / 0.15)`, color: rgb(c.accent.workspace) }}
        >
          Workspace
        </span>
      </div>

      {/* 主体：侧栏 + 内容 */}
      <div className="flex" style={{ minHeight: '160px' }}>
        {/* 侧栏 */}
        <div
          className="w-20 shrink-0 p-2 space-y-1.5 border-r"
          style={{
            background: `rgb(${c.background.elevated} / ${theme.immersive?.enabled ? theme.immersive.layerOpacity.panel : 1})`,
            borderColor: `rgb(${c.border} / 0.08)`,
          }}
        >
          {/* 侧栏导航项 */}
          <div className="flex items-center gap-1.5 px-1.5 py-1 rounded" style={{ background: `rgb(${c.primary} / 0.15)` }}>
            <span className="w-2 h-2 rounded" style={{ background: rgb(c.primary.base) }} />
            <span className="text-[10px]" style={{ color: rgb(c.primary.base) }}>Chat</span>
          </div>
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <span className="w-2 h-2 rounded" style={{ background: rgb(c.text.muted) }} />
            <span className="text-[10px]" style={{ color: rgb(c.text.tertiary) }}>Files</span>
          </div>
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <span className="w-2 h-2 rounded" style={{ background: rgb(c.text.muted) }} />
            <span className="text-[10px]" style={{ color: rgb(c.text.tertiary) }}>Git</span>
          </div>
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <span className="w-2 h-2 rounded" style={{ background: rgb(c.accent.ai) }} />
            <span className="text-[10px]" style={{ color: rgb(c.text.tertiary) }}>Agents</span>
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex-1 p-2.5 space-y-2 min-w-0">
          {/* 用户消息 */}
          <div className="flex justify-end">
            <div
              className="px-2.5 py-1.5 text-[11px]"
              style={{
                background: rgb(c.primary.base),
                color: rgb(c.misc.onPrimary),
                borderRadius: theme.shape.chatBubbleRadius,
                padding: `${theme.shape.chatBubblePaddingY} ${theme.shape.chatBubblePaddingX}`,
              }}
            >
              帮我分析这段代码
            </div>
          </div>

          {/* AI 消息 */}
          <div className="flex gap-1.5">
            <div
              className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-semibold overflow-hidden"
              style={{ background: `rgb(${c.primary} / 0.15)`, color: rgb(c.primary.base) }}
            >
              {theme.immersive?.enabled && theme.immersive.avatar?.url ? (
                <img src={theme.immersive.avatar.url} alt="" className="w-full h-full object-cover" />
              ) : (
                'P'
              )}
            </div>
            <div className="flex-1 min-w-0 space-y-1.5">
              <span className="text-[11px] font-medium" style={{ color: rgb(c.text.primary) }}>
                Polaris
              </span>
              {/* AI 回复内容 */}
              <div
                className="text-[11px] px-2.5 py-1.5"
                style={{
                  background: `rgb(${c.background.surface} / ${theme.immersive?.enabled ? theme.immersive.layerOpacity.surface : 1})`,
                  color: rgb(c.text.secondary),
                  borderRadius: theme.shape.radiusMd,
                }}
              >
                这段代码实现了主题预览功能。
                <span style={{ display: 'block', marginTop: theme.layout.chatParagraphSpacing + 'px', color: rgb(c.text.tertiary) }}>
                  通过微缩组件展示效果。
                </span>
              </div>
              {/* 代码块 */}
              <div
                className="px-2 py-1 text-[10px]"
                style={{
                  background: `rgb(${c.background.tertiary} / ${theme.immersive?.enabled ? theme.immersive.layerOpacity.child : 1})`,
                  color: rgb(c.text.secondary),
                  borderRadius: theme.shape.radiusSm,
                  fontFamily: theme.typography.fontMono,
                  fontSize: theme.typography.chatCodeFontSize,
                }}
              >
                <span style={{ color: rgb(c.accent.ai) }}>const</span>{' '}
                <span style={{ color: rgb(c.primary.base) }}>theme</span>{' '}
                ={' '}
                <span style={{ color: rgb(c.status.success) }}>'dark'</span>;
              </div>
            </div>
          </div>

          {/* 状态条 */}
          <div className="flex gap-1.5 pt-1">
            <span
              className="px-1.5 py-0.5 text-[10px] rounded"
              style={{ background: `rgb(${c.status.warning} / 0.15)`, color: rgb(c.status.warning) }}
            >
              Warning
            </span>
            <span
              className="px-1.5 py-0.5 text-[10px] rounded"
              style={{ background: `rgb(${c.status.success} / 0.15)`, color: rgb(c.status.success) }}
            >
              Success
            </span>
            <span
              className="px-1.5 py-0.5 text-[10px] rounded"
              style={{ background: `rgb(${c.status.danger} / 0.15)`, color: rgb(c.status.danger) }}
            >
              Error
            </span>
          </div>

          {/* 按钮组 */}
          <div className="flex gap-1.5 pt-1">
            <button
              className="px-2 py-0.5 text-[10px] rounded font-medium"
              style={{
                background: rgb(c.primary.base),
                color: rgb(c.misc.onPrimary),
                borderRadius: theme.shape.radiusSm,
              }}
            >
              Primary
            </button>
            <button
              className="px-2 py-0.5 text-[10px] rounded border"
              style={{
                background: 'transparent',
                color: rgb(c.text.secondary),
                borderColor: `rgb(${c.border} / 0.25)`,
                borderRadius: theme.shape.radiusSm,
              }}
            >
              Secondary
            </button>
          </div>

          {/* 输入框 */}
          <div
            className="px-2 py-1 text-[10px] rounded"
            style={{
              background: `rgb(${c.background.elevated} / ${theme.immersive?.enabled ? theme.immersive.layerOpacity.panel : 1})`,
              color: rgb(c.text.muted),
              borderRadius: theme.shape.radiusMd,
              borderColor: `rgb(${c.border} / 0.1)`,
              borderWidth: theme.shape.borderWidth,
              borderStyle: theme.shape.borderStyle,
            }}
          >
            输入消息...
          </div>
        </div>
      </div>
    </div>
  );
}