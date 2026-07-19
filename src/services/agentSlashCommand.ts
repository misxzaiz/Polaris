/**
 * Polaris 本地 agent slash 命令(P1-5)
 *
 * - `/agent <slug>` → 设为当前专家(写 sessionConfig.agent,L0 用户显式指定)
 * - `/agent`(无参)→ 清除当前专家
 * - `/dispatch <slug> <task>` → slug 命中 corpus 时改写派发 prompt:
 *   要求后台会话先读取全局 corpus 中该 agent 定义再执行任务
 *   (dispatch_task 是独立 Polaris 会话,无 agent 参数,经文件引用注入人格)
 */


export interface ParsedAgentCommand {
  /** 目标 slug;null = 清除当前专家 */
  slug: string | null;
}

/** 解析 `/agent [slug]`;非本命令返回 null */
export function parseAgentSlashCommand(text: string): ParsedAgentCommand | null {
  if (!text.startsWith('/agent')) return null;
  const rest = text.slice('/agent'.length);
  // 命令边界:避免误吞 /agents 等
  if (rest && !/^\s/.test(rest)) return null;
  const slug = rest.trim();
  return { slug: slug || null };
}

export interface AgentDispatchRewrite {
  prompt: string;
  title: string;
}

/** 可派发专家条目:corpus catalog 或自定义专家(filePath 直接指向定义文件) */
export interface DispatchableAgent {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  filePath?: string;
}

/**
 * `/dispatch` 首 token 命中专家 slug 时,改写派发 prompt(注入专家人格引用)。
 * 自定义专家用其 filePath;corpus 专家用 installDir/corpus/<slug>.md。
 * 未命中返回 null(按原始 prompt 派发)。
 */
export function rewriteDispatchPromptWithAgent(
  prompt: string,
  catalog: DispatchableAgent[],
  installDir: string | null,
): AgentDispatchRewrite | null {
  const spaceIdx = prompt.search(/\s/);
  const first = spaceIdx > 0 ? prompt.slice(0, spaceIdx) : prompt;
  const agent = catalog.find((a) => a.slug === first);
  if (!agent) return null;
  const task = spaceIdx > 0 ? prompt.slice(spaceIdx).trim() : '';
  if (!task) return null;

  const defRef =
    agent.filePath ??
    (installDir ? `${installDir.replace(/[\\/]+$/, '')}/corpus/${agent.slug}.md` : null);
  const persona = defRef
    ? `你将以专家「${agent.name}」的身份执行任务。开始前先读取该专家定义并遵循其中的人格、使命与规则:${defRef}`
    : `你将以专家「${agent.name}」(${agent.description})的身份执行任务。`;
  return {
    prompt: `${persona}\n\n任务:\n${task}`,
    title: `${agent.emoji ? agent.emoji + ' ' : ''}${agent.name}`,
  };
}

export interface ParsedNexusCommand {
  scenario: string;
  goal: string;
  /** sprint(默认) | micro(轻量小队,前 5 人) */
  mode?: 'micro';
}

export const NEXUS_SCENARIOS = [
  'startup-mvp',
  'enterprise-feature',
  'marketing-campaign',
  'incident-response',
] as const;

/** 解析 `/nexus <scenario> <goal>`;非本命令返回 null,参数不全返回 goal 为空串 */
export function parseNexusSlashCommand(text: string): ParsedNexusCommand | null {
  if (!text.startsWith('/nexus')) return null;
  const rest = text.slice('/nexus'.length);
  if (rest && !/^\s/.test(rest)) return null;
  let trimmed = rest.trim();
  let mode: 'micro' | undefined;
  if (trimmed === 'micro' || trimmed.startsWith('micro ')) {
    mode = 'micro';
    trimmed = trimmed.slice('micro'.length).trim();
  }
  const spaceIdx = trimmed.search(/\s/);
  const scenario = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
  const goal = spaceIdx > 0 ? trimmed.slice(spaceIdx).trim() : '';
  return mode ? { scenario, goal, mode } : { scenario, goal };
}
