/**
 * 补丁解析器
 *
 * 解析 SimpleAI apply_patch 工具的 Codex V4A 补丁信封格式，
 * 提取文件级变更信息用于前端 Diff 渲染。
 *
 * 信封格式：
 * ```text
 * *** Begin Patch
 * *** Add File: path/to/new.rs
 * +line 1
 * +line 2
 * *** Delete File: path/to/old.rs
 * *** Update File: path/to/edit.rs
 * *** Move to: path/to/renamed.rs
 * @@ optional context anchor
 *  unchanged context line
 * -removed line
 * +added line
 * *** End Patch
 * ```
 */

/** 单文件的变更信息 */
export interface PatchFileChange {
  type: 'add' | 'update' | 'delete';
  /** 目标文件路径（Add 为新建路径，Update 为原路径，Delete 为删除路径） */
  filePath: string;
  /** 重命名后的路径（仅 Update 有，可为空表示无重命名） */
  movePath?: string;
  /** 补丁中包含的 chunk 数 */
  chunkCount: number;
  /** 新增行数 */
  addedLines: number;
  /** 删除行数 */
  removedLines: number;
  /** DiffViewer 所需：旧内容（仅补丁涉及的部分） */
  oldContent: string;
  /** DiffViewer 所需：新内容（仅补丁涉及的部分） */
  newContent: string;
}

/** 解析后的完整补丁 */
export interface ParsedPatch {
  files: PatchFileChange[];
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
}

/** 行级 diff 项 */
interface DiffLine {
  type: '+' | '-' | ' ';
  text: string;
}

/** 一个 hunk 的 diff 行 */
interface ChunkDiff {
  lines: DiffLine[];
}

function parseChunkLines(lines: string[]): ChunkDiff {
  const result: DiffLine[] = [];
  for (const line of lines) {
    if (line.startsWith('+')) {
      result.push({ type: '+', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      result.push({ type: '-', text: line.slice(1) });
    } else {
      // 上下文行（以空格开头或无前缀）
      const text = line.startsWith(' ') ? line.slice(1) : line;
      result.push({ type: ' ', text });
    }
  }
  return { lines: result };
}

/** 从 chunk 行中统计增减行数 */
function countChunkLines(chunk: ChunkDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of chunk.lines) {
    if (line.type === '+') added++;
    if (line.type === '-') removed++;
  }
  return { added, removed };
}

/** 从 chunk 行重建 oldContent */
function rebuildOldContent(chunks: ChunkDiff[]): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      if (line.type === '+' || line.type === ' ') {
        continue;
      }
      // 只收 context 行和 removed 行
    }
    // 按顺序收集
    for (const line of chunk.lines) {
      if (line.type === '-') {
        parts.push(line.text);
      } else if (line.type === ' ') {
        parts.push(line.text);
      }
    }
  }
  return parts.join('\n');
}

/** 从 chunk 行重建 newContent */
function rebuildNewContent(chunks: ChunkDiff[]): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      if (line.type === '+') {
        parts.push(line.text);
      } else if (line.type === ' ') {
        parts.push(line.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * 解析 apply_patch 补丁信封，返回结构化数据。
 *
 * @param patchText 完整的补丁信封文本
 * @returns 解析后的补丁数据，解析失败返回 null（调用方回退纯文本展示）
 */
export function parseApplyPatch(patchText: string): ParsedPatch | null {
  if (!patchText || typeof patchText !== 'string') {
    return null;
  }

  const lines = patchText.split('\n');
  const beginIdx = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  if (beginIdx === -1) return null;

  const files: PatchFileChange[] = [];
  let i = beginIdx + 1;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '*** End Patch') {
      break;
    }

    // Add File
    const addMatch = trimmed.match(/^\*\*\* Add File:\s*(.+)$/);
    if (addMatch) {
      const filePath = addMatch[1].trim();
      i++;
      const newLines: string[] = [];
      while (
        i < lines.length &&
        !isFileMarker(lines[i])
      ) {
        const l = lines[i];
        if (l.startsWith('+')) {
          newLines.push(l.slice(1));
        } else {
          // 容错：非 + 行原样收录
          newLines.push(l);
        }
        i++;
      }
      files.push({
        type: 'add',
        filePath,
        chunkCount: 1,
        addedLines: newLines.length,
        removedLines: 0,
        oldContent: '',
        newContent: newLines.join('\n'),
      });
      continue;
    }

    // Delete File
    const deleteMatch = trimmed.match(/^\*\*\* Delete File:\s*(.+)$/);
    if (deleteMatch) {
      const filePath = deleteMatch[1].trim();
      files.push({
        type: 'delete',
        filePath,
        chunkCount: 0,
        addedLines: 0,
        removedLines: 0,
        oldContent: '',
        newContent: '',
      });
      i++;
      continue;
    }

    // Update File
    const updateMatch = trimmed.match(/^\*\*\* Update File:\s*(.+)$/);
    if (updateMatch) {
      const filePath = updateMatch[1].trim();
      i++;

      let movePath: string | undefined = undefined;
      if (i < lines.length) {
        const moveToMatch = lines[i].trim().match(/^\*\*\* Move to:\s*(.+)$/);
        if (moveToMatch) {
          movePath = moveToMatch[1].trim();
          i++;
        }
      }

      const chunks: ChunkDiff[] = [];
      let currentChunkLines: string[] = [];

      while (
        i < lines.length &&
        !isFileMarker(lines[i])
      ) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          // 新 chunk 开始：保存上一个 chunk
          if (currentChunkLines.length > 0) {
            chunks.push(parseChunkLines(currentChunkLines));
          }
          currentChunkLines = [];
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          i++;
          continue;
        }
        currentChunkLines.push(l);
        i++;
      }
      if (currentChunkLines.length > 0) {
        chunks.push(parseChunkLines(currentChunkLines));
      }

      let totalAdded = 0;
      let totalRemoved = 0;
      for (const chunk of chunks) {
        const { added, removed } = countChunkLines(chunk);
        totalAdded += added;
        totalRemoved += removed;
      }

      const fileChange: PatchFileChange = {
        type: 'update',
        filePath,
        movePath: movePath || undefined,
        chunkCount: chunks.length,
        addedLines: totalAdded,
        removedLines: totalRemoved,
        oldContent: rebuildOldContent(chunks),
        newContent: rebuildNewContent(chunks),
      };
      files.push(fileChange);
      continue;
    }

    // 跳过 Begin 之后的空行/杂项
    i++;
  }

  if (files.length === 0) return null;

  const totalAdded = files.reduce((sum, f) => sum + f.addedLines, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.removedLines, 0);

  return {
    files,
    totalFiles: files.length,
    totalAdded,
    totalRemoved,
  };
}

function isFileMarker(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith('*** Add File:') ||
    t.startsWith('*** Delete File:') ||
    t.startsWith('*** Update File:') ||
    t === '*** End Patch'
  );
}
