/**
 * 通过 LSP `textDocument/formatting` 请求格式化当前文档，
 * 把返回的 `TextEdit[]` 转为 CodeMirror `ChangeSpec[]` 并 `view.dispatch`。
 *
 * 供"保存时格式化"（format on save）与手动"Format Document"命令复用。
 */

import type { LSPClient } from '@codemirror/lsp-client';
import type { EditorView } from '@codemirror/view';
import { useLspStore } from '@/stores/lspStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('LspFormat');

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** file path → file URI（与 lspStore.pathToUri 保持一致） */
function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

/** LSP Position → CodeMirror 文档 offset（越界 clamp 到行尾） */
function posToOffset(view: EditorView, pos: LspPosition): number {
  const doc = view.state.doc;
  const lineNum = pos.line + 1;
  if (lineNum < 1) return 0;
  if (lineNum > doc.lines) return doc.length;
  const line = doc.line(lineNum);
  return Math.min(line.from + pos.character, line.to);
}

/**
 * 请求 LSP 格式化当前文件并应用结果。
 *
 * 策略：
 * - 按语言查 LSP client；没有就直接返回 false。
 * - 发起 `textDocument/formatting`，options 使用 editor 自带缩进（2 空格）。
 * - 把所有 TextEdit 转成 ChangeSpec 数组一次性 dispatch。CodeMirror 会自己
 *   处理同一事务里多个 change 的相对 offset。
 *
 * @returns 是否执行了格式化（true=已 dispatch，false=没有 LSP / 返回空）
 */
export async function formatDocumentForFile(
  filePath: string,
  language: string,
  view: EditorView,
): Promise<boolean> {
  const lspStore = useLspStore.getState();
  // 通过 store 拿到已连接的 client（避免重复暴露内部状态）
  const client = getActiveClientForFile(lspStore, language);
  if (!client) {
    log.debug('format skipped: no active LSP for language', { language });
    return false;
  }

  const uri = pathToUri(filePath);
  try {
    const edits = await client.request<unknown, LspTextEdit[] | null>(
      'textDocument/formatting',
      {
        textDocument: { uri },
        options: {
          tabSize: 2,
          insertSpaces: true,
          trimTrailingWhitespace: true,
          insertFinalNewline: true,
          trimFinalNewlines: true,
        },
      },
    );

    if (!edits || edits.length === 0) {
      log.debug('format: server returned no edits', { uri });
      return false;
    }

    const changes = edits.map((e) => ({
      from: posToOffset(view, e.range.start),
      to: posToOffset(view, e.range.end),
      insert: e.newText,
    }));
    view.dispatch({ changes });
    log.debug('format applied', { uri, count: changes.length });
    return true;
  } catch (err) {
    log.warn('format request failed', { error: String(err) });
    return false;
  }
}

/** 给定语言从 lspStore 找到活跃的 LSPClient。封装成函数方便替换。 */
function getActiveClientForFile(
  lspStore: ReturnType<typeof useLspStore.getState>,
  language: string,
): LSPClient | null {
  const serverConfig = lspStore.servers.find(
    (s) => s.enabled && s.languages.includes(language),
  );
  if (!serverConfig) return null;
  const active = lspStore.clients.get(serverConfig.id);
  return active?.client ?? null;
}
