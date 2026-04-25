/**
 * 对话交互相关 Tauri 命令
 * 包含：AskUserQuestion、PlanMode、stdin 输入、对话导出
 */

import { invoke } from '@/services/transport';
import { createLogger } from '../../utils/logger';

const log = createLogger('ChatService');

// Lazy-load Tauri dialog plugin
const isTauriEnv = typeof window !== 'undefined' && '__TAURI__' in window;

// ============================================================================
// AskUserQuestion 相关命令
// ============================================================================

/** 问题选项 */
export interface QuestionOption {
  value: string;
  label?: string;
}

/** 问题状态 */
export type QuestionStatus = 'pending' | 'answered';

/** 待回答问题 */
export interface PendingQuestion {
  callId: string;
  sessionId: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
  allowCustomInput: boolean;
  status: QuestionStatus;
}

/** 问题答案 */
export interface QuestionAnswer {
  selected: string[];
  customInput?: string;
}

/**
 * 注册待回答问题
 * @internal 内部使用，由事件处理器调用
 */
export async function registerPendingQuestion(
  sessionId: string,
  callId: string,
  header: string,
  multiSelect: boolean,
  options: QuestionOption[],
  allowCustomInput: boolean
): Promise<void> {
  return invoke('register_pending_question', {
    sessionId,
    callId,
    header,
    multiSelect,
    options,
    allowCustomInput,
  });
}

/** 回答问题 */
export async function answerQuestion(
  sessionId: string,
  callId: string,
  answer: QuestionAnswer
): Promise<void> {
  return invoke('answer_question', {
    sessionId,
    callId,
    answer,
  });
}

/** 获取待回答问题列表 */
export async function getPendingQuestions(sessionId?: string): Promise<PendingQuestion[]> {
  return invoke<PendingQuestion[]>('get_pending_questions', { sessionId });
}

/** 清除已回答的问题 */
export async function clearAnsweredQuestions(): Promise<number> {
  return invoke<number>('clear_answered_questions');
}

// ============================================================================
// PlanMode 相关命令
// ============================================================================

/** 计划审批状态 */
export type PlanApprovalStatus = 'pending' | 'approved' | 'rejected';

/** 待审批计划 */
export interface PendingPlan {
  planId: string;
  sessionId: string;
  title?: string;
  description?: string;
  status: PlanApprovalStatus;
  feedback?: string;
}

/** 注册待审批计划 */
export async function registerPendingPlan(
  sessionId: string,
  planId: string,
  title?: string,
  description?: string
): Promise<void> {
  return invoke('register_pending_plan', {
    sessionId,
    planId,
    title,
    description,
  });
}

/** 批准计划 */
export async function approvePlan(
  sessionId: string,
  planId: string
): Promise<void> {
  return invoke('approve_plan', {
    sessionId,
    planId,
  });
}

/** 拒绝计划 */
export async function rejectPlan(
  sessionId: string,
  planId: string,
  feedback?: string
): Promise<void> {
  return invoke('reject_plan', {
    sessionId,
    planId,
    feedback,
  });
}

/** 获取待审批计划列表 */
export async function getPendingPlans(sessionId?: string): Promise<PendingPlan[]> {
  return invoke<PendingPlan[]>('get_pending_plans', { sessionId });
}

/** 清除已处理的计划 */
export async function clearProcessedPlans(): Promise<number> {
  return invoke<number>('clear_processed_plans');
}

// ============================================================================
// stdin 输入相关命令
// ============================================================================

/**
 * 向会话发送输入
 *
 * 通过 stdin 向运行中的会话发送输入数据
 * @param sessionId 会话 ID
 * @param input 输入内容
 * @returns 是否发送成功
 */
export async function sendInput(
  sessionId: string,
  input: string
): Promise<boolean> {
  return invoke<boolean>('send_input', { sessionId, input });
}

// ============================================================================
// 导出相关命令
// ============================================================================

/** 保存对话到文件 */
export async function saveChatToFile(content: string, defaultFileName: string): Promise<string | null> {
  try {
    if (!isTauriEnv) {
      // Web fallback: use browser download
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultFileName;
      a.click();
      URL.revokeObjectURL(url);
      return defaultFileName;
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      defaultPath: defaultFileName,
      filters: [
        {
          name: 'Markdown',
          extensions: ['md']
        },
        {
          name: 'JSON',
          extensions: ['json']
        },
        {
          name: 'Text',
          extensions: ['txt']
        }
      ]
    });

    if (filePath) {
      // 写入文件内容，使用已有的 create_file 命令
      await invoke('create_file', { path: filePath, content });
      return filePath;
    }
    return null;
  } catch (e) {
    log.error('保存文件失败:', e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
}
