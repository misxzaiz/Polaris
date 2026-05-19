/**
 * commandRegistry — V2 命令面板的注册中心
 *
 * 角色:
 *   单例 registry, 任何模块通过 register() 注入命令,
 *   CommandPalette 通过 useCommands() / subscribe() 订阅渲染.
 *
 * 设计:
 *   - 命令分三类 (category): navigate / layout / action
 *   - 命令永远有 title (已 i18n) + perform; 其他字段可选
 *   - 注册返回 unregister 函数, 便于在 useEffect cleanup 中调用
 *   - 最近使用 5 个 id 维护于 recent 数组, 用于"最近使用"分组排序
 *
 * 模糊匹配:
 *   - matchScore(cmd, query) 返回 0-1 分数, 0=不匹配
 *   - 大小写无关, 多字段加权 (title > keywords > description)
 *   - 子串命中即可, 不引入额外依赖 (fuse.js 等)
 *
 * 解耦:
 *   - 此模块不依赖 React; 是纯 TS 类
 *   - hook 层在 src/hooks/useCommands.ts (本期一起提供)
 *   - 不持久化最近使用 (会话级即可, 重启重置)
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('CommandRegistry')

export type CommandCategory = 'navigate' | 'layout' | 'action'

export interface Command {
  /** 全局唯一 id, 建议形如 "git.commit" / "layout.preset.developer" */
  id: string
  /** 用户可见标题 (已 i18n) */
  title: string
  /** 类别, 用于分组渲染 */
  category: CommandCategory
  /** 副标 / 提示 */
  description?: string
  /** 图标 (lucide-react 名称, 或 emoji 字符串) */
  icon?: string
  /** 快捷键展示, 例如 ['⌘', 'K'] */
  shortcut?: string[]
  /** 额外匹配关键词 */
  keywords?: string[]
  /** 执行回调 */
  perform: () => void | Promise<void>
}

type Listener = () => void

class CommandRegistryImpl {
  private commands = new Map<string, Command>()
  private listeners = new Set<Listener>()
  private recent: string[] = []
  private static RECENT_MAX = 5

  /**
   * 注册命令. 同 id 重复注册会覆盖 (并打 warn 日志).
   * @returns unregister 函数, 调用以注销
   */
  register(cmd: Command): () => void {
    if (this.commands.has(cmd.id)) {
      log.warn('Command id already registered, overriding', { id: cmd.id })
    }
    this.commands.set(cmd.id, cmd)
    this.notify()
    return () => this.unregister(cmd.id)
  }

  /** 批量注册, 返回单个 unregister all 函数 */
  registerAll(cmds: Command[]): () => void {
    const unregisters = cmds.map((c) => this.register(c))
    return () => unregisters.forEach((u) => u())
  }

  unregister(id: string): void {
    if (this.commands.delete(id)) {
      this.recent = this.recent.filter((r) => r !== id)
      this.notify()
    }
  }

  list(): Command[] {
    return Array.from(this.commands.values())
  }

  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  /** 推送到 recent, 触发对应 perform */
  async execute(id: string): Promise<void> {
    const cmd = this.commands.get(id)
    if (!cmd) {
      log.warn('Command not found', { id })
      return
    }
    this.bumpRecent(id)
    // recent 顺序变化, 订阅者 (CommandPalette) 可能需要重排 → 通知
    this.notify()
    try {
      await cmd.perform()
    } catch (err) {
      log.error('Command perform failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      })
      // 重新抛出以便上层 (CommandPalette) 显示错误 toast
      throw err
    }
  }

  recentIds(): string[] {
    return [...this.recent]
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 仅供测试使用 */
  _clearForTest(): void {
    this.commands.clear()
    this.recent = []
    this.notify()
  }

  private bumpRecent(id: string): void {
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(
      0,
      CommandRegistryImpl.RECENT_MAX
    )
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }
}

/** 单例 registry */
export const commandRegistry = new CommandRegistryImpl()

// ============================================================
// 模糊匹配
// ============================================================

/**
 * 计算命令对查询字符串的匹配分数.
 * 返回 0 表示不匹配, > 0 表示匹配 (越大越匹配).
 *
 * 评分加权:
 *   - title 子串命中: +10 (开头命中再 +5)
 *   - keywords 元素子串命中: +6 (每个)
 *   - description 子串命中: +3
 *   - id 子串命中: +2
 *
 * 空 query 返回 1 (全部匹配, 用于不输入时的默认列表).
 */
export function matchScore(cmd: Command, query: string): number {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 1
  let score = 0
  const title = cmd.title.toLowerCase()
  if (title.includes(q)) {
    score += 10
    if (title.startsWith(q)) score += 5
  }
  if (cmd.keywords) {
    for (const k of cmd.keywords) {
      if (k.toLowerCase().includes(q)) score += 6
    }
  }
  if (cmd.description && cmd.description.toLowerCase().includes(q)) {
    score += 3
  }
  if (cmd.id.toLowerCase().includes(q)) {
    score += 2
  }
  return score
}

/**
 * 过滤 + 排序: 分数降序, 同分按 recent 优先.
 */
export function filterAndRank(
  commands: Command[],
  query: string,
  recentIds: string[]
): Command[] {
  const recentRank = new Map(recentIds.map((id, idx) => [id, recentIds.length - idx]))
  return commands
    .map((cmd) => ({ cmd, score: matchScore(cmd, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ra = recentRank.get(a.cmd.id) ?? 0
      const rb = recentRank.get(b.cmd.id) ?? 0
      return rb - ra
    })
    .map((x) => x.cmd)
}
