/**
 * form_core — 表单共享业务核（纯函数，可独立单测）
 *
 * 从 Polaris `form_core.rs` 移植（语义逐条对齐，TS 实现）。sky 无前端，
 * 表单信任边界与 Polaris 完全一致：
 * - 字段原文只在服务端流转，AI 上下文只见 `buildReceipt` 生成的文本。
 * - 三态 read 由服务端强制，不是提示词约束：
 *   - read = "full"（默认）：AI 可读全部字段值，secret 类型仍掩码
 *   - read = "none"：AI 只见字段名列表，值全部 `<已隐藏>`
 *   - secret 字段无论模式一律掩码
 * - `hidden=true` 字段（值不进入 AI 上下文，但仍参与转发）与 secret 互斥：
 *   secret 是「服务端掩码 + 前端密码框」，hidden 是「回执隐藏但值仍随 payload 转发」。
 */

// ============================================================================
// 类型
// ============================================================================

export type FormField = Record<string, unknown>;
export type ReadMode = 'full' | 'none';

// ============================================================================
// 校验 fields schema（纯函数，供拉起与单测复用）
// ============================================================================

/** 校验 fields schema。规则：非空数组 / 非空 name / select 带 options / 未知 type 容错 / hidden 与 secret 互斥 */
export function validateFields(fields: unknown): string | null {
  if (!Array.isArray(fields)) return 'fields 必须是数组';
  if (fields.length === 0) return 'fields 不能为空';
  for (let i = 0; i < fields.length; i++) {
    const f = (fields[i] ?? {}) as Record<string, unknown>;
    const name = (f.name ?? '') as string;
    if (typeof name === 'string' ? name.trim() === '' : true) {
      return `fields[${i}] 缺少 name`;
    }
    const ty = (f.type as string) || 'string';
    if (ty === 'select') {
      const hasOpts = Array.isArray(f.options) && f.options.length > 0;
      if (!hasOpts) return `fields[${i}] type=select 需要 options 数组`;
    }
    const isSecret = ty === 'secret' || f.secret === true;
    const isHidden = f.hidden === true;
    if (isSecret && isHidden) {
      return `fields[${i}] (name=${name}) hidden 与 secret 互斥：secret 值前端即不可见，hidden 用于「值可转发但 AI 不可读」`;
    }
  }
  return null;
}

/** 收集 hidden=true 字段的 name 列表（回执掩码用）。hidden 值仍随 payload 转发，但回执隐藏。 */
export function hiddenFieldNames(fields: FormField[]): string[] {
  return fields
    .filter((f) => f.hidden === true)
    .map((f) => (f.name as string) ?? '')
    .filter((n) => n.length > 0);
}

// ============================================================================
// 点路径展开：{"a.b":1,"a.c":2,"d":3} → {"a":{"b":1,"c":2},"d":3}
// ============================================================================

export function expandDotPaths(flat: unknown): unknown {
  if (typeof flat !== 'object' || flat === null || Array.isArray(flat)) return flat;
  const obj = flat as Record<string, unknown>;
  const root: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const segments = k.split('.').filter((s) => s.length > 0);
    if (segments.length <= 1) {
      root[k] = v;
      continue;
    }
    // 逐层深入，中途遇到非 object 就地建表
    let cur = root;
    for (const seg of segments.slice(0, -1)) {
      const existing = cur[seg];
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        cur = existing as Record<string, unknown>;
      } else {
        const next: Record<string, unknown> = {};
        cur[seg] = next;
        cur = next;
      }
    }
    cur[segments[segments.length - 1]] = v;
  }
  return root;
}

// ============================================================================
// 目标能力契约参数别名表（转发前把 AI 声明的自由字段名归一化到契约名）
// ============================================================================

/** 各目标能力的常见别名 → 契约参数名。首版覆盖 sky 数据/编辑域的表单目标。 */
const TARGET_PARAM_ALIASES: Record<string, Array<[string, string[]]>> = {
  // cap.edit 工作区文件编辑
  'cap.edit': [
    ['path', ['路径', '文件', 'file', 'p']],
    ['content', ['内容', '正文', '新内容', 'new']],
    ['old', ['旧内容', '原文', 'oldText', 'old_content']],
  ],
  // cap.kv 存储
  'cap.kv': [
    ['key', ['键', '主键', 'k']],
    ['value', ['值', 'value_', 'v']],
  ],
  // cap.session 会话管理
  'cap.session': [
    ['sessionId', ['会话', '会话id', 'session_id', 'sid']],
    ['title', ['标题', '会话名', '会话标题', 'name']],
  ],
  // cap.history 会话历史
  'cap.history': [
    ['sessionId', ['会话', 'session_id', 'sid']],
    ['message', ['消息', '消息内容', 'msg']],
  ],
};

/** 字段级 label→name 修正 + 按目标能力别名归一化。未命中别名的 key 原样保留。 */
export function normalizePayloadForTarget(
  target: string,
  payload: unknown,
  fields: FormField[],
): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  const obj = payload as Record<string, unknown>;

  // 1. 收集 label→name 映射（fields schema 声明的关系）
  const labelToName = new Map<string, string>();
  for (const f of fields) {
    const name = f.name as string | undefined;
    const label = f.label as string | undefined;
    if (name && label && name.trim() && label.trim() && label !== name) {
      labelToName.set(label, name);
    }
  }

  // 2) target 专属别名表
  const aliases = TARGET_PARAM_ALIASES[target.trim()] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    let normalized = labelToName.get(k);
    if (!normalized) {
      normalized = k;
      for (const [canonical, aliasList] of aliases) {
        if (aliasList.some((a) => a.toLowerCase() === k.trim().toLowerCase())) {
          normalized = canonical;
          break;
        }
      }
    }
    out[normalized ?? k] = v;
  }
  return out;
}

// ============================================================================
// 回执生成（信任边界 — AI 只见这份文本）
// ============================================================================

/** 生成回执。`sanitizeExec=true`（用户私密提交）时脱敏执行结果，不透出字段原文/目标返回。 */
export function buildReceipt(
  readMode: ReadMode | string,
  fields: FormField[],
  values: Record<string, unknown> | undefined | null,
  execResult: { ok: boolean; data?: unknown; error?: string },
  sanitizeExec = false,
): string {
  const secretNames = fields
    .filter((f) => (f.type as string) === 'secret' || f.secret === true)
    .map((f) => f.name as string);
  const hiddenNames = hiddenFieldNames(fields);

  const execLine = sanitizeExec
    ? (execResult.ok ? '执行结果: 成功' : '执行失败: 目标能力拒绝或内部错误（详情已隐藏）')
    : (execResult.ok
        ? `执行结果: ${JSON.stringify(execResult.data, null, 0)}`
        : `执行失败: ${execResult.error ?? 'unknown error'}`);

  const lines: string[] = [];
  if (readMode === 'none') {
    lines.push('用户已提交表单（隐私模式：AI 不可读取字段值）');
    for (const f of fields) {
      const name = f.name as string | undefined;
      if (name) lines.push(`- ${name}: <已隐藏>`);
    }
  } else {
    lines.push('用户已提交表单');
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        if (secretNames.some((s) => k.includes(s))) {
          lines.push(`- ${k}: <secret 已掩码>`);
        } else if (hiddenNames.some((s) => k.includes(s))) {
          lines.push(`- ${k}: <已隐藏>`);
        } else {
          lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
      }
    }
  }
  lines.push(execLine);
  return lines.join('\n');
}

/** 跳过回执（用户跳过 / 超时）。信任边界与 buildReceipt 一致：不携带任何字段值。 */
export function buildSkipReceipt(target: string, action: string, reason: string, timeoutSecs: number): string {
  const reasonText = reason === 'timeout'
    ? `用户未在 ${timeoutSecs}s 内提交，表单已超时自动跳过`
    : '用户跳过了该表单';
  const lines = [reasonText, `目标: ${target}`];
  if (action) lines.push(`动作: ${action}`);
  lines.push('未提交任何字段值');
  return lines.join('\n');
}