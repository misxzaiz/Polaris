/**
 * 会话变更汇总派生（悬浮岛常驻变更段数据源）
 *
 * 纯派生：唯一数据源是 conversationStore 已有的 messages / currentMessage.blocks，
 * 零新增写入路径、零协议改动（plans/dynamic-island-change-summary-plan.md 第四节）。
 *
 * 口径（如实标注）：
 * - 工具流水累加：同文件多次编辑按次累加 +N −M，不是 git 快照的真实 diff；
 * - 仅统计结构化文件工具（edit / write / apply_patch / delete_file），bash 内的
 *   文件操作（rm 等）不计入；
 * - 文件操作只计 status === 'completed' 的块（running 无 diffData，failed 未落盘）。
 *
 * 后台 bash 任务口径：bash 异步任务「工具调用先返回、任务继续跑」，块 completed
 * 只是启动成功的回执，不等于任务结束；真实退出状态由展示层按需经 cap.bash status
 * 对账（本地面板不弹审批）。此处把已启动任务一律计为 running（failed 除外），
 * 这是 P3 生命周期事件落地前的诚实近似。
 *
 * memo 策略：历史消息数组按引用 WeakMap 缓存（流式期间 messages 引用不变，
 * 不会每 token 重扫）；currentBlocks 每次快照现算（单消息块数，代价小）。
 */

import type { AssistantChatMessage, ChatMessage, ContentBlock, ToolCallBlock } from '@/types';
import { extractEditDiff, extractWriteInfo, isEditTool, isWriteTool } from '@/utils/diffExtractor';
import { extractCommand } from '@/utils/toolInputExtractor';

/** 文件操作类型（edit=编辑，write=写入/新建，delete=删除；apply_patch 按文件类型映射到这三类） */
export type FileOpKind = 'edit' | 'write' | 'delete';

/**
 * 单侧 diff 内容截断上限（字符）：行内预览只需局部内容，大文件写入不落全量，
 * 超限截断并置 truncated 标记（仅影响预览完整度，不影响 +/- 统计口径）。
 */
export const MAX_DIFF_CHARS = 8000;

/** 最近一次操作的 diff 内容（行内预览用；删除操作无） */
export interface SessionFileDiffPreview {
  oldContent?: string;
  newContent?: string;
  /** 内容超上限被截断 */
  truncated?: boolean;
}

/** 单文件的会话内变更记录 */
export interface SessionFileChange {
  filePath: string;
  /** 流水累加的新增行数 */
  addedLines: number;
  /** 流水累加的删除行数 */
  removedLines: number;
  /** 累计操作次数 */
  opCount: number;
  /** 最近一次操作的类型（决定行图标） */
  lastKind: FileOpKind;
  /** 最近一次操作时间（ms epoch，0 = 未知） */
  lastOpAt: number;
  /** 最近一次操作的块 id（预留定位/跳转） */
  lastBlockId: string;
  /** 最近一次操作的 diff 内容（供行内查看变更；删除操作无） */
  lastDiff?: SessionFileDiffPreview;
}

/** 后台 bash 任务（cap.bash taskId 透传聚合） */
export interface SessionBgTask {
  taskId: string;
  /** 命令摘要 */
  label: string;
  /**
   * 启动态近似：failed 仅在启动失败时成立；running 表示「已启动、生命周期未知」，
   * 真实退出状态由展示层经 cap.bash status 对账（P3 生命周期事件前的过渡方案）。
   */
  status: 'running' | 'failed';
  startedAt: number;
  blockId: string;
}

/** 会话变更汇总 */
export interface SessionChangeSummary {
  /** 按 lastOpAt 降序（MRU），上限 MAX_FILES */
  files: SessionFileChange[];
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  /** 失败优先，其后按开始时间降序，上限 MAX_TASKS */
  backgroundTasks: SessionBgTask[];
  runningBgCount: number;
}

export const MAX_FILES = 100;
export const MAX_TASKS = 20;

export const EMPTY_CHANGE_SUMMARY: SessionChangeSummary = {
  files: [],
  totalFiles: 0,
  totalAdded: 0,
  totalRemoved: 0,
  backgroundTasks: [],
  runningBgCount: 0,
};

/** 历史扫描中间态（WeakMap 缓存值） */
interface ScanState {
  files: Map<string, SessionFileChange>;
  tasks: SessionBgTask[];
}

const historyCache = new WeakMap<ChatMessage[], ScanState>();

/** 与 toolSummary.ts 同一口径：去末尾单个换行后计行，空串为 0 行 */
function countLines(s: string | undefined): number {
  if (!s) return 0;
  const t = s.replace(/\n$/, '');
  return t === '' ? 0 : t.split('\n').length;
}

/** 判断是否删除类工具（toolSummary 注册名：DeleteFile / delete_file） */
function isDeleteTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('delete_file') || n.includes('deletefile');
}

/** apply_patch 的文件级补丁类型 → 操作类型 */
function patchKind(type: 'add' | 'update' | 'delete'): FileOpKind {
  if (type === 'add') return 'write';
  if (type === 'delete') return 'delete';
  return 'edit';
}

function blockTimeMs(block: ToolCallBlock, fallbackTs: string | undefined): number {
  const raw = block.startedAt || fallbackTs;
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? 0 : ts;
}

/** diff 单侧内容截断（超 MAX_DIFF_CHARS 截断并标记） */
function capContent(s: string | undefined): { text?: string; truncated: boolean } {
  if (!s) return { truncated: false };
  if (s.length <= MAX_DIFF_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_DIFF_CHARS), truncated: true };
}

/** 把一次文件操作合入汇总（累加语义，最近操作信息覆盖） */
function applyOp(
  files: Map<string, SessionFileChange>,
  filePath: string,
  kind: FileOpKind,
  added: number,
  removed: number,
  at: number,
  blockId: string,
  diff?: SessionFileDiffPreview,
): void {
  if (!filePath) return;
  const prev = files.get(filePath);
  files.set(filePath, {
    filePath,
    addedLines: (prev?.addedLines ?? 0) + added,
    removedLines: (prev?.removedLines ?? 0) + removed,
    opCount: (prev?.opCount ?? 0) + 1,
    lastKind: kind,
    lastOpAt: Math.max(prev?.lastOpAt ?? 0, at),
    lastBlockId: blockId,
    lastDiff: diff ?? prev?.lastDiff,
  });
}

/**
 * 从单个 tool_call 块提取信息。
 * 后台 bash 任务不限块状态（启动中/已回执都计入）；文件操作仅计 completed。
 */
function collectBlockOps(
  block: ToolCallBlock,
  files: Map<string, SessionFileChange>,
  tasks: SessionBgTask[],
  fallbackTs: string | undefined,
): void {
  // 后台 bash 任务：taskId 由 ToolCallStart/End 透传（协议注释：供前端管理面板关联）。
  // 同 taskId 的启动块在「流式 currentBlocks → 落盘 messages」交接前后只会存在一处，
  // upsert 兜底防重。
  if (block.taskId) {
    const task: SessionBgTask = {
      taskId: block.taskId,
      label: extractCommand(block.input) || block.name,
      status: block.status === 'failed' ? 'failed' : 'running',
      startedAt: blockTimeMs(block, fallbackTs),
      blockId: block.id,
    };
    const existing = tasks.find(t => t.taskId === block.taskId);
    if (existing) tasks[tasks.indexOf(existing)] = task;
    else tasks.push(task);
    return;
  }

  if (block.status !== 'completed') return;
  const at = blockTimeMs(block, fallbackTs);

  // apply_patch：patchData 是事件层已解析好的 per-file 权威数据（eventHandler 写入）
  if (block.name === 'apply_patch' && block.patchData?.length) {
    for (const f of block.patchData) {
      const oldC = capContent(f.oldContent);
      const newC = capContent(f.newContent);
      applyOp(files, f.filePath, patchKind(f.type), f.addedLines, f.removedLines, at, block.id, {
        oldContent: oldC.text,
        newContent: newC.text,
        truncated: oldC.truncated || newC.truncated,
      });
    }
    return;
  }

  // 编辑类：diffData 由 eventHandler 在 tool_call_end 写入；老数据回退从 input 推导
  if (isEditTool(block.name)) {
    const diff = block.diffData ?? extractEditDiff(block);
    const filePath = diff?.filePath || String(block.input?.file_path || block.input?.path || '');
    const oldC = capContent(diff?.oldContent);
    const newC = capContent(diff?.newContent);
    applyOp(files, filePath, 'edit', countLines(diff?.newContent), countLines(diff?.oldContent), at, block.id, {
      oldContent: oldC.text,
      newContent: newC.text,
      truncated: oldC.truncated || newC.truncated,
    });
    return;
  }

  // 写入/新建类
  if (isWriteTool(block.name)) {
    const info = block.diffData
      ? { filePath: block.diffData.filePath, newContent: block.diffData.newContent }
      : extractWriteInfo(block);
    const filePath = info?.filePath || String(block.input?.file_path || block.input?.path || '');
    const newC = capContent(info?.newContent);
    applyOp(files, filePath, 'write', countLines(info?.newContent), 0, at, block.id, {
      newContent: newC.text,
      truncated: newC.truncated,
    });
    return;
  }

  // 删除类：无行数可计，仅记操作
  if (isDeleteTool(block.name)) {
    const filePath = String(block.input?.file_path || block.input?.path || '');
    applyOp(files, filePath, 'delete', 0, 0, at, block.id);
  }
}

/** 扫描一条 assistant 消息的块 */
function collectMessage(msg: ChatMessage, state: ScanState): void {
  if (msg.type !== 'assistant') return;
  const blocks = (msg as AssistantChatMessage).blocks;
  if (!blocks) return;
  for (const b of blocks) {
    if (b.type === 'tool_call') collectBlockOps(b as ToolCallBlock, state.files, state.tasks, msg.timestamp);
  }
}

/** 历史消息扫描（按数组引用 memo） */
function scanHistory(messages: ChatMessage[]): ScanState {
  const cached = historyCache.get(messages);
  if (cached) return cached;
  const state: ScanState = { files: new Map(), tasks: [] };
  for (const msg of messages) collectMessage(msg, state);
  historyCache.set(messages, state);
  return state;
}

function toSortedFiles(map: Map<string, SessionFileChange>): SessionFileChange[] {
  return Array.from(map.values())
    .sort((a, b) => b.lastOpAt - a.lastOpAt)
    .slice(0, MAX_FILES);
}

function toSortedTasks(tasks: SessionBgTask[]): SessionBgTask[] {
  return [...tasks]
    .sort((a, b) => {
      if (a.status === 'failed' && b.status !== 'failed') return -1;
      if (b.status === 'failed' && a.status !== 'failed') return 1;
      return b.startedAt - a.startedAt;
    })
    .slice(0, MAX_TASKS);
}

/**
 * 派生会话变更汇总。
 * @param messages 已落盘的历史消息（store.messages）
 * @param currentBlocks 当前流式回复的块（store.currentMessage?.blocks，可为空）
 * @param now 流式块的兜底时间源（与 deriveRuntimeSummary 的 now 同源，保持快照纯净）
 */
export function deriveChangeSummary(
  messages: ChatMessage[],
  currentBlocks: ContentBlock[] | undefined,
  now: number,
): SessionChangeSummary {
  const history = scanHistory(messages || []);

  // 克隆历史态再叠加当前流式块，避免污染 WeakMap 缓存
  const files = new Map<string, SessionFileChange>();
  for (const [k, v] of history.files) files.set(k, { ...v });
  const tasks: SessionBgTask[] = history.tasks.map(t => ({ ...t }));

  if (currentBlocks) {
    for (const b of currentBlocks) {
      if (b.type === 'tool_call') collectBlockOps(b as ToolCallBlock, files, tasks, undefined);
    }
  }
  // 流式块无 startedAt 时以 now 兜底，保证后台任务可排序
  for (const t of tasks) {
    if (!t.startedAt) t.startedAt = now;
  }

  const sortedFiles = toSortedFiles(files);
  const sortedTasks = toSortedTasks(tasks);
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const f of sortedFiles) {
    totalAdded += f.addedLines;
    totalRemoved += f.removedLines;
  }

  return {
    files: sortedFiles,
    totalFiles: sortedFiles.length,
    totalAdded,
    totalRemoved,
    backgroundTasks: sortedTasks,
    runningBgCount: sortedTasks.filter(t => t.status === 'running').length,
  };
}
