/**
 * cap.form — 表单能力（独立 capability，闭环「拉起 → 提交 → 回执」）
 *
 * 从 Polaris `form_flow.rs` 语义移植（sky 架构：一切是 cap，唯一入口 dispatch）。
 * 表单工具支持 = form_core 纯函数 + 独立 cap.form capability + 目标白名单。
 *
 * 动作：
 * - create  — AI 声明 fields/target/action，服务端校验 + 存 hold + WS 推 form 事件（供前端渲染）
 * - submit  — 客户端/前端提交 {formId, values, private?}，白名单纵深防御 → 原文转发目标 cap
 *             → buildReceipt 回执（AI 只见这份文本）。WS 推 form-answered。
 * - skip    — 用户主动跳过 / 超时跳过，回执不含字段值
 * - status  — 清理超时 form + 查询 hold 状态
 *
 * 信任边界：
 * - 字段原文只在服务端流转，AI 上下文只见 buildReceipt。
 * - 三态 read + secret 恒掩码 + hidden 掩码但转发（见 form_core）。
 * - 目标白名单默认拒绝、仅白名单放行（与全局权限默认放行相反，独立兜底）。
 * - private 提交：强制 read=none + 脱敏 exec，字段值与目标返回原文都不回喂 AI。
 */

import type { Capability, CallContext, Value } from '../../contracts.ts';
import {
  validateFields, expandDotPaths, normalizePayloadForTarget,
  buildReceipt, buildSkipReceipt, type FormField,
} from './form_core.ts';

/** 表单存活时长：超时后清理，迟到的提交被拒绝 */
export const FORM_WAIT_TIMEOUT_SECS = 600;

/** 目标能力白名单（安全兜底）：默认拒绝、仅白名单放行。
 *  数据/编辑域起步；管理面（cap.config 等）拒绝。放开即改这张表，不动架构。 */
export const FORM_TARGET_WHITELIST = [
  'cap.kv',
  'cap.edit',
  'cap.session',
  'cap.workspace',
  'cap.history',
  'cap.fs',
] as const;

export function targetAllowed(target: string): boolean {
  return (FORM_TARGET_WHITELIST as readonly string[]).includes(target.trim());
}

/** 表单元数据（formId 之外均由 create 动作声明，服务端存储） */
interface FormHold {
  formId: string;
  title: string;
  sessionId: string;
  target: string;
  action: string;
  read: 'full' | 'none' | string;
  fields: FormField[];
  mode: 'dispatch' | 'collect';
  createdAt: number; // epoch ms，用于超时清理
  /** AI 声明的样式（可选）——服务端不校验内容，前端按白名单键应用 */
  style?: Record<string, unknown>;
}

const formHolds = new Map<string, FormHold>();

export function createFormCap(): Capability {
  return {
    id: 'cap.form',
    description: 'Form capability. Actions: create (declare fields+target, hold a form), submit (submit {formId, values, private?}), skip (decline), status (cleanup/query). Read modes: full (AI sees values, secret masked) / none (AI sees field names only).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'submit', 'skip', 'status'] },
        // create
        formId: { type: 'string', description: 'Client-issued form id (create) or existing hold id (submit/skip)' },
        title: { type: 'string' },
        sessionId: { type: 'string' },
        target: { type: 'string', description: 'Dispatch target capability (dispatch mode; must be in whitelist)' },
        actionName: { type: 'string', description: 'Action to dispatch to target capability on submit' },
        read: { type: 'string', enum: ['full', 'none'], description: 'full (default): AI sees values, secret masked; none: AI sees field names only' },
        fields: { type: 'array', description: 'Field schema [{name, type, options?, hidden?, secret?, label?}]' },
        mode: { type: 'string', enum: ['dispatch', 'collect'], description: 'dispatch (default): forward values to target; collect: only collect params, no target needed' },
        style: { type: 'object', description: 'Optional UI style hints (not validated server-side)' },
        // submit
        values: { type: 'object', description: 'Field values to submit' },
        private: { type: 'boolean', description: 'Private submit: force read=none + sanitized exec, values never returned to AI' },
      },
      required: ['action'],
    },

    async invoke(params: Value, ctx: CallContext) {
      const p = (params ?? {}) as Record<string, unknown>;
      const action = p.action as string;

      switch (action) {
        default:
        case 'status': {
          const removed = cleanupExpired();
          const holds = [...formHolds.entries()].map(([id, h]) => ({
            formId: id, title: h.title, target: h.target, action: h.action,
            read: h.read, mode: h.mode,
          }));
          return { ok: true, removed, holds };
        }

        case 'create': {
          const fields = (p.fields as unknown) ?? [];
          // 校验 fields 的失败信息要能喂 AI
          const vErr = validateFields(fields);
          if (vErr) return { ok: false, error: `fields schema 非法：${vErr}` };

          const mode = p.mode === 'collect' ? 'collect' : 'dispatch';
          const target = (p.target as string) ?? '';
          if (mode === 'dispatch' && target.trim() === '') {
            return {
              ok: false,
              error: '缺少 target 参数（dispatch 模式需要声明 dispatch 目标 capability；若仅需收集参数不转发，请用 mode=collect）',
            };
          }
          const read = p.read === 'none' ? 'none' : 'full';
          const formId = (p.formId as string) || `form-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

          const hold: FormHold = {
            formId,
            title: (p.title as string) ?? '',
            sessionId: (p.sessionId as string) ?? '',
            target: target.trim(),
            action: (p.actionName as string) ?? '',
            read,
            fields: fields as FormField[],
            mode,
            createdAt: Date.now(),
            style: (p.style as Record<string, unknown>) ?? undefined,
          };
          formHolds.set(formId, hold);

          // 拉起提示页：通知前端/订阅者（新前端可据此渲染；无头下仅记录）
          ctx.emit({
            type: 'form',
            data: {
              formId, title: hold.title, sessionId: hold.sessionId,
              target: hold.target, action: hold.action, read: hold.read,
              mode: hold.mode, fields: hold.fields, style: hold.style,
            },
            ts: Date.now(),
          });

          return { ok: true, data: { formId, status: 'waiting', mode: hold.mode } };
        }

        case 'submit': {
          const formId = (p.formId as string) ?? '';
          const hold = formHolds.get(formId);
          if (!hold) {
            return { ok: false, error: `表单已失效，请让 AI 重新发起（formId=${formId}）` };
          }
          const privateSubmit = p.private === true;

          // collect 模式：仅收集参数，不做白名单校验（值经回执回喂 AI 自行处理）
          if (hold.mode === 'collect') {
            formHolds.delete(formId);
            const allowedRead = privateSubmit ? 'none' : hold.read;
            const receipt = buildReceipt(allowedRead, hold.fields, (p.values as Record<string, unknown>), { ok: true, data: { collected: true } }, privateSubmit);
            emitAnswered(ctx, formId, true, receipt);
            return { ok: true, data: { receipt } };
          }

          // dispatch 模式：白名单纵深防御（拉起可能被绕过，提交再兜底）
          if (!targetAllowed(hold.target)) {
            const receipt = `提交拒绝：目标能力 ${hold.target} 不在表单白名单（${FORM_TARGET_WHITELIST.join(' / ')}）`;
            emitAnswered(ctx, formId, false, receipt);
            return { ok: false, data: { receipt } };
          }

          // 原文转发目标 cap（敏感值只在这里流经，不进 AI 上下文）
          let payload = expandDotPaths(p.values ?? {});
          payload = normalizePayloadForTarget(hold.target, payload, hold.fields);
          if (hold.action) {
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
              (payload as Record<string, unknown>).action = hold.action;
            }
          }

          let execResult: { ok: boolean; data?: unknown; error?: string };
          try {
            const reply = await ctx.dispatch(hold.target, payload);
            if (reply.result.ok) execResult = { ok: true, data: reply.result.data };
            else execResult = { ok: false, error: reply.result.error };
          } catch (err) {
            execResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }

          formHolds.delete(formId);
          const allowedRead = privateSubmit ? 'none' : hold.read;
          const receipt = buildReceipt(allowedRead, hold.fields, (p.values as Record<string, unknown>), execResult, privateSubmit);
          const ok = execResult.ok;
          emitAnswered(ctx, formId, ok, receipt);
          return { ok, data: { receipt } };
        }

        case 'skip': {
          const formId = (p.formId as string) ?? '';
          const hold = formHolds.get(formId);
          if (!hold) {
            return { ok: false, error: `表单已失效，请让 AI 重新发起（formId=${formId}）` };
          }
          const reason = (p.reason as string) === 'timeout' ? 'timeout' : 'user';
          formHolds.delete(formId);
          const receipt = buildSkipReceipt(hold.target, hold.action, reason, FORM_WAIT_TIMEOUT_SECS);
          emitAnswered(ctx, formId, false, receipt, true);
          return { ok: true, data: { receipt, skipped: true } };
        }
      }
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function emitAnswered(
  ctx: CallContext,
  formId: string,
  ok: boolean,
  receipt: string,
  skipped = false,
): void {
  ctx.emit({
    type: skipped ? 'form-skipped' : 'form-answered',
    data: { formId, ok, receipt },
    ts: Date.now(),
  });
}

/** 清理超时表单；返回被移除数量。迟到的提交经 submit 分支拒绝（hold 不存在）。 */
function cleanupExpired(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, h] of formHolds) {
    if (now - h.createdAt > FORM_WAIT_TIMEOUT_SECS * 1000) {
      formHolds.delete(id);
      removed++;
    }
  }
  return removed;
}