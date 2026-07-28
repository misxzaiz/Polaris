/**
 * desktopClient — Pocket 连接桌面端后的 HTTP API 客户端
 *
 * 参考 polaris-mobile src/services/transport/httpTransport.ts 的路由映射。
 * 读取 localStorage 中的 serverUrl 和 token，所有请求统一走 JSON fetch。
 */

import { getServerUrl, getTokenMd5 } from './auth';

// ============================================================================
// 路由映射
// ============================================================================

const COMMAND_ROUTE_MAP: Record<string, string> = {
  // Chat
  continue_chat: '/api/chat/send',
  interrupt_chat: '/api/chat/interrupt',
  get_session_history: '/api/chat/history',
  answer_question: '/api/chat/answer-question',
  approve_plan: '/api/chat/approve-plan',
  reject_plan: '/api/chat/reject-plan',
  // Sessions (paginated)
  list_sessions: '/api/sessions',
  // Settings
  get_config: '/api/settings',
  // Health
  health_check: '/api/health',
  // Todos
  list_todos: '/api/todos',
  complete_todo: '/api/todos',
  // Scheduler
  scheduler_list_tasks: '/api/scheduler/tasks',
  scheduler_run_task: '/api/scheduler/tasks',
  // Workspace
  validate_workspace_path: '/api/workspace/validate',
};

/** GET-only commands */
const GET_COMMANDS: ReadonlySet<string> = new Set([
  'get_config',
  'list_sessions',
  'health_check',
  'get_session_history',
  'list_todos',
  'scheduler_list_tasks',
]);

function commandToPath(command: string): string {
  const mapped = COMMAND_ROUTE_MAP[command];
  if (mapped) return mapped;
  // fallback: kebab-case
  return `/api/${command.replace(/_/g, '-')}`;
}

function getUrl(): string {
  return getServerUrl().replace(/\/+$/, '');
}

function getToken(): string {
  return getTokenMd5();
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// ============================================================================
// 公开 API
// ============================================================================

export function isConfigured(): boolean {
  return !!getUrl();
}

/**
 * 通用 invoke — 类似于 Tauri invoke 的 HTTP 版
 */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const baseUrl = getUrl();
  if (!baseUrl) {
    throw new Error('未配置桌面端连接');
  }

  const path = commandToPath(command);
  const isGet = GET_COMMANDS.has(command);

  let url = `${baseUrl}${path}`;
  let method = 'POST';
  let body: string | undefined;

  if (isGet) {
    method = 'GET';
    if (args && Object.keys(args).length > 0) {
      const params = new URLSearchParams();
      for (const [key, val] of Object.entries(args)) {
        if (val != null && val !== '') {
          params.set(key, String(val));
        }
      }
      const qs = params.toString();
      if (qs) url = `${url}?${qs}`;
    }
  } else if (command === 'get_session_history' && args?.sessionId) {
    method = 'GET';
    url = `${baseUrl}/api/chat/history/${encodeURIComponent(args.sessionId as string)}`;
  } else if (command === 'complete_todo' && args?.id) {
    // POST with id in body
    body = JSON.stringify({ id: args.id, workspacePath: args.workspacePath || null });
  } else if (command === 'scheduler_run_task' && args?.id) {
    body = JSON.stringify({ id: args.id, workspacePath: args.workspacePath || null });
  } else {
    body = JSON.stringify(args ?? {});
  }

  const res = await fetch(url, {
    method,
    headers: getHeaders(),
    body,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((errBody as { error?: string }).error || `API error: ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
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