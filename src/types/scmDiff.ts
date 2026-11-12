/**
 * SCM 差异类型 —— 通用渲染契约（无 Git 语义）。
 *
 * 宿主不再持有任何 SCM 引擎：`ScmDiffEntry` 是"一份文件差异"的最小描述，
 * 由插件（diffRefresh 槽位 / 面板自身）产出，宿主 `components/Diff` 与 diff tab
 * 消费。字段名沿用 snake_case（跨进程 JSON 直传，避免二次映射）。
 */

/**
 * 差异变更类型
 */
export type DiffChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

/**
 * 单文件差异条目
 */
export interface ScmDiffEntry {
  file_path: string
  old_file_path?: string
  change_type: DiffChangeType
  old_content?: string
  new_content?: string
  additions?: number
  deletions?: number
  is_binary: boolean
  content_omitted?: boolean  // 内容过大被省略
  status_hint?: {            // 状态冲突提示
    has_conflict: boolean
    message?: string
    current_view: string
  }
}
