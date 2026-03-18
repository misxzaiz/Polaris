/**
 * chatExport.ts 测试 - 聊天导出服务
 * 
 * 测试覆盖范围：
 * - exportToMarkdown: Markdown 格式导出
 * - exportToJson: JSON 格式导出
 * - generateFileName: 文件名生成
 * 
 * 测试模式：
 * - 使用 mock 日期确保输出可预测
 * - 验证输出格式和结构
 * - 边界情况：空消息、特殊字符、代码块
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exportToMarkdown,
  exportToJson,
  generateFileName,
} from './chatExport';
import type {
  ChatMessage,
  UserChatMessage,
  AssistantChatMessage,
  SystemChatMessage,
  ContentBlock,
} from '../types';

// Mock Date for consistent output
const MOCK_DATE = new Date('2026-03-19T10:30:00.000Z');

describe('chatExport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('exportToMarkdown', () => {
    describe('基本导出', () => {
      it('应正确导出空消息列表', () => {
        const result = exportToMarkdown([]);
        
        expect(result).toContain('# Polaris 对话记录');
        expect(result).toContain('**消息数**: 0');
        expect(result).not.toContain('**工作区**');
      });

      it('应包含工作区名称（如果提供）', () => {
        const result = exportToMarkdown([], 'my-project');
        
        expect(result).toContain('**工作区**: my-project');
      });

      it('应正确格式化时间戳', () => {
        const result = exportToMarkdown([]);
        // 时间戳格式因时区而异，只验证存在
        expect(result).toMatch(/\*\*时间\*\*:.+/);
      });
    });

    describe('用户消息导出', () => {
      it('应正确导出单条用户消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Hello, how are you?',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('## 用户');
        expect(result).toContain('Hello, how are you?');
      });

      it('应正确导出包含附件的用户消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Check this image',
            timestamp: '2026-03-19T10:00:00.000Z',
            attachments: [
              {
                id: 'att-1',
                type: 'image',
                fileName: 'screenshot.png',
                fileSize: 1024,
              },
            ],
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        // 导出只包含 content，不处理附件
        expect(result).toContain('Check this image');
      });

      it('应正确处理多行用户消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Line 1\nLine 2\nLine 3',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('Line 1');
        expect(result).toContain('Line 2');
        expect(result).toContain('Line 3');
      });
    });

    describe('助手消息导出', () => {
      it('应正确导出单条助手消息（仅文本）', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              { type: 'text', content: 'I am fine, thank you!' },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:01:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('## 助手');
        expect(result).toContain('I am fine, thank you!');
      });

      it('应正确导出包含工具调用的助手消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              { type: 'text', content: 'Let me check that for you.' },
              {
                type: 'tool_call',
                id: 'tool-1',
                name: 'Read',
                input: { file: 'test.ts' },
                status: 'completed',
                output: 'file content',
                startedAt: '2026-03-19T10:01:01.000Z',
                completedAt: '2026-03-19T10:01:02.000Z',
              },
              { type: 'text', content: 'Here is the result.' },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:01:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('## 助手');
        expect(result).toContain('Let me check that for you.');
        expect(result).toContain('Here is the result.');
        // 工具调用摘要
        expect(result).toContain('调用了 1 个工具');
        expect(result).toContain('Read');
      });

      it('应正确导出包含多个工具调用的助手消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              { type: 'text', content: 'Processing...' },
              {
                type: 'tool_call',
                id: 'tool-1',
                name: 'Read',
                input: { file: 'a.ts' },
                status: 'completed',
                startedAt: '2026-03-19T10:01:01.000Z',
              },
              {
                type: 'tool_call',
                id: 'tool-2',
                name: 'Write',
                input: { file: 'b.ts' },
                status: 'completed',
                startedAt: '2026-03-19T10:01:02.000Z',
              },
              {
                type: 'tool_call',
                id: 'tool-3',
                name: 'Read', // 重复的工具名
                input: { file: 'c.ts' },
                status: 'completed',
                startedAt: '2026-03-19T10:01:03.000Z',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:01:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('调用了 3 个工具');
        // 去重后的工具名
        expect(result).toContain('Read, Write');
      });

      it('应正确导出包含思考块的助手消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              { type: 'thinking', content: 'Let me think about this...' },
              { type: 'text', content: 'Here is my answer.' },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:01:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        // 思考块会被 extractTextFromBlocks 过滤掉（只提取 text 类型）
        expect(result).toContain('Here is my answer.');
      });

      it('应处理无文本块的助手消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              {
                type: 'tool_call',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'ls' },
                status: 'completed',
                startedAt: '2026-03-19T10:01:00.000Z',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:01:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('## 助手');
        // 无文本内容，但有工具摘要
        expect(result).toContain('调用了 1 个工具');
      });
    });

    describe('系统消息导出', () => {
      it('应正确导出系统消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'system',
            content: 'Session started',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as SystemChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('## 系统');
        expect(result).toContain('*Session started*');
      });
    });

    describe('混合消息导出', () => {
      it('应正确导出多类型消息混合', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'system',
            content: 'Session started',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as SystemChatMessage,
          {
            id: 'msg-2',
            type: 'user',
            content: 'Hello!',
            timestamp: '2026-03-19T10:00:01.000Z',
          } as UserChatMessage,
          {
            id: 'msg-3',
            type: 'assistant',
            blocks: [{ type: 'text', content: 'Hi there!' }],
            timestamp: '2026-03-19T10:00:02.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('## 系统');
        expect(result).toContain('## 用户');
        expect(result).toContain('## 助手');
        expect(result).toContain('Hello!');
        expect(result).toContain('Hi there!');
      });

      it('应按顺序导出消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'First',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
          {
            id: 'msg-2',
            type: 'user',
            content: 'Second',
            timestamp: '2026-03-19T10:00:01.000Z',
          } as UserChatMessage,
          {
            id: 'msg-3',
            type: 'user',
            content: 'Third',
            timestamp: '2026-03-19T10:00:02.000Z',
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        const firstIndex = result.indexOf('First');
        const secondIndex = result.indexOf('Second');
        const thirdIndex = result.indexOf('Third');
        
        expect(firstIndex).toBeLessThan(secondIndex);
        expect(secondIndex).toBeLessThan(thirdIndex);
      });
    });

    describe('代码块处理', () => {
      it('应正确处理包含代码块的消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              {
                type: 'text',
                content: 'Here is the code:\n```typescript\nconst x = 1;\nconsole.log(x);\n```\nDone.',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('```typescript');
        expect(result).toContain('const x = 1;');
        expect(result).toContain('console.log(x);');
      });

      it('应正确处理多个代码块', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              {
                type: 'text',
                content: 'First:\n```js\ncode1\n```\nSecond:\n```python\ncode2\n```',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('```js');
        expect(result).toContain('code1');
        expect(result).toContain('```python');
        expect(result).toContain('code2');
      });

      it('应处理无语言标识的代码块', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              {
                type: 'text',
                content: '```\nplain code\n```',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('```');
        expect(result).toContain('plain code');
      });

      it('应处理未闭合的代码块', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              {
                type: 'text',
                content: '```javascript\nconsole.log("unclosed");',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        // 未闭合的代码块应该在输出中闭合
        expect(result).toContain('```javascript');
        expect(result).toContain('console.log("unclosed");');
      });
    });

    describe('特殊字符处理', () => {
      it('应正确处理包含 Markdown 特殊字符的消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Test **bold** and *italic* and `code`',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('Test **bold** and *italic* and `code`');
      });

      it('应正确处理包含 HTML 标签的消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: '<div>Hello</div>',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('<div>Hello</div>');
      });

      it('应正确处理包含中文的消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: '你好，世界！这是一条测试消息。',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('你好，世界！这是一条测试消息。');
      });

      it('应正确处理包含 emoji 的消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Hello 👋 World 🌍',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToMarkdown(messages);
        
        expect(result).toContain('Hello 👋 World 🌍');
      });
    });
  });

  describe('exportToJson', () => {
    describe('基本导出', () => {
      it('应正确导出空消息列表', () => {
        const result = exportToJson([]);
        const parsed = JSON.parse(result);
        
        expect(parsed.metadata.messageCount).toBe(0);
        expect(parsed.messages).toEqual([]);
        expect(parsed.metadata.exportedBy).toBe('Polaris');
      });

      it('应包含工作区名称（如果提供）', () => {
        const result = exportToJson([], 'my-project');
        const parsed = JSON.parse(result);
        
        expect(parsed.metadata.workspace).toBe('my-project');
      });

      it('工作区为空时应为 null', () => {
        const result = exportToJson([]);
        const parsed = JSON.parse(result);
        
        expect(parsed.metadata.workspace).toBeNull();
      });

      it('应包含 ISO 格式的日期', () => {
        const result = exportToJson([]);
        const parsed = JSON.parse(result);
        
        expect(parsed.metadata.date).toBe('2026-03-19T10:30:00.000Z');
      });
    });

    describe('用户消息导出', () => {
      it('应正确导出用户消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Hello!',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToJson(messages);
        const parsed = JSON.parse(result);
        
        expect(parsed.messages).toHaveLength(1);
        expect(parsed.messages[0].type).toBe('user');
        expect(parsed.messages[0].content).toBe('Hello!');
        expect(parsed.messages[0].timestamp).toBe('2026-03-19T10:00:00.000Z');
        expect(parsed.messages[0].toolSummary).toBeUndefined();
      });
    });

    describe('助手消息导出', () => {
      it('应正确导出助手消息（仅文本）', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              { type: 'text', content: 'Response text' },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToJson(messages);
        const parsed = JSON.parse(result);
        
        expect(parsed.messages[0].type).toBe('assistant');
        expect(parsed.messages[0].content).toBe('Response text');
        expect(parsed.messages[0].toolSummary).toBeUndefined();
      });

      it('应正确导出包含工具调用的助手消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              { type: 'text', content: 'Processing...' },
              {
                type: 'tool_call',
                id: 'tool-1',
                name: 'Read',
                input: { file: 'test.ts' },
                status: 'completed',
                startedAt: '2026-03-19T10:00:01.000Z',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToJson(messages);
        const parsed = JSON.parse(result);
        
        expect(parsed.messages[0].content).toBe('Processing...');
        expect(parsed.messages[0].toolSummary).toEqual({
          count: 1,
          names: ['Read'],
        });
      });

      it('应正确处理多个工具调用（去重名称）', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              {
                type: 'tool_call',
                id: 'tool-1',
                name: 'Read',
                input: {},
                status: 'completed',
                startedAt: '2026-03-19T10:00:01.000Z',
              },
              {
                type: 'tool_call',
                id: 'tool-2',
                name: 'Read',
                input: {},
                status: 'completed',
                startedAt: '2026-03-19T10:00:02.000Z',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToJson(messages);
        const parsed = JSON.parse(result);
        
        expect(parsed.messages[0].toolSummary).toEqual({
          count: 2,
          names: ['Read'], // 去重
        });
      });

      it('应处理无文本块的助手消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'assistant',
            blocks: [
              {
                type: 'tool_call',
                id: 'tool-1',
                name: 'Bash',
                input: {},
                status: 'completed',
                startedAt: '2026-03-19T10:00:00.000Z',
              },
            ] as ContentBlock[],
            timestamp: '2026-03-19T10:00:00.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToJson(messages);
        const parsed = JSON.parse(result);
        
        expect(parsed.messages[0].content).toBe('');
        expect(parsed.messages[0].toolSummary).toEqual({
          count: 1,
          names: ['Bash'],
        });
      });
    });

    describe('系统消息导出', () => {
      it('应正确导出系统消息', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'system',
            content: 'Session ended',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as SystemChatMessage,
        ];

        const result = exportToJson(messages);
        const parsed = JSON.parse(result);
        
        expect(parsed.messages[0].type).toBe('system');
        expect(parsed.messages[0].content).toBe('Session ended');
      });
    });

    describe('混合消息导出', () => {
      it('应正确导出多类型消息混合', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Question',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
          {
            id: 'msg-2',
            type: 'assistant',
            blocks: [{ type: 'text', content: 'Answer' }],
            timestamp: '2026-03-19T10:00:01.000Z',
          } as AssistantChatMessage,
        ];

        const result = exportToJson(messages);
        const parsed = JSON.parse(result);
        
        expect(parsed.messages).toHaveLength(2);
        expect(parsed.metadata.messageCount).toBe(2);
      });
    });

    describe('JSON 格式验证', () => {
      it('应输出格式化的 JSON（带缩进）', () => {
        const result = exportToJson([]);
        
        expect(result).toContain('\n  '); // 2 空格缩进
      });

      it('应输出有效的 JSON', () => {
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Test with "quotes" and \\backslashes\\',
            timestamp: '2026-03-19T10:00:00.000Z',
          } as UserChatMessage,
        ];

        const result = exportToJson(messages);
        
        // 不应抛出错误
        expect(() => JSON.parse(result)).not.toThrow();
      });
    });
  });

  describe('generateFileName', () => {
    it('应生成 md 格式的文件名', () => {
      const result = generateFileName('md');
      
      expect(result).toMatch(/^对话记录-\d{8}-\d{4}\.md$/);
    });

    it('应生成 json 格式的文件名', () => {
      const result = generateFileName('json');
      
      expect(result).toMatch(/^对话记录-\d{8}-\d{4}\.json$/);
    });

    it('默认应生成 md 格式', () => {
      const result = generateFileName();
      
      expect(result).toMatch(/\.md$/);
    });

    it('应使用当前日期时间', () => {
      // 使用 mock 时间: 2026-03-19T10:30:00.000Z
      // 北京时间: 2026-03-19 18:30:00
      const result = generateFileName('md');
      
      // 文件名包含日期和时间（本地时间）
      expect(result).toContain('20260319');
      expect(result).toContain('1830');
    });

    it('多次调用应返回相同的文件名（在同一分钟内）', () => {
      const result1 = generateFileName();
      const result2 = generateFileName();
      
      expect(result1).toBe(result2);
    });
  });
});
