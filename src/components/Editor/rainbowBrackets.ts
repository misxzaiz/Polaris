/**
 * 彩虹括号 (Rainbow Brackets)
 *
 * 根据括号嵌套深度为 (), [], {} 分配不同颜色。
 * 使用 syntaxTree 遍历 token，通过 Decoration.mark 着色。
 */

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Range } from '@codemirror/state';

/** 括号字符集合 */
const BRACKET_CHARS = new Set(['(', ')', '[', ']', '{', '}']);

/** 彩虹色板 — 循环使用 */
const RAINBOW_COLORS = [
  '#ffd700', // 金色 — 第 1 层
  '#da70d6', // 兰花紫 — 第 2 层
  '#87ceeb', // 天蓝 — 第 3 层
  '#98fb98', // 浅绿 — 第 4 层
  '#ffb6c1', // 浅粉 — 第 5 层
  '#ffa07a', // 浅鲑鱼 — 第 6 层
];

/**
 * 构建装饰集合 — 遍历语法树中的括号 token 并着色
 */
function buildDecorations(state: EditorState): DecorationSet {
  const tree = syntaxTree(state);
  const widgets: Range<Decoration>[] = [];
  let depth = 0;

  tree.iterate({
    enter(node) {
      const text = state.doc.sliceString(node.from, node.to);
      if (text.length === 1 && BRACKET_CHARS.has(text)) {
        if ('([{'.includes(text)) {
          const colorIdx = depth % RAINBOW_COLORS.length;
          widgets.push(
            Decoration.mark({
              class: `cm-rainbowBracket-${colorIdx}`,
            }).range(node.from, node.to)
          );
          depth++;
        } else {
          depth = Math.max(0, depth - 1);
          const colorIdx = depth % RAINBOW_COLORS.length;
          widgets.push(
            Decoration.mark({
              class: `cm-rainbowBracket-${colorIdx}`,
            }).range(node.from, node.to)
          );
        }
      }
    },
  });

  return widgets.length > 0
    ? Decoration.set(widgets, true)
    : Decoration.none;
}

/** 彩虹括号 ViewPlugin */
const rainbowBracketsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.state);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/** 彩虹括号主题样式 */
const rainbowBracketsTheme = EditorView.theme(
  Object.fromEntries(
    RAINBOW_COLORS.map((color, i) => [
      `.cm-rainbowBracket-${i}`,
      { color, fontWeight: '700' },
    ])
  )
);

/** 彩虹括号完整扩展 */
export const rainbowBrackets = [
  rainbowBracketsPlugin,
  rainbowBracketsTheme,
];
