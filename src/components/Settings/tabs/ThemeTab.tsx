/**
 * 主题设置 Tab
 * 包含：主题生成指南、主题管理器
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { ThemeManager } from '@/components/Theme/ThemeManager';

export function ThemeTab() {
  const { t } = useTranslation('settings');
  const [showGuide, setShowGuide] = React.useState(false);

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
    </div>
  </>
);
}

// ============ 主题生成指南 ============

function ThemeGuide() {
  const [copied, setCopied] = React.useState(false);

  const guideContent = `# Polaris 主题生成与安装指南（AI 直调版）

你是 Polaris 的主题设计师。请按以下规范生成主题，并**直接调用 cap.ui.theme 工具安装应用**，
不要输出让用户手动保存/导入的文件。若当前会话没有 cap.ui.theme 工具（bus_dispatch /
cap_dispatch 均未暴露），先提示用户在 设置→通用 开启「AI 界面控制」后重试。

## 你可用的主题动作（经 bus_dispatch(target="cap.ui.theme") 或等价 cap_dispatch）

- listThemes：列出内置与用户主题
- get：当前激活主题 id
- import：{ "theme": <下方 theme 对象> } → 安装并激活新主题（缺省字段自动以 Dark 补全）
- patch：{ "palette": { "primary.base": "59 130 246", ... } } → 基于当前主题微调配色
- applyPreset：{ "preset": "dark" | "light" } → 切换内置主题
- setActive：{ "id": "<主题id>" } → 切换到已有主题
- export：导出当前完整主题定义
- delete：{ "id": "<主题id>" } → 删除用户主题（内置不可删）

## 用户需求模板

- 名称：[主题名]
- 描述：[风格描述]
- 作者：[作者名]
- 整体风格：暗色 / 浅色；主色调 / 背景色倾向 / 文字对比度
- 可选：壁纸（Unsplash）、圆角风格、字体、自定义 CSS

## theme 对象结构（import 的 payload；颜色为空格分隔 RGB 三元组，如 "59 130 246"）


{
  "name": "主题名称",
  "description": "主题描述",
  "author": "作者名",
  "version": 1,

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
        <span className="text-xs text-text-tertiary">复制以下提示词发给 AI，AI 会直接生成并应用主题（需先在 设置→通用 开启「AI 界面控制」）。</span>
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