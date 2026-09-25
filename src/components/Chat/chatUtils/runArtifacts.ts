/**
 * 运行产物共享工具 —— 会话操作数据源
 *
 * 从消息块（messages + currentMessage）实时派生三类会话操作数据：
 *  1. 变更文件（FileChange[]）：Edit/Write/apply_patch 工具提取，去重合并
 *  2. 产物预览（ArtifactPreviewBlock[]）：plugin_card(PRD result) / artifact_preview 提取
 *  3. 过程块（ContentBlock[]）：thinking/tool_call/plan/agent/perm/question/compact/tool_group/text
 *
 * 底部操作区（SessionOperationBar）与灵动岛展开态共用本模块，保证数据一致。
 */

import type { ArtifactPreviewBlock, ContentBlock, ToolCallBlock } from '@/types';
import type { DiffData } from '@/types/chat';
import { extractEditDiff, extractWriteInfo } from '@/utils/diffExtractor';
import { diffLines } from 'diff';

/** 变更文件信息（从工具调用块中提取） */
export interface FileChange {
  /** 完整路径（用于打开编辑器 + 去重 key） */
  fullPath: string;
  /** 仅文件名（用于展示） */
  fileName: string;
  /** 目录路径（用于展示的次要信息） */
  dirPath: string;
  /** 变更类型 */
  changeType: 'modified' | 'created' | 'deleted';
  /** Edit 工具的 diff 数据（modified 时有） */
  diffData?: DiffData;
  /** Write 工具的新内容（created 时有） */
  newContent?: string;
}

/** 从完整路径中拆分文件名和目录 */
export function splitFilePath(filePath: string): { fileName: string; dirPath: string } {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  const fileName = parts.pop() || filePath;
  const dirPath = parts.join('/') + (parts.length ? '/' : '');
  return { fileName, dirPath };
}

/** 计算 Edit diff 的 +N/-M 统计（added/removed 行数） */
export function computeDiffStats(diffData: DiffData): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (diffData.diffString) {
    for (const line of diffData.diffString.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
  } else if (diffData.oldContent !== undefined && diffData.newContent !== undefined) {
    const changes = diffLines(diffData.oldContent, diffData.newContent);
    for (const part of changes) {
      if (part.added) added += part.value.replace(/\n$/, '').split('\n').length;
      else if (part.removed) removed += part.value.replace(/\n$/, '').split('\n').length;
    }
  }
  return { added, removed };
}

/**
 * 从工具调用块中提取变更文件列表。
 * - Edit 工具：diffData.filePath → modified（含 diff 数据）
 * - Write 工具：input.file_path/path → created（含新内容）
 * - apply_patch：patchData[] 多文件 → modified / deleted
 * 复用 diffExtractor，去重（同一文件多次修改只记一次，优先保留 diff 数据）。
 */
export function extractFileChanges(blocks: ContentBlock[]): FileChange[] {
  const seen = new Map<string, FileChange>();
  const add = (fullPath: string, changeType: FileChange['changeType'], data?: Partial<FileChange>) => {
    const { fileName, dirPath } = splitFilePath(fullPath);
    const existing = seen.get(fullPath);
    if (existing) {
      // 已存在：合并 diff/内容数据（保留已有，补充缺失）
      seen.set(fullPath, {
        ...existing,
        ...data,
        changeType,
        fileName: existing.fileName || fileName,
        dirPath: existing.dirPath || dirPath,
      });
      return;
    }
    seen.set(fullPath, {
      fullPath,
      fileName,
      dirPath,
      changeType,
      ...data,
    });
  };

  for (const b of blocks) {
    if (b.type !== 'tool_call' || b.status !== 'completed') continue;

    // apply_patch：多文件补丁（Claude Code 主要改文件工具）
    if (b.name === 'apply_patch' && b.patchData && b.patchData.length > 0) {
      for (const p of b.patchData) {
        if (!p.filePath) continue;
        add(p.filePath, p.type === 'delete' ? 'deleted' : 'modified');
      }
      continue;
    }

    const edit = extractEditDiff(b);
    if (edit?.filePath) {
      add(edit.filePath, 'modified', { diffData: edit });
      continue;
    }
    // 实时流已回填块级 diffData（updateToolCallBlockDiff）时直接从块取，
    // 避免与 input 推导结果不一致（历史恢复 setMessagesFromHistory 回填同源）
    if (b.diffData?.filePath) {
      add(b.diffData.filePath, 'modified', { diffData: b.diffData });
      continue;
    }
    const write = extractWriteInfo(b);
    if (write?.filePath) {
      add(write.filePath, 'created', { newContent: write.newContent });
    }
  }
  return Array.from(seen.values());
}

/** 是否为 PRD 预览结果卡（plugin_card result 模式，data 含 html+previewId） */
function isPreviewPluginCard(b: ContentBlock): b is ContentBlock & { data: Record<string, unknown> } {
  return b.type === 'plugin_card' && b.mode === 'result' && !!b.data && typeof (b.data as Record<string, unknown>).html === 'string';
}

/**
 * 从块中提取产物预览列表（去重保序，新版本覆盖旧版本）。
 * 支持两种来源：
 *  - artifact_preview 块（直接）
 *  - plugin_card result 模式（PRD 预览 MCP，data 含 previewId/html/title/...）
 */
export function extractArtifacts(blocks: ContentBlock[]): ArtifactPreviewBlock[] {
  const seen = new Map<string, ArtifactPreviewBlock>();
  const push = (a: ArtifactPreviewBlock) => {
    const key = a.previewId || a.title || 'unknown';
    // 同 id 新版本覆盖旧版本（版本递增时保留最新）
    const prev = seen.get(key);
    if (prev && (a.version ?? 0) < (prev.version ?? 0)) return;
    seen.set(key, a);
  };

  for (const b of blocks) {
    if (b.type === 'artifact_preview') {
      push(b);
      continue;
    }
    if (isPreviewPluginCard(b)) {
      const d = b.data as Record<string, unknown>;
      const previewId = typeof d.previewId === 'string' ? d.previewId : '';
      if (!previewId) continue;
      push({
        type: 'artifact_preview',
        previewId,
        title: typeof d.title === 'string' && d.title.trim() ? d.title : 'PRD Prototype',
        contentType: 'html',
        html: d.html as string,
        sourcePath: typeof d.sourcePath === 'string' ? d.sourcePath : undefined,
        createdAt: typeof d.createdAt === 'string' ? d.createdAt : undefined,
        version: typeof d.version === 'number' ? d.version : undefined,
        versionLabel: typeof d.versionLabel === 'string' ? d.versionLabel : undefined,
        requirementId: typeof d.requirementId === 'string' ? d.requirementId : undefined,
        description: typeof d.description === 'string' ? d.description : undefined,
      });
    }
  }
  return Array.from(seen.values());
}

/** 是否为过程块（折叠入运行过程列表） */
export function isProcessBlock(block: ContentBlock): boolean {
  switch (block.type) {
    case 'thinking':
    case 'tool_call':
    case 'plan_mode':
    case 'agent_run':
    case 'permission_request':
    case 'question':
    case 'context_compact':
    case 'tool_group':
      return true;
    case 'text':
      // 空文本（"" / "..."）不算过程块
      return !(block.content === '' || block.content === '...' || block.content?.trim() === '');
    default:
      return false;
  }
}

/** 提取过程块列表（按出现顺序） */
export function extractProcessBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter(isProcessBlock);
}

/** 工具调用块（供运行过程列表渲染完整卡） */
export function isToolCallBlock(b: ContentBlock): b is ToolCallBlock {
  return b.type === 'tool_call';
}
