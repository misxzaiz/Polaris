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
import { symbolAtCursor } from './lspReferences';
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
