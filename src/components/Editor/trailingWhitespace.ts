/**
 * 尾部空白可视化
 *
 * 使用 highlightSpecialChars 的 addSpecialChars 选项，
 * 将行尾空白字符（空格 / Tab）标记为特殊字符并着色。
 */

import { EditorView, highlightSpecialChars } from '@codemirror/view';

/** 尾部空白标记的颜色样式 */
const trailingWhitespaceTheme = EditorView.theme({
  '.cm-trailingWhitespace': {
    backgroundColor: 'rgba(255, 127, 80, 0.15)',
    borderRadius: '2px',
  },
});

/**
 * 创建尾部空白可视化的 span 元素。
 * 将每个空格/Tab 渲染为带背景色的占位标记。
 */
function renderTrailingWhitespace(code: number): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cm-trailingWhitespace';
  // 空格显示小点，Tab 显示箭头
  span.textContent = code === 32 ? '·' : '→';
  return span;
}

/**
 * 尾部空白可视化扩展。
 * 匹配每行末尾的连续空白字符，以淡色背景标记。
 */
export const trailingWhitespaceHighlight = [
  highlightSpecialChars({
    addSpecialChars: /[ \t]+$/gm,
    render: (code) => renderTrailingWhitespace(code),
  }),
  trailingWhitespaceTheme,
];
