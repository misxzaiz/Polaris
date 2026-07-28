/**
 * desktopClient — Pocket 连接桌面端后的 HTTP API 客户端
 *
 * HTTP invoke 直接复用主项目 @/services/transport/httpTransport 的 createHttpTransport。
 * 保留 Pocket 自己的类型定义和快捷 API 函数。
 */
import { getServerUrl } from './auth';

// ============================================================================
// 获取传输适配器（懒加载单例）
// ============================================================================

let transportPromise: ReturnType<typeof import('@/services/transport/httpTransport').createHttpTransport> | null = null;

async function getTransport() {
  if (!transportPromise) {
    const { createHttpTransport } = await import('@/services/transport/httpTransport');
    const url = getServerUrl().replace(/\/+$/, '');
    if (!url) throw new Error('未配置桌面端连接');
    transportPromise = createHttpTransport(url);
  }
  return transportPromise;
}

// ============================================================================
// 公开 API
// ============================================================================

export function isConfigured(): boolean {
  return !!getServerUrl();
}

/**
 * 通用 invoke — 委托给主项目 httpTransport 的 invoke
 */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const transport = await getTransport();
  return transport.invoke<T>(command, args);
}

// ============================================================================
// 类型定义
// ============================================================================

export interface SessionMeta {
  sessionId: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  engineId?: string;
  projectPath?: string;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  blocks?: Array<{ type: string; content: string }>;
}

export interface TodoItem {
  id: string;
  content: string;
  description?: string;
  status: string;
  priority: string;
  workspacePath?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  enabled: boolean;
  engineId: string;
  workDir?: string;
  cron?: string;
}

export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  lastAccessed?: string;
}

export interface Config {
  workspaces?: WorkspaceEntry[];
  currentWorkspaceId?: string;
}

// ============================================================================
// 快捷 API
// ============================================================================

export async function listSessions(engineId: string, page = 1, pageSize = 20): Promise<PagedResult<SessionMeta>> {
  return invoke<PagedResult<SessionMeta>>('list_sessions', { engineId, page, pageSize });
}

export async function getSessionHistory(sessionId: string): Promise<ChatMessage[]> {
  return invoke<ChatMessage[]>('get_session_history', { sessionId });
}

export async function continueChat(sessionId: string, message: string, options?: Record<string, unknown>): Promise<void> {
  return invoke('continue_chat', { sessionId, message, options });
}

export async function interruptChat(sessionId: string): Promise<void> {
  return invoke('interrupt_chat', { sessionId });
}

export async function answerQuestion(sessionId: string, callId: string, answer: { selected?: string[]; declined?: boolean }): Promise<void> {
  return invoke('answer_question', { sessionId, callId, answer });
}

export async function approvePlan(sessionId: string, planId: string): Promise<void> {
  return invoke('approve_plan', { sessionId, planId });
}

export async function rejectPlan(sessionId: string, planId: string): Promise<void> {
  return invoke('reject_plan', { sessionId, planId });
}

export async function listTodos(workspacePath?: string | null): Promise<TodoItem[]> {
  return invoke<TodoItem[]>('list_todos', { params: { scope: 'workspace', workspacePath: workspacePath || null } });
}

export async function completeTodo(id: string, workspacePath?: string | null): Promise<void> {
  return invoke('complete_todo', { id, workspacePath: workspacePath || null });
}

export async function listSchedulerTasks(workspacePath?: string | null): Promise<ScheduledTask[]> {
  return invoke<ScheduledTask[]>('scheduler_list_tasks', { workspacePath: workspacePath || null });
}

export async function runSchedulerTask(id: string, workspacePath?: string | null): Promise<void> {
  return invoke('scheduler_run_task', { id, workspacePath: workspacePath || null });
}

export async function getConfig(): Promise<Config> {
  return invoke<Config>('get_config');
}

export async function validateWorkspacePath(path: string): Promise<{ valid: boolean; error?: string }> {
  return invoke<{ valid: boolean; error?: string }>('validate_workspace_path', { path });
}