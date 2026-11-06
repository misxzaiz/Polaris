/**
 * form 宿主桥注册模块（动态加载）
 *
 * 被 plugin-system/hostBridge.ensureFormHostRegistered() 动态 import，把表单
 * 回传薄封装挂到 window.__POLARIS_HOST_FORM__——插件卡片经 polaris-host/form
 * shim 消费（plugin-ui-contribution-spec [S-7]）。
 *
 * 信任边界纪律：本桥只是 cap.ai.chat 既有动作的透传封装——read 三态/secret
 * 掩码/回执脱敏全部由服务端 form_core 强制，桥内不做也不做任何"信任 AI 声明"
 * 的处理。提交/登记语义见 router/ai_chat_capability.rs form 动作族注释。
 */

import { aiChatDispatch } from './aiChatDispatch'

export interface FormHostBridge {
  /**
   * 登记自由组件的表单契约（AI 经 render_component marker 声明）。
   * 建立组件型 hold；之后用户的提交走 submitForm（现有 form_submit 动作）。
   */
  registerComponent: (decl: {
    sessionId: string
    componentId: string
    formId: string
    read: 'full' | 'none'
    secretKeys?: string[]
    title?: string
  }) => Promise<unknown>
  /** 提交组件表单（= 现有 form_submit；read 三态/掩码由服务端强制） */
  submitForm: (formId: string, values: unknown, opts?: { private?: boolean; read?: 'full' | 'none'; sessionId?: string }) => Promise<unknown>
  /** 跳过组件表单（= form_skip） */
  skipForm: (formId: string) => Promise<unknown>
  /** ask 问答应答（= answer_question；oneshot 一次性消费在服务端） */
  answerQuestion: (callId: string, answer: unknown) => Promise<unknown>
  /** 表单结构存为模板（= form_template_save；只存结构不存填写值） */
  saveFormTemplate: (formId: string, templateName?: string) => Promise<{ name?: string }>
}

export function registerFormHost(): void {
  const bridge: FormHostBridge = {
    registerComponent: (decl) =>
      aiChatDispatch({
        action: 'component_register',
        sessionId: decl.sessionId,
        componentId: decl.componentId,
        formId: decl.formId,
        read: decl.read,
        secretKeys: decl.secretKeys,
        title: decl.title,
      }),
    submitForm: (formId, values, opts) =>
      aiChatDispatch({
        action: 'form_submit',
        formId,
        values,
        ...(opts?.private != null ? { private: opts.private } : {}),
        ...(opts?.read != null ? { read: opts.read } : {}),
      }).then((res) => {
        // 组件回执回流（v2）：collect 模式的 reply 携带 receipt（form_flow.submit_form
        // collect 分支）。回执入队本会话，下次 sendMessage 经一次性系统提示带出——
        // 组件不是阻塞工具调用，AI 在下一轮看到提交结果（对齐派发报告回流惯例）。
        // 仅组件卡片走本桥（FormCard 直调 dispatch 不经此），天然不双注入。
        try {
          const r = res as { receipt?: unknown; collected?: unknown } | null
          const receipt = typeof r?.receipt === 'string' ? r.receipt : null
          if (receipt && opts?.sessionId) {
            enqueueComponentReceipt(opts.sessionId, receipt)
          }
        } catch {
          // 回流入队失败不阻断提交本身（回执仍随 form-answered 事件到卡片）
        }
        return res
      }),
    skipForm: (formId) => aiChatDispatch({ action: 'form_skip', formId }),
    answerQuestion: (callId, answer) =>
      aiChatDispatch({ action: 'answer_question', callId, answer }),
    saveFormTemplate: (formId, templateName) =>
      aiChatDispatch({
        action: 'form_template_save',
        formId,
        ...(templateName ? { templateName } : {}),
      }) as Promise<{ name?: string }>,
  }
  ;(window as unknown as Record<string, unknown>).__POLARIS_HOST_FORM__ = bridge
}

// ── 组件回执队列（会话级，sendMessage 时一次性消费注入） ────────────────────

const pendingComponentReceipts = new Map<string, string[]>()
const MAX_RECEIPTS_PER_SESSION = 8

/** 组件表单提交回执入队（form 桥提交成功后调用；spec [S-7] 回执已服务端脱敏） */
export function enqueueComponentReceipt(sessionId: string, receipt: string): void {
  const queue = pendingComponentReceipts.get(sessionId) ?? []
  queue.push(receipt)
  while (queue.length > MAX_RECEIPTS_PER_SESSION) queue.shift()
  pendingComponentReceipts.set(sessionId, queue)
}

/** 取走并清空某会话的组件回执（sendMessage 一次性注入；空数组=无） */
export function takeComponentReceipts(sessionId: string): string[] {
  const queue = pendingComponentReceipts.get(sessionId)
  pendingComponentReceipts.delete(sessionId)
  return queue ?? []
}

declare global {
  // eslint-disable-next-line no-var
  var __POLARIS_HOST_FORM__: FormHostBridge | undefined
}
