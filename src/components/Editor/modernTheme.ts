/**
 * Polaris Modern Dark Theme
 *
 * 现代化暗色主题，灵感来源于：
 * - Cursor Editor
 * - GitHub Dark Modern
 * - VS Code Dark+ (Modern)
 *
 * 设计原则：
 * 1. 低饱和度配色，减少视觉疲劳
 * 2. 清晰的灰阶层次，提升代码可读性
 * 3. 克制的 token 配色，不喧宾夺主
 * 4. 舒适的行距和字间距
 * 5. 低调的 UI 元素（光标、选区、高亮）
 */

import { EditorView } from '@codemirror/view';

/* ============================================
   COLOR PALETTE
   ============================================ */

// 背景色系 - 深邃但不是纯黑
const bg = {
  primary: '#0d1117',      // 主背景 (GitHub Dark)
  secondary: '#161b22',    // 次级背景
  tertiary: '#21262d',     // 三级背景 (面板、浮层)
  highlight: '#1a3a5c',    // 当前行高亮 - 明显的蓝色背景
};

// 文本色系 - 柔和的白
const fg = {
  primary: '#e6edf3',      // 主文本
  secondary: '#8b949e',    // 次级文本 (行号、gutter)
  muted: '#6e7681',        // 弱化文本 (注释、占位符)
  disabled: '#484f58',     // 禁用状态
};

// 语法高亮 - 克制、低饱和度
const syntax = {
  keyword: '#ff7b72',       // 关键字 - 柔和红
  variable: '#e6edf3',      // 变量 - 主文本色
  string: '#a5d6ff',        // 字符串 - 柔和蓝
  number: '#79c0ff',        // 数字 - 亮蓝
  comment: '#8b949e',       // 注释 - 灰色
  type: '#ffa657',          // 类型 - 橙色
  function: '#d2a8ff',      // 函数 - 紫色
  constant: '#79c0ff',      // 常量 - 蓝色
  tag: '#7ee787',           // 标签 - 绿色
  attribute: '#79c0ff',     // 属性 - 蓝色
  property: '#79c0ff',      // 属性名 - 蓝色
  operator: '#ff7b72',      // 运算符 - 红色
  punct: '#e6edf3',         // 标点 - 主文本色
  regex: '#a5d6ff',         // 正则 - 蓝色
  module: '#d2a8ff',        // 模块名 - 紫色
};

// UI 强调色
const accent = {
  primary: '#58a6ff',       // 主强调色 - 蓝色
  selection: 'rgba(88, 166, 255, 0.35)',           // 选区（非聚焦）
  selectionFocused: 'rgba(88, 166, 255, 0.55)',    // 聚焦时选区
  match: 'rgba(88, 166, 255, 0.40)',               // 匹配高亮 - 更明显
  matchSelected: 'rgba(88, 166, 255, 0.60)',       // 搜索匹配（当前选中）- 更明显
  bracketMatch: 'rgba(38, 139, 210, 0.25)',        // 括号匹配背景
  cursor: '#58a6ff',       // 光标
  gutterActive: '#e6edf3', // 活跃行号
};

// 状态色
const status = {
  error: '#f85149',
  warning: '#d29922',
  info: '#58a6ff',
  success: '#3fb950',
};

/* ============================================
   THEME DEFINITION
   ============================================ */

export const modernDarkTheme = EditorView.theme({
  // ===== 编辑器根容器 =====
  '&': {
    height: '100%',
    backgroundColor: bg.primary,
    color: fg.primary,

    // 字体设置 - 优先使用现代等宽字体
    fontSize: '14px',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Consolas', monospace",
    fontVariantLigatures: 'normal', // 连字保持可选，不强制

    // 文字渲染优化
    textRendering: 'optimizeLegibility',
    WebkitFontSmoothing: 'antialiased',
    MozOsxFontSmoothing: 'grayscale',
  },

  // ===== 滚动容器 =====
  '.cm-scroller': {
    overflow: 'auto',
    height: '100%',
    fontFamily: 'inherit',
  },

  // ===== 编辑器内容区 =====
  '.cm-content': {
    padding: '12px 0',     // 增加上下内边距，更有呼吸感
    minHeight: '100%',
    fontFamily: 'inherit',

    // 行高设置 - 舒适但不松散
    lineHeight: '1.7',
    letterSpacing: '0.01em',  // 轻微增加字间距
  },

  // ===== 单行样式 =====
  '.cm-line': {
    padding: '0 16px',     // 增加左右内边距
    fontFamily: 'inherit',
  },

  // ===== 聚焦状态 - 去除轮廓 =====
  '.cm-focused': {
    outline: 'none',
  },

  // ===== 当前行高亮 =====
  '.cm-activeLine': {
    backgroundColor: bg.highlight,
  },

  // ===== 行号槽 =====
  '.cm-lineNumbers': {
    color: fg.secondary,
    backgroundColor: bg.primary,
    fontSize: '13px',
  },

  '.cm-gutters': {
    backgroundColor: bg.primary,
    color: fg.secondary,
    border: 'none',        // 移除边框
    borderRight: '1px solid rgba(48, 54, 61, 0.5)', // 细微分隔线
  },

  '.cm-gutterElement': {
    padding: '0 12px 0 16px',  // 右侧留白，左侧更多
    minWidth: '40px',
    textAlign: 'right',
    fontFamily: 'inherit',
  },

  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: accent.gutterActive,
  },

  // ===== 光标 =====
  '.cm-cursor': {
    borderLeftColor: accent.cursor,
    borderLeftWidth: '2px',    // 稍粗的光标，更清晰
  },

  // ===== 选区 =====
  '& ::selection': {
    background: accent.selection,
  },

  '.cm-selectionLayer .cm-selectionBackground': {
    background: accent.selection,
  },

  '&.cm-focused .cm-selectionLayer .cm-selectionBackground': {
    background: accent.selectionFocused,
  },

  // ===== 匹配高亮（双击选词后相同词高亮）=====
  '.cm-selectionMatch': {
    backgroundColor: accent.match,
  },

  '.cm-selectionMatch-main': {
    backgroundColor: accent.matchSelected,
  },

  // ===== 括号匹配 =====
  '.cm-matchingBracket': {
    color: accent.primary,
    backgroundColor: accent.bracketMatch,
    outline: '1px solid rgba(88, 166, 255, 0.4)',
  },

  '.cm-nonmatchingBracket': {
    color: status.error,
    borderBottom: '1px solid rgba(248, 81, 73, 0.5)',
  },

  // ===== 搜索高亮 =====
  '.cm-searchMatch': {
    backgroundColor: 'rgba(88, 166, 255, 0.25) !important',
  },

  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(88, 166, 255, 0.45) !important',
    outline: '1px solid rgba(88, 166, 255, 0.6) !important',
  },

  // ===== Lint Gutter (错误/警告标记) =====
  '.cm-lintRange-error': {
    backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 6 3\'%3E%3Cpath fill=\'%23f85149\' d=\'M0 0h6v1H0zM0 2h6v1H0z\'/%3E%3C/svg%3E")',
    backgroundRepeat: 'repeat-x',
    backgroundPosition: 'bottom left',
    backgroundSize: '6px 3px',
  },

  '.cm-lintRange-warning': {
    backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 6 3\'%3E%3Cpath fill=\'%23d29922\' d=\'M0 0h6v1H0zM0 2h6v1H0z\'/%3E%3C/svg%3E")',
    backgroundRepeat: 'repeat-x',
    backgroundPosition: 'bottom left',
    backgroundSize: '6px 3px',
  },

  '.cm-lintRange-info': {
    backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 6 3\'%3E%3Cpath fill=\'%2358a6ff\' d=\'M0 0h6v1H0zM0 2h6v1H0z\'/%3E%3C/svg%3E")',
    backgroundRepeat: 'repeat-x',
    backgroundPosition: 'bottom left',
    backgroundSize: '6px 3px',
  },

  '.cm-lint-marker-error': {
    color: status.error,
  },

  '.cm-lint-marker-warning': {
    color: status.warning,
  },

  '.cm-lint-marker-info': {
    color: status.info,
  },

  // ===== 面板/弹窗样式 =====
  '.cm-panel': {
    backgroundColor: bg.secondary,
    border: '1px solid rgba(48, 54, 61, 0.8)',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
  },

  '.cm-panel.cm-search': {
    padding: '8px',
  },

  // ===== 自动补全 =====
  '.cm-tooltip': {
    backgroundColor: bg.secondary,
    border: '1px solid rgba(48, 54, 61, 0.8)',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
  },

  '.cm-tooltip-autocomplete': {
    maxWidth: '280px',
    fontFamily: 'inherit',
  },

  'ul.cm-tooltip-autocomplete': {
    maxHeight: '200px',
    overflowY: 'auto',
  },

  '.cm-tooltip-autocomplete ul': {
    maxHeight: '200px',
    overflowY: 'auto',
    fontFamily: 'inherit',
  },

  '.cm-tooltip-autocomplete li': {
    padding: '6px 12px',
    fontSize: '13px',
  },

  '.cm-tooltip-autocomplete li[aria-selected]': {
    backgroundColor: bg.tertiary,
    color: fg.primary,
  },

  '.cm-completionIcon': {
    width: '16px',
    marginRight: '8px',
  },

  '.cm-completionIcon-function': {
    color: syntax.function,
  },

  '.cm-completionIcon-variable': {
    color: syntax.variable,
  },

  '.cm-completionIcon-class': {
    color: syntax.type,
  },

  '.cm-completionIcon-keyword': {
    color: syntax.keyword,
  },

  // ===== 折叠代码 =====
  '.cm-foldPlaceholder': {
    backgroundColor: bg.tertiary,
    border: '1px solid rgba(48, 54, 61, 0.5)',
    borderRadius: '3px',
    color: fg.secondary,
    padding: '0 6px',
    fontSize: '12px',
  },

  // ===== 特殊字符 =====
  '.cm-specialChar': {
    color: accent.primary,
    fontSize: '12px',
    opacity: 0.7,
  },

  // ===== 嵌入内容 (如图片预览) =====
  '.cm-widget': {
    fontFamily: 'inherit',
  },

  // ===== 滚动条样式 (编辑器内部) =====
  '.cm-scroller::-webkit-scrollbar': {
    width: '12px',
    height: '12px',
  },

  '.cm-scroller::-webkit-scrollbar-track': {
    backgroundColor: 'transparent',
  },

  '.cm-scroller::-webkit-scrollbar-thumb': {
    backgroundColor: 'rgba(139, 148, 158, 0.3)',
    borderRadius: '6px',
    border: '3px solid transparent',
    backgroundClip: 'padding-box',
  },

  '.cm-scroller::-webkit-scrollbar-thumb:hover': {
    backgroundColor: 'rgba(139, 148, 158, 0.5)',
    backgroundClip: 'padding-box',
  },

  '.cm-scroller::-webkit-scrollbar-corner': {
    backgroundColor: 'transparent',
  },
}, { dark: true });

/* ============================================
   SYNTAX HIGHLIGHTING
   ============================================ */

export const modernHighlightStyle = EditorView.theme({
  // ===== 关键字 =====
  '.cm-keyword': {
    color: syntax.keyword,
    fontWeight: '500',  // 轻微加粗
  },

  // ===== 变量 =====
  '.cm-variable': {
    color: syntax.variable,
  },

  '.cm-variableName': {
    color: syntax.variable,
  },

  '.cm-variableDefined': {
    color: syntax.variable,
  },

  '.cm-variableSpecial': {
    color: syntax.function,
  },

  // ===== 字符串 =====
  '.cm-string': {
    color: syntax.string,
  },

  '.cm-string-2': {
    color: syntax.string,
  },

  // ===== 数字 =====
  '.cm-number': {
    color: syntax.number,
  },

  // ===== 注释 =====
  '.cm-comment': {
    color: syntax.comment,
    fontStyle: 'italic',  // 斜体注释，传统但有效
    opacity: 0.85,
  },

  // ===== 类型/类 =====
  '.cm-type': {
    color: syntax.type,
  },

  '.cm-property': {
    color: syntax.property,
  },

  '.cm-attribute': {
    color: syntax.attribute,
  },

  // ===== 函数 =====
  '.cm-def': {
    color: syntax.function,
    fontWeight: '500',
  },

  '.cm-defName': {
    color: syntax.function,
  },

  '.cm-variableName.function': {
    color: syntax.function,
  },

  '.cm-variableName.function.definition': {
    color: syntax.function,
  },

  // ===== 运算符 =====
  '.cm-operator': {
    color: syntax.operator,
  },

  // ===== 标点符号 =====
  '.cm-punctuation': {
    color: syntax.punct,
  },

  '.cm-bracket': {
    color: syntax.punct,
  },

  // ===== 常量 =====
  '.cm-qualifier': {
    color: syntax.constant,
  },

  '.cm-builtin': {
    color: syntax.constant,
  },

  // ===== 标签 (HTML/JSX) =====
  '.cm-tag': {
    color: syntax.tag,
  },

  // ===== 正则表达式 =====
  '.cm-regex': {
    color: syntax.regex,
  },

  // ===== 命名空间/模块 =====
  '.cm-namespace': {
    color: syntax.module,
  },

  // ===== 布尔值 =====
  '.cm-atom': {
    color: syntax.constant,
  },

  // ===== 链接 =====
  '.cm-link': {
    color: accent.primary,
    textDecoration: 'underline',
  },

  // ===== 强调 =====
  '.cm-strong': {
    fontWeight: '700',
  },

  '.cm-emphasis': {
    fontStyle: 'italic',
  },

  // ===== 标题 =====
  '.cm-header': {
    fontWeight: '600',
    color: fg.primary,
  },

  // ===== 引用 =====
  '.cm-quote': {
    color: fg.secondary,
    fontStyle: 'italic',
  },

  // ===== 列表 =====
  '.cm-list': {
    color: accent.primary,
  },

  // ===== 水平线 =====
  '.cm-hr': {
    borderColor: fg.disabled,
  },

  // ===== 代码块 (Markdown 内联) =====
  '.cm-monospace': {
    fontFamily: 'inherit',
  },
}, { dark: true });

/* ============================================
   COMBINED THEME
   ============================================ */

/**
 * 完整的现代化主题，包含基础样式和语法高亮
 * 直接使用此主题即可获得完整的现代化编辑器外观
 *
 * 使用方式：extensions: [modernTheme]
 */
export const modernTheme = [
  modernDarkTheme,
  modernHighlightStyle,
];
