/**
 * CodeMirror 6 断点 gutter 扩展（Spring Boot 内置调试）。
 *
 * - 行号左侧渲染断点 gutter，点击设/删断点（回调交由 store 处理）
 * - 命中行整行高亮（Decoration）
 *
 * 断点行集合与命中行由外部经 StateEffect 注入（Editor 订阅 debugStore 后 dispatch），
 * 本扩展只负责渲染与点击事件，不直接依赖 store——保持可测、低耦合。
 */

import {
  gutter,
  GutterMarker,
  EditorView,
  Decoration,
  type DecorationSet,
} from '@codemirror/view';
import { StateField, StateEffect, RangeSet, type Extension } from '@codemirror/state';

/** 注入当前文件的断点行号集合（1-based）。 */
export const setBreakpointsEffect = StateEffect.define<number[]>();
/** 注入当前命中行（1-based）；null 表示无命中。 */
export const setHitLineEffect = StateEffect.define<number | null>();

const breakpointLinesField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBreakpointsEffect)) return e.value;
    return value;
  },
});

class BreakpointMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement('div');
    dot.className = 'cm-breakpoint-dot';
    return dot;
  }
}
const breakpointMarker = new BreakpointMarker();

const hitLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHitLineEffect)) value = e.value;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state): DecorationSet => {
      const line = state.field(f);
      if (line == null || line < 1 || line > state.doc.lines) return Decoration.none;
      const deco = Decoration.line({ class: 'cm-debug-hit-line' });
      return Decoration.set([deco.range(state.doc.line(line).from)]);
    }),
});

const breakpointTheme = EditorView.baseTheme({
  '.cm-breakpoint-gutter': {
    width: '16px',
    cursor: 'pointer',
  },
  '.cm-breakpoint-gutter:hover': {
    backgroundColor: 'rgba(229,20,0,0.10)',
  },
  '.cm-breakpoint-dot': {
    width: '10px',
    height: '10px',
    margin: '4px 3px',
    borderRadius: '50%',
    backgroundColor: '#e51400',
    boxShadow: '0 0 4px rgba(229,20,0,0.55)',
  },
  '.cm-debug-hit-line': {
    backgroundColor: 'rgba(229,229,16,0.13)',
    boxShadow: 'inset 3px 0 0 #e5e510',
  },
});

/**
 * 构建断点 gutter 扩展。
 * @param onToggle 点击行号时回调（1-based 行号），由调用方决定设/删断点。
 */
export function breakpointGutter(onToggle: (line: number) => void): Extension {
  return [
    breakpointLinesField,
    hitLineField,
    gutter({
      class: 'cm-breakpoint-gutter',
      markers: (view) => {
        const lines = view.state.field(breakpointLinesField);
        const ranges = lines
          .filter((l) => l >= 1 && l <= view.state.doc.lines)
          .map((l) => breakpointMarker.range(view.state.doc.line(l).from))
          .sort((a, b) => a.from - b.from);
        return ranges.length ? RangeSet.of(ranges) : RangeSet.empty;
      },
      domEventHandlers: {
        mousedown(view, line) {
          const ln = view.state.doc.lineAt(line.from).number;
          onToggle(ln);
          return true;
        },
      },
    }),
    breakpointTheme,
  ];
}
