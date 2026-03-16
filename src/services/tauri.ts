/**
 * Tauri 命令服务包装器
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openPath } from '@tauri-apps/plugin-opener';
import { save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Config, HealthStatus } from '../types';

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

/** 查找所有可用的 IFlow CLI 路径 */
export async function findIFlowPaths(): Promise<string[]> {
  return invoke<string[]>('find_iflow_paths');
}

/** 验证 IFlow CLI 路径 */
export async function validateIFlowPath(path: string): Promise<PathValidationResult> {
  return invoke<PathValidationResult>('validate_iflow_path', { path });
}

/** 查找所有可用的 Codex CLI 路径 */
export async function findCodexPaths(): Promise<string[]> {
  return invoke<string[]>('find_codex_paths');
}

/** 验证 Codex CLI 路径 */
export async function validateCodexPath(path: string): Promise<PathValidationResult> {
  return invoke<PathValidationResult>('validate_codex_path', { path });
}

/** Codex 会话元数据 */
export interface CodexSessionMeta {
  sessionId: string;
  title: string;
  messageCount: number;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
  filePath: string;
}

/** Codex 历史消息 */
export interface CodexHistoryMessage {
  id: string;
  timestamp: string;
  type: string;
  content: string;
}

/** 列出 Codex 会话 */
export async function listCodexSessions(workDir?: string): Promise<CodexSessionMeta[]> {
  return invoke<CodexSessionMeta[]>('list_codex_sessions', { workDir });
}

/** 获取 Codex 会话历史 */
export async function getCodexSessionHistory(filePath: string): Promise<CodexHistoryMessage[]> {
  return invoke<CodexHistoryMessage[]>('get_codex_session_history', { filePath });
}

// ============================================================================
// 健康检查命令
// ============================================================================

/** 健康检查 */
export async function healthCheck(): Promise<HealthStatus> {
  return invoke<HealthStatus>('health_check');
}

// ============================================================================
// 聊天相关命令
// ============================================================================

/**
 * 启动聊天会话
 * @deprecated 使用 eventChatStore.sendMessage 代替
 */
export async function startChat(message: string, workDir?: string): Promise<string> {
  return invoke<string>('start_chat', { message, workDir });
}

/**
 * 继续聊天会话
 * @deprecated 使用 eventChatStore.continueChat 代替
 */
export async function continueChat(sessionId: string, message: string, workDir?: string): Promise<void> {
  return invoke('continue_chat', { sessionId, message, workDir });
}

/**
 * 中断聊天
 * @deprecated 使用 eventChatStore.interruptChat 代替
 */
export async function interruptChat(sessionId: string): Promise<void> {
  return invoke('interrupt_chat', { sessionId });
}

// ============================================================================
// IFlow 聊天相关命令（废弃，使用统一聊天接口）
// ============================================================================

/**
 * @deprecated 使用 eventChatStore.sendMessage 并设置 engineId: 'iflow'
 */
export async function startIFlowChat(message: string): Promise<string> {
  return invoke<string>('start_iflow_chat', { message });
}

/**
 * @deprecated 使用 eventChatStore.continueChat 并设置 engineId: 'iflow'
 */
export async function continueIFlowChat(sessionId: string, message: string): Promise<void> {
  return invoke('continue_iflow_chat', { sessionId, message });
}

/**
 * @deprecated 使用 eventChatStore.interruptChat 代替
 */
export async function interruptIFlowChat(sessionId: string): Promise<void> {
  return invoke('interrupt_iflow_chat', { sessionId });
}

// ============================================================================
// Codex 聊天相关命令（废弃，使用统一聊天接口）
// ============================================================================

/**
 * @deprecated 使用 eventChatStore.sendMessage 并设置 engineId: 'codex'
 */
export async function startCodexChat(message: string): Promise<string> {
  return invoke<string>('start_codex_chat', { message });
}

/**
 * @deprecated 使用 eventChatStore.continueChat 并设置 engineId: 'codex'
 */
export async function continueCodexChat(sessionId: string, message: string): Promise<void> {
  return invoke('continue_codex_chat', { sessionId, message });
}

/**
 * @deprecated 使用 eventChatStore.interruptChat 代替
 */
export async function interruptCodexChat(sessionId: string): Promise<void> {
  return invoke('interrupt_codex_chat', { sessionId });
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
    console.error('保存文件失败:', e);
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
export async function initIntegration(qqbotConfig: QQBotConfig | null): Promise<void> {
  return invoke('init_integration', { qqbotConfig });
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
// 定时任务相关命令
// ============================================================================

import type { ScheduledTask, TaskLog, TriggerType, CreateTaskParams, LockStatus, RunTaskResult, PaginatedLogs } from '../types/scheduler';

/** 获取所有任务 */
export async function schedulerGetTasks(): Promise<ScheduledTask[]> {
  return invoke<ScheduledTask[]>('scheduler_get_tasks');
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

/** 立即执行任务 */
export async function schedulerRunTask(id: string): Promise<RunTaskResult> {
  return invoke<RunTaskResult>('scheduler_run_task', { id });
}

/** 立即执行任务（订阅模式 - 发送事件到前端窗口） */
export async function schedulerRunTaskWithWindow(
  id: string,
  contextId?: string
): Promise<RunTaskResult> {
  return invoke<RunTaskResult>('scheduler_run_task_with_window', { id, contextId });
}

/** 获取任务日志 */
export async function schedulerGetTaskLogs(taskId: string): Promise<TaskLog[]> {
  return invoke<TaskLog[]>('scheduler_get_task_logs', { taskId });
}

/** 获取所有日志 */
export async function schedulerGetAllLogs(limit?: number): Promise<TaskLog[]> {
  return invoke<TaskLog[]>('scheduler_get_all_logs', { limit });
}

/** 清理过期日志 */
export async function schedulerCleanupLogs(): Promise<void> {
  return invoke('scheduler_cleanup_logs');
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

/** 获取调度器锁状态 */
export async function schedulerGetLockStatus(): Promise<LockStatus> {
  return invoke<LockStatus>('scheduler_get_lock_status');
}

/** 启动调度器 */
export async function schedulerStart(): Promise<string> {
  return invoke<string>('scheduler_start');
}

/** 停止调度器 */
export async function schedulerStop(): Promise<string> {
  return invoke<string>('scheduler_stop');
}

/** 分页获取日志 */
export async function schedulerGetLogsPaginated(
  taskId?: string,
  page: number = 1,
  pageSize: number = 20
): Promise<PaginatedLogs> {
  return invoke<PaginatedLogs>('scheduler_get_logs_paginated', { taskId, page, pageSize });
}

/** 删除单条日志 */
export async function schedulerDeleteLog(logId: string): Promise<boolean> {
  return invoke<boolean>('scheduler_delete_log', { logId });
}

/** 批量删除日志 */
export async function schedulerDeleteLogs(logIds: string[]): Promise<number> {
  return invoke<number>('scheduler_delete_logs', { logIds });
}

/** 清理任务的所有日志 */
export async function schedulerClearTaskLogs(taskId: string): Promise<number> {
  return invoke<number>('scheduler_clear_task_logs', { taskId });
}

/** 协议文档类型 */
export type ProtocolFileType = 'task' | 'supplement' | 'memory_index' | 'memory_tasks';

/** 读取协议任务文档 */
export async function schedulerReadProtocolFile(
  workDir: string,
  taskPath: string,
  fileType: ProtocolFileType
): Promise<string> {
  return invoke<string>('scheduler_read_protocol_file', { workDir, taskPath, fileType });
}

/** 写入协议任务文档 */
export async function schedulerWriteProtocolFile(
  workDir: string,
  taskPath: string,
  fileType: ProtocolFileType,
  content: string
): Promise<void> {
  return invoke('scheduler_write_protocol_file', { workDir, taskPath, fileType, content });
}

/** 获取协议任务文档路径 */
export async function schedulerGetProtocolFilePath(
  workDir: string,
  taskPath: string,
  fileType: ProtocolFileType
): Promise<string> {
  return invoke<string>('scheduler_get_protocol_file_path', { workDir, taskPath, fileType });
}

/** 订阅任务（设置任务的 subscribedContextId） */
export async function schedulerSubscribeTask(
  id: string,
  contextId: string
): Promise<void> {
  return invoke('scheduler_subscribe_task', { id, contextId });
}

/** 取消订阅任务 */
export async function schedulerUnsubscribeTask(id: string): Promise<void> {
  return invoke('scheduler_unsubscribe_task', { id });
}
