/**
 * 索引模式的跳转定义 + 智能跳转。
 *
 * 调后端 `lsp_index_definition`（tree-sitter 语义级 + 排序）拿到候选：
 * - 0 个：静默失败（返回 false）；
 * - 1 个：直接跨文件跳转；
 * - 多个：根据触发源
 *   - 'ctrl-click' / 'definition-key' → DefinitionPeek（贴光标浮窗）
 *   - 'references-key' → ReferencesPanel（全量面板）
 *
 * 跳转时会把所有 dirty buffer 一并传给后端，覆盖 DB 旧候选。
 */

import type { EditorView } from '@codemirror/view';
import { useLspUiStore } from '@/stores/lspUiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { lspIndexDefinition } from '@/services/tauri/lspService';
import type { IndexMatch } from '@/services/tauri/lspService';
import { extensionsForLanguages } from './languageExtensions';
import { symbolAtCursor, runFindReferences } from './lspReferences';
import { collectDirtyBuffers } from './dirtyBuffers';
import { createLogger } from '@/utils/logger';

const log = createLogger('IndexNav');

/** 触发源——决定多候选时把结果摆在哪里 */
export type NavigationSource = 'ctrl-click' | 'definition-key' | 'references-key';

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function matchesToReferenceItems(matches: IndexMatch[]) {
  return matches.map((m) => ({
    path: m.path,
    line: m.line,
    column: m.column,
    preview: m.preview,
    kind: m.kind,
    fqn: m.fqn,
  }));
}

/**
 * 索引模式跳转定义。
 * @param view 当前编辑器
 * @param language 当前文件语言 ID
 * @param languages 服务器声明支持的语言（推导扫描扩展名）
 * @param source 触发源（影响多候选 UI 路由）
 * @returns 是否成功发起（取不到符号 / 无工作区时返回 false）
 */
export async function jumpToDefinitionIndex(
  view: EditorView,
  language: string,
  languages: string[],
  source: NavigationSource = 'definition-key',
): Promise<boolean> {
  const symbol = symbolAtCursor(view);
  if (!symbol) return false;

  const root = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
  if (!root) return false;

  const exts = extensionsForLanguages(languages);
  const currentFile = useFileEditorStore.getState().currentFile?.path;
  const dirty = collectDirtyBuffers();

  try {
    const matches = await lspIndexDefinition(
      root,
      symbol,
      language,
      exts,
      currentFile,
      dirty.length ? dirty : undefined,
    );
    if (matches.length === 0) {
      log.debug('index definition: no result', { symbol });
      return false;
    }

    if (matches.length === 1) {
      const m = matches[0];
      await useFileEditorStore
        .getState()
        .openFileAtPosition(m.path, fileNameOf(m.path), m.line, m.column);
      return true;
    }

    // 多候选 → 根据触发源决定 UI
    if (source === 'references-key') {
      useLspUiStore.getState().openReferences({
        symbol,
        loading: false,
        items: matchesToReferenceItems(matches),
        error: null,
      });
    } else {
      const anchor = computePeekAnchor(view);
      useLspUiStore.getState().openDefinitionPeek({
        symbol,
        items: matchesToReferenceItems(matches),
        anchor,
      });
    }
    return true;
  } catch (err) {
    log.warn('index definition failed', { error: String(err) });
    return false;
  }
}

/**
 * 索引模式智能跳转（Ctrl+左键合并行为）。
 * - 不在定义处 → 跳定义；
 * - 唯一定义就是当前位置 → 改查引用。
 */
export async function smartJumpIndex(
  view: EditorView,
  language: string,
  languages: string[],
  _source: NavigationSource = 'ctrl-click',
): Promise<boolean> {
  const symbol = symbolAtCursor(view);
  if (!symbol) return false;

  const root = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
  if (!root) return false;

  const exts = extensionsForLanguages(languages);
  const currentFile = useFileEditorStore.getState().currentFile?.path;
  const dirty = collectDirtyBuffers();

  try {
    const defs = await lspIndexDefinition(
      root,
      symbol,
      language,
      exts,
      currentFile,
      dirty.length ? dirty : undefined,
    );

    // 没有定义匹配 → 直接查引用兜底
    if (defs.length === 0) {
      return await runFindReferences(view, { mode: 'index', languages });
    }

    // 当前光标位置（与索引匹配的行/列对齐：1-based 行 + 0-based 列）
    const head = view.state.selection.main.head;
    const cmLine = view.state.doc.lineAt(head);
    const curLine = cmLine.number;
    const curCol = head - cmLine.from;
    const curPath = currentFile ?? '';

    // 唯一一个定义且就在当前光标处 → 切换为查引用
    if (
      defs.length === 1 &&
      pathsEqual(defs[0].path, curPath) &&
      defs[0].line === curLine &&
      Math.abs(defs[0].column - curCol) <= symbol.length
    ) {
      return await runFindReferences(view, { mode: 'index', languages });
    }

    // 否则跳转：单个直接跳，多个进 peek
    if (defs.length === 1) {
      const m = defs[0];
      await useFileEditorStore
        .getState()
        .openFileAtPosition(m.path, fileNameOf(m.path), m.line, m.column);
      return true;
    }

    const anchor = computePeekAnchor(view);
    useLspUiStore.getState().openDefinitionPeek({
      symbol,
      items: matchesToReferenceItems(defs),
      anchor,
    });
    return true;
  } catch (err) {
    log.warn('smartJumpIndex failed', { error: String(err) });
    return false;
  }
}

/** 计算 peek 浮窗锚点：当前光标的屏幕坐标 */
function computePeekAnchor(view: EditorView): { x: number; y: number; lineHeight: number } {
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  if (!coords) {
    const rect = view.dom.getBoundingClientRect();
    return { x: rect.left + 24, y: rect.top + 24, lineHeight: 18 };
  }
  return {
    x: coords.left,
    y: coords.bottom,
    lineHeight: coords.bottom - coords.top,
  };
}

/** 跨平台路径比较（统一斜杠 + 大小写不敏感，应对 Windows） */
function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}
