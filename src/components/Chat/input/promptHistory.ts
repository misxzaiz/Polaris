/**
 * Prompt 历史（终端风格 ArrowUp/ArrowDown 召回）纯函数模块
 *
 * 语义对齐 ZCode 已验证实现（temp/ZCode/packages/ui/src/lib/promptHistory.ts）：
 * - 内部 entries 统一为「旧→新」序（数组末尾是最近一条）
 * - append：trim、仅与最后一条比对去重（不破坏 A,B,A 非连续重复）、上限截断
 * - navigate：up 聚最旧（clamp 0）；down 翻尽得 index=null、value=''；

 *   未进入浏览态时 down 从最新一条进入历史
 *
 * 修复依据：此前 ChatInput 内联实现存在「浏览态上键失效」「下键无法继续翻」
 * 「savedCurrentInputRef 假机制」等问题，收敛到本模块统一语义并补单测。
 */

export const MAX_PROMPT_HISTORY = 30;

type PromptHistoryDirection = "up" | "down";

export interface PromptHistoryNavigationResult {
  /** null 表示退出浏览态（回到空输入） */
  nextIndex: number | null;
  nextValue: string;
  /** 是否接管该按键（preventDefault） */
  shouldHandle: boolean;
}

/** 内容级相等比较（append 去重与回滚前的快照比对共用） */
export function arePromptHistoryEntriesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, i) => entry === right[i]);
}

/**
 * 追加一条历史（旧→新序）。去重只比对最后一条（trim 后），
 * 避免连续发送相同 prompt 时上键重复命中同一条。
 */
export function appendPromptHistoryEntry(
  entries: readonly string[],
  entry: string,
  limit = MAX_PROMPT_HISTORY,
): string[] {
  const trimmed = entry.trim();
  if (!trimmed) {
    return [...entries];
  }

  if (entries[entries.length - 1]?.trim() === trimmed) {
    return [...entries];
  }

  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return [...entries, trimmed].slice(-normalizedLimit);
}

/** 读侧规范化：仅保留非空字符串，trim，上限截断（持久化加载与写入前共用） */
export function normalizePromptHistoryEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

/**
 * 在「空输入」或「已在浏览态」的前提下计算下一次历史位置。
 * 空史或非法下标时返回 shouldHandle=false，由调用方放行原生行为。
 */
export function navigatePromptHistory(
  entries: readonly string[],
  currentIndex: number | null,
  direction: PromptHistoryDirection,
): PromptHistoryNavigationResult {
  if (entries.length === 0) {
    return {
      nextIndex: currentIndex,
      nextValue: "",
      shouldHandle: false,
    };
  }

  // 浏览态下标越界（历史被并发截短等）视为未进入浏览态
  const safeCurrentIndex =
    currentIndex !== null && entries[currentIndex] === undefined
      ? null
      : currentIndex;

  if (direction === "up") {
    const nextIndex = safeCurrentIndex === null
      ? entries.length - 1
      : Math.max(safeCurrentIndex - 1, 0);
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (safeCurrentIndex === null) {
    // 未进入浏览态时按 down：从最新一条进入历史（与 ZCode 一致）
    const nextIndex = entries.length - 1;
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (safeCurrentIndex >= entries.length - 1) {
    // 翻尽：退出浏览态并清空输入，回到「浏览前」状态
    return {
      nextIndex: null,
      nextValue: "",
      shouldHandle: true,
    };
  }

  const nextIndex = safeCurrentIndex + 1;
  return {
    nextIndex,
    nextValue: entries[nextIndex] ?? "",
    shouldHandle: true,
  };
}
