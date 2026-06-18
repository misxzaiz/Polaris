/**
 * 索引模式的跳转定义。
 *
 * 调后端 `lsp_index_definition`（语言感知正则启发式）拿到定义候选：
 * - 0 个：静默失败（返回 false）；
 * - 1 个：直接跨文件跳转；
 * - 多个：用 ReferencesPanel 列出候选供用户选择。
 *
 * 不依赖任何常驻进程，面向低配机 / 重型语言（Java、C++ 等）。
 */

import type { EditorView } from '@codemirror/view';
import { useLspUiStore } from '@/stores/lspUiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { lspIndexDefinition } from '@/services/tauri/lspService';
import { extensionsForLanguages } from './languageExtensions';
import { symbolAtCursor, runFindReferences } from './lspReferences';
import { createLogger } from '@/utils/logger';

const log = createLogger('IndexNav');

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 索引模式跳转定义。
 * @param view 当前编辑器
 * @param language 当前文件语言 ID
 * @param languages 服务器声明支持的语言（推导扫描扩展名）
 * @returns 是否成功发起（取不到符号 / 无工作区时返回 false）
 */
export async function jumpToDefinitionIndex(
  view: EditorView,
  language: string,
  languages: string[],
): Promise<boolean> {
  const symbol = symbolAtCursor(view);
  if (!symbol) return false;

  const root = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
  if (!root) return false;

  const exts = extensionsForLanguages(languages);

  try {
    const matches = await lspIndexDefinition(root, symbol, language, exts);
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

    // 多个候选 → 列入 References 面板
    useLspUiStore.getState().openReferences({
      symbol,
      loading: false,
      items: matches.map((m) => ({
        path: m.path,
        line: m.line,
        column: m.column,
        preview: m.preview,
      })),
      error: null,
    });
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
): Promise<boolean> {
  const symbol = symbolAtCursor(view);
  if (!symbol) return false;

  const root = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
  if (!root) return false;

  const exts = extensionsForLanguages(languages);

  try {
    const defs = await lspIndexDefinition(root, symbol, language, exts);

    // 没有定义匹配 → 直接查引用兜底
    if (defs.length === 0) {
      return await runFindReferences(view, { mode: 'index', languages });
    }

    // 当前光标位置（与索引匹配的行/列对齐：1-based 行 + 0-based 列）
    const head = view.state.selection.main.head;
    const cmLine = view.state.doc.lineAt(head);
    const curLine = cmLine.number;
    const curCol = head - cmLine.from;
    const curPath = useFileEditorStore.getState().currentFile?.path ?? '';

    // 唯一一个定义且就在当前光标处 → 切换为查引用
    if (
      defs.length === 1 &&
      pathsEqual(defs[0].path, curPath) &&
      defs[0].line === curLine &&
      Math.abs(defs[0].column - curCol) <= symbol.length
    ) {
      return await runFindReferences(view, { mode: 'index', languages });
    }

    // 否则跳转：单个直接跳，多个进面板
    if (defs.length === 1) {
      const m = defs[0];
      await useFileEditorStore
        .getState()
        .openFileAtPosition(m.path, fileNameOf(m.path), m.line, m.column);
      return true;
    }
    useLspUiStore.getState().openReferences({
      symbol,
      loading: false,
      items: defs.map((m) => ({
        path: m.path,
        line: m.line,
        column: m.column,
        preview: m.preview,
      })),
      error: null,
    });
    return true;
  } catch (err) {
    log.warn('smartJumpIndex failed', { error: String(err) });
    return false;
  }
}

/** 跨平台路径比较（统一斜杠 + 大小写不敏感，应对 Windows） */
function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}
