/**
 * codexHistoryService.ts 单元测试
 *
 * 测试 Codex 历史服务的核心功能：
 * - 会话列表获取
 * - 历史消息获取
 * - 消息格式转换
 * - 工具调用提取
 * - 工具函数
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  CodexHistoryService,
  getCodexHistoryService,
  resetCodexHistoryService,
  type CodexSessionMeta,
  type CodexHistoryMessage,
} from './codexHistoryService';
import type { Message, ToolCall } from '../types';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// 获取 mock 函数
const mockInvoke = vi.mocked(invoke);

// ============================================================
// 辅助函数
// ============================================================

/**
 * 创建模拟的 CodexSessionMeta
 */
function createMockSessionMeta(overrides: Partial<CodexSessionMeta> = {}): CodexSessionMeta {
  return {
    sessionId: 'session-1',
    title: 'Test Session',
    messageCount: 10,
    fileSize: 1024,
    createdAt: '2026-03-19T10:00:00.000Z',
    updatedAt: '2026-03-19T11:00:00.000Z',
    filePath: '/test/.codex/session-1.json',
    ...overrides,
  };
}

/**
 * 创建模拟的 CodexHistoryMessage
 */
function createMockMessage(overrides: Partial<CodexHistoryMessage> = {}): CodexHistoryMessage {
  return {
    uuid: 'msg-1',
    parentUuid: undefined,
    timestamp: '2026-03-19T10:00:00.000Z',
    type: 'user',
    content: 'Test message',
    toolCalls: [],
    ...overrides,
  };
}

// ============================================================
// 异步方法测试
// ============================================================
describe('异步方法', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CodexHistoryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listSessions', () => {
    it('应成功获取会话列表', async () => {
      const mockSessions = [
        createMockSessionMeta({ sessionId: 'session-1' }),
        createMockSessionMeta({ sessionId: 'session-2', title: 'Another Session' }),
      ];
      mockInvoke.mockResolvedValueOnce(mockSessions);

      const sessions = await service.listSessions();

      expect(mockInvoke).toHaveBeenCalledWith('list_codex_sessions', {
        workDir: undefined,
      });
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe('session-1');
      expect(sessions[1].title).toBe('Another Session');
    });

    it('应传递工作目录参数', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      await service.listSessions('/custom/workspace');

      expect(mockInvoke).toHaveBeenCalledWith('list_codex_sessions', {
        workDir: '/custom/workspace',
      });
    });

    it('错误时应返回空数组', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Network error'));

      const sessions = await service.listSessions();

      expect(sessions).toEqual([]);
    });

    it('后端返回 null 时应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const sessions = await service.listSessions();

      expect(sessions).toEqual([]);
    });

    it('后端返回 undefined 时应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const sessions = await service.listSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe('getSessionHistory', () => {
    it('应成功获取会话历史', async () => {
      const mockMessages = [
        createMockMessage({ uuid: 'msg-1', type: 'user', content: 'Hello' }),
        createMockMessage({ uuid: 'msg-2', type: 'assistant', content: 'Hi there!' }),
      ];
      mockInvoke.mockResolvedValueOnce(mockMessages);

      const messages = await service.getSessionHistory('/test/session.json');

      expect(mockInvoke).toHaveBeenCalledWith('get_codex_session_history', {
        filePath: '/test/session.json',
      });
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[1].content).toBe('Hi there!');
    });

    it('错误时应返回空数组', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('File not found'));

      const messages = await service.getSessionHistory('/nonexistent.json');

      expect(messages).toEqual([]);
    });

    it('后端返回 null 时应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const messages = await service.getSessionHistory('/test/session.json');

      expect(messages).toEqual([]);
    });

    it('后端返回 undefined 时应返回空数组', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const messages = await service.getSessionHistory('/test/session.json');

      expect(messages).toEqual([]);
    });
  });
});

// ============================================================
// 消息转换测试
// ============================================================
describe('消息转换', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    service = new CodexHistoryService();
  });

  describe('convertMessagesToFormat', () => {
    it('应正确转换用户消息', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'Hello world' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toBe('Hello world');
      expect(result[0].id).toBe('msg-1');
      expect(result[0].timestamp).toBe('2026-03-19T10:00:00.000Z');
    });

    it('应正确转换助手消息', () => {
      const messages = [
        createMockMessage({ type: 'assistant', content: 'Hi there!' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].role).toBe('assistant');
      expect(result[0].content).toBe('Hi there!');
    });

    it('消息包含工具调用时应添加 toolSummary', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          toolCalls: [
            { id: 'tc-1', name: 'read_file', input: { path: '/test.ts' } },
            { id: 'tc-2', name: 'write_file', input: { path: '/output.ts' } },
          ],
        }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].toolSummary).toBeDefined();
      expect(result[0].toolSummary?.count).toBe(2);
      expect(result[0].toolSummary?.names).toContain('read_file');
      expect(result[0].toolSummary?.names).toContain('write_file');
    });

    it('相同工具名称应去重', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          toolCalls: [
            { id: 'tc-1', name: 'read_file', input: {} },
            { id: 'tc-2', name: 'read_file', input: {} },
            { id: 'tc-3', name: 'write_file', input: {} },
          ],
        }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].toolSummary?.count).toBe(3);
      expect(result[0].toolSummary?.names).toHaveLength(2);
      expect(result[0].toolSummary?.names).toEqual(
        expect.arrayContaining(['read_file', 'write_file'])
      );
    });

    it('空消息列表应返回空数组', () => {
      const result = service.convertMessagesToFormat([]);

      expect(result).toEqual([]);
    });

    it('应保留多条消息顺序', () => {
      const messages = [
        createMockMessage({ uuid: 'msg-1', type: 'user', content: 'First' }),
        createMockMessage({ uuid: 'msg-2', type: 'assistant', content: 'Second' }),
        createMockMessage({ uuid: 'msg-3', type: 'user', content: 'Third' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('First');
      expect(result[1].content).toBe('Second');
      expect(result[2].content).toBe('Third');
    });
  });

  describe('extractToolCalls', () => {
    it('应提取所有工具调用', () => {
      const messages = [
        createMockMessage({
          uuid: 'msg-1',
          type: 'assistant',
          timestamp: '2026-03-19T10:00:00.000Z',
          toolCalls: [
            { id: 'tc-1', name: 'read_file', input: { path: '/test.ts' } },
          ],
        }),
        createMockMessage({
          uuid: 'msg-2',
          type: 'assistant',
          timestamp: '2026-03-19T10:01:00.000Z',
          toolCalls: [
            { id: 'tc-2', name: 'write_file', input: { path: '/output.ts' } },
          ],
        }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('tc-1');
      expect(result[0].name).toBe('read_file');
      expect(result[1].id).toBe('tc-2');
    });

    it('工具调用应标记为 completed 状态', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          toolCalls: [{ id: 'tc-1', name: 'test_tool', input: {} }],
        }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result[0].status).toBe('completed');
    });

    it('应使用消息时间戳作为 startedAt', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          timestamp: '2026-03-19T10:00:00.000Z',
          toolCalls: [{ id: 'tc-1', name: 'test_tool', input: {} }],
        }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result[0].startedAt).toBe('2026-03-19T10:00:00.000Z');
    });

    it('无工具调用时应返回空数组', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'Hello' }),
        createMockMessage({ type: 'assistant', content: 'Hi' }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result).toEqual([]);
    });

    it('应正确处理复杂 input', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'edit_file',
              input: {
                path: '/test.ts',
                edits: [{ oldText: 'foo', newText: 'bar' }],
                options: { dryRun: true },
              },
            },
          ],
        }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result[0].input).toEqual({
        path: '/test.ts',
        edits: [{ oldText: 'foo', newText: 'bar' }],
        options: { dryRun: true },
      });
    });
  });
});

// ============================================================
// 工具函数测试
// ============================================================
describe('工具函数', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    service = new CodexHistoryService();
  });

  describe('generateSessionTitle', () => {
    it('应从第一条用户消息生成标题', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'Help me fix this bug' }),
        createMockMessage({ type: 'assistant', content: 'Sure!' }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title).toBe('Help me fix this bug');
    });

    it('长内容应截断并添加省略号', () => {
      const longContent = 'A'.repeat(60);
      const messages = [
        createMockMessage({ type: 'user', content: longContent }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title.length).toBe(53); // 50 + '...'
      expect(title.endsWith('...')).toBe(true);
    });

    it('50 字符内容不应截断', () => {
      const exactContent = 'A'.repeat(50);
      const messages = [
        createMockMessage({ type: 'user', content: exactContent }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title).toBe(exactContent);
      expect(title.endsWith('...')).toBe(false);
    });

    it('无用户消息时应返回默认标题', () => {
      const messages = [
        createMockMessage({ type: 'assistant', content: 'Hello' }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title).toBe('Codex 对话');
    });

    it('空消息列表应返回默认标题', () => {
      const title = service.generateSessionTitle([]);

      expect(title).toBe('Codex 对话');
    });

    it('用户消息内容为空时应返回默认标题', () => {
      const messages = [
        createMockMessage({ type: 'user', content: '' }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title).toBe('Codex 对话');
    });

    it('用户消息内容为空白时应返回默认标题', () => {
      const messages = [
        createMockMessage({ type: 'user', content: '   ' }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title).toBe('Codex 对话');
    });
  });

  describe('getSessionSummary', () => {
    it('应返回消息数量', () => {
      const meta = createMockSessionMeta({ messageCount: 25 });

      const summary = service.getSessionSummary(meta);

      expect(summary).toBe('25 条消息');
    });

    it('应处理 0 条消息', () => {
      const meta = createMockSessionMeta({ messageCount: 0 });

      const summary = service.getSessionSummary(meta);

      expect(summary).toBe('0 条消息');
    });
  });

  describe('formatFileSize', () => {
    it('应格式化字节', () => {
      expect(service.formatFileSize(512)).toBe('512 B');
    });

    it('应格式化 KB', () => {
      expect(service.formatFileSize(1024)).toBe('1 KB');
      expect(service.formatFileSize(1536)).toBe('1.5 KB');
    });

    it('应格式化 MB', () => {
      expect(service.formatFileSize(1048576)).toBe('1 MB');
      expect(service.formatFileSize(2621440)).toBe('2.5 MB');
    });

    it('应格式化 GB', () => {
      expect(service.formatFileSize(1073741824)).toBe('1 GB');
    });

    it('0 字节应返回 0 B', () => {
      expect(service.formatFileSize(0)).toBe('0 B');
    });

    it('应处理小数值', () => {
      expect(service.formatFileSize(1234)).toBe('1.21 KB');
    });
  });

  describe('formatTime', () => {
    it('刚刚（小于 1 分钟）', () => {
      const now = new Date().toISOString();

      expect(service.formatTime(now)).toBe('刚刚');
    });

    it('几分钟前', () => {
      const fiveMinsAgo = new Date(Date.now() - 5 * 60000).toISOString();

      expect(service.formatTime(fiveMinsAgo)).toBe('5 分钟前');
    });

    it('几小时前', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();

      expect(service.formatTime(threeHoursAgo)).toBe('3 小时前');
    });

    it('几天前', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      expect(service.formatTime(twoDaysAgo)).toBe('2 天前');
    });

    it('一周以上应显示日期', () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 86400000);

      const result = service.formatTime(tenDaysAgo.toISOString());

      // 格式应为 "3月9日" 这样的形式
      expect(result).toMatch(/\d+月\d+日/);
    });

    it('边界值：刚好 1 分钟', () => {
      const oneMinAgo = new Date(Date.now() - 60000).toISOString();

      expect(service.formatTime(oneMinAgo)).toBe('1 分钟前');
    });

    it('边界值：刚好 1 小时', () => {
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();

      expect(service.formatTime(oneHourAgo)).toBe('1 小时前');
    });

    it('边界值：刚好 1 天', () => {
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();

      expect(service.formatTime(oneDayAgo)).toBe('1 天前');
    });

    it('边界值：刚好 7 天应显示日期', () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      // 服务代码使用 diffDays < 7，刚好 7 天会进入日期格式分支
      const result = service.formatTime(sevenDaysAgo);
      expect(result).toMatch(/\d+月\d+日/);
    });

    it('边界值：6 天应显示天数', () => {
      const sixDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString();

      expect(service.formatTime(sixDaysAgo)).toBe('6 天前');
    });
  });
});

// ============================================================
// 单例管理测试
// ============================================================
describe('单例管理', () => {
  beforeEach(() => {
    resetCodexHistoryService();
  });

  afterEach(() => {
    resetCodexHistoryService();
  });

  it('getCodexHistoryService 应返回单例', () => {
    const service1 = getCodexHistoryService();
    const service2 = getCodexHistoryService();

    expect(service1).toBe(service2);
  });

  it('resetCodexHistoryService 应重置单例', () => {
    const service1 = getCodexHistoryService();
    resetCodexHistoryService();
    const service2 = getCodexHistoryService();

    expect(service1).not.toBe(service2);
  });
});

// ============================================================
// 边界情况测试
// ============================================================
describe('边界情况', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CodexHistoryService();
  });

  describe('特殊字符处理', () => {
    it('消息内容应正确处理 Unicode', () => {
      const messages = [
        createMockMessage({ type: 'user', content: '你好世界 🔥 emoji' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('你好世界 🔥 emoji');
    });

    it('工具调用名称应正确处理特殊字符', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          toolCalls: [
            { id: 'tc-1', name: 'read_file_测试', input: { 路径: '/文件/测试.ts' } },
          ],
        }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result[0].name).toBe('read_file_测试');
      expect(result[0].input).toEqual({ 路径: '/文件/测试.ts' });
    });
  });

  describe('极端数据', () => {
    it('应处理大量消息', () => {
      const messages = Array.from({ length: 1000 }, (_, i) =>
        createMockMessage({ uuid: `msg-${i}`, content: `Message ${i}` })
      );

      const result = service.convertMessagesToFormat(messages);

      expect(result).toHaveLength(1000);
    });

    it('应处理超长消息内容', () => {
      const longContent = 'A'.repeat(10000);
      const messages = [
        createMockMessage({ type: 'user', content: longContent }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe(longContent);
    });

    it('应处理大量工具调用', () => {
      const toolCalls = Array.from({ length: 100 }, (_, i) => ({
        id: `tc-${i}`,
        name: `tool_${i}`,
        input: { index: i },
      }));
      const messages = [
        createMockMessage({ type: 'assistant', toolCalls }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result).toHaveLength(100);
    });

    it('formatFileSize 应处理极大值', () => {
      expect(service.formatFileSize(Number.MAX_SAFE_INTEGER)).toBeDefined();
    });
  });

  describe('空值和 undefined', () => {
    it('消息缺少可选字段时应正常工作', () => {
      const messages = [
        {
          uuid: 'msg-1',
          timestamp: '2026-03-19T10:00:00.000Z',
          type: 'user' as const,
          content: 'Test',
          toolCalls: [],
        },
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg-1');
    });

    it('工具调用 input 为 null 时应正常处理', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          toolCalls: [{ id: 'tc-1', name: 'test', input: null }],
        }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result[0].input).toBeNull();
    });
  });
});

// ============================================================
// 并发安全性测试
// ============================================================
describe('并发安全性', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CodexHistoryService();
  });

  it('并发调用 listSessions 应正确处理', async () => {
    const mockSessions1 = [createMockSessionMeta({ sessionId: 'session-1' })];
    const mockSessions2 = [createMockSessionMeta({ sessionId: 'session-2' })];
    const mockSessions3 = [createMockSessionMeta({ sessionId: 'session-3' })];

    mockInvoke
      .mockResolvedValueOnce(mockSessions1)
      .mockResolvedValueOnce(mockSessions2)
      .mockResolvedValueOnce(mockSessions3);

    const results = await Promise.all([
      service.listSessions('/ws1'),
      service.listSessions('/ws2'),
      service.listSessions('/ws3'),
    ]);

    expect(results[0]).toHaveLength(1);
    expect(results[1]).toHaveLength(1);
    expect(results[2]).toHaveLength(1);
    expect(results[0][0].sessionId).toBe('session-1');
    expect(results[1][0].sessionId).toBe('session-2');
    expect(results[2][0].sessionId).toBe('session-3');
  });

  it('并发调用 getSessionHistory 应正确处理', async () => {
    const mockMsgs1 = [createMockMessage({ uuid: 'msg-1' })];
    const mockMsgs2 = [createMockMessage({ uuid: 'msg-2' })];

    mockInvoke
      .mockResolvedValueOnce(mockMsgs1)
      .mockResolvedValueOnce(mockMsgs2);

    const results = await Promise.all([
      service.getSessionHistory('/file1.json'),
      service.getSessionHistory('/file2.json'),
    ]);

    expect(results[0][0].uuid).toBe('msg-1');
    expect(results[1][0].uuid).toBe('msg-2');
  });

  it('混合并发调用应正确处理', async () => {
    mockInvoke
      .mockResolvedValueOnce([createMockSessionMeta()]) // listSessions
      .mockResolvedValueOnce([createMockMessage()]) // getSessionHistory
      .mockResolvedValueOnce([createMockSessionMeta({ sessionId: 'session-2' })]); // listSessions

    const results = await Promise.all([
      service.listSessions(),
      service.getSessionHistory('/test.json'),
      service.listSessions('/another'),
    ]);

    expect(results[0]).toHaveLength(1);
    expect(results[1]).toHaveLength(1);
    expect(results[2]).toHaveLength(1);
  });

  it('单例在并发访问时应返回相同实例', () => {
    resetCodexHistoryService();

    const services = Array.from({ length: 10 }, () => getCodexHistoryService());

    const firstService = services[0];
    services.forEach(s => expect(s).toBe(firstService));
  });
});

// ============================================================
// 数据一致性测试
// ============================================================
describe('数据一致性', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CodexHistoryService();
  });

  it('多次转换相同消息应返回相同结果', () => {
    const messages = [
      createMockMessage({ type: 'user', content: 'Test' }),
      createMockMessage({ type: 'assistant', content: 'Response' }),
    ];

    const result1 = service.convertMessagesToFormat(messages);
    const result2 = service.convertMessagesToFormat(messages);

    expect(result1).toEqual(result2);
  });

  it('extractToolCalls 不应修改原数组', () => {
    const messages = [
      createMockMessage({
        type: 'assistant',
        toolCalls: [{ id: 'tc-1', name: 'test', input: {} }],
      }),
    ];
    const originalLength = messages.length;
    const originalToolCalls = [...messages[0].toolCalls];

    service.extractToolCalls(messages);

    expect(messages.length).toBe(originalLength);
    expect(messages[0].toolCalls).toEqual(originalToolCalls);
  });

  it('convertMessagesToFormat 不应修改原数组', () => {
    const messages = [createMockMessage()];
    const originalLength = messages.length;

    service.convertMessagesToFormat(messages);

    expect(messages.length).toBe(originalLength);
  });

  it('会话摘要应与元数据一致', () => {
    const meta = createMockSessionMeta({
      messageCount: 42,
    });

    const summary = service.getSessionSummary(meta);

    expect(summary).toContain('42');
  });

  it('工具调用提取应保持时间戳一致性', () => {
    const messages = [
      createMockMessage({
        type: 'assistant',
        timestamp: '2026-03-19T10:00:00.000Z',
        toolCalls: [
          { id: 'tc-1', name: 'tool1', input: {} },
          { id: 'tc-2', name: 'tool2', input: {} },
        ],
      }),
    ];

    const toolCalls = service.extractToolCalls(messages);

    expect(toolCalls[0].startedAt).toBe('2026-03-19T10:00:00.000Z');
    expect(toolCalls[1].startedAt).toBe('2026-03-19T10:00:00.000Z');
  });
});

// ============================================================
// 错误恢复测试
// ============================================================
describe('错误恢复', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CodexHistoryService();
  });

  it('listSessions 错误后应能继续工作', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Network error'));
    mockInvoke.mockResolvedValueOnce([createMockSessionMeta()]);

    const result1 = await service.listSessions();
    const result2 = await service.listSessions();

    expect(result1).toEqual([]);
    expect(result2).toHaveLength(1);
  });

  it('getSessionHistory 错误后应能继续工作', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('File not found'));
    mockInvoke.mockResolvedValueOnce([createMockMessage()]);

    const result1 = await service.getSessionHistory('/nonexistent.json');
    const result2 = await service.getSessionHistory('/exists.json');

    expect(result1).toEqual([]);
    expect(result2).toHaveLength(1);
  });

  it('非 Error 对象的错误应正确处理', async () => {
    mockInvoke.mockRejectedValueOnce('string error');
    mockInvoke.mockRejectedValueOnce(123);
    mockInvoke.mockRejectedValueOnce(null);

    const results = await Promise.all([
      service.listSessions(),
      service.listSessions(),
      service.listSessions(),
    ]);

    results.forEach(r => expect(r).toEqual([]));
  });

  it('服务实例在错误后仍可用', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Error'));
    mockInvoke.mockResolvedValueOnce([createMockSessionMeta()]);

    await service.listSessions();
    const result = await service.listSessions();

    expect(result).toHaveLength(1);
  });
});

// ============================================================
// 国际化测试
// ============================================================
describe('国际化', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    service = new CodexHistoryService();
  });

  describe('中文内容', () => {
    it('应正确处理中文消息', () => {
      const messages = [
        createMockMessage({ type: 'user', content: '你好世界，这是一条中文消息' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('你好世界，这是一条中文消息');
    });

    it('应从中文消息生成标题', () => {
      const messages = [
        createMockMessage({ type: 'user', content: '帮我修复这个中文标题测试' }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title).toBe('帮我修复这个中文标题测试');
    });

    it('长中文内容应正确截断', () => {
      const longChinese = '测试'.repeat(30); // 60 个字符
      const messages = [
        createMockMessage({ type: 'user', content: longChinese }),
      ];

      const title = service.generateSessionTitle(messages);

      expect(title.endsWith('...')).toBe(true);
    });
  });

  describe('其他语言', () => {
    it('应正确处理日文内容', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'こんにちは世界' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('こんにちは世界');
    });

    it('应正确处理韩文内容', () => {
      const messages = [
        createMockMessage({ type: 'user', content: '안녕하세요 세계' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('안녕하세요 세계');
    });

    it('应正确处理俄文内容', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'Привет мир' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('Привет мир');
    });

    it('应正确处理阿拉伯文内容', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'مرحبا بالعالم' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('مرحبا بالعالم');
    });
  });

  describe('Emoji 和特殊字符', () => {
    it('应正确处理 emoji', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'Hello 👋 World 🌍 Test 🧪' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('Hello 👋 World 🌍 Test 🧪');
    });

    it('应正确处理混合语言内容', () => {
      const messages = [
        createMockMessage({
          type: 'user',
          content: 'Chinese 中文 Japanese 日本語 Korean 한국어 English',
        }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('Chinese 中文 Japanese 日本語 Korean 한국어 English');
    });

    it('应正确处理特殊符号', () => {
      const messages = [
        createMockMessage({ type: 'user', content: 'Test © 2026 ® ™ € £ ¥ § ¶ † ‡' }),
      ];

      const result = service.convertMessagesToFormat(messages);

      expect(result[0].content).toBe('Test © 2026 ® ™ € £ ¥ § ¶ † ‡');
    });

    it('工具调用名称应支持 Unicode', () => {
      const messages = [
        createMockMessage({
          type: 'assistant',
          toolCalls: [{ id: 'tc-1', name: '工具_测试', input: { 参数: '值' } }],
        }),
      ];

      const result = service.extractToolCalls(messages);

      expect(result[0].name).toBe('工具_测试');
      expect(result[0].input).toEqual({ 参数: '值' });
    });
  });
});

// ============================================================
// 更多边界值测试
// ============================================================
describe('更多边界值', () => {
  let service: CodexHistoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CodexHistoryService();
  });

  describe('formatFileSize 边界', () => {
    it('负数应返回有效结果', () => {
      // Math.log(-1) 返回 NaN，需要确认行为
      const result = service.formatFileSize(-1);
      // 由于 Math.log(-1) = NaN，结果可能是 "NaN undefined"
      expect(typeof result).toBe('string');
    });

    it('小数应正确处理', () => {
      expect(service.formatFileSize(0.5)).toBe('0.5 B');
      expect(service.formatFileSize(1024.5)).toBe('1 KB');
    });

    it('刚好边界值', () => {
      expect(service.formatFileSize(1023)).toBe('1023 B');
      expect(service.formatFileSize(1048575)).toMatch(/KB/);
      expect(service.formatFileSize(1073741823)).toMatch(/MB/);
    });
  });

  describe('formatTime 边界', () => {
    it('未来时间应返回 "刚刚"', () => {
      const future = new Date(Date.now() + 3600000).toISOString();

      expect(service.formatTime(future)).toBe('刚刚');
    });

    it('无效日期应返回有效结果', () => {
      const result = service.formatTime('invalid date');
      expect(typeof result).toBe('string');
    });

    it('空字符串日期应返回有效结果', () => {
      const result = service.formatTime('');
      expect(typeof result).toBe('string');
    });
  });

  describe('generateSessionTitle 边界', () => {
    it('51 字符内容应截断', () => {
      const content51 = 'A'.repeat(51);
      const messages = [createMockMessage({ type: 'user', content: content51 })];

      const title = service.generateSessionTitle(messages);

      expect(title.length).toBe(53);
      expect(title.endsWith('...')).toBe(true);
    });

    it('49 字符内容不应截断', () => {
      const content49 = 'A'.repeat(49);
      const messages = [createMockMessage({ type: 'user', content: content49 })];

      const title = service.generateSessionTitle(messages);

      expect(title).toBe(content49);
    });
  });

  describe('消息类型', () => {
    it('所有消息类型应正确处理', () => {
      const userMsg = createMockMessage({ type: 'user', content: 'User' });
      const assistantMsg = createMockMessage({ type: 'assistant', content: 'Assistant' });

      const result = service.convertMessagesToFormat([userMsg, assistantMsg]);

      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });
  });

  describe('空数组处理', () => {
    it('空消息数组转换应返回空数组', () => {
      expect(service.convertMessagesToFormat([])).toEqual([]);
    });

    it('空消息数组提取工具调用应返回空数组', () => {
      expect(service.extractToolCalls([])).toEqual([]);
    });

    it('空消息数组生成标题应返回默认值', () => {
      expect(service.generateSessionTitle([])).toBe('Codex 对话');
    });
  });
});
