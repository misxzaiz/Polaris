/**
 * 主题设置 Tab
 * 包含：主题管理器、对话显示、窗口透明度
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import type { Config, WindowSettings, ChatDisplayDensity, ChatDisplayFontFamily } from '@/types';
import { DEFAULT_CHAT_DISPLAY_SETTINGS, getChatDisplayStyleVars, normalizeChatDisplaySettings } from '@/types';
import { ThemeManager } from '@/components/Theme/ThemeManager';

interface ThemeTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function ThemeTab({ config, onConfigChange, loading }: ThemeTabProps) {
  const { t } = useTranslation('settings');
  const [showGuide, setShowGuide] = React.useState(false);

  const currentTheme = config.theme ?? 'dark';
  const chatDisplay = normalizeChatDisplaySettings(config.chatDisplay);

  const updateChatDisplay = (patch: Partial<typeof chatDisplay>) => {
    onConfigChange({
      ...config,
      chatDisplay: normalizeChatDisplaySettings({ ...chatDisplay, ...patch }),
    });
  };

  const applyChatDensityPreset = (density: ChatDisplayDensity) => {
    const preset = {
      compact: { fontSize: 13, lineHeight: 1.45, paragraphSpacing: 2, messageSpacing: 'compact' as const, codeFontSize: 12 },
      comfortable: DEFAULT_CHAT_DISPLAY_SETTINGS,
      spacious: { fontSize: 16, lineHeight: 1.7, paragraphSpacing: 8, messageSpacing: 'spacious' as const, codeFontSize: 14 },
    }[density];
    onConfigChange({
      ...config,
      chatDisplay: normalizeChatDisplaySettings({ ...chatDisplay, ...preset }),
    });
  };

  const resetChatDisplay = () => {
    onConfigChange({ ...config, chatDisplay: DEFAULT_CHAT_DISPLAY_SETTINGS });
  };

  const formatLineHeight = (value: number) => value.toFixed(2);

  const ChatSlider = ({
    label,
    hint,
    value,
    min,
    max,
    step,
    suffix,
    format = String,
    onChange,
  }: {
    label: string;
    hint: string;
    value: number;
    min: number;
    max: number;
    step: number;
    suffix?: string;
    format?: (value: number) => string;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={loading}
          className="w-28 h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <span className="text-xs text-text-secondary w-12 text-right tabular-nums">
          {format(value)}{suffix}
        </span>
      </div>
    </div>
  );

  const SegmentedButton = <T extends string>({
    value,
    options,
    onChange,
  }: {
    value: T;
    options: Array<{ value: T; label: string }>;
    onChange: (value: T) => void;
  }) => (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={loading}
          className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
            value === option.value
              ? 'bg-primary text-on-primary'
              : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
          } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  // 获取窗口设置，默认值
  const windowSettings: WindowSettings = config.window || {
    normalOpacity: 100,
    compactOpacity: 100,
  };

  // 处理大窗透明度变化
  const handleNormalOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, normalOpacity: value },
    });
  };

  // 处理小窗透明度变化
  const handleCompactOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, compactOpacity: value },
    });
  };

  // 透明度滑块组件
  const OpacitySlider = ({
    label,
    hint,
    value,
    onChange,
  }: {
    label: string;
    hint: string;
    value: number;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center justify-between">
      <div className="flex-1 mr-4">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          disabled={loading}
          className="w-24 h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <span className="text-xs text-text-secondary w-10 text-right">
          {value}%
        </span>
      </div>
    </div>
  );

  return (
    <>
      <div className="space-y-6">
        {/* 主题生成指南 */}
        <div className="rounded-lg border border-border-subtle bg-background-surface">
          <button
            type="button"
            onClick={() => setShowGuide(!showGuide)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
          >
            <BookOpen size={14} className="shrink-0 text-text-muted" />
            <span className="flex-1 text-xs font-medium text-text-secondary">
              {t('theme.guideTitle', '主题生成指南')}
            </span>
            {showGuide ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
          </button>
          {showGuide && (
            <div className="border-t border-border-subtle px-3 py-3">
              <ThemeGuide />
            </div>
          )}
        </div>

      {/* 主题管理器（卡片列表 + 编辑 + 导入导出） */}
      <ThemeManager />

      {/* 对话显示 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('chatDisplay.title')}</h3>
            <div className="text-xs text-text-secondary mt-1">{t('chatDisplay.hint')}</div>
          </div>
          <button
            type="button"
            onClick={resetChatDisplay}
            disabled={loading}
            className={`px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {t('chatDisplay.reset')}
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary">{t('chatDisplay.preset')}</div>
              <div className="text-xs text-text-secondary">{t('chatDisplay.presetHint')}</div>
            </div>
            <SegmentedButton<ChatDisplayDensity>
              value={chatDisplay.messageSpacing}
              onChange={applyChatDensityPreset}
              options={[
                { value: 'compact', label: t('chatDisplay.compact') },
                { value: 'comfortable', label: t('chatDisplay.comfortable') },
                { value: 'spacious', label: t('chatDisplay.spacious') },
              ]}
            />
          </div>

          <ChatSlider
            label={t('chatDisplay.fontSize')}
            hint={t('chatDisplay.fontSizeHint')}
            value={chatDisplay.fontSize}
            min={12}
            max={20}
            step={1}
            suffix="px"
            onChange={(fontSize) => updateChatDisplay({ fontSize })}
          />
          <ChatSlider
            label={t('chatDisplay.lineHeight')}
            hint={t('chatDisplay.lineHeightHint')}
            value={chatDisplay.lineHeight}
            min={1.35}
            max={1.8}
            step={0.05}
            format={formatLineHeight}
            onChange={(lineHeight) => updateChatDisplay({ lineHeight })}
          />
          <ChatSlider
            label={t('chatDisplay.paragraphSpacing')}
            hint={t('chatDisplay.paragraphSpacingHint')}
            value={chatDisplay.paragraphSpacing}
            min={0}
            max={12}
            step={1}
            suffix="px"
            onChange={(paragraphSpacing) => updateChatDisplay({ paragraphSpacing })}
          />
          <ChatSlider
            label={t('chatDisplay.codeFontSize')}
            hint={t('chatDisplay.codeFontSizeHint')}
            value={chatDisplay.codeFontSize}
            min={11}
            max={18}
            step={1}
            suffix="px"
            onChange={(codeFontSize) => updateChatDisplay({ codeFontSize })}
          />

          <div className="flex items-center justify-between gap-4 pt-1">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary">{t('chatDisplay.fontFamily')}</div>
              <div className="text-xs text-text-secondary">{t('chatDisplay.fontFamilyHint')}</div>
            </div>
            <SegmentedButton<ChatDisplayFontFamily>
              value={chatDisplay.fontFamily}
              onChange={(fontFamily) => updateChatDisplay({ fontFamily })}
              options={[
                { value: 'system', label: t('chatDisplay.systemFont') },
                { value: 'serif', label: t('chatDisplay.serifFont') },
                { value: 'mono', label: t('chatDisplay.monoFont') },
              ]}
            />
          </div>

          {/* 过程块折叠模式 */}
          <div className="flex items-center justify-between gap-4 pt-1">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary">{t('chatDisplay.processBlockCollapse')}</div>
              <div className="text-xs text-text-secondary">{t('chatDisplay.processBlockCollapseHint')}</div>
            </div>
            <SegmentedButton<'auto' | 'legacy'>
              value={chatDisplay.processBlockCollapse ?? 'auto'}
              onChange={(mode) => updateChatDisplay({ processBlockCollapse: mode })}
              options={[
                { value: 'auto', label: t('chatDisplay.collapseAuto') },
                { value: 'legacy', label: t('chatDisplay.collapseLegacy') },
              ]}
            />
          </div>

          <div className="p-3 rounded-lg bg-background-base border border-border-subtle chat-display-root" style={getChatDisplayStyleVars(chatDisplay)}>
            <div className="text-xs font-medium text-text-secondary mb-2">{t('chatDisplay.preview')}</div>
            <div className="chat-user-message flex justify-end">
              <div className="chat-user-bubble bg-gradient-to-br from-primary to-primary-600 text-white shadow-glow max-w-[85%]">
                <div className="chat-user-text whitespace-pre-wrap break-words">{t('chatDisplay.previewUser')}</div>
              </div>
            </div>
            <div className="chat-assistant-message flex gap-2">
              <div className="shrink-0 mt-0.5">
                <div className="w-5 h-5 rounded-full bg-primary-faint flex items-center justify-center text-[11px] text-primary font-semibold">AI</div>
              </div>
              <div className="chat-assistant-content flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-text-primary">Polaris</span>
                  <span className="text-xs text-text-tertiary">09:41</span>
                </div>
                <div className="chat-prose prose prose-invert max-w-none">
                  <p>{t('chatDisplay.previewAssistant')}</p>
                  <ul>
                    <li>{t('chatDisplay.previewListOne')}</li>
                    <li>{t('chatDisplay.previewListTwo')}</li>
                  </ul>
                  <pre className="chat-code-pre !bg-background-base !m-0 !rounded-lg border border-border-subtle overflow-x-auto"><code className="chat-code-text text-text-secondary">const readable = true;</code></pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 窗口透明度设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('window.opacityTitle')}
        </h3>

        {/* 大窗模式透明度 */}
        <div className="mb-4">
          <OpacitySlider
            label={t('window.normalOpacity')}
            hint={t('window.normalOpacityHint')}
            value={windowSettings.normalOpacity}
            onChange={handleNormalOpacityChange}
          />
        </div>

        {/* 小屏模式透明度 */}
        <OpacitySlider
          label={t('window.compactOpacity')}
          hint={t('window.compactOpacityHint')}
          value={windowSettings.compactOpacity}
          onChange={handleCompactOpacityChange}
        />
      </div>
    </div>
  </>
);
}

// ============ 主题生成指南 ============

function ThemeGuide() {
  const [copied, setCopied] = React.useState(false);

  const guideContent = `# Polaris 主题生成指南

请根据以下规范生成一份 .polaris-theme 主题文件，输出纯 JSON（不要用代码块包裹）。

## 主题信息

- 名称：[主题名]
- 描述：[风格描述]
- 作者：[作者名]

## 配色要求

- 整体风格：暗色 / 浅色
- 主色调：[颜色]
- 背景色倾向：冷 / 暖 / 中性
- 文字对比度：高 / 柔和

## 可选要求

- 壁纸：合适的 Unsplash 背景图
- 圆角风格：锐利 / 标准 / 圆润
- 字体：有特殊要求吗？
- 自定义 CSS：需要额外效果吗？

## 格式规范

### 1. 颜色格式

所有颜色值使用 RGB 三元组字符串，三个数字以空格分隔，不带括号：

- 正确："59 130 246"
- 错误：rgb(59,130,246) 或 #3B82F6

### 2. 完整字段结构

{
  "formatVersion": 1,
  "type": "polaris-theme",
  "exportedAt": "2026-08-04T12:00:00.000Z",
  "minAppVersion": "1.0.0",
  "theme": {
    "name": "主题名称",
    "description": "主题描述",
    "author": "作者名",
    "version": 1,
    "extends": null,

    "colors": {
      "primary": {
        "base": "59 130 246",
        "hover": "37 99 235",
        "50": "239 246 255",
        "100": "219 234 254",
        "200": "191 219 254",
        "300": "147 197 253",
        "400": "96 165 250",
        "500": "59 130 246",
        "600": "37 99 235",
        "700": "29 78 216"
      },
      "background": {
        "base": "0 0 0",
        "elevated": "26 26 31",
        "surface": "37 37 43",
        "hover": "45 45 53",
        "active": "53 53 61",
        "tertiary": "33 38 45",
        "secondary": "22 27 34"
      },
      "border": { "base": "255 255 255" },
      "text": {
        "primary": "248 248 248",
        "secondary": "180 180 184",
        "tertiary": "142 142 147",
        "muted": "109 109 112"
      },
      "status": {
        "warning": "251 191 36",
        "success": "52 211 153",
        "danger": "248 113 113",
        "info": "96 165 250",
        "done": "16 185 129",
        "failed": "239 68 68",
        "neutral": "156 163 175"
      },
      "priority": {
        "low": "156 163 175",
        "normal": "96 165 250",
        "high": "251 146 60",
        "urgent": "248 113 113"
      },
      "accent": {
        "ai": "167 139 250",
        "prototype": "34 211 238",
        "workspace": "251 191 36"
      },
      "misc": {
        "overlay": "0 0 0",
        "onPrimary": "255 255 255",
        "canvas": "255 255 255",
        "tagBg": "255 255 255",
        "shadow": "0 0 0"
      }
    },

    "typography": {
      "fontSans": "-apple-system, BlinkMacSystemFont, \\"Segoe UI\\", Roboto, sans-serif",
      "fontMono": "\\"JetBrains Mono\\", \\"Fira Code\\", Consolas, monospace",
      "fontSizeBase": "14px",
      "fontWeightNormal": "400",
      "fontWeightMedium": "500",
      "fontWeightSemibold": "600",
      "letterSpacing": "normal",
      "chatFontSize": 14,
      "chatLineHeight": 1.55,
      "chatCodeFontSize": 13,
      "chatInputFontSize": 14
    },

    "shape": {
      "radiusSm": "4px",
      "radiusMd": "8px",
      "radiusLg": "12px",
      "radiusXl": "16px",
      "radiusFull": "9999px",
      "chatBubbleRadius": "16px",
      "borderWidth": "1px",
      "borderStyle": "solid",
      "chatBubblePaddingX": "16px",
      "chatBubblePaddingY": "12px"
    },

    "motion": {
      "transitionFast": "0.15s",
      "transitionNormal": "0.3s",
      "transitionSlow": "0.5s",
      "easeDefault": "ease",
      "easeIn": "ease-in",
      "easeOut": "ease-out",
      "easeInOut": "ease-in-out",
      "motionReduce": false
    },

    "layout": {
      "windowOpacity": { "normal": 100, "compact": 100 },
      "chatMessageGap": 10,
      "chatBlockGap": 6,
      "chatParagraphSpacing": 4
    },

    "immersive": {
      "enabled": true,
      "wallpaper": {
        "type": "image",
        "image": "https://images.unsplash.com/photo-xxxxx?q=80&w=1920",
        "opacity": 0.65,
        "positionX": 50,
        "positionY": 50,
        "size": "cover"
      },
      "layerOpacity": {
        "panel": 0.45,
        "surface": 0.35,
        "child": 0.45
      },
      "effects": {
        "panelBlur": 12,
        "webTexture": 0.08,
        "blueAccent": 0.4,
        "hoverOpacity": 0.5
      }
    },

    "customCss": "/* 可选的 L6 自定义 CSS */"
  }
}

## 设计原则

1. 主色 50-700 应自然过渡，保持色调一致
2. 暗色主题 background 从 base 到 elevated 逐层变亮，层次分明
3. 文字 primary / secondary / tertiary / muted 亮度差要足够，保证可读
4. 沉浸层 opacity 建议 0.4-0.7，panelBlur 建议 8-16px
5. 圆角越大越现代，但控件不宜超过 16px

## 常见错误

- 颜色值带括号或 # 前缀 → 必须用空格分隔的 RGB 三元组
- missing 字段 → 确保 colors 层 40 个字段完整
- 尾随逗号 → 最后一个字段后不能有逗号
- 类型错误 → chatFontSize 是数字，不是字符串
- avatar 链接不稳定 → 使用 Unsplash、GitHub 等稳定 CDN`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(guideContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = guideContent;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-tertiary">复制以下内容，粘贴给 AI 即可生成主题。</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/15 transition-colors shrink-0"
        >
          {copied ? <><Check size={12} /> 已复制</> : <><Copy size={12} /> 复制全部</>}
        </button>
      </div>
      <pre className="rounded-lg border border-border-subtle bg-background-elevated p-3 text-[11px] font-mono text-text-tertiary overflow-auto max-h-[500px] whitespace-pre-wrap leading-relaxed">
        {guideContent}
      </pre>
    </div>
  );
}