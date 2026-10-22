/**
 * HTML 卡片渲染 —— 检测层纯函数
 *
 * 从 AI 完整文本输出中识别「自包含 HTML 文档」，用于在消息流中自动渲染为
 * 可交互卡片（MVP-A 复用 ArtifactPreviewRenderer 渲染）。
 *
 * 设计约束（与 plans/html-output-card-render-spec.md 契约对齐）：
 * - 零 DOM 依赖、零副作用：可在任意上下文（浏览器 / node / 单测）安全调用。
 * - 误判要极低：必须同时满足「开头是合法 HTML 文档」+「结尾闭合 </html>」，
 *   才认定是完整文档；纯文字、普通代码块、非完整 HTML 一律返回 false。
 * - 与现有 markdown 渲染路径解耦：本模块只管「判定 + 提取」，
 *   渲染由调用方（eventHandler → ArtifactPreviewRenderer）负责。
 */

/** 完整 HTML 文档判定：开头是 <!doctype html> 或 <html>，且以 </html> 结尾 */
export function isCompleteHtmlDoc(text: string): boolean {
  const t = text.trimStart()
  const opens = /^(<!doctype\s+html|<html[\s>])/i.test(t)
  if (!opens) return false
  return /<\/html>\s*$/i.test(t)
}

/** 流式中途判定：只要 trimStart 后开头命中合法 HTML 文档标记即进入卡片模式 */
export function isHtmlOpening(text: string): boolean {
  const t = text.trimStart()
  return /^(<!doctype\s+html|<html[\s>])/i.test(t)
}

/**
 * 从完整输出文本中提取 HTML 卡片候选。
 *
 * 优先取 ```html 围栏（第一对匹配）内的内容，其次把整体文本当候选；
 * 只有候选通过 isCompleteHtmlDoc 才返回，否则返回 null。
 */
export function extractHtmlCandidate(text: string): string | null {
  const fenceMatch = text.match(/```(?:html)?\s*\n?([\s\S]*?)\n?```/i)
  const candidate = fenceMatch ? fenceMatch[1] : text
  return isCompleteHtmlDoc(candidate) ? candidate : null
}

/**
 * 从输出文本中剥离尚未闭合的 ```html 围栏前缀。
 * 用于流式防误判：已出现但未闭合的围栏不应参与「HTML 开头」判定，
 * 避免「先说话再给代码」的纯文本出现假阳性。
 */
export function stripFence(text: string): string {
  return text.replace(/^```(?:html)?\s*\n?/i, '')
}

/** 提取 <title> 内容作为卡片标题；缺省 'HTML 卡片' */
export function guessTitle(text: string): string {
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match?.[1]?.trim() || 'HTML 卡片'
}

/**
 * 把含完整 HTML 文档的文本块拆成 前文 / 文档 / 后文。
 *
 * text 中可能存在多个 ```html 围栏或整体文档；本函数取「首个通过判定」的
 * 候选作为卡片内容，两侧（before/after）保留为文本，避免信息丢失。
 *
 * 判定顺序：优先找围栏候选，其次整块候选；均不命中时 html 为 null 且两侧为空。
 */
export function splitAroundHtml(
  text: string,
): { before: string; html: string | null; after: string } {
  // 优先处理 ```html 围栏包裹的文档
  const fenceRe = /```(?:html)?\s*\n?([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(text)) !== null) {
    const candidate = match[1]
    if (isCompleteHtmlDoc(candidate)) {
      const start = match.index
      const end = start + match[0].length
      return {
        before: text.slice(0, start),
        // 去掉围栏内首尾的空行，与 extractHtmlCandidate 的围栏语义对齐
        html: candidate.trim(),
        after: text.slice(end),
      }
    }
  }
  // 无围栏：整体判定
  if (isCompleteHtmlDoc(text)) {
    return { before: '', html: text, after: '' }
  }
  return { before: '', html: null, after: '' }
}

/**
 * 最后一段非空 text 块的 index；没有则 -1。
 * 由调用方遍历 blocks 定位可检测的文本块（本文件只提供纯判定）。
 */
export function findLastTextBlockIndex(
  blocks: ReadonlyArray<{ type: string; content?: string }>,
): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type === 'text' && b.content?.trim()) return i
  }
  return -1
}