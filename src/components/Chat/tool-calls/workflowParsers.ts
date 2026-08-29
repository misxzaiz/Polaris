/**
 * Workflow 输出解析器注册表
 *
 * workflow 工具(SDK 内置多 agent 编排)的 tool_result 按 schema 自协商:
 * - assaultParser: 命中攻坚格式(result.status=solved/open 或 logs 含 SURVIVOR/STATE_SNAPSHOT)
 * - genericParser: 命中通用 workflow(summary/agentCount/workflowProgress 任一)
 * - 全部失败 → 降级通用工具块
 *
 * 运行中数据限制:SDK CLI 模式下 log() 不实时到达前端(仅完成后一次性输出),
 * 故运行中靠 block.status(pending/running),完成后解析 output。
 */

/** Workflow 通用输出(非攻坚) */
export interface WorkflowGenericOutput {
  summary?: string;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  logs?: string[];
  /** 产物文件路径列表 */
  artifacts?: string[];
  /** 运行中 agent 进度(SDK 完成态可能也带) */
  workflowProgress?: Array<{
    type: string;
    label?: string;
    phaseTitle?: string;
    state?: string;
    tokens?: number;
    durationMs?: number;
    error?: string;
    resultPreview?: string;
  }>;
}

/** 解析后的 workflow 输出分类 */
export type ParsedWorkflowOutput =
  | { kind: 'assault' }       // 攻坚格式,走 AssaultResultCard
  | { kind: 'generic'; data: WorkflowGenericOutput }  // 通用 workflow
  | { kind: 'none' };        // 解析失败,降级工具块

/** 安全 JSON.parse,兼容嵌套字符串包裹(text/output 字段) */
function tryParseWorkflow(output?: string): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    const candidate =
      typeof parsed === 'string' ? JSON.parse(parsed) :
      typeof (parsed as Record<string, unknown>)?.text === 'string' ? JSON.parse((parsed as Record<string, unknown>).text as string) :
      typeof (parsed as Record<string, unknown>)?.output === 'string' ? JSON.parse((parsed as Record<string, unknown>).output as string) :
      parsed;
    return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 攻坚格式判定:result.status 为 solved/open,或 logs 含攻坚特征标记 */
function isAssaultFormat(obj: Record<string, unknown>): boolean {
  const result = obj.result as Record<string, unknown> | undefined;
  if (result?.status === 'solved' || result?.status === 'open') return true;
  const logs = Array.isArray(obj.logs) ? (obj.logs as string[]) : [];
  return logs.some((l) => /SURVIVOR:|STATE_SNAPSHOT|^family \S+ (blocked|解锁)/.test(l));
}

/** 通用 workflow 判定:有 summary/agentCount/workflowProgress/totalTokens 任一 */
function isGenericWorkflow(obj: Record<string, unknown>): boolean {
  if (typeof obj.summary === 'string' && obj.summary.trim()) return true;
  if (typeof obj.agentCount === 'number') return true;
  if (Array.isArray(obj.workflowProgress) && obj.workflowProgress.length > 0) return true;
  if (typeof obj.totalTokens === 'number') return true;
  // 有 logs 但非攻坚,也归类为通用
  if (Array.isArray(obj.logs) && (obj.logs as unknown[]).length > 0) return true;
  return false;
}

/** 提取通用 workflow 数据 */
function extractGeneric(obj: Record<string, unknown>): WorkflowGenericOutput {
  const logs = Array.isArray(obj.logs) ? (obj.logs as string[]) : undefined;
  // 从 logs 提取产物路径(匹配常见产物模式)
  const artifacts = logs
    ?.filter(l => /\.(md|json|txt|rs|ts|tsx|py|html|svg)$/i.test(l))
    .map(l => {
      const m = l.match(/([\w./\\-]+\.\w{1,5})\s*$/);
      return m ? m[1] : null;
    })
    .filter((x): x is string => !!x);
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    agentCount: typeof obj.agentCount === 'number' ? obj.agentCount : undefined,
    totalTokens: typeof obj.totalTokens === 'number' ? obj.totalTokens : undefined,
    totalToolCalls: typeof obj.totalToolCalls === 'number' ? obj.totalToolCalls : undefined,
    logs,
    artifacts: artifacts && artifacts.length > 0 ? artifacts : undefined,
    workflowProgress: Array.isArray(obj.workflowProgress)
      ? (obj.workflowProgress as WorkflowGenericOutput['workflowProgress'])
      : undefined,
  };
}

/** 主解析入口:自协商分类 */
export function parseWorkflowResult(output?: string): ParsedWorkflowOutput {
  const obj = tryParseWorkflow(output);
  if (!obj) return { kind: 'none' };
  if (isAssaultFormat(obj)) return { kind: 'assault' };
  if (isGenericWorkflow(obj)) return { kind: 'generic', data: extractGeneric(obj) };
  return { kind: 'none' };
}
