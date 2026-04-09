/**
 * CodeMirror 6 缩进参考线插件
 *
 * 在每个缩进层级绘制垂直参考线，使用 CSS background-image + CSS 自定义属性实现。
 * ViewPlugin 为每行计算缩进深度并设置 --cm-indent 变量，
 * CSS 通过 repeating-linear-gradient 在对应位置绘制参考线。
 */

import {
  ViewPlugin,
  ViewUpdate,
  Decoration,
  EditorView,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { Range } from '@codemirror/state';

/** 缩进宽度（空格数），需与 Editor.tsx 中 indentUnit.of('  ') 一致 */
const INDENT_UNIT = 2;

/**
 * 为可视区域内的行构建缩进参考线装饰
 */
function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to && pos <= view.state.doc.length) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;

      // 统计行首空白字符宽度
      let col = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') {
          col++;
        } else if (text[i] === '\t') {
          col += view.state.tabSize - (col % view.state.tabSize);
        } else {
          break;
        }
      }

      // 只为有缩进的行设置 CSS 变量
      if (col >= INDENT_UNIT) {
        decorations.push(
          Decoration.line({
            attributes: { style: `--cm-indent:${col}` },
          }).range(line.from)
        );
      }

      pos = line.to + 1;
    }
  }

  return Decoration.set(decorations, true);
}

/**
 * 缩进参考线 ViewPlugin
 *
 * 监听文档变更和视口变化，重新计算缩进装饰。
 */
export const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/**
 * 缩进参考线主题样式
 *
 * 使用 repeating-linear-gradient 在每 INDENT_UNIT 个字符处绘制 1px 垂直线。
 * background-size 由 --cm-indent CSS 变量控制，仅在缩进范围内显示参考线。
 */
export const indentGuideTheme = EditorView.baseTheme({
  '&dark .cm-line': {
    backgroundImage: `repeating-linear-gradient(90deg, transparent 0, transparent calc(${INDENT_UNIT}ch - 1px), rgba(255,255,255,0.05) calc(${INDENT_UNIT}ch - 1px), rgba(255,255,255,0.05) ${INDENT_UNIT}ch)`,
    backgroundSize: 'calc(var(--cm-indent, 0) * 1ch) 100%',
    backgroundRepeat: 'no-repeat',
  },
  '&light .cm-line': {
    backgroundImage: `repeating-linear-gradient(90deg, transparent 0, transparent calc(${INDENT_UNIT}ch - 1px), rgba(0,0,0,0.08) calc(${INDENT_UNIT}ch - 1px), rgba(0,0,0,0.08) ${INDENT_UNIT}ch)`,
    backgroundSize: 'calc(var(--cm-indent, 0) * 1ch) 100%',
    backgroundRepeat: 'no-repeat',
  },
});
