/**
 * 编辑器 SCM 数据 provider 注册表（H3）—— 通用槽位，无 Git 语义。
 *
 * 宿主保留 CM6 渲染壳（gutter / blame 悬浮 / 变更导航），但不再内置任何
 * SCM 数据源：由插件在 `registerUi` 中注册 provider，宿主按需调用。
 * 数据契约刻意保持最小（只含渲染所需字段），避免把某一家 SCM 的模型
 * 泄漏到宿主公共类型里。
 *
 * 约定：
 * - provider 由插件实现，内部自行访问插件服务 / 外部进程；
 * - 宿主只做短 TTL 缓存与 diff 计算（computeDiff），不做 Git 语义判断；
 * - 未注册 provider 时所有读取返回 null，编辑器静默无装饰（不报错）。
 */

/** 状态里的文件引用（只需要路径） */
export interface ScmFileRef {
  path: string
}

/** 工作区 SCM 状态快照（gutter 判定变更级别所需） */
export interface ScmStatusSnapshot {
  exists: boolean
  branch?: string
  staged: ScmFileRef[]
  unstaged: ScmFileRef[]
  untracked: string[]
}

/** 单文件差异内容（宿主据此计算逐行 diff） */
export interface ScmFileDiffContent {
  old_content?: string | null
  new_content?: string | null
}

/** blame 单行（字段与编辑器悬浮展示对齐） */
export interface ScmBlameLine {
  lineNumber: number
  originalLineNumber: number
  commitSha: string
  shortSha: string
  author: string
  authorEmail: string
  timestamp: number
  summary?: string
  content: string
}

export interface ScmBlameResult {
  lines: ScmBlameLine[]
  totalLines: number
}

/** 插件实现的 SCM 数据提供者 */
export interface EditorScmProvider {
  /** 工作区状态；非仓库返回 exists=false 或 null */
  getStatus(workspacePath: string): Promise<ScmStatusSnapshot | null>
  /** 单文件差异（worktree=工作区 vs HEAD，index=暂存区 vs HEAD） */
  getFileDiff(
    workspacePath: string,
    filePath: string,
    kind: 'worktree' | 'index',
  ): Promise<ScmFileDiffContent | null>
  /** 文件 blame；不支持时返回 null */
  getBlame(workspacePath: string, filePath: string): Promise<ScmBlameResult | null>
}

interface ScmProviderEntry {
  pluginId: string
  provider: EditorScmProvider
}

let entry: ScmProviderEntry | null = null

export function registerEditorScmProvider(
  pluginId: string,
  provider: EditorScmProvider,
): void {
  entry = { pluginId, provider }
}

export function unregisterEditorScmProvider(pluginId: string): void {
  if (entry?.pluginId === pluginId) entry = null
}

export function getEditorScmProvider(): EditorScmProvider | null {
  return entry?.provider ?? null
}

export function hasEditorScmProvider(): boolean {
  return entry !== null
}

/** 当前 provider 所属插件（诊断用） */
export function getEditorScmProviderId(): string | null {
  return entry?.pluginId ?? null
}
