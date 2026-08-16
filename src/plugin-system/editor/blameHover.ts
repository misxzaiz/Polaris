/**
 * Git 悬停 Blame（CM6 hover tooltip）
 *
 * 鼠标悬停在任意行上时，显示该行最后一次提交的作者、时间、消息。
 * 数据源：gitEditorService#getBlameForLine（git_blame_file，60s 缓存）。
 * 通过 editorExtensionRegistry 注入。
 */

import { hoverTooltip } from '@codemirror/view'
import { getBlameForLine, type GitFileContext } from '@/services/gitEditorService'

export function gitBlameHoverExtension(getContext: () => GitFileContext) {
  return hoverTooltip(
    (view, pos) => {
      const ctx = getContext()
      if (!ctx.filePath || !ctx.workspacePath) return null

      const line = view.state.doc.lineAt(pos)
      const { filePath, workspacePath } = ctx

      // 预取 blame（承诺缓存：gitEditorService 已缓存 60s）
      void getBlameForLine(filePath, workspacePath, line.number)

      const dom = document.createElement('div')
      dom.className = 'git-blame-tooltip'
      const header = document.createElement('div')
      header.className = 'git-blame-loading'
      header.textContent = '加载 git 信息…'
      const body = document.createElement('div')
      body.className = 'git-blame-body'
      body.style.display = 'none'
      dom.appendChild(header)
      dom.appendChild(body)

      void getBlameForLine(filePath, workspacePath, line.number)
        .then((blame) => {
          if (!blame) {
            header.textContent = '无当前行的 git 提交信息'
            body.style.display = 'none'
            return
          }
          header.style.display = 'none'
          body.style.display = 'block'
          body.innerHTML = `
            <div class="git-blame-author">${escapeHtml(blame.author)}</div>
            <div class="git-blame-hash">${escapeHtml(blame.shortSha)} <span class="git-blame-sha-full">${escapeHtml(blame.commitSha)}</span></div>
            <div class="git-blame-date">${escapeHtml(formatDate(blame.timestamp))}</div>
            <div class="git-blame-summary">${escapeHtml(blame.summary ?? '')}</div>
          `
        })
        .catch(() => {
          header.textContent = '无法获取 git 信息'
        })

      return {
        pos: line.from,
        end: line.to,
        above: true,
        create: () => ({ dom }),
      }
    },
  )
}

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ))
}