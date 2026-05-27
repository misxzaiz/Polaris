/**
 * LSP 跳转逻辑（跨文件感知）。
 *
 * 不依赖 `@codemirror/lsp-client` 的 `Workspace` 抽象：直接调用
 * `client.request('textDocument/definition', ...)`，拿到 `Location` 后
 * 自行路由——同文件用 `view.dispatch` 滚动，跨文件通过
 * `fileEditorStore.openFileAtPosition` 走项目已有的"打开文件"流程。
 *
 * 这使得 Ctrl+Click / F12 在不打开的目标文件上也能工作，不必等
 * `Workspace.requestFile` 重构完成。
 */

import type { LSPClient } from '@codemirror/lsp-client';
import { EditorView } from '@codemirror/view';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('LspNav');

/** LSP 标准 Location（JSON-RPC 层，不需要 TS 类型依赖 vscode-languageserver-protocol） */
interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

type DefinitionResult = LspLocation | LspLocation[] | LspLocationLink[] | null;

/** 把 CodeMirror 文档偏移换算成 LSP Position */
function offsetToLspPosition(view: EditorView, offset: number): LspPosition {
  const line = view.state.doc.lineAt(offset);
  return {
    line: line.number - 1, // CM 1-indexed → LSP 0-indexed
    character: offset - line.from,
  };
}

/** file:///D:/path/to/x.ts → D:\path\to\x.ts（Windows 兼容） */
function uriToPath(uri: string): string {
  let p = uri;
  if (p.startsWith('file:///')) p = p.slice(8);
  else if (p.startsWith('file://')) p = p.slice(7);
  try {
    p = decodeURIComponent(p);
  } catch {
    // ignore malformed escapes
  }
  // Windows: /D:/foo → D:\foo
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p.replace(/\//g, '\\');
}

/** 归一化 definition 响应为第一个 Location（range + uri） */
function firstLocation(result: DefinitionResult): LspLocation | null {
  if (!result) return null;
  if (Array.isArray(result)) {
    if (result.length === 0) return null;
    const first = result[0];
    if ('targetUri' in first) {
      return {
        uri: first.targetUri,
        range: first.targetSelectionRange ?? first.targetRange,
      };
    }
    return first;
  }
  return result;
}

/**
 * 跳转到定义（可能跨文件）。
 *
 * @param view 当前编辑器视图
 * @param client 已连接的 LSPClient
 * @param currentUri 当前文件的 LSP URI（用于判断是否跨文件）
 * @returns 是否成功触发了跳转（未连接/无定义时返回 false）
 */
export async function jumpToDefinitionCrossFile(
  view: EditorView,
  client: LSPClient,
  currentUri: string,
): Promise<boolean> {
  try {
    const head = view.state.selection.main.head;
    const position = offsetToLspPosition(view, head);

    const result = await client.request<unknown, DefinitionResult>(
      'textDocument/definition',
      {
        textDocument: { uri: currentUri },
        position,
      },
    );

    const loc = firstLocation(result);
    if (!loc) {
      log.debug('definition: no result', { uri: currentUri, position });
      return false;
    }

    const targetLine = loc.range.start.line + 1; // LSP 0-indexed → CM 1-indexed
    const targetCol = loc.range.start.character;

    // 同一文件：本地 dispatch
    if (loc.uri === currentUri) {
      const doc = view.state.doc;
      if (targetLine < 1 || targetLine > doc.lines) return false;
      const line = doc.line(targetLine);
      const anchor = Math.min(line.from + targetCol, line.to);
      view.dispatch({
        selection: { anchor },
        effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
      });
      view.focus();
      return true;
    }

    // 跨文件：走 fileEditorStore，Editor 组件会按 pendingGotoLine/Column 落位
    const targetPath = uriToPath(loc.uri);
    const name = targetPath.split(/[\\/]/).pop() ?? targetPath;
    log.debug('definition: cross-file jump', { to: targetPath, line: targetLine, col: targetCol });
    await useFileEditorStore.getState().openFileAtPosition(
      targetPath,
      name,
      targetLine,
      targetCol,
    );
    return true;
  } catch (err) {
    log.warn('jumpToDefinition failed', { error: String(err) });
    return false;
  }
}

