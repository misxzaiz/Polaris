/**
 * tauri.ts 单元测试
 *
 * 测试 Tauri IPC 服务层的核心功能：
 * - 配置相关命令
 * - 文件操作命令
 * - 上下文管理命令
 * - 定时任务命令
 * - 窗口控制命令
 * - 集成相关命令
 *
 * 注意：所有 IPC 调用通过 vi.mocked(invoke) 进行 mock。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

// 导入被测模块
import {
  // 配置相关
  getConfig,
  updateConfig,
  setWorkDir,
  setClaudeCmd,
  findClaudePaths,
  validateClaudePath,
  findIFlowPaths,
  validateIFlowPath,
  findCodexPaths,
  validateCodexPath,
  // Codex 会话
  listCodexSessions,
  getCodexSessionHistory,
  // 健康检查
  healthCheck,
  // 文件操作
  readDirectory,
  getFileContent,
  readFile,
  createFile,
  createDirectory,
  deleteFile,
  renameFile,
  pathExists,
  copyPath,
  movePath,
  // 工作区
  validateWorkspacePath,
  getDirectoryInfo,
  // 系统相关
  openInDefaultApp,
  // 导出相关
  saveChatToFile,
  // 窗口控制
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  // 上下文管理
  queryContext,
  upsertContext,
  upsertContextMany,
  getAllContext,
  removeContext,
  clearContext,
  // IDE 上报
  ideReportCurrentFile,
  ideReportFileStructure,
  ideReportDiagnostics,
  // 定时任务
  schedulerGetTasks,
  schedulerCreateTask,
  schedulerDeleteTask,
  schedulerRunTask,
  schedulerGetTaskLogs,
  // 集成相关
  startIntegration,
  stopIntegration,
  getIntegrationStatus,
  getAllIntegrationStatus,
  // 钉钉服务
  startDingTalkService,
  stopDingTalkService,
  sendDingTalkMessage,
  isDingTalkServiceRunning,
  getDingTalkServiceStatus,
  testDingTalkConnection,
  // 翻译
  baiduTranslate,
  // 废弃命令（向后兼容）
  startChat,
  continueChat,
  interruptChat,
  startIFlowChat,
  continueIFlowChat,
  interruptIFlowChat,
  startCodexChat,
  continueCodexChat,
  interruptCodexChat,
  // 类型导出
  type PathValidationResult,
  type ContextEntry,
  type ContextQueryRequest,
} from './tauri';
import type { Config, HealthStatus } from '../types';

// 获取 mock 函数
const mockInvoke = vi.mocked(invoke);
const mockOpenPath = vi.mocked(openPath);
const mockSave = vi.mocked(save);
const mockGetCurrentWindow = vi.mocked(getCurrentWindow);

// ============================================================
// 配置相关命令测试
// ============================================================
describe('配置相关命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getConfig', () => {
    it('应调用 get_config 命令并返回配置', async () => {
      const mockConfig: Config = {
        workDir: '/test/path',
        theme: 'dark',
        language: 'zh-CN',
      } as Config;
      mockInvoke.mockResolvedValueOnce(mockConfig);

      const result = await getConfig();

      expect(mockInvoke).toHaveBeenCalledWith('get_config');
      expect(result).toEqual(mockConfig);
    });
  });

  describe('updateConfig', () => {
    it('应调用 update_config 命令并传递配置', async () => {
      const mockConfig: Config = {
        workDir: '/test/path',
        theme: 'light',
      } as Config;
      mockInvoke.mockResolvedValueOnce(undefined);

      await updateConfig(mockConfig);

      expect(mockInvoke).toHaveBeenCalledWith('update_config', { config: mockConfig });
    });
  });

  describe('setWorkDir', () => {
    it('应调用 set_work_dir 命令并传递路径', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await setWorkDir('/new/path');

      expect(mockInvoke).toHaveBeenCalledWith('set_work_dir', { path: '/new/path' });
    });

    it('应支持 null 路径', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await setWorkDir(null);

      expect(mockInvoke).toHaveBeenCalledWith('set_work_dir', { path: null });
    });
  });

  describe('setClaudeCmd', () => {
    it('应调用 set_claude_cmd 命令', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await setClaudeCmd('/usr/local/bin/claude');

      expect(mockInvoke).toHaveBeenCalledWith('set_claude_cmd', { cmd: '/usr/local/bin/claude' });
    });
  });

  describe('findClaudePaths', () => {
    it('应返回可用路径列表', async () => {
      const mockPaths = ['/usr/local/bin/claude', '/home/user/.local/bin/claude'];
      mockInvoke.mockResolvedValueOnce(mockPaths);

      const result = await findClaudePaths();

      expect(mockInvoke).toHaveBeenCalledWith('find_claude_paths');
      expect(result).toEqual(mockPaths);
    });
  });

  describe('validateClaudePath', () => {
    it('应验证有效路径', async () => {
      const mockResult: PathValidationResult = {
        valid: true,
        version: '1.0.0',
      };
      mockInvoke.mockResolvedValueOnce(mockResult);

      const result = await validateClaudePath('/usr/local/bin/claude');

      expect(mockInvoke).toHaveBeenCalledWith('validate_claude_path', { path: '/usr/local/bin/claude' });
      expect(result.valid).toBe(true);
      expect(result.version).toBe('1.0.0');
    });

    it('应处理无效路径', async () => {
      const mockResult: PathValidationResult = {
        valid: false,
        error: 'File not found',
      };
      mockInvoke.mockResolvedValueOnce(mockResult);

      const result = await validateClaudePath('/invalid/path');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('File not found');
    });
  });

  describe('其他 CLI 路径查找', () => {
    it('findIFlowPaths 应调用正确命令', async () => {
      mockInvoke.mockResolvedValueOnce(['/path/to/iflow']);
      const result = await findIFlowPaths();
      expect(mockInvoke).toHaveBeenCalledWith('find_iflow_paths');
      expect(result).toEqual(['/path/to/iflow']);
    });

    it('validateIFlowPath 应调用正确命令', async () => {
      mockInvoke.mockResolvedValueOnce({ valid: true });
      await validateIFlowPath('/path/to/iflow');
      expect(mockInvoke).toHaveBeenCalledWith('validate_iflow_path', { path: '/path/to/iflow' });
    });

    it('findCodexPaths 应调用正确命令', async () => {
      mockInvoke.mockResolvedValueOnce(['/path/to/codex']);
      const result = await findCodexPaths();
      expect(mockInvoke).toHaveBeenCalledWith('find_codex_paths');
      expect(result).toEqual(['/path/to/codex']);
    });

    it('validateCodexPath 应调用正确命令', async () => {
      mockInvoke.mockResolvedValueOnce({ valid: true });
      await validateCodexPath('/path/to/codex');
      expect(mockInvoke).toHaveBeenCalledWith('validate_codex_path', { path: '/path/to/codex' });
    });
  });
});

// ============================================================
// 健康检查测试
// ============================================================
describe('健康检查', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应返回健康状态', async () => {
    const mockStatus: HealthStatus = {
      status: 'healthy',
      version: '1.0.0',
    } as HealthStatus;
    mockInvoke.mockResolvedValueOnce(mockStatus);

    const result = await healthCheck();

    expect(mockInvoke).toHaveBeenCalledWith('health_check');
    expect(result).toEqual(mockStatus);
  });
});

// ============================================================
// 文件操作命令测试
// ============================================================
describe('文件操作命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readDirectory', () => {
    it('应读取目录内容', async () => {
      const mockContent = { files: ['a.ts', 'b.ts'], directories: ['src'] };
      mockInvoke.mockResolvedValueOnce(mockContent);

      const result = await readDirectory('/test/path');

      expect(mockInvoke).toHaveBeenCalledWith('read_directory', { path: '/test/path' });
      expect(result).toEqual(mockContent);
    });
  });

  describe('getFileContent / readFile', () => {
    it('getFileContent 应读取文件内容', async () => {
      mockInvoke.mockResolvedValueOnce('file content');

      const result = await getFileContent('/test/file.ts');

      expect(mockInvoke).toHaveBeenCalledWith('get_file_content', { path: '/test/file.ts' });
      expect(result).toBe('file content');
    });

    it('readFile 应作为 getFileContent 的别名', async () => {
      mockInvoke.mockResolvedValueOnce('file content');

      const result = await readFile('/test/file.ts');

      expect(mockInvoke).toHaveBeenCalledWith('get_file_content', { path: '/test/file.ts' });
      expect(result).toBe('file content');
    });
  });

  describe('createFile', () => {
    it('应创建文件（无内容）', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await createFile('/test/new.ts');

      expect(mockInvoke).toHaveBeenCalledWith('create_file', { path: '/test/new.ts', content: undefined });
    });

    it('应创建文件（有内容）', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await createFile('/test/new.ts', 'initial content');

      expect(mockInvoke).toHaveBeenCalledWith('create_file', {
        path: '/test/new.ts',
        content: 'initial content',
      });
    });
  });

  describe('createDirectory', () => {
    it('应创建目录', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await createDirectory('/test/newdir');

      expect(mockInvoke).toHaveBeenCalledWith('create_directory', { path: '/test/newdir' });
    });
  });

  describe('deleteFile', () => {
    it('应删除文件', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await deleteFile('/test/file.ts');

      expect(mockInvoke).toHaveBeenCalledWith('delete_file', { path: '/test/file.ts' });
    });
  });

  describe('renameFile', () => {
    it('应重命名文件', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await renameFile('/test/old.ts', 'new.ts');

      expect(mockInvoke).toHaveBeenCalledWith('rename_file', {
        oldPath: '/test/old.ts',
        newName: 'new.ts',
      });
    });
  });

  describe('pathExists', () => {
    it('应检查路径存在', async () => {
      mockInvoke.mockResolvedValueOnce(true);

      const result = await pathExists('/test/path');

      expect(mockInvoke).toHaveBeenCalledWith('path_exists', { path: '/test/path' });
      expect(result).toBe(true);
    });
  });

  describe('copyPath', () => {
    it('应复制文件或目录', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await copyPath('/source', '/destination');

      expect(mockInvoke).toHaveBeenCalledWith('copy_path', {
        source: '/source',
        destination: '/destination',
      });
    });
  });

  describe('movePath', () => {
    it('应移动文件或目录', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await movePath('/source', '/destination');

      expect(mockInvoke).toHaveBeenCalledWith('move_path', {
        source: '/source',
        destination: '/destination',
      });
    });
  });
});

// ============================================================
// 工作区相关命令测试
// ============================================================
describe('工作区命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateWorkspacePath', () => {
    it('应验证工作区路径', async () => {
      mockInvoke.mockResolvedValueOnce(true);

      const result = await validateWorkspacePath('/workspace');

      expect(mockInvoke).toHaveBeenCalledWith('validate_workspace_path', { path: '/workspace' });
      expect(result).toBe(true);
    });
  });

  describe('getDirectoryInfo', () => {
    it('应获取目录信息', async () => {
      const mockInfo = { name: 'src', size: 1024 };
      mockInvoke.mockResolvedValueOnce(mockInfo);

      const result = await getDirectoryInfo('/workspace/src');

      expect(mockInvoke).toHaveBeenCalledWith('get_directory_info', { path: '/workspace/src' });
      expect(result).toEqual(mockInfo);
    });
  });
});

// ============================================================
// 系统相关命令测试
// ============================================================
describe('系统命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('openInDefaultApp', () => {
    it('应在默认应用中打开路径', async () => {
      await openInDefaultApp('/test/file.pdf');

      expect(mockOpenPath).toHaveBeenCalledWith('/test/file.pdf');
    });
  });
});

// ============================================================
// 导出相关命令测试
// ============================================================
describe('导出命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveChatToFile', () => {
    it('用户取消时应返回 null', async () => {
      mockSave.mockResolvedValueOnce(null);

      const result = await saveChatToFile('content', 'chat.md');

      expect(mockSave).toHaveBeenCalledWith({
        defaultPath: 'chat.md',
        filters: expect.arrayContaining([
          expect.objectContaining({ name: 'Markdown' }),
          expect.objectContaining({ name: 'JSON' }),
          expect.objectContaining({ name: 'Text' }),
        ]),
      });
      expect(result).toBeNull();
    });

    it('用户选择路径时应写入文件', async () => {
      mockSave.mockResolvedValueOnce('/saved/chat.md');
      mockInvoke.mockResolvedValueOnce(undefined);

      const result = await saveChatToFile('chat content', 'chat.md');

      expect(result).toBe('/saved/chat.md');
      expect(mockInvoke).toHaveBeenCalledWith('create_file', {
        path: '/saved/chat.md',
        content: 'chat content',
      });
    });
  });
});

// ============================================================
// 窗口控制命令测试
// ============================================================
describe('窗口控制命令', () => {
  let mockWindow: {
    minimize: ReturnType<typeof vi.fn>;
    maximize: ReturnType<typeof vi.fn>;
    unmaximize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isMaximized: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = {
      minimize: vi.fn(() => Promise.resolve()),
      maximize: vi.fn(() => Promise.resolve()),
      unmaximize: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      isMaximized: vi.fn(() => Promise.resolve(false)),
    };
    mockGetCurrentWindow.mockReturnValue(mockWindow as unknown as ReturnType<typeof getCurrentWindow>);
  });

  describe('minimizeWindow', () => {
    it('应最小化窗口', async () => {
      await minimizeWindow();

      expect(mockWindow.minimize).toHaveBeenCalled();
    });
  });

  describe('toggleMaximizeWindow', () => {
    it('窗口未最大化时应最大化', async () => {
      mockWindow.isMaximized.mockResolvedValueOnce(false);

      await toggleMaximizeWindow();

      expect(mockWindow.maximize).toHaveBeenCalled();
    });

    it('窗口已最大化时应还原', async () => {
      mockWindow.isMaximized.mockResolvedValueOnce(true);

      await toggleMaximizeWindow();

      expect(mockWindow.unmaximize).toHaveBeenCalled();
    });
  });

  describe('closeWindow', () => {
    it('应关闭窗口', async () => {
      await closeWindow();

      expect(mockWindow.close).toHaveBeenCalled();
    });
  });
});

// ============================================================
// 上下文管理命令测试
// ============================================================
describe('上下文管理命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('queryContext', () => {
    it('应查询上下文', async () => {
      const mockRequest: ContextQueryRequest = {
        max_tokens: 1000,
      };
      const mockResult = {
        entries: [],
        total_tokens: 0,
        summary: { file_count: 0, symbol_count: 0, workspace_ids: [], languages: [] },
      };
      mockInvoke.mockResolvedValueOnce(mockResult);

      const result = await queryContext(mockRequest);

      expect(mockInvoke).toHaveBeenCalledWith('context_query', { request: mockRequest });
      expect(result).toEqual(mockResult);
    });
  });

  describe('upsertContext', () => {
    it('应添加或更新上下文条目', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const entry: ContextEntry = {
        id: 'test-id',
        source: 'user_selection',
        type: 'file',
        priority: 1,
        content: { type: 'file', path: '/test.ts', content: 'test', language: 'typescript' },
        created_at: Date.now(),
        estimated_tokens: 10,
      };

      await upsertContext(entry);

      expect(mockInvoke).toHaveBeenCalledWith('context_upsert', { entry });
    });
  });

  describe('getAllContext', () => {
    it('应获取所有上下文', async () => {
      const mockEntries: ContextEntry[] = [];
      mockInvoke.mockResolvedValueOnce(mockEntries);

      const result = await getAllContext();

      expect(mockInvoke).toHaveBeenCalledWith('context_get_all');
      expect(result).toEqual(mockEntries);
    });
  });

  describe('removeContext', () => {
    it('应移除指定上下文', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await removeContext('entry-id');

      expect(mockInvoke).toHaveBeenCalledWith('context_remove', { id: 'entry-id' });
    });
  });

  describe('clearContext', () => {
    it('应清空所有上下文', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await clearContext();

      expect(mockInvoke).toHaveBeenCalledWith('context_clear');
    });
  });
});

// ============================================================
// 定时任务命令测试
// ============================================================
describe('定时任务命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('schedulerGetTasks', () => {
    it('应获取所有任务', async () => {
      const mockTasks = [{ id: '1', name: 'Test Task' }];
      mockInvoke.mockResolvedValueOnce(mockTasks);

      const result = await schedulerGetTasks();

      expect(mockInvoke).toHaveBeenCalledWith('scheduler_get_tasks');
      expect(result).toEqual(mockTasks);
    });
  });

  describe('schedulerCreateTask', () => {
    it('应创建任务', async () => {
      const mockTask = { id: 'new-id', name: 'New Task' };
      mockInvoke.mockResolvedValueOnce(mockTask);
      const params = {
        name: 'New Task',
        triggerType: 'interval' as const,
        triggerValue: '1h',
        engineId: 'claude',
        prompt: 'test',
        mode: 'chat' as const,
        runInTerminal: false,
        notifyOnComplete: false,
      };

      const result = await schedulerCreateTask(params);

      expect(mockInvoke).toHaveBeenCalledWith('scheduler_create_task', { params });
      expect(result).toEqual(mockTask);
    });
  });

  describe('schedulerDeleteTask', () => {
    it('应删除任务', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await schedulerDeleteTask('task-id');

      expect(mockInvoke).toHaveBeenCalledWith('scheduler_delete_task', { id: 'task-id' });
    });
  });

  describe('schedulerRunTask', () => {
    it('应立即执行任务', async () => {
      const mockResult = { success: true, output: 'done' };
      mockInvoke.mockResolvedValueOnce(mockResult);

      const result = await schedulerRunTask('task-id');

      expect(mockInvoke).toHaveBeenCalledWith('scheduler_run_task', { id: 'task-id' });
      expect(result).toEqual(mockResult);
    });
  });

  describe('schedulerGetTaskLogs', () => {
    it('应获取任务日志', async () => {
      const mockLogs = [{ id: '1', taskId: 'task-id' }];
      mockInvoke.mockResolvedValueOnce(mockLogs);

      const result = await schedulerGetTaskLogs('task-id');

      expect(mockInvoke).toHaveBeenCalledWith('scheduler_get_task_logs', { taskId: 'task-id' });
      expect(result).toEqual(mockLogs);
    });
  });
});

// ============================================================
// 集成相关命令测试
// ============================================================
describe('集成相关命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startIntegration', () => {
    it('应启动集成平台', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await startIntegration('dingtalk');

      expect(mockInvoke).toHaveBeenCalledWith('start_integration', { platform: 'dingtalk' });
    });
  });

  describe('stopIntegration', () => {
    it('应停止集成平台', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await stopIntegration('dingtalk');

      expect(mockInvoke).toHaveBeenCalledWith('stop_integration', { platform: 'dingtalk' });
    });
  });

  describe('getIntegrationStatus', () => {
    it('应获取单个平台状态', async () => {
      const mockStatus = { connected: true };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await getIntegrationStatus('dingtalk');

      expect(mockInvoke).toHaveBeenCalledWith('get_integration_status', { platform: 'dingtalk' });
      expect(result).toEqual(mockStatus);
    });
  });

  describe('getAllIntegrationStatus', () => {
    it('应获取所有平台状态', async () => {
      const mockStatuses = { dingtalk: { connected: true } };
      mockInvoke.mockResolvedValueOnce(mockStatuses);

      const result = await getAllIntegrationStatus();

      expect(mockInvoke).toHaveBeenCalledWith('get_all_integration_status');
      expect(result).toEqual(mockStatuses);
    });
  });
});

// ============================================================
// Codex 会话命令测试
// ============================================================
describe('Codex 会话命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listCodexSessions', () => {
    it('应列出 Codex 会话', async () => {
      const mockSessions = [
        { sessionId: '1', title: 'Session 1', messageCount: 5 },
      ];
      mockInvoke.mockResolvedValueOnce(mockSessions);

      const result = await listCodexSessions('/workspace');

      expect(mockInvoke).toHaveBeenCalledWith('list_codex_sessions', { workDir: '/workspace' });
      expect(result).toEqual(mockSessions);
    });

    it('应支持不传 workDir', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await listCodexSessions();

      expect(mockInvoke).toHaveBeenCalledWith('list_codex_sessions', { workDir: undefined });
    });
  });

  describe('getCodexSessionHistory', () => {
    it('应获取会话历史', async () => {
      const mockHistory = [
        { id: '1', timestamp: '2026-01-01', type: 'user', content: 'Hello' },
      ];
      mockInvoke.mockResolvedValueOnce(mockHistory);

      const result = await getCodexSessionHistory('/path/to/session.json');

      expect(mockInvoke).toHaveBeenCalledWith('get_codex_session_history', {
        filePath: '/path/to/session.json',
      });
      expect(result).toEqual(mockHistory);
    });
  });
});

// ============================================================
// 钉钉服务命令测试
// ============================================================
describe('钉钉服务命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startDingTalkService', () => {
    it('应启动钉钉服务', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await startDingTalkService();

      expect(mockInvoke).toHaveBeenCalledWith('start_dingtalk_service');
    });
  });

  describe('stopDingTalkService', () => {
    it('应停止钉钉服务', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await stopDingTalkService();

      expect(mockInvoke).toHaveBeenCalledWith('stop_dingtalk_service');
    });
  });

  describe('sendDingTalkMessage', () => {
    it('应发送钉钉消息', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await sendDingTalkMessage('test message', 'conv-123');

      expect(mockInvoke).toHaveBeenCalledWith('send_dingtalk_message', {
        content: 'test message',
        conversationId: 'conv-123',
      });
    });
  });

  describe('isDingTalkServiceRunning', () => {
    it('应检查服务是否运行', async () => {
      mockInvoke.mockResolvedValueOnce(true);

      const result = await isDingTalkServiceRunning();

      expect(mockInvoke).toHaveBeenCalledWith('is_dingtalk_service_running');
      expect(result).toBe(true);
    });
  });

  describe('getDingTalkServiceStatus', () => {
    it('应获取服务状态', async () => {
      const mockStatus = { isRunning: true, pid: 12345, port: 8080 };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await getDingTalkServiceStatus();

      expect(mockInvoke).toHaveBeenCalledWith('get_dingtalk_service_status');
      expect(result).toEqual(mockStatus);
    });
  });

  describe('testDingTalkConnection', () => {
    it('应测试钉钉连接', async () => {
      mockInvoke.mockResolvedValueOnce('success');

      const result = await testDingTalkConnection('test', 'conv-123');

      expect(mockInvoke).toHaveBeenCalledWith('test_dingtalk_connection', {
        testMessage: 'test',
        conversationId: 'conv-123',
      });
      expect(result).toBe('success');
    });
  });
});

// ============================================================
// 翻译命令测试
// ============================================================
describe('翻译命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('baiduTranslate', () => {
    it('应调用百度翻译', async () => {
      const mockResult = { success: true, result: '你好' };
      mockInvoke.mockResolvedValueOnce(mockResult);

      const result = await baiduTranslate('hello', 'appId', 'secretKey');

      expect(mockInvoke).toHaveBeenCalledWith('baidu_translate', {
        text: 'hello',
        appId: 'appId',
        secretKey: 'secretKey',
        to: undefined,
      });
      expect(result).toEqual(mockResult);
    });

    it('应支持指定目标语言', async () => {
      const mockResult = { success: true, result: '你好' };
      mockInvoke.mockResolvedValueOnce(mockResult);

      await baiduTranslate('hello', 'appId', 'secretKey', 'zh');

      expect(mockInvoke).toHaveBeenCalledWith('baidu_translate', {
        text: 'hello',
        appId: 'appId',
        secretKey: 'secretKey',
        to: 'zh',
      });
    });

    it('应处理翻译失败', async () => {
      const mockResult = { success: false, error: 'Network error' };
      mockInvoke.mockResolvedValueOnce(mockResult);

      const result = await baiduTranslate('hello', 'appId', 'secretKey');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });
});

// ============================================================
// IDE 上报命令测试
// ============================================================
describe('IDE 上报命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ideReportCurrentFile', () => {
    it('应上报当前文件', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await ideReportCurrentFile({
        workspace_id: 'ws-1',
        file_path: '/test.ts',
        content: 'const x = 1;',
        language: 'typescript',
        cursor_offset: 5,
      });

      expect(mockInvoke).toHaveBeenCalledWith('ide_report_current_file', {
        context: {
          workspace_id: 'ws-1',
          file_path: '/test.ts',
          content: 'const x = 1;',
          language: 'typescript',
          cursor_offset: 5,
        },
      });
    });
  });

  describe('ideReportFileStructure', () => {
    it('应上报文件结构', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await ideReportFileStructure({
        workspace_id: 'ws-1',
        file_path: '/test.ts',
        symbols: [{ name: 'MyClass', kind: 'class', location: { path: '/test.ts', line_start: 1, line_end: 10 } }],
      });

      expect(mockInvoke).toHaveBeenCalledWith('ide_report_file_structure', {
        structure: {
          workspace_id: 'ws-1',
          file_path: '/test.ts',
          symbols: [{ name: 'MyClass', kind: 'class', location: { path: '/test.ts', line_start: 1, line_end: 10 } }],
        },
      });
    });
  });

  describe('ideReportDiagnostics', () => {
    it('应上报诊断信息', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await ideReportDiagnostics({
        workspace_id: 'ws-1',
        file_path: '/test.ts',
        diagnostics: [{
          path: '/test.ts',
          severity: 'error',
          message: 'Unused variable',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        }],
      });

      expect(mockInvoke).toHaveBeenCalledWith('ide_report_diagnostics', {
        diagnostics: {
          workspace_id: 'ws-1',
          file_path: '/test.ts',
          diagnostics: [{
            path: '/test.ts',
            severity: 'error',
            message: 'Unused variable',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          }],
        },
      });
    });
  });
});

// ============================================================
// 上下文扩展命令测试
// ============================================================
describe('上下文扩展命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('upsertContextMany', () => {
    it('应批量添加上下文', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const entries: ContextEntry[] = [
        {
          id: '1',
          source: 'user_selection',
          type: 'file',
          priority: 1,
          content: { type: 'file', path: '/a.ts', content: 'a', language: 'ts' },
          created_at: Date.now(),
          estimated_tokens: 10,
        },
        {
          id: '2',
          source: 'user_selection',
          type: 'file',
          priority: 2,
          content: { type: 'file', path: '/b.ts', content: 'b', language: 'ts' },
          created_at: Date.now(),
          estimated_tokens: 10,
        },
      ];

      await upsertContextMany(entries);

      expect(mockInvoke).toHaveBeenCalledWith('context_upsert_many', { entries });
    });
  });
});

// ============================================================
// 废弃命令测试（确保向后兼容）
// ============================================================
describe('废弃命令（向后兼容）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Claude 聊天命令（废弃）', () => {
    it('startChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce('session-1');

      const result = await startChat('hello', '/workspace');

      expect(mockInvoke).toHaveBeenCalledWith('start_chat', { message: 'hello', workDir: '/workspace' });
      expect(result).toBe('session-1');
    });

    it('continueChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await continueChat('session-1', 'continue');

      expect(mockInvoke).toHaveBeenCalledWith('continue_chat', {
        sessionId: 'session-1',
        message: 'continue',
        workDir: undefined,
      });
    });

    it('interruptChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await interruptChat('session-1');

      expect(mockInvoke).toHaveBeenCalledWith('interrupt_chat', { sessionId: 'session-1' });
    });
  });

  describe('IFlow 聊天命令（废弃）', () => {
    it('startIFlowChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce('session-1');

      const result = await startIFlowChat('hello');

      expect(mockInvoke).toHaveBeenCalledWith('start_iflow_chat', { message: 'hello' });
      expect(result).toBe('session-1');
    });

    it('continueIFlowChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await continueIFlowChat('session-1', 'continue');

      expect(mockInvoke).toHaveBeenCalledWith('continue_iflow_chat', {
        sessionId: 'session-1',
        message: 'continue',
      });
    });

    it('interruptIFlowChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await interruptIFlowChat('session-1');

      expect(mockInvoke).toHaveBeenCalledWith('interrupt_iflow_chat', { sessionId: 'session-1' });
    });
  });

  describe('Codex 聊天命令（废弃）', () => {
    it('startCodexChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce('session-1');

      const result = await startCodexChat('hello');

      expect(mockInvoke).toHaveBeenCalledWith('start_codex_chat', { message: 'hello' });
      expect(result).toBe('session-1');
    });

    it('continueCodexChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await continueCodexChat('session-1', 'continue');

      expect(mockInvoke).toHaveBeenCalledWith('continue_codex_chat', {
        sessionId: 'session-1',
        message: 'continue',
      });
    });

    it('interruptCodexChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await interruptCodexChat('session-1');

      expect(mockInvoke).toHaveBeenCalledWith('interrupt_codex_chat', { sessionId: 'session-1' });
    });
  });
});
