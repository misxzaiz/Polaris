/**
 * Polaris 本地 agent slash 命令(P1-5)
 *
 * - `/agent <slug>` → 设为当前专家(写 sessionConfig.agent,L0 用户显式指定)
 * - `/agent`(无参)→ 清除当前专家
 * - `/dispatch <slug> <task>` → slug 命中专家时:
 *   把 slug 作为 role 传后端,后端 register_dispatch_task 读 corpus 人格 body
 *   注入 system prompt(不再依赖"模型自己去读文件")。prompt 只保留任务文本。
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
  /** 命中的专家 slug,作为 role 传后端(后端读 corpus 人格注入 system prompt) */
  slug: string;
  /** 纯任务文本(已剥离 slug 前缀) */
  prompt: string;
  title: string;
  /**
   * 自定义专家(项目级 .polaris/agents)的 system prompt body。
   * 非空时由前端经 appendSystemPrompt 注入;corpus 专家留空,由后端按 role 读 corpus 注入。
   */
  systemPrompt?: string;
}

/** 可派发专家条目:corpus catalog 或自定义专家 */
export interface DispatchableAgent {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  filePath?: string;
  /** 自定义专家的 system prompt(corpus 专家无此字段) */
  systemPrompt?: string;
}

/**
 * `/dispatch` 首 token 命中专家 slug 时,返回 slug + 纯任务文本。
 * - corpus 专家:返回 slug,后端读 corpus 人格 body 注入 system prompt
 * - 自定义专家:返回 systemPrompt,前端经 appendSystemPrompt 注入
 * 未命中返回 null(按原始 prompt 派发)。
 */
export function rewriteDispatchPromptWithAgent(
  prompt: string,
  catalog: DispatchableAgent[],
  _installDir: string | null,
): AgentDispatchRewrite | null {
  const spaceIdx = prompt.search(/\s/);
  const first = spaceIdx > 0 ? prompt.slice(0, spaceIdx) : prompt;
  const agent = catalog.find((a) => a.slug === first);
  if (!agent) return null;
  const task = spaceIdx > 0 ? prompt.slice(spaceIdx).trim() : '';
  if (!task) return null;

  return {
    slug: agent.slug,
    prompt: task,
    title: `${agent.emoji ? agent.emoji + ' ' : ''}${agent.name}`,
    systemPrompt: agent.systemPrompt,
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
