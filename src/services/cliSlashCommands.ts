/**
 * Claude CLI 斜杠命令目录
 *
 * Polaris 以 `claude -p --input-format stream-json` 逐轮调用 CLI，
 * 用户消息首字符为 `/` 时会被 CLI 按斜杠命令解析（本地执行或展开为 prompt），
 * 且**永远不会作为普通文本到达模型**。
 *
 * 本目录基于 Claude Code CLI 2.1.205 实测维护（测试矩阵与事件形态见
 * docs/claude-slash-commands.md），分三级：
 * - suggest：出现在输入框 `/` 建议列表中（headless 下有意义且安全）
 * - known：不建议但放行（CLI 自行响应；同时用于把它们从动态建议中排除）
 * - blocked：发送前拦截（会破坏 Polaris 会话状态一致性）
 *
 * 动态部分：CLI 每轮 init 事件下发 slash_commands 全集（内置 + skill + 自定义命令），
 * 由 getCliCommandSuggestions 合并——目录之外且不属于已知 skill 的名字
 * （通常是 .claude/commands 自定义命令）以通用描述展示。
 */

export interface CliSlashCommandMeta {
  /** 命令名（不含 /） */
  name: string
  /** 别名（CLI 侧等价触发） */
  aliases?: string[]
  /** 参数语法提示（原样展示，不翻译） */
  argumentHint?: string
  /** 描述 i18n key 后缀（chat:cliCommand.desc.<descKey>） */
  descKey: string
}

/** 建议列表命令（实测 headless 可用且对 Polaris 用户有价值） */
export const CLI_SUGGESTED_COMMANDS: CliSlashCommandMeta[] = [
  { name: 'compact', argumentHint: '[instructions]', descKey: 'compact' },
  { name: 'context', descKey: 'context' },
  { name: 'usage', aliases: ['cost', 'stats'], descKey: 'usage' },
  { name: 'mcp', descKey: 'mcp' },
  { name: 'model', descKey: 'model' },
  { name: 'recap', descKey: 'recap' },
]

/**
 * 已知但不进建议列表的内置命令（CLI 自行响应，放行）。
 * 用途：从 init 动态清单中排除，避免以"自定义命令"身份混入建议。
 * - effort/model 带参：会被 Polaris 每轮透传的 --effort/--model 覆盖
 * - insights：LLM 生成报告，实测 ~145s
 * - heapdump：向桌面写快照文件
 * - fast：Agent SDK 模式不可用
 */
export const CLI_KNOWN_HIDDEN_COMMANDS: string[] = [
  'agents',
  'color',
  'config',
  'settings',
  'effort',
  'fast',
  'heapdump',
  'init',
  'insights',
  'reload-skills',
  'rename',
  'name',
  'review',
  'security-review',
  'doctor',
  'checkup',
  'goal',
  'team-onboarding',
]

/**
 * 发送前拦截的命令：/clear（及别名）在 CLI 侧新开对话，
 * 会导致 CLI 会话状态与 Polaris 界面历史脱钩（界面还在、上下文没了）。
 * 需要清空上下文时应使用 Polaris 的新建会话。
 */
export const CLI_BLOCKED_COMMANDS: string[] = ['clear', 'reset', 'new']

/** 输入框建议条目 */
export interface CliCommandSuggestion {
  /** 命令名（不含 /） */
  name: string
  /** 参数语法提示 */
  argumentHint?: string
  /** 描述 i18n key 后缀（chat:cliCommand.desc.<descKey>）；动态命令为 'custom' */
  descKey: string
  /** 是否来自 init 动态清单（自定义命令） */
  dynamic?: boolean
}

/** 动态建议数量上限（自定义命令可能很多，避免刷屏） */
const MAX_DYNAMIC_SUGGESTIONS = 6

/**
 * 解析消息文本命中的被拦截命令名；未命中返回 null。
 * 与 CLI 语义一致：仅当首字符为 `/` 时才是命令（前导空格则不是）。
 */
export function matchBlockedCliCommand(text: string): string | null {
  if (!text.startsWith('/')) return null
  const name = text.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? ''
  return CLI_BLOCKED_COMMANDS.includes(name) ? name : null
}

/**
 * 构建 CLI 命令建议列表。
 *
 * @param query 用户在 `/` 后输入的过滤词（小写）
 * @param dynamicNames CLI init 事件下发的 slash_commands 全集（可为空，此时仅返回静态目录）
 * @param excludeNames 需要排除的名字集合（如 skillStore 已单独建议的 skill id，避免双条目）
 */
export function getCliCommandSuggestions(
  query: string,
  dynamicNames: string[],
  excludeNames: Set<string>,
): CliCommandSuggestion[] {
  const q = query.toLowerCase()

  const matchMeta = (meta: CliSlashCommandMeta): boolean =>
    meta.name.includes(q) || (meta.aliases?.some((a) => a.includes(q)) ?? false)

  const curated: CliCommandSuggestion[] = CLI_SUGGESTED_COMMANDS.filter(matchMeta).map((meta) => ({
    name: meta.name,
    argumentHint: meta.argumentHint,
    descKey: meta.descKey,
  }))

  // 动态清单：排除静态目录（含别名/隐藏/拦截项）与调用方指定的排除集
  const knownNames = new Set<string>([
    ...CLI_SUGGESTED_COMMANDS.flatMap((m) => [m.name, ...(m.aliases ?? [])]),
    ...CLI_KNOWN_HIDDEN_COMMANDS,
    ...CLI_BLOCKED_COMMANDS,
  ])
  const dynamic: CliCommandSuggestion[] = dynamicNames
    .filter(
      (name) =>
        !name.startsWith('__') &&
        !knownNames.has(name) &&
        !excludeNames.has(name) &&
        name.toLowerCase().includes(q),
    )
    .slice(0, MAX_DYNAMIC_SUGGESTIONS)
    .map((name) => ({ name, descKey: 'custom', dynamic: true }))

  // 前缀命中优先，其余保持目录顺序
  const rank = (s: CliCommandSuggestion) => (s.name.toLowerCase().startsWith(q) ? 0 : 1)
  return [...curated, ...dynamic].sort((a, b) => rank(a) - rank(b))
}
