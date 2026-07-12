/**
 * 收集编辑器中所有"未保存修改"的缓冲区，给后端索引引擎做 dirty buffer 合并。
 *
 * 跳转/查应用时：用户可能改了 Foo.java 但没保存，此时 DB 里的 Foo 还是旧版本。
 * 把这些"脏"内容连带传过去，后端用 tree-sitter 即时解析覆盖 DB 候选。
 */

import { useFileEditorStore } from '@/stores/fileEditorStore';
import type { DirtyBuffer } from '@/services/tauri/lspService';

/**
 * 返回当前工作区里所有 dirty 文件的 buffer 内容。
 *
 * 当前文件也算（只要 isModified=true），因为它是最常见的"刚写完还没存"场景。
 * 仅返回支持索引提取的语言（目前 Java；其它后端会忽略）。
 */
export function collectDirtyBuffers(): DirtyBuffer[] {
  const state = useFileEditorStore.getState();
  const out: DirtyBuffer[] = [];

  const supported = (lang: string) => lang === 'java';

  // 当前文件
  const cur = state.currentFile;
  if (cur && cur.isModified && supported(cur.language)) {
    out.push({
      path: cur.path,
      content: cur.content,
      language: cur.language,
    });
  }

  // 后台 buffers
  for (const [path, buf] of state.buffers.entries()) {
    if (path === cur?.path) continue;
    if (!buf.isModified) continue;
    if (!supported(buf.language)) continue;
    out.push({
      path,
      content: buf.content,
      language: buf.language,
    });
  }

  return out;
}
