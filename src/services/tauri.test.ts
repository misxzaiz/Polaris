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

      expect(mockInvoke).toHaveBeenCalledWith('start_chat', { message: 'hello', options: { workDir: '/workspace' } });
      expect(result).toBe('session-1');
    });

    it('continueChat 应正常调用', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await continueChat('session-1', 'continue');

      expect(mockInvoke).toHaveBeenCalledWith('continue_chat', {
        sessionId: 'session-1',
        message: 'continue',
        options: { workDir: undefined },
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

// ============================================================
// 错误处理场景测试
// ============================================================
describe('错误处理场景', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('IPC 调用错误', () => {
    it('getConfig 应拒绝并传递错误', async () => {
      const error = new Error('Config not found');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(getConfig()).rejects.toThrow('Config not found');
    });

    it('updateConfig 应拒绝并传递错误', async () => {
      const error = new Error('Failed to save config');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(updateConfig({} as Config)).rejects.toThrow('Failed to save config');
    });

    it('findClaudePaths 应拒绝并传递错误', async () => {
      const error = new Error('Search failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(findClaudePaths()).rejects.toThrow('Search failed');
    });

    it('validateClaudePath 应拒绝并传递错误', async () => {
      const error = new Error('Validation error');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(validateClaudePath('/invalid')).rejects.toThrow('Validation error');
    });

    it('healthCheck 应拒绝并传递错误', async () => {
      const error = new Error('Health check failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(healthCheck()).rejects.toThrow('Health check failed');
    });

    it('readDirectory 应拒绝并传递错误', async () => {
      const error = new Error('Permission denied');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(readDirectory('/protected')).rejects.toThrow('Permission denied');
    });

    it('getFileContent 应拒绝并传递错误', async () => {
      const error = new Error('File not found');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(getFileContent('/missing.txt')).rejects.toThrow('File not found');
    });

    it('createFile 应拒绝并传递错误', async () => {
      const error = new Error('Disk full');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(createFile('/new.txt', 'content')).rejects.toThrow('Disk full');
    });

    it('deleteFile 应拒绝并传递错误', async () => {
      const error = new Error('File in use');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(deleteFile('/locked.txt')).rejects.toThrow('File in use');
    });

    it('schedulerCreateTask 应拒绝并传递错误', async () => {
      const error = new Error('Invalid trigger');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(schedulerCreateTask({
        name: 'Test',
        triggerType: 'interval',
        triggerValue: 'invalid',
        engineId: 'claude',
        prompt: 'test',
        mode: 'chat',
        runInTerminal: false,
        notifyOnComplete: false,
      })).rejects.toThrow('Invalid trigger');
    });

    it('startIntegration 应拒绝并传递错误', async () => {
      const error = new Error('Connection failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(startIntegration('dingtalk')).rejects.toThrow('Connection failed');
    });
  });

  describe('saveChatToFile 错误处理', () => {
    it('用户取消选择时应返回 null', async () => {
      mockSave.mockResolvedValueOnce(null);

      const result = await saveChatToFile('content', 'chat.md');

      expect(result).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('文件写入失败时应抛出错误', async () => {
      mockSave.mockResolvedValueOnce('/saved/chat.md');
      const error = new Error('Write failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(saveChatToFile('content', 'chat.md')).rejects.toThrow('Write failed');
    });

    it('保存对话框失败时应抛出错误', async () => {
      const error = new Error('Dialog error');
      mockSave.mockRejectedValueOnce(error);

      await expect(saveChatToFile('content', 'chat.md')).rejects.toThrow('Dialog error');
    });
  });

  describe('openInDefaultApp 错误处理', () => {
    it('openPath 失败时应拒绝', async () => {
      const error = new Error('No default app');
      mockOpenPath.mockRejectedValueOnce(error);

      await expect(openInDefaultApp('/unknown.ext')).rejects.toThrow('No default app');
    });
  });

  describe('窗口操作错误处理', () => {
    let mockWindow: {
      minimize: ReturnType<typeof vi.fn>;
      maximize: ReturnType<typeof vi.fn>;
      unmaximize: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      isMaximized: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockWindow = {
        minimize: vi.fn(),
        maximize: vi.fn(),
        unmaximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn(),
      };
      mockGetCurrentWindow.mockReturnValue(mockWindow as unknown as ReturnType<typeof getCurrentWindow>);
    });

    it('minimizeWindow 应拒绝并传递错误', async () => {
      const error = new Error('Minimize failed');
      mockWindow.minimize.mockRejectedValueOnce(error);

      await expect(minimizeWindow()).rejects.toThrow('Minimize failed');
    });

    it('toggleMaximizeWindow 最小化失败时应拒绝', async () => {
      mockWindow.isMaximized.mockResolvedValueOnce(false);
      const error = new Error('Maximize failed');
      mockWindow.maximize.mockRejectedValueOnce(error);

      await expect(toggleMaximizeWindow()).rejects.toThrow('Maximize failed');
    });

    it('toggleMaximizeWindow 还原失败时应拒绝', async () => {
      mockWindow.isMaximized.mockResolvedValueOnce(true);
      const error = new Error('Unmaximize failed');
      mockWindow.unmaximize.mockRejectedValueOnce(error);

      await expect(toggleMaximizeWindow()).rejects.toThrow('Unmaximize failed');
    });

    it('closeWindow 应拒绝并传递错误', async () => {
      const error = new Error('Close failed');
      mockWindow.close.mockRejectedValueOnce(error);

      await expect(closeWindow()).rejects.toThrow('Close failed');
    });

    it('isMaximized 查询失败时应拒绝', async () => {
      const error = new Error('State query failed');
      mockWindow.isMaximized.mockRejectedValueOnce(error);

      await expect(toggleMaximizeWindow()).rejects.toThrow('State query failed');
    });
  });

  describe('上下文管理错误处理', () => {
    it('queryContext 应拒绝并传递错误', async () => {
      const error = new Error('Query failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(queryContext({})).rejects.toThrow('Query failed');
    });

    it('upsertContext 应拒绝并传递错误', async () => {
      const error = new Error('Upsert failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(upsertContext({} as ContextEntry)).rejects.toThrow('Upsert failed');
    });

    it('getAllContext 应拒绝并传递错误', async () => {
      const error = new Error('Get all failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(getAllContext()).rejects.toThrow('Get all failed');
    });

    it('removeContext 应拒绝并传递错误', async () => {
      const error = new Error('Remove failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(removeContext('id')).rejects.toThrow('Remove failed');
    });

    it('clearContext 应拒绝并传递错误', async () => {
      const error = new Error('Clear failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(clearContext()).rejects.toThrow('Clear failed');
    });

    it('upsertContextMany 应拒绝并传递错误', async () => {
      const error = new Error('Batch upsert failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(upsertContextMany([])).rejects.toThrow('Batch upsert failed');
    });
  });

  describe('钉钉服务错误处理', () => {
    it('startDingTalkService 应拒绝并传递错误', async () => {
      const error = new Error('Service start failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(startDingTalkService()).rejects.toThrow('Service start failed');
    });

    it('stopDingTalkService 应拒绝并传递错误', async () => {
      const error = new Error('Service stop failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(stopDingTalkService()).rejects.toThrow('Service stop failed');
    });

    it('sendDingTalkMessage 应拒绝并传递错误', async () => {
      const error = new Error('Send failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(sendDingTalkMessage('msg', 'conv')).rejects.toThrow('Send failed');
    });

    it('isDingTalkServiceRunning 应拒绝并传递错误', async () => {
      const error = new Error('Status check failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(isDingTalkServiceRunning()).rejects.toThrow('Status check failed');
    });

    it('getDingTalkServiceStatus 应拒绝并传递错误', async () => {
      const error = new Error('Get status failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(getDingTalkServiceStatus()).rejects.toThrow('Get status failed');
    });

    it('testDingTalkConnection 应拒绝并传递错误', async () => {
      const error = new Error('Connection test failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(testDingTalkConnection('test', 'conv')).rejects.toThrow('Connection test failed');
    });
  });

  describe('翻译错误处理', () => {
    it('baiduTranslate 应拒绝并传递错误', async () => {
      const error = new Error('API error');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(baiduTranslate('text', 'app', 'key')).rejects.toThrow('API error');
    });
  });

  describe('IDE 上报错误处理', () => {
    it('ideReportCurrentFile 应拒绝并传递错误', async () => {
      const error = new Error('Report failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(ideReportCurrentFile({
        workspace_id: 'ws',
        file_path: '/file.ts',
        content: 'code',
        language: 'ts',
        cursor_offset: 0,
      })).rejects.toThrow('Report failed');
    });

    it('ideReportFileStructure 应拒绝并传递错误', async () => {
      const error = new Error('Structure report failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(ideReportFileStructure({
        workspace_id: 'ws',
        file_path: '/file.ts',
        symbols: [],
      })).rejects.toThrow('Structure report failed');
    });

    it('ideReportDiagnostics 应拒绝并传递错误', async () => {
      const error = new Error('Diagnostics report failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(ideReportDiagnostics({
        workspace_id: 'ws',
        file_path: '/file.ts',
        diagnostics: [],
      })).rejects.toThrow('Diagnostics report failed');
    });
  });

  describe('废弃命令错误处理', () => {
    it('startChat 应拒绝并传递错误', async () => {
      const error = new Error('Start failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(startChat('msg')).rejects.toThrow('Start failed');
    });

    it('continueChat 应拒绝并传递错误', async () => {
      const error = new Error('Continue failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(continueChat('sid', 'msg')).rejects.toThrow('Continue failed');
    });

    it('interruptChat 应拒绝并传递错误', async () => {
      const error = new Error('Interrupt failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(interruptChat('sid')).rejects.toThrow('Interrupt failed');
    });

    it('startIFlowChat 应拒绝并传递错误', async () => {
      const error = new Error('IFlow start failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(startIFlowChat('msg')).rejects.toThrow('IFlow start failed');
    });

    it('startCodexChat 应拒绝并传递错误', async () => {
      const error = new Error('Codex start failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(startCodexChat('msg')).rejects.toThrow('Codex start failed');
    });
  });
});

// ============================================================
// 集成扩展命令测试
// ============================================================
import {
  sendIntegrationMessage,
  getIntegrationSessions,
  initIntegration,
  onIntegrationMessage,
} from './tauri';
import type { IntegrationSession, QQBotConfig } from '../types';

describe('集成扩展命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendIntegrationMessage', () => {
    it('应发送集成消息到对话', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await sendIntegrationMessage(
        'qqbot',
        { type: 'conversation', conversationId: 'conv-1' },
        { type: 'text', text: 'Hello' }
      );

      expect(mockInvoke).toHaveBeenCalledWith('send_integration_message', {
        platform: 'qqbot',
        target: { type: 'conversation', conversationId: 'conv-1' },
        content: { type: 'text', text: 'Hello' },
      });
    });

    it('应发送集成消息到频道', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await sendIntegrationMessage(
        'telegram',
        { type: 'channel', channelId: 'ch-1' },
        { type: 'text', text: 'Broadcast' }
      );

      expect(mockInvoke).toHaveBeenCalledWith('send_integration_message', {
        platform: 'telegram',
        target: { type: 'channel', channelId: 'ch-1' },
        content: { type: 'text', text: 'Broadcast' },
      });
    });

    it('应发送集成消息到用户', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await sendIntegrationMessage(
        'wechat',
        { type: 'user', userId: 'user-1' },
        { type: 'text', text: 'Direct message' }
      );

      expect(mockInvoke).toHaveBeenCalledWith('send_integration_message', {
        platform: 'wechat',
        target: { type: 'user', userId: 'user-1' },
        content: { type: 'text', text: 'Direct message' },
      });
    });

    it('应发送消息到 webhook', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await sendIntegrationMessage(
        'qqbot',
        { type: 'webhook', url: 'https://example.com/webhook' },
        { type: 'text', text: 'Webhook message' }
      );

      expect(mockInvoke).toHaveBeenCalledWith('send_integration_message', {
        platform: 'qqbot',
        target: { type: 'webhook', url: 'https://example.com/webhook' },
        content: { type: 'text', text: 'Webhook message' },
      });
    });

    it('应处理发送错误', async () => {
      const error = new Error('Send failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(
        sendIntegrationMessage('qqbot', { type: 'conversation', conversationId: 'c' }, { type: 'text', text: 'test' })
      ).rejects.toThrow('Send failed');
    });
  });

  describe('getIntegrationSessions', () => {
    it('应获取集成会话列表', async () => {
      const mockSessions: IntegrationSession[] = [
        {
          conversationId: 'conv-1',
          sessionId: 'session-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 5,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockSessions);

      const result = await getIntegrationSessions();

      expect(mockInvoke).toHaveBeenCalledWith('get_integration_sessions');
      expect(result).toEqual(mockSessions);
    });

    it('应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await getIntegrationSessions();

      expect(result).toEqual([]);
    });

    it('应处理获取错误', async () => {
      const error = new Error('Failed to get sessions');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(getIntegrationSessions()).rejects.toThrow('Failed to get sessions');
    });
  });

  describe('initIntegration', () => {
    it('应使用配置初始化集成管理器', async () => {
      const config: QQBotConfig = {
        enabled: true,
        appId: 'test-app-id',
        clientSecret: 'test-secret',
        sandbox: false,
        displayMode: 'chat',
        autoConnect: true,
      };
      mockInvoke.mockResolvedValueOnce(undefined);

      await initIntegration(config);

      expect(mockInvoke).toHaveBeenCalledWith('init_integration', { qqbotConfig: config });
    });

    it('应支持 null 配置初始化', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await initIntegration(null);

      expect(mockInvoke).toHaveBeenCalledWith('init_integration', { qqbotConfig: null });
    });

    it('应处理初始化错误', async () => {
      const error = new Error('Init failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(initIntegration(null)).rejects.toThrow('Init failed');
    });
  });

  describe('onIntegrationMessage', () => {
    it('应注册集成消息监听器并返回取消函数', async () => {
      const mockUnlisten = vi.fn();
      const mockListen = vi.fn().mockResolvedValue(mockUnlisten);

      // 动态导入 listen mock
      vi.doMock('@tauri-apps/api/event', () => ({
        listen: mockListen,
      }));

      const callback = vi.fn();
      const unlisten = await onIntegrationMessage(callback);

      expect(mockUnlisten).toBeDefined();
    });
  });
});

// ============================================================
// 实例管理命令测试
// ============================================================
import {
  addIntegrationInstance,
  removeIntegrationInstance,
  listIntegrationInstances,
  listIntegrationInstancesByPlatform,
  getActiveIntegrationInstance,
  switchIntegrationInstance,
  disconnectIntegrationInstance,
  updateIntegrationInstance,
} from './tauri';
import type { PlatformInstance, InstanceId, InstanceConfig } from '../types';

describe('实例管理命令', () => {
  const mockInstanceConfig: InstanceConfig = {
    type: 'qqbot',
    enabled: true,
    appId: 'test-app',
    clientSecret: 'test-secret',
    sandbox: false,
    displayMode: 'chat',
    autoConnect: true,
  };

  const mockInstance: PlatformInstance = {
    id: 'instance-1',
    name: 'Test Instance',
    platform: 'qqbot',
    config: mockInstanceConfig,
    createdAt: '2026-01-01T00:00:00Z',
    enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addIntegrationInstance', () => {
    it('应添加集成实例并返回 ID', async () => {
      const mockId: InstanceId = 'new-instance-id';
      mockInvoke.mockResolvedValueOnce(mockId);

      const result = await addIntegrationInstance(mockInstance);

      expect(mockInvoke).toHaveBeenCalledWith('add_integration_instance', { instance: mockInstance });
      expect(result).toBe(mockId);
    });

    it('应处理添加错误', async () => {
      const error = new Error('Add failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(addIntegrationInstance(mockInstance)).rejects.toThrow('Add failed');
    });
  });

  describe('removeIntegrationInstance', () => {
    it('应移除实例并返回被移除的实例', async () => {
      mockInvoke.mockResolvedValueOnce(mockInstance);

      const result = await removeIntegrationInstance('instance-1');

      expect(mockInvoke).toHaveBeenCalledWith('remove_integration_instance', { instanceId: 'instance-1' });
      expect(result).toEqual(mockInstance);
    });

    it('应返回 null 当实例不存在时', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const result = await removeIntegrationInstance('non-existent');

      expect(result).toBeNull();
    });

    it('应处理移除错误', async () => {
      const error = new Error('Remove failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(removeIntegrationInstance('id')).rejects.toThrow('Remove failed');
    });
  });

  describe('listIntegrationInstances', () => {
    it('应获取所有实例列表', async () => {
      const mockInstances: PlatformInstance[] = [mockInstance];
      mockInvoke.mockResolvedValueOnce(mockInstances);

      const result = await listIntegrationInstances();

      expect(mockInvoke).toHaveBeenCalledWith('list_integration_instances');
      expect(result).toEqual(mockInstances);
    });

    it('应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await listIntegrationInstances();

      expect(result).toEqual([]);
    });

    it('应处理列表错误', async () => {
      const error = new Error('List failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(listIntegrationInstances()).rejects.toThrow('List failed');
    });
  });

  describe('listIntegrationInstancesByPlatform', () => {
    it('应按平台获取实例列表', async () => {
      const mockInstances: PlatformInstance[] = [mockInstance];
      mockInvoke.mockResolvedValueOnce(mockInstances);

      const result = await listIntegrationInstancesByPlatform('qqbot');

      expect(mockInvoke).toHaveBeenCalledWith('list_integration_instances_by_platform', { platform: 'qqbot' });
      expect(result).toEqual(mockInstances);
    });

    it('应返回空数组当平台无实例', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await listIntegrationInstancesByPlatform('wechat');

      expect(result).toEqual([]);
    });

    it('应处理错误', async () => {
      const error = new Error('Platform list failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(listIntegrationInstancesByPlatform('qqbot')).rejects.toThrow('Platform list failed');
    });
  });

  describe('getActiveIntegrationInstance', () => {
    it('应获取当前激活的实例', async () => {
      mockInvoke.mockResolvedValueOnce(mockInstance);

      const result = await getActiveIntegrationInstance('qqbot');

      expect(mockInvoke).toHaveBeenCalledWith('get_active_integration_instance', { platform: 'qqbot' });
      expect(result).toEqual(mockInstance);
    });

    it('应返回 null 当无激活实例', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const result = await getActiveIntegrationInstance('wechat');

      expect(result).toBeNull();
    });

    it('应处理错误', async () => {
      const error = new Error('Get active failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(getActiveIntegrationInstance('qqbot')).rejects.toThrow('Get active failed');
    });
  });

  describe('switchIntegrationInstance', () => {
    it('应切换到指定实例', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await switchIntegrationInstance('instance-2');

      expect(mockInvoke).toHaveBeenCalledWith('switch_integration_instance', { instanceId: 'instance-2' });
    });

    it('应处理切换错误', async () => {
      const error = new Error('Switch failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(switchIntegrationInstance('invalid-id')).rejects.toThrow('Switch failed');
    });
  });

  describe('disconnectIntegrationInstance', () => {
    it('应断开指定平台的连接', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await disconnectIntegrationInstance('qqbot');

      expect(mockInvoke).toHaveBeenCalledWith('disconnect_integration_instance', { platform: 'qqbot' });
    });

    it('应处理断开错误', async () => {
      const error = new Error('Disconnect failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(disconnectIntegrationInstance('qqbot')).rejects.toThrow('Disconnect failed');
    });
  });

  describe('updateIntegrationInstance', () => {
    it('应更新实例配置', async () => {
      const updatedInstance: PlatformInstance = {
        ...mockInstance,
        name: 'Updated Instance',
        enabled: false,
      };
      mockInvoke.mockResolvedValueOnce(undefined);

      await updateIntegrationInstance(updatedInstance);

      expect(mockInvoke).toHaveBeenCalledWith('update_integration_instance', { instance: updatedInstance });
    });

    it('应处理更新错误', async () => {
      const error = new Error('Update failed');
      mockInvoke.mockRejectedValueOnce(error);

      await expect(updateIntegrationInstance(mockInstance)).rejects.toThrow('Update failed');
    });
  });
});
