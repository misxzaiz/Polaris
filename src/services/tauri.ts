/**
 * Tauri 命令服务包装器
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openPath } from '@tauri-apps/plugin-opener';
import { save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Config, HealthStatus } from '../types';
import type { PromptSnippet, CreateSnippetParams, UpdateSnippetParams } from '../types/promptSnippet';
import { createLogger } from '../utils/logger';

const log = createLogger('TauriService');

// 导出 invoke 和 listen 供其他模块使用
export { invoke, listen };

// ============================================================================
// 配置相关命令
// ============================================================================

/** 获取配置 */
export async function getConfig(): Promise<Config> {
  return invoke<Config>('get_config');
}

/** 更新配置 */
export async function updateConfig(config: Config): Promise<void> {
  return invoke('update_config', { config });
}

/** 设置工作目录 */
export async function setWorkDir(path: string | null): Promise<void> {
  return invoke('set_work_dir', { path });
}

/** 设置 Claude 命令路径 */
export async function setClaudeCmd(cmd: string): Promise<void> {
  return invoke('set_claude_cmd', { cmd });
}

/** 路径验证结果 */
export interface PathValidationResult {
  valid: boolean;
  error?: string;
  version?: string;
}

/** 查找所有可用的 Claude CLI 路径 */
export async function findClaudePaths(): Promise<string[]> {
  return invoke<string[]>('find_claude_paths');
}

/** 验证 Claude CLI 路径 */
export async function validateClaudePath(path: string): Promise<PathValidationResult> {
  return invoke<PathValidationResult>('validate_claude_path', { path });
}

// ============================================================================
// 健康检查命令
// ============================================================================

/** 健康检查 */
export async function healthCheck(): Promise<HealthStatus> {
  return invoke<HealthStatus>('health_check');
}

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

/**
 * 回答问题
 */
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

/**
 * 获取待回答问题列表
 */
export async function getPendingQuestions(sessionId?: string): Promise<PendingQuestion[]> {
  return invoke<PendingQuestion[]>('get_pending_questions', { sessionId });
}

/**
 * 清除已回答的问题
 */
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

/**
 * 注册待审批计划
 * @internal 内部使用，由事件处理器调用
 */
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

/**
 * 批准计划
 */
export async function approvePlan(
  sessionId: string,
  planId: string
): Promise<void> {
  return invoke('approve_plan', {
    sessionId,
    planId,
  });
}

/**
 * 拒绝计划
 */
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

/**
 * 获取待审批计划列表
 */
export async function getPendingPlans(sessionId?: string): Promise<PendingPlan[]> {
  return invoke<PendingPlan[]>('get_pending_plans', { sessionId });
}

/**
 * 清除已处理的计划
 */
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
// 工作区相关命令
// ============================================================================

/** 验证工作区路径 */
export async function validateWorkspacePath(path: string): Promise<boolean> {
  return invoke('validate_workspace_path', { path });
}

/** 获取目录信息 */
export async function getDirectoryInfo(path: string) {
  return invoke('get_directory_info', { path });
}

// ============================================================================
// 文件浏览器相关命令
// ============================================================================

/** 读取目录内容 */
export async function readDirectory(path: string) {
  return invoke('read_directory', { path });
}

/** 获取文件内容 */
export async function getFileContent(path: string): Promise<string> {
  return invoke('get_file_content', { path });
}

/** 读取文件内容（别名） */
export async function readFile(path: string): Promise<string> {
  return invoke('get_file_content', { path });
}

/** 创建文件 */
export async function createFile(path: string, content?: string) {
  return invoke('create_file', { path, content });
}

/** 创建目录 */
export async function createDirectory(path: string) {
  return invoke('create_directory', { path });
}

/** 删除文件或目录 */
export async function deleteFile(path: string) {
  return invoke('delete_file', { path });
}

/** 重命名文件或目录 */
export async function renameFile(oldPath: string, newName: string) {
  return invoke('rename_file', { oldPath, newName });
}

/** 检查路径是否存在 */
export async function pathExists(path: string) {
  return invoke('path_exists', { path });
}

/** 复制文件或目录 */
export async function copyPath(source: string, destination: string) {
  return invoke('copy_path', { source, destination });
}

/** 移动文件或目录 */
export async function movePath(source: string, destination: string) {
  return invoke('move_path', { source, destination });
}

// ============================================================================
// 文件内容搜索命令
// ============================================================================

/** 内容搜索结果 */
export interface ContentMatch {
  /** 文件名 */
  name: string;
  /** 相对路径 */
  relativePath: string;
  /** 完整路径 */
  fullPath: string;
  /** 匹配行号（1-based） */
  lineNumber: number;
  /** 匹配内容 */
  matchedLine: string;
  /** 匹配前的上下文行 */
  contextBefore: string[];
  /** 匹配后的上下文行 */
  contextAfter: string[];
  /** 匹配文本在行中的起始位置 */
  matchStart: number;
  /** 匹配文本在行中的结束位置 */
  matchEnd: number;
}

/**
 * 搜索文件内容
 * @param query 搜索关键词
 * @param workDir 工作目录
 * @param options 搜索选项
 * @param maxResults 最大结果数
 */
export async function searchFileContents(
  query: string,
  workDir: string | null,
  options?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
  },
  maxResults: number = 100
): Promise<ContentMatch[]> {
  if (!workDir || !query.trim()) {
    return [];
  }

  return invoke<ContentMatch[]>('search_file_contents', {
    workDir,
    query: query.trim(),
    caseSensitive: options?.caseSensitive ?? false,
    wholeWord: options?.wholeWord ?? false,
    maxResults,
  });
}

// ============================================================================
// 文件监听命令
// ============================================================================

/** 启动文件系统监听 */
export async function fsWatchStart(rootPath: string) {
  return invoke('fs_watch_start', { rootPath });
}

/** 停止文件系统监听 */
export async function fsWatchStop() {
  return invoke('fs_watch_stop');
}

/** 获取文件监听状态 */
export async function fsWatchStatus(): Promise<boolean> {
  return invoke('fs_watch_status');
}



// ============================================================================
// 系统相关命令
// ============================================================================

/** 在默认应用中打开文件（HTML 文件可在浏览器中打开） */
export async function openInDefaultApp(path: string): Promise<void> {
  await openPath(path);
}

// ============================================================================
// 上下文管理相关命令
// ============================================================================

/** 上下文来源类型 */
export type ContextSource = 'project' | 'workspace' | 'ide' | 'user_selection' | 'semantic_related' | 'history' | 'diagnostics';

/** 上下文类型 */
export type ContextType = 'file' | 'file_structure' | 'symbol' | 'selection' | 'diagnostics' | 'project_meta';

/** 上下文条目 */
export interface ContextEntry {
  id: string;
  source: ContextSource;
  type: ContextType;
  priority: number;
  content: ContextContent;
  workspace_id?: string;
  created_at: number;
  expires_at?: number;
  estimated_tokens: number;
}

/** 上下文内容 */
export type ContextContent =
  | { type: 'file'; path: string; content: string; language: string }
  | { type: 'file_structure'; path: string; symbols: ContextSymbol[]; summary?: string }
  | { type: 'symbol'; name: string; definition: ContextLocation; kind: SymbolKind; documentation?: string; signature?: string }
  | { type: 'selection'; path: string; range: ContextRange; content: string; context_lines?: number }
  | { type: 'diagnostics'; path?: string; items: ContextDiagnostic[]; summary?: ContextDiagnosticSummary }
  | { type: 'project_meta'; name: string; root_dir: string; project_type: string; languages: string[]; frameworks: string[] };

/** 符号类型 */
export type SymbolKind = 'class' | 'interface' | 'enum' | 'function' | 'method' | 'variable' | 'constant' | 'property';

/** 上下文符号 */
export interface ContextSymbol {
  name: string;
  kind: SymbolKind;
  location: ContextLocation;
  documentation?: string;
  children?: ContextSymbol[];
}

/** 上下文位置 */
export interface ContextLocation {
  path: string;
  line_start: number;
  line_end: number;
  column_start?: number;
  column_end?: number;
}

/** 上下文范围 */
export interface ContextRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** 上下文诊断 */
export interface ContextDiagnostic {
  path: string;
  severity: string;
  message: string;
  range: ContextRange;
  code?: string;
  source?: string;
}

/** 诊断摘要 */
export interface ContextDiagnosticSummary {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
}

/** 上下文查询请求 */
export interface ContextQueryRequest {
  workspace_id?: string;
  types?: ContextType[];
  sources?: ContextSource[];
  max_tokens?: number;
  min_priority?: number;
  current_file?: string;
  mentioned_files?: string[];
}

/** 上下文查询结果 */
export interface ContextQueryResult {
  entries: ContextEntry[];
  total_tokens: number;
  summary: ContextSummary;
}

/** 上下文摘要 */
export interface ContextSummary {
  file_count: number;
  symbol_count: number;
  workspace_ids: string[];
  languages: string[];
}

/** 查询上下文 */
export async function queryContext(request: ContextQueryRequest): Promise<ContextQueryResult> {
  return invoke('context_query', { request });
}

/** 添加或更新上下文 */
export async function upsertContext(entry: ContextEntry): Promise<void> {
  return invoke('context_upsert', { entry });
}

/** 批量添加或更新上下文 */
export async function upsertContextMany(entries: ContextEntry[]): Promise<void> {
  return invoke('context_upsert_many', { entries });
}

/** 获取所有上下文 */
export async function getAllContext(): Promise<ContextEntry[]> {
  return invoke('context_get_all');
}

/** 移除上下文 */
export async function removeContext(id: string): Promise<void> {
  return invoke('context_remove', { id });
}

/** 清空上下文 */
export async function clearContext(): Promise<void> {
  return invoke('context_clear');
}

/** IDE 上报当前文件 */
export async function ideReportCurrentFile(context: {
  workspace_id: string;
  file_path: string;
  content: string;
  language: string;
  cursor_offset: number;
}): Promise<void> {
  return invoke('ide_report_current_file', { context });
}

/** IDE 上报文件结构 */
export async function ideReportFileStructure(structure: {
  workspace_id: string;
  file_path: string;
  symbols: ContextSymbol[];
}): Promise<void> {
  return invoke('ide_report_file_structure', { structure });
}

/** IDE 上报诊断信息 */
export async function ideReportDiagnostics(diagnostics: {
  workspace_id: string;
  file_path: string;
  diagnostics: ContextDiagnostic[];
}): Promise<void> {
  return invoke('ide_report_diagnostics', { diagnostics });
}

// ============================================================================
// 导出相关命令
// ============================================================================

/** 保存对话到文件 */
export async function saveChatToFile(content: string, defaultFileName: string): Promise<string | null> {
  try {
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

// ============================================================================
// 翻译相关命令
// ============================================================================

/** 翻译结果 */
export interface TranslateResult {
  success: boolean;
  result?: string;
  error?: string;
}

/** 百度翻译 */
export async function baiduTranslate(
  text: string,
  appId: string,
  secretKey: string,
  to?: string
): Promise<TranslateResult> {
  return invoke<TranslateResult>('baidu_translate', { text, appId, secretKey, to });
}

// ============================================================================
// 窗口控制相关命令
// ============================================================================

/** 最小化窗口 */
export async function minimizeWindow(): Promise<void> {
  const window = getCurrentWindow();
  await window.minimize();
}

/** 最大化/还原窗口 */
export async function toggleMaximizeWindow(): Promise<void> {
  const window = getCurrentWindow();
  if (await window.isMaximized()) {
    await window.unmaximize();
  } else {
    await window.maximize();
  }
}

/** 关闭窗口 */
export async function closeWindow(): Promise<void> {
  const window = getCurrentWindow();
  await window.close();
}

// ============================================================================
// 钉钉相关命令
// ============================================================================

/** 启动钉钉服务 */
export async function startDingTalkService(): Promise<void> {
  return invoke('start_dingtalk_service');
}

/** 停止钉钉服务 */
export async function stopDingTalkService(): Promise<void> {
  return invoke('stop_dingtalk_service');
}

/** 发送钉钉消息 */
export async function sendDingTalkMessage(content: string, conversationId: string): Promise<void> {
  return invoke('send_dingtalk_message', { content, conversationId });
}

/** 检查钉钉服务是否运行 */
export async function isDingTalkServiceRunning(): Promise<boolean> {
  return invoke('is_dingtalk_service_running');
}

/** 获取钉钉服务状态 */
export async function getDingTalkServiceStatus(): Promise<{
  isRunning: boolean;
  pid?: number;
  port?: number;
  error?: string;
}> {
  return invoke('get_dingtalk_service_status');
}

/** 测试钉钉连接 */
export async function testDingTalkConnection(testMessage: string, conversationId: string): Promise<string> {
  return invoke('test_dingtalk_connection', { testMessage, conversationId });
}

// ============================================================================
// 集成相关命令
// ============================================================================

import type {
  Platform,
  IntegrationStatus,
  IntegrationMessage,
  IntegrationSession,
  SendTarget,
  MessageContent,
  QQBotConfig,
  FeishuConfig,
} from '../types';

/** 启动集成平台 */
export async function startIntegration(platform: Platform): Promise<void> {
  return invoke('start_integration', { platform });
}

/** 停止集成平台 */
export async function stopIntegration(platform: Platform): Promise<void> {
  return invoke('stop_integration', { platform });
}

/** 获取集成状态 */
export async function getIntegrationStatus(platform: Platform): Promise<IntegrationStatus | null> {
  return invoke<IntegrationStatus | null>('get_integration_status', { platform });
}

/** 获取所有集成状态 */
export async function getAllIntegrationStatus(): Promise<Record<string, IntegrationStatus>> {
  return invoke<Record<string, IntegrationStatus>>('get_all_integration_status');
}

/** 发送集成消息 */
export async function sendIntegrationMessage(
  platform: Platform,
  target: SendTarget,
  content: MessageContent
): Promise<void> {
  return invoke('send_integration_message', { platform, target, content });
}

/** 获取集成会话列表 */
export async function getIntegrationSessions(): Promise<IntegrationSession[]> {
  return invoke<IntegrationSession[]>('get_integration_sessions');
}

/** 初始化集成管理器 */
export async function initIntegration(qqbotConfig: QQBotConfig | null, feishuConfig: FeishuConfig | null): Promise<void> {
  return invoke('init_integration', { qqbotConfig, feishuConfig });
}

/** 监听集成消息事件 */
export async function onIntegrationMessage(
  callback: (message: IntegrationMessage) => void
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<IntegrationMessage>('integration:message', (event) => {
    callback(event.payload);
  });
}

// ==================== 实例管理 ====================

import type { PlatformInstance, InstanceId } from '../types';

/** 添加集成实例 */
export async function addIntegrationInstance(
  instance: PlatformInstance
): Promise<InstanceId> {
  return invoke<InstanceId>('add_integration_instance', { instance });
}

/** 移除集成实例 */
export async function removeIntegrationInstance(
  instanceId: InstanceId
): Promise<PlatformInstance | null> {
  return invoke<PlatformInstance | null>('remove_integration_instance', { instanceId });
}

/** 获取所有集成实例 */
export async function listIntegrationInstances(): Promise<PlatformInstance[]> {
  return invoke<PlatformInstance[]>('list_integration_instances');
}

/** 按平台获取实例列表 */
export async function listIntegrationInstancesByPlatform(
  platform: Platform
): Promise<PlatformInstance[]> {
  return invoke<PlatformInstance[]>('list_integration_instances_by_platform', { platform });
}

/** 获取当前激活的实例 */
export async function getActiveIntegrationInstance(
  platform: Platform
): Promise<PlatformInstance | null> {
  return invoke<PlatformInstance | null>('get_active_integration_instance', { platform });
}

/** 切换实例 */
export async function switchIntegrationInstance(
  instanceId: InstanceId
): Promise<void> {
  return invoke('switch_integration_instance', { instanceId });
}

/** 断开当前实例 */
export async function disconnectIntegrationInstance(
  platform: Platform
): Promise<void> {
  return invoke('disconnect_integration_instance', { platform });
}

/** 更新实例配置 */
export async function updateIntegrationInstance(
  instance: PlatformInstance
): Promise<void> {
  return invoke('update_integration_instance', { instance });
}

// ============================================================================
// 定时任务相关命令（精简版）
// ============================================================================

import type { ScheduledTask, TriggerType, CreateTaskParams, TaskCategory, TaskMode, ProtocolTemplate, CreateProtocolTemplateParams } from '../types/scheduler';

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

import type { PromptTemplate, CreateTemplateParams } from '../types/scheduler';

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

import type { ProtocolDocuments } from '../types/scheduler';

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

// ============ Protocol Template API ============

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

// ===== Prompt Snippet 快捷片段 =====

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

