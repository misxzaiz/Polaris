/**
 * 定时任务相关 Tauri 命令
 * 包含：任务 CRUD、锁管理、模板、协议任务、协议模板、快捷片段
 */

import { invoke } from '@/services/transport';
import type { ScheduledTask, TriggerType, CreateTaskParams, TaskCategory, TaskMode, ProtocolTemplate, CreateProtocolTemplateParams } from '../../types/scheduler';
import type { PromptTemplate, CreateTemplateParams } from '../../types/scheduler';
import type { ProtocolDocuments } from '../../types/scheduler';
import type { PromptSnippet, CreateSnippetParams, UpdateSnippetParams } from '../../types/promptSnippet';

// ============================================================================
// 定时任务 CRUD 命令
// ============================================================================

/** 获取所有任务 */
export async function schedulerGetTasks(): Promise<ScheduledTask[]> {
  return invoke<ScheduledTask[]>('scheduler_list_tasks');
}

/** 获取单个任务 */
export async function schedulerGetTask(id: string): Promise<ScheduledTask | null> {
  return invoke<ScheduledTask | null>('scheduler_get_task', { id });
}

/** 创建任务 */
export async function schedulerCreateTask(params: CreateTaskParams): Promise<ScheduledTask> {
  return invoke<ScheduledTask>('scheduler_create_task', { params });
}

/** 更新任务 */
export async function schedulerUpdateTask(task: ScheduledTask): Promise<void> {
  return invoke('scheduler_update_task', { task });
}

/** 删除任务 */
export async function schedulerDeleteTask(id: string): Promise<void> {
  return invoke('scheduler_delete_task', { id });
}

/** 切换任务启用状态 */
export async function schedulerToggleTask(id: string, enabled: boolean): Promise<void> {
  return invoke('scheduler_toggle_task', { id, enabled });
}

/** 验证触发表达式 */
export async function schedulerValidateTrigger(
  triggerType: TriggerType,
  triggerValue: string
): Promise<number | null> {
  return invoke<number | null>('scheduler_validate_trigger', { triggerType, triggerValue });
}

/** 解析间隔表达式 */
export async function schedulerParseInterval(value: string): Promise<number | null> {
  return invoke<number | null>('scheduler_parse_interval', { value });
}

/** 按分类列出任务 */
export async function schedulerListTasksByCategory(category: TaskCategory): Promise<ScheduledTask[]> {
  return invoke<ScheduledTask[]>('scheduler_list_tasks_by_category', { category });
}

/** 按模式列出任务 */
export async function schedulerListTasksByMode(mode: TaskMode): Promise<ScheduledTask[]> {
  return invoke<ScheduledTask[]>('scheduler_list_tasks_by_mode', { mode });
}

/** 按分组列出任务 */
export async function schedulerListTasksByGroup(group: string): Promise<ScheduledTask[]> {
  return invoke<ScheduledTask[]>('scheduler_list_tasks_by_group', { group });
}

// ============================================================================
// 调度器锁相关命令
// ============================================================================

/** 锁状态 */
export interface LockStatus {
  /** 当前实例是否持有锁 */
  isHolder: boolean;
  /** 是否有其他实例持有锁 */
  isLockedByOther: boolean;
  /** 当前进程 PID */
  pid: number;
}

/** 调度器完整状态 */
export interface SchedulerStatus {
  /** 调度器是否正在运行 */
  isRunning: boolean;
  /** 当前实例是否持有锁 */
  isHolder: boolean;
  /** 是否有其他实例持有锁 */
  isLockedByOther: boolean;
  /** 当前进程 PID */
  pid: number;
  /** 状态消息 */
  message?: string;
}

/** 获取调度器锁状态 */
export async function schedulerGetLockStatus(): Promise<LockStatus> {
  return invoke<LockStatus>('scheduler_get_lock_status');
}

/** 尝试获取调度器锁 */
export async function schedulerAcquireLock(): Promise<boolean> {
  return invoke<boolean>('scheduler_acquire_lock');
}

/** 释放调度器锁 */
export async function schedulerReleaseLock(): Promise<void> {
  return invoke('scheduler_release_lock');
}

/** 获取调度器完整状态（锁 + 运行状态） */
export async function schedulerGetStatus(): Promise<SchedulerStatus> {
  return invoke<SchedulerStatus>('scheduler_get_status');
}

/** 启动调度器（获取锁 + 启动守护进程） */
export async function schedulerStart(): Promise<SchedulerStatus> {
  return invoke<SchedulerStatus>('scheduler_start');
}

/** 停止调度器（停止守护进程 + 释放锁） */
export async function schedulerStop(): Promise<SchedulerStatus> {
  return invoke<SchedulerStatus>('scheduler_stop');
}

/** 手动触发任务执行 */
export async function schedulerRunTask(id: string): Promise<ScheduledTask> {
  return invoke<ScheduledTask>('scheduler_run_task', { id });
}

/** 更新任务执行结果 */
export async function schedulerUpdateRunStatus(id: string, status: 'success' | 'failed'): Promise<ScheduledTask> {
  return invoke<ScheduledTask>('scheduler_update_run_status', { id, status });
}

// ============================================================================
// 模板相关命令
// ============================================================================

/** 列出所有模板 */
export async function schedulerListTemplates(): Promise<PromptTemplate[]> {
  return invoke<PromptTemplate[]>('scheduler_list_templates');
}

/** 获取单个模板 */
export async function schedulerGetTemplate(id: string): Promise<PromptTemplate | null> {
  return invoke<PromptTemplate | null>('scheduler_get_template', { id });
}

/** 创建模板 */
export async function schedulerCreateTemplate(params: CreateTemplateParams): Promise<PromptTemplate> {
  return invoke<PromptTemplate>('scheduler_create_template', { params });
}

/** 更新模板 */
export async function schedulerUpdateTemplate(template: PromptTemplate): Promise<PromptTemplate> {
  return invoke<PromptTemplate>('scheduler_update_template', { template });
}

/** 删除模板 */
export async function schedulerDeleteTemplate(id: string): Promise<void> {
  return invoke('scheduler_delete_template', { id });
}

/** 切换模板启用状态 */
export async function schedulerToggleTemplate(id: string, enabled: boolean): Promise<PromptTemplate> {
  return invoke<PromptTemplate>('scheduler_toggle_template', { id, enabled });
}

/** 构建提示词（应用模板） */
export async function schedulerBuildPrompt(
  templateId: string,
  taskName: string,
  userPrompt: string
): Promise<string> {
  return invoke<string>('scheduler_build_prompt', { templateId, taskName, userPrompt });
}

// ============================================================================
// 协议任务命令
// ============================================================================

/** 构建协议模式任务的完整 prompt
 *
 * 读取协议文档、用户补充、记忆文件，组合成完整的 prompt
 */
export async function schedulerBuildProtocolPrompt(
  taskPath: string,
  workDir: string
): Promise<string> {
  return invoke<string>('scheduler_build_protocol_prompt', { taskPath, workDir });
}

/** 读取协议任务文档 */
export async function schedulerReadProtocolDocuments(
  taskPath: string,
  workDir: string
): Promise<ProtocolDocuments> {
  return invoke<ProtocolDocuments>('scheduler_read_protocol_documents', { taskPath, workDir });
}

/** 更新协议文档 */
export async function schedulerUpdateProtocol(
  taskPath: string,
  workDir: string,
  content: string
): Promise<void> {
  return invoke('scheduler_update_protocol', { taskPath, workDir, content });
}

/** 更新用户补充 */
export async function schedulerUpdateSupplement(
  taskPath: string,
  workDir: string,
  content: string
): Promise<void> {
  return invoke('scheduler_update_supplement', { taskPath, workDir, content });
}

/** 更新记忆索引 */
export async function schedulerUpdateMemoryIndex(
  taskPath: string,
  workDir: string,
  content: string
): Promise<void> {
  return invoke('scheduler_update_memory_index', { taskPath, workDir, content });
}

/** 更新记忆任务 */
export async function schedulerUpdateMemoryTasks(
  taskPath: string,
  workDir: string,
  content: string
): Promise<void> {
  return invoke('scheduler_update_memory_tasks', { taskPath, workDir, content });
}

/** 清空用户补充 */
export async function schedulerClearSupplement(
  taskPath: string,
  workDir: string
): Promise<void> {
  return invoke('scheduler_clear_supplement', { taskPath, workDir });
}

/** 备份用户补充内容 */
export async function schedulerBackupSupplement(
  taskPath: string,
  workDir: string,
  content: string
): Promise<string> {
  return invoke<string>('scheduler_backup_supplement', { taskPath, workDir, content });
}

/** 备份协议文档 */
export async function schedulerBackupDocument(
  taskPath: string,
  workDir: string,
  docName: string,
  content: string,
  summary?: string
): Promise<string> {
  return invoke<string>('scheduler_backup_document', { taskPath, workDir, docName, content, summary });
}

/** 检查用户补充是否有内容 */
export function schedulerHasSupplementContent(content: string): boolean {
  // This is a synchronous command, but we use invoke for consistency
  return invoke<boolean>('scheduler_has_supplement_content', { content }) as unknown as boolean;
}

/** 检查文档是否需要备份 */
export function schedulerNeedsBackup(content: string): boolean {
  return invoke<boolean>('scheduler_needs_backup', { content }) as unknown as boolean;
}

/** 提取用户补充内容 */
export function schedulerExtractUserContent(content: string): string {
  return invoke<string>('scheduler_extract_user_content', { content }) as unknown as string;
}

// ============================================================================
// 协议模板命令
// ============================================================================

/** 列出所有协议模板（内置 + 自定义） */
export async function schedulerListProtocolTemplates(): Promise<ProtocolTemplate[]> {
  return invoke<ProtocolTemplate[]>('scheduler_list_protocol_templates');
}

/** 按分类列出协议模板 */
export async function schedulerListProtocolTemplatesByCategory(
  category: TaskCategory
): Promise<ProtocolTemplate[]> {
  return invoke<ProtocolTemplate[]>('scheduler_list_protocol_templates_by_category', { category });
}

/** 获取单个协议模板 */
export async function schedulerGetProtocolTemplate(id: string): Promise<ProtocolTemplate | null> {
  return invoke<ProtocolTemplate | null>('scheduler_get_protocol_template', { id });
}

/** 创建自定义协议模板 */
export async function schedulerCreateProtocolTemplate(
  params: CreateProtocolTemplateParams
): Promise<ProtocolTemplate> {
  return invoke<ProtocolTemplate>('scheduler_create_protocol_template', { params });
}

/** 更新自定义协议模板 */
export async function schedulerUpdateProtocolTemplate(
  id: string,
  params: CreateProtocolTemplateParams
): Promise<ProtocolTemplate | null> {
  return invoke<ProtocolTemplate | null>('scheduler_update_protocol_template', { id, params });
}

/** 删除自定义协议模板 */
export async function schedulerDeleteProtocolTemplate(id: string): Promise<boolean> {
  return invoke<boolean>('scheduler_delete_protocol_template', { id });
}

/** 切换协议模板启用状态 */
export async function schedulerToggleProtocolTemplate(
  id: string,
  enabled: boolean
): Promise<ProtocolTemplate | null> {
  return invoke<ProtocolTemplate | null>('scheduler_toggle_protocol_template', { id, enabled });
}

/** 使用模板生成协议文档 */
export async function schedulerRenderProtocolDocument(
  template: ProtocolTemplate,
  params: Record<string, string>
): Promise<string> {
  return invoke<string>('scheduler_render_protocol_document', { template, params });
}

// ============================================================================
// Prompt Snippet 快捷片段
// ============================================================================

/** 列出所有快捷片段 */
export async function snippetList(): Promise<PromptSnippet[]> {
  return invoke<PromptSnippet[]>('snippet_list');
}

/** 获取单个快捷片段 */
export async function snippetGet(id: string): Promise<PromptSnippet | null> {
  return invoke<PromptSnippet | null>('snippet_get', { id });
}

/** 创建快捷片段 */
export async function snippetCreate(params: CreateSnippetParams): Promise<PromptSnippet> {
  return invoke<PromptSnippet>('snippet_create', { params });
}

/** 更新快捷片段 */
export async function snippetUpdate(id: string, params: UpdateSnippetParams): Promise<PromptSnippet | null> {
  return invoke<PromptSnippet | null>('snippet_update', { id, params });
}

/** 删除快捷片段 */
export async function snippetDelete(id: string): Promise<boolean> {
  return invoke<boolean>('snippet_delete', { id });
}
