/**
 * Ctrl/Cmd 悬停下划线：按住 Ctrl（macOS 下 Cmd）时，鼠标指针下方的
 * 标识符（Identifier 语法节点）会加上下划线与手型指针，提示"可点击跳转"。
 *
 * 纯前端视觉效果，不触发 LSP 请求。实际跳转由
 * `ctrlClickJumpToDefinition`（见 `lspStore.ts`）负责。
 */

import { syntaxTree } from '@codemirror/language';
import { StateField, StateEffect } from '@codemirror/state';
import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

interface CtrlHoverState {
  /** 是否正按住 Ctrl/Meta */
  active: boolean;
  /** 鼠标在文档中的位置（null 表示鼠标不在编辑器内或未按修饰键） */
  pos: number | null;
}

const INITIAL: CtrlHoverState = { active: false, pos: null };

const setHoverState = StateEffect.define<CtrlHoverState>();

const ctrlHoverField = StateField.define<CtrlHoverState>({
  create: () => INITIAL,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHoverState)) return e.value;
    }
    // 文档变化时清掉 pos，避免指向已失效的 offset
    if (tr.docChanged && value.pos != null) {
      return { ...value, pos: null };
    }
    return value;
  },
});

/** 判断节点类型是否为标识符（跨语言的启发式） */
function isIdentifierNode(name: string): boolean {
  // Lezer 各语言把标识符命名为 VariableName / PropertyName / TypeName / ClassName...
  // 统一用包含 "Name" 的节点作为"可点击符号"
  return /Name$/.test(name);
}

/** 取 pos 所在的标识符节点范围，找不到返回 null */
function identifierRangeAt(
  state: EditorView['state'],
  pos: number,
): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, 0);
  // 向上找最近的标识符节点
  let cur: typeof node | null = node;
  while (cur) {
    if (isIdentifierNode(cur.name)) {
      return { from: cur.from, to: cur.to };
    }
    cur = cur.parent;
  }
  return null;
}

const linkMark = Decoration.mark({ class: 'cm-lsp-link' });

const ctrlHoverDecorations = EditorView.decorations.compute(
  [ctrlHoverField],
  (state) => {
    const { active, pos } = state.field(ctrlHoverField);
    if (!active || pos == null) return Decoration.none;
    const range = identifierRangeAt(state, pos);
    if (!range) return Decoration.none;
    const marks: Range<Decoration>[] = [linkMark.range(range.from, range.to)];
    return Decoration.set(marks);
  },
);

const ctrlHoverTheme = EditorView.theme({
  '.cm-lsp-link': {
    textDecoration: 'underline',
    textDecorationColor: '#58a6ff',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
});

/**
 * 用户手指可能从编辑器外抬起 Ctrl，此时 keyup 不会传到 CM。
 * 监听 document 层级的 keyup/blur 作为兜底。
 */
function installGlobalResetListeners(view: EditorView): () => void {
  const reset = () => {
    view.dispatch({ effects: setHoverState.of(INITIAL) });
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Control' || e.key === 'Meta') reset();
  };
  const onBlur = () => reset();
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}

const ctrlHoverLifecycle = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== 'Control' && event.key !== 'Meta') return false;
    const prev = view.state.field(ctrlHoverField);
    if (prev.active) return false;
    view.dispatch({ effects: setHoverState.of({ ...prev, active: true }) });
    return false;
  },
  keyup(event, view) {
    if (event.key !== 'Control' && event.key !== 'Meta') return false;
    view.dispatch({ effects: setHoverState.of(INITIAL) });
    return false;
  },
  mousemove(event, view) {
    const prev = view.state.field(ctrlHoverField);
    const active = prev.active || event.ctrlKey || event.metaKey;
    if (!active) {
      if (prev.pos != null) view.dispatch({ effects: setHoverState.of(INITIAL) });
      return false;
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== prev.pos || active !== prev.active) {
      view.dispatch({ effects: setHoverState.of({ active, pos }) });
    }
    return false;
  },
  mouseleave(_event, view) {
    const prev = view.state.field(ctrlHoverField);
    if (prev.pos != null) view.dispatch({ effects: setHoverState.of({ ...prev, pos: null }) });
    return false;
  },
});

/**
 * 入口：导出一个 Extension 数组，直接展开进编辑器 extensions 即可。
 */
export const ctrlHoverLink: Extension = [
  ctrlHoverField,
  ctrlHoverDecorations,
  ctrlHoverTheme,
  ctrlHoverLifecycle,
  // 全局兜底监听（仅在视图创建后注册一次）
  EditorView.updateListener.of((update) => {
    const anyView = update.view as EditorView & { __ctrlHoverCleanup?: () => void };
    if (!anyView.__ctrlHoverCleanup) {
      anyView.__ctrlHoverCleanup = installGlobalResetListeners(update.view);
    }
  }),
];
