/**
 * PR-2a C1：cap.git Reply 结构化错误的前端拆包（纯函数，零 transport 依赖）
 *
 * - 后端 RouterDispatchResponse 新增 `errorDetail?: ReplyErrorDetail`
 *   （camelCase：{ code?, kind?, stderrSnip? }，cap.git 内按机器码分型）。
 * - invokeGitCap 拿到 errorDetail → 抛 GitCapError（instanceof Error + detail 字段）；
 *   旧后端（无该字段）→ tag = undefined，`parseReplyError` 返回 undefined，
 *   调用方语义与改动前完全一致（向后兼容降级）。
 */

export interface GitErrorDetail {
  /** 后端机器码（如 CONFLICTS_DETECTED） */
  code?: string
  /** 粗分类型：conflict / operation-in-progress / not-found / git … */
  kind?: string
  /** git stderr 尾部摘要（UI 展开原因用） */
  stderrSnip?: string
}

/** RouterDispatchResponse.errorDetail 的透传（cap 未分类时缺省） */
export type ReplyErrorDetail = GitErrorDetail

/** 携带结构化 detail 的 cap.git 错误（frontend 各消费方可 instanceof 识别） */
export class GitCapError extends Error {
  readonly detail?: GitErrorDetail

  constructor(message: string, detail?: GitErrorDetail) {
    super(message)
    this.name = 'GitCapError'
    this.detail = detail
  }

  /** 便捷分类：kind 缺省视为 'git'（旧行为等价） */
  get kind(): string | undefined {
    return this.detail?.kind
  }
}

/**
 * 从应答的 error 串构造 GitCapError：
 * errorDetail 存在 → 结构化；不存在 → 纯 message（detail undefined，旧行为等价）。
 * 纯函数便于字段级单测，不 mock transport。
 */
export function parseReplyError(rawError: string, detail?: GitErrorDetail | null): GitCapError {
  return new GitCapError(rawError, detail ?? undefined)
}
