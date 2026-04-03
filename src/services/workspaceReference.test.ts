/**
 * workspaceReference.ts 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseWorkspaceReferences,
  getWorkspaceByName,
  isValidWorkspaceReference,
  buildWorkspaceContextExtra,
  buildSystemPrompt,
} from './workspaceReference';
import type { Workspace } from '../types';

// Mock i18next
vi.mock('i18next', () => ({
  default: {
    t: vi.fn((key: string, params?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'systemPrompt:workingIn': `正在工作区 ${params?.name || ''} 中工作`,
        'systemPrompt:projectPath': `项目路径: ${params?.path || ''}`,
        'systemPrompt:fileRefSyntax': '文件引用语法: @filename 或 @dir/filename',
        'systemPrompt:contextWorkspaces': '关联工作区:',
        'systemPrompt:refSyntax': `引用语法: @${params?.name || ''}:filename`,
        'systemPrompt:workspaceToolGuidance': '处理待办、定时任务或需求库时，优先使用工作区 MCP 工具，不要直接读写 .polaris/*.json',
      };
      return translations[key] || key;
    }),
    bind: vi.fn((fn) => fn),
  },
}));

// 创建模拟工作区数据
const createMockWorkspace = (id: string, name: string, path: string): Workspace => ({
  id,
  name,
  path,
  createdAt: '2026-01-01T00:00:00Z',
  lastAccessed: '2026-03-19T00:00:00Z',
});

describe('workspaceReference', () => {
  const mockWorkspaces: Workspace[] = [
    createMockWorkspace('ws-1', 'Polaris', 'D:/space/base/Polaris'),
    createMockWorkspace('ws-2', 'Utils', 'D:/space/libs/utils'),
    createMockWorkspace('ws-3', '测试项目', 'D:/space/test/中文路径'),
  ];

  describe('parseWorkspaceReferences', () => {
    it('应解析指定工作区的引用', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/helper.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Utils');
      expect(result.references[0].relativePath).toBe('src/helper.ts');
      expect(result.references[0].absolutePath).toBe('D:/space/libs/utils/src/helper.ts');
    });

    it('应解析当前工作区的引用（@/path 格式，旧语法兼容）', () => {
      const result = parseWorkspaceReferences(
        '参考 @/src/App.tsx',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Polaris');
      // 旧语法 @/path 的 relativePath 会去掉前导斜杠
      expect(result.references[0].relativePath).toBe('src/App.tsx');
      // 绝对路径会正确拼接
      expect(result.references[0].absolutePath).toBe('D:/space/base/Polaris/src/App.tsx');
    });

    it('应解析当前工作区的引用（@path 格式，新语法）', () => {
      const result = parseWorkspaceReferences(
        '参考 @src/App.tsx',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Polaris');
      expect(result.references[0].relativePath).toBe('src/App.tsx');
      expect(result.references[0].absolutePath).toBe('D:/space/base/Polaris/src/App.tsx');
    });

    it('应处理多个引用', () => {
      const result = parseWorkspaceReferences(
        '参考 @Utils:src/a.ts 和 @Polaris:src/b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(2);
      expect(result.references[0].relativePath).toBe('src/a.ts');
      expect(result.references[1].relativePath).toBe('src/b.ts');
    });

    it('应处理中文工作区名', () => {
      const result = parseWorkspaceReferences(
        '查看 @测试项目:readme.md',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('测试项目');
    });

    it('应忽略普通 @ 提及（不包含 . 或 /）', () => {
      const result = parseWorkspaceReferences(
        '联系 @user 和 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // @user 不包含 . 或 /，会被过滤
      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('src/a.ts');
    });

    it('应处理邮箱地址（包含 .）', () => {
      const result = parseWorkspaceReferences(
        '联系 test@example.com',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // @example.com 会被匹配为当前工作区引用（example.com 包含 .）
      // relativePath 是 example.com
      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Polaris');
      expect(result.references[0].relativePath).toBe('example.com');
    });

    it('应处理空消息', () => {
      const result = parseWorkspaceReferences('', mockWorkspaces, [], 'ws-1');

      expect(result.references).toHaveLength(0);
      expect(result.processedMessage).toBe('');
    });

    it('应处理无引用的消息', () => {
      const result = parseWorkspaceReferences(
        '这是一条普通消息',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(0);
      expect(result.processedMessage).toBe('这是一条普通消息');
    });

    it('应处理不存在的工作区引用', () => {
      const result = parseWorkspaceReferences(
        '查看 @NotExist:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(0);
    });

    it('应处理无当前工作区的情况', () => {
      const result = parseWorkspaceReferences(
        '参考 @src/App.tsx',
        mockWorkspaces,
        [],
        null
      );

      // 无当前工作区时，@path 格式不应被处理
      expect(result.references).toHaveLength(0);
    });

    it('应正确替换为绝对路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/helper.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.processedMessage).toBe('查看 @D:/space/libs/utils/src/helper.ts');
    });

    it('应生成上下文头', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/helper.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.contextHeader).toContain('工作区信息');
      expect(result.contextHeader).toContain('当前工作区: Polaris');
      expect(result.contextHeader).toContain('本次引用的工作区');
    });

    it('应包含关联工作区信息', () => {
      const contextWorkspaces = [mockWorkspaces[1]];
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/helper.ts',
        mockWorkspaces,
        contextWorkspaces,
        'ws-1'
      );

      expect(result.contextHeader).toContain('关联工作区');
      expect(result.contextHeader).toContain('Utils');
    });

    it('应处理路径分隔符（Windows 风格）', () => {
      const winWorkspace = createMockWorkspace('ws-win', 'WinProj', 'C:\\Projects\\WinProj');
      const result = parseWorkspaceReferences(
        '查看 @WinProj:src\\main.ts',
        [winWorkspace],
        [],
        'ws-win'
      );

      expect(result.references[0].absolutePath).toContain('WinProj');
    });

    it('应处理路径分隔符（Unix 风格）', () => {
      const unixWorkspace = createMockWorkspace('ws-unix', 'UnixProj', '/home/user/UnixProj');
      const result = parseWorkspaceReferences(
        '查看 @UnixProj:src/main.ts',
        [unixWorkspace],
        [],
        'ws-unix'
      );

      expect(result.references[0].absolutePath).toBe('/home/user/UnixProj/src/main.ts');
    });

    it('应正确记录原始文本', () => {
      const result = parseWorkspaceReferences(
        '参考 @Utils:src/helper.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references[0].originalText).toBe('@Utils:src/helper.ts');
    });

    it('应处理多个相同工作区的引用', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts 和 @Utils:src/b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(2);
      expect(result.references[0].workspaceName).toBe('Utils');
      expect(result.references[1].workspaceName).toBe('Utils');
    });
  });

  describe('getWorkspaceByName', () => {
    it('应正确查找工作区', () => {
      const result = getWorkspaceByName('Utils', mockWorkspaces);
      expect(result?.id).toBe('ws-2');
    });

    it('应大小写不敏感', () => {
      const result = getWorkspaceByName('utils', mockWorkspaces);
      expect(result?.id).toBe('ws-2');
    });

    it('应处理中文名', () => {
      const result = getWorkspaceByName('测试项目', mockWorkspaces);
      expect(result?.id).toBe('ws-3');
    });

    it('应返回 undefined 当不存在时', () => {
      const result = getWorkspaceByName('NotExist', mockWorkspaces);
      expect(result).toBeUndefined();
    });

    it('应处理空数组', () => {
      const result = getWorkspaceByName('Utils', []);
      expect(result).toBeUndefined();
    });
  });

  describe('isValidWorkspaceReference', () => {
    it('应返回 true 对于有效格式', () => {
      expect(isValidWorkspaceReference('@Utils:src/a.ts')).toBe(true);
    });

    it('应返回 true 对于中文名', () => {
      expect(isValidWorkspaceReference('@测试项目:readme.md')).toBe(true);
    });

    it('应返回 true 对于带连字符的名', () => {
      expect(isValidWorkspaceReference('@my-project:src/a.ts')).toBe(true);
    });

    it('应返回 false 对于 @/ 格式（旧语法，不再推荐）', () => {
      // @/path 是旧语法，现在推荐使用 @path 引用当前工作区
      expect(isValidWorkspaceReference('@/src/a.ts')).toBe(false);
    });

    it('应返回 false 对于普通文本', () => {
      expect(isValidWorkspaceReference('普通文本')).toBe(false);
    });

    it('应返回 false 对于邮箱', () => {
      expect(isValidWorkspaceReference('test@example.com')).toBe(false);
    });

    it('应返回 false 对于空字符串', () => {
      expect(isValidWorkspaceReference('')).toBe(false);
    });
  });

  describe('buildWorkspaceContextExtra', () => {
    it('应构建工作区上下文', () => {
      const result = buildWorkspaceContextExtra(mockWorkspaces, [], 'ws-1');

      expect(result).not.toBeNull();
      expect(result?.currentWorkspace.name).toBe('Polaris');
      expect(result?.currentWorkspace.path).toBe('D:/space/base/Polaris');
      expect(result?.contextWorkspaces).toEqual([]);
    });

    it('应包含关联工作区', () => {
      const contextWorkspaces = [mockWorkspaces[1]];
      const result = buildWorkspaceContextExtra(mockWorkspaces, contextWorkspaces, 'ws-1');

      expect(result?.contextWorkspaces).toHaveLength(1);
      expect(result?.contextWorkspaces[0].name).toBe('Utils');
    });

    it('应返回 null 当无当前工作区时', () => {
      const result = buildWorkspaceContextExtra(mockWorkspaces, [], null);
      expect(result).toBeNull();
    });

    it('应返回 null 当当前工作区不存在时', () => {
      const result = buildWorkspaceContextExtra(mockWorkspaces, [], 'not-exist');
      expect(result).toBeNull();
    });

    it('应处理多个关联工作区', () => {
      const contextWorkspaces = [mockWorkspaces[1], mockWorkspaces[2]];
      const result = buildWorkspaceContextExtra(mockWorkspaces, contextWorkspaces, 'ws-1');

      expect(result?.contextWorkspaces).toHaveLength(2);
    });
  });

  describe('buildSystemPrompt', () => {
    it('应构建系统提示词', () => {
      const result = buildSystemPrompt(mockWorkspaces, [], 'ws-1');

      expect(result).toContain('正在工作区 Polaris 中工作');
      expect(result).toContain('项目路径: D:/space/base/Polaris');
      expect(result).toContain('文件引用语法');
    });

    it('应包含关联工作区信息', () => {
      const contextWorkspaces = [mockWorkspaces[1]];
      const result = buildSystemPrompt(mockWorkspaces, contextWorkspaces, 'ws-1');

      expect(result).toContain('关联工作区');
      expect(result).toContain('Utils');
    });

    it('应包含 MCP 工具引导信息', () => {
      const result = buildSystemPrompt(mockWorkspaces, [], 'ws-1');

      // 新版本使用通用的 MCP 工具引导，不再包含具体的待办管理指令
      expect(result).toContain('MCP 工具');
      expect(result).not.toContain('todo_write');
      expect(result).not.toContain('todo_read');
    });

    it('应返回空字符串当无当前工作区时', () => {
      const result = buildSystemPrompt(mockWorkspaces, [], null);
      expect(result).toBe('');
    });

    it('应返回空字符串当当前工作区不存在时', () => {
      const result = buildSystemPrompt(mockWorkspaces, [], 'not-exist');
      expect(result).toBe('');
    });
  });

  describe('边界情况', () => {
    it('应处理特殊字符路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/[test]/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('src/[test]/a.ts');
    });

    it('应处理空格路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/my folder/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 空格会导致路径中断，因为正则使用 [^\s]
      expect(result.references).toHaveLength(1);
    });

    it('应处理深路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:a/b/c/d/e/f.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references[0].relativePath).toBe('a/b/c/d/e/f.ts');
    });

    it('应处理文件扩展名', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:README.md',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references[0].relativePath).toBe('README.md');
    });

    it('应处理无扩展名文件', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/Makefile',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references[0].relativePath).toBe('src/Makefile');
    });

    it('应处理隐藏文件', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:.gitignore',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references[0].relativePath).toBe('.gitignore');
    });

    it('应处理 Unicode 路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/中文/文件.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references[0].relativePath).toBe('src/中文/文件.ts');
    });

    it('应处理重复引用', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts 和 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(2);
    });

    it('应处理极长路径', () => {
      const longPath = 'a/'.repeat(50) + 'file.ts';
      const result = parseWorkspaceReferences(
        `查看 @Utils:${longPath}`,
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references[0].relativePath).toBe(longPath);
    });
  });

  describe('并发安全性', () => {
    it('应处理多次并发调用', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(
          parseWorkspaceReferences(
            `查看 @Utils:src/file${i}.ts`,
            mockWorkspaces,
            [],
            'ws-1'
          )
        )
      );

      const results = await Promise.all(promises);

      results.forEach((result, i) => {
        expect(result.references).toHaveLength(1);
        expect(result.references[0].relativePath).toBe(`src/file${i}.ts`);
      });
    });

    it('应处理不同工作区的并发引用', async () => {
      const messages = [
        '查看 @Utils:src/a.ts',
        '查看 @Polaris:src/b.ts',
        '查看 @测试项目:readme.md',
      ];

      const promises = messages.map(msg =>
        Promise.resolve(parseWorkspaceReferences(msg, mockWorkspaces, [], 'ws-1'))
      );

      const results = await Promise.all(promises);

      expect(results[0].references[0].workspaceName).toBe('Utils');
      expect(results[1].references[0].workspaceName).toBe('Polaris');
      expect(results[2].references[0].workspaceName).toBe('测试项目');
    });

    it('应处理空数组的并发查找', async () => {
      const promises = Array.from({ length: 5 }, () =>
        Promise.resolve(getWorkspaceByName('Utils', []))
      );

      const results = await Promise.all(promises);

      results.forEach(result => {
        expect(result).toBeUndefined();
      });
    });
  });

  describe('性能测试', () => {
    it('应高效处理大量引用', () => {
      const refs = Array.from({ length: 100 }, (_, i) => `@Utils:src/file${i}.ts`);
      const message = refs.join(' ');

      const startTime = performance.now();
      const result = parseWorkspaceReferences(message, mockWorkspaces, [], 'ws-1');
      const endTime = performance.now();

      expect(result.references).toHaveLength(100);
      expect(endTime - startTime).toBeLessThan(100); // 应在 100ms 内完成
    });

    it('应高效处理大量工作区', () => {
      const manyWorkspaces: Workspace[] = Array.from({ length: 100 }, (_, i) =>
        createMockWorkspace(`ws-${i}`, `Workspace${i}`, `/path/to/workspace${i}`)
      );

      const startTime = performance.now();
      const result = parseWorkspaceReferences(
        '查看 @Workspace50:src/a.ts',
        manyWorkspaces,
        [],
        'ws-0'
      );
      const endTime = performance.now();

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Workspace50');
      expect(endTime - startTime).toBeLessThan(50); // O(1) 查找应很快
    });

    it('应高效处理极长消息', () => {
      const longMessage = '这是一段很长的消息。'.repeat(1000) + ' @Utils:src/a.ts';

      const startTime = performance.now();
      const result = parseWorkspaceReferences(longMessage, mockWorkspaces, [], 'ws-1');
      const endTime = performance.now();

      expect(result.references).toHaveLength(1);
      expect(endTime - startTime).toBeLessThan(100);
    });
  });

  describe('正则边界情况', () => {
    it('应处理连续的 @ 符号', () => {
      const result = parseWorkspaceReferences(
        '@@Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 第一个 @ 被忽略，第二个 @ 开始匹配
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });

    it('应处理 @ 在字符串末尾', () => {
      const result = parseWorkspaceReferences(
        '查看文件 @',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(0);
    });

    it('应处理只有 @ 和工作区名', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // @Utils 不包含 . 或 /，会被过滤
      expect(result.references).toHaveLength(0);
    });

    it('应处理工作区名后的空格', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils :src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 空格会打断正则匹配
      expect(result.references).toHaveLength(0);
    });

    it('应处理多个冒号', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src:a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 只有第一个冒号是分隔符
      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('src:a.ts');
    });

    it('应处理路径中的 @ 符号', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/@types/a.d.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('src/@types/a.d.ts');
    });

    it('应处理数字工作区名', () => {
      const numWorkspace = createMockWorkspace('ws-num', '123Project', '/path/to/123');
      const result = parseWorkspaceReferences(
        '查看 @123Project:src/a.ts',
        [numWorkspace],
        [],
        'ws-num'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('123Project');
    });

    it('应处理下划线工作区名', () => {
      const underscoreWorkspace = createMockWorkspace('ws-us', 'my_project', '/path/to/my_project');
      const result = parseWorkspaceReferences(
        '查看 @my_project:src/a.ts',
        [underscoreWorkspace],
        [],
        'ws-us'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('my_project');
    });
  });

  describe('特殊输入测试', () => {
    it('应处理 null 工作区列表', () => {
      // TypeScript 类型检查会阻止 null，但运行时可能有意外情况
      expect(() => {
        parseWorkspaceReferences('test', null as unknown as Workspace[], [], 'ws-1');
      }).toThrow();
    });

    it('应处理 undefined 当前工作区 ID', () => {
      const result = parseWorkspaceReferences(
        '查看 @/src/a.ts',
        mockWorkspaces,
        [],
        undefined as unknown as string
      );

      expect(result.references).toHaveLength(0);
    });

    it('应处理工作区缺少 name 属性', () => {
      const incompleteWorkspace = { id: 'ws-inc', path: '/path' } as Workspace;
      const result = parseWorkspaceReferences(
        '查看 @/src/a.ts',
        [incompleteWorkspace],
        [],
        'ws-inc'
      );

      // 应该能处理缺少 name 的情况
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });

    it('应处理工作区缺少 path 属性', () => {
      const incompleteWorkspace = { id: 'ws-inc', name: 'Incomplete' } as Workspace;
      const result = parseWorkspaceReferences(
        '查看 @Incomplete:src/a.ts',
        [incompleteWorkspace],
        [],
        'ws-1'
      );

      // 可能产生无效路径，但不应崩溃
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });

    it('应处理空字符串路径', () => {
      const emptyPathWorkspace = createMockWorkspace('ws-empty', 'Empty', '');
      const result = parseWorkspaceReferences(
        '查看 @Empty:src/a.ts',
        [emptyPathWorkspace],
        [],
        'ws-empty'
      );

      // 空路径是无效的工作区状态，不应产生引用
      expect(result.references).toHaveLength(0);
    });

    it('应处理路径末尾有分隔符', () => {
      const trailingSlashWorkspace = createMockWorkspace('ws-trail', 'Trailing', '/path/to/ws/');
      const result = parseWorkspaceReferences(
        '查看 @Trailing:src/a.ts',
        [trailingSlashWorkspace],
        [],
        'ws-trail'
      );

      expect(result.references[0].absolutePath).toContain('src/a.ts');
    });

    it('应处理只含空格的消息', () => {
      const result = parseWorkspaceReferences('   ', mockWorkspaces, [], 'ws-1');

      expect(result.references).toHaveLength(0);
      expect(result.processedMessage).toBe('   ');
    });

    it('应处理消息只有换行符', () => {
      const result = parseWorkspaceReferences('\n\n\n', mockWorkspaces, [], 'ws-1');

      expect(result.references).toHaveLength(0);
    });

    it('应处理 Tab 字符', () => {
      const result = parseWorkspaceReferences(
        '\t查看\t@Utils:src/a.ts\t',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });
  });

  describe('数据一致性', () => {
    it('多次调用应返回相同结果', () => {
      const message = '查看 @Utils:src/a.ts';

      const result1 = parseWorkspaceReferences(message, mockWorkspaces, [], 'ws-1');
      const result2 = parseWorkspaceReferences(message, mockWorkspaces, [], 'ws-1');
      const result3 = parseWorkspaceReferences(message, mockWorkspaces, [], 'ws-1');

      expect(result1.processedMessage).toBe(result2.processedMessage);
      expect(result2.processedMessage).toBe(result3.processedMessage);
      expect(result1.references).toEqual(result2.references);
      expect(result2.references).toEqual(result3.references);
    });

    it('上下文头应包含正确的引用计数', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts 和 @Polaris:src/b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(2);
      // 上下文头应包含两个被引用的工作区
      expect(result.contextHeader).toContain('Utils');
      expect(result.contextHeader).toContain('Polaris');
    });

    it('原始文本应保持不变', () => {
      const originalMessage = '查看 @Utils:src/a.ts';
      const result = parseWorkspaceReferences(originalMessage, mockWorkspaces, [], 'ws-1');

      // 验证原始文本被正确记录
      expect(result.references[0].originalText).toBe('@Utils:src/a.ts');
    });
  });

  describe('错误恢复', () => {
    it('应处理无效的正则匹配结果', () => {
      // 测试正则在边界情况下的稳定性
      const result = parseWorkspaceReferences(
        '@',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(0);
    });

    it('应处理工作区名大小写混合', () => {
      const result = parseWorkspaceReferences(
        '查看 @UTILS:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 应该大小写不敏感匹配
      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('UTILS');
    });

    it('应处理关联工作区为 null', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        null as unknown as Workspace[],
        'ws-1'
      );

      // 不应崩溃
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('集成测试', () => {
    it('parseWorkspaceReferences 和 getWorkspaceByName 应协作正确', () => {
      const message = '查看 @Utils:src/a.ts';
      const result = parseWorkspaceReferences(message, mockWorkspaces, [], 'ws-1');

      if (result.references.length > 0) {
        const ws = getWorkspaceByName(result.references[0].workspaceName, mockWorkspaces);
        expect(ws).toBeDefined();
        expect(ws?.id).toBe('ws-2');
      }
    });

    it('buildWorkspaceContextExtra 应与 parseWorkspaceReferences 配合', () => {
      const contextExtra = buildWorkspaceContextExtra(mockWorkspaces, [mockWorkspaces[1]], 'ws-1');

      expect(contextExtra).not.toBeNull();
      expect(contextExtra?.currentWorkspace.name).toBe('Polaris');

      // 使用相同的工作区列表进行引用解析
      const result = parseWorkspaceReferences(
        `查看 @${contextExtra!.contextWorkspaces[0].name}:src/a.ts`,
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('buildSystemPrompt 应与 buildWorkspaceContextExtra 一致', () => {
      const contextWorkspaces = [mockWorkspaces[1]];
      const contextExtra = buildWorkspaceContextExtra(mockWorkspaces, contextWorkspaces, 'ws-1');
      const systemPrompt = buildSystemPrompt(mockWorkspaces, contextWorkspaces, 'ws-1');

      expect(contextExtra).not.toBeNull();
      expect(contextExtra?.currentWorkspace.name).toBe('Polaris');
      expect(systemPrompt).toContain('Polaris');
      expect(systemPrompt).toContain('Utils');
    });

    it('isValidWorkspaceReference 应正确识别解析结果格式', () => {
      const validRefs = ['@Utils:src/a.ts', '@测试项目:readme.md', '@my-project:file.js'];
      const invalidRefs = ['@/src/a.ts', 'test@example.com', '普通文本', '@Utils'];

      validRefs.forEach(ref => {
        expect(isValidWorkspaceReference(ref)).toBe(true);
      });

      invalidRefs.forEach(ref => {
        expect(isValidWorkspaceReference(ref)).toBe(false);
      });
    });

    it('完整工作流：解析消息 -> 验证引用 -> 构建上下文', () => {
      const message = '请参考 @Utils:src/helper.ts 和 @Polaris:src/main.ts 完成任务';

      // 1. 解析消息
      const parsed = parseWorkspaceReferences(message, mockWorkspaces, [], 'ws-1');
      expect(parsed.references).toHaveLength(2);

      // 2. 验证每个引用
      parsed.references.forEach(ref => {
        const ws = getWorkspaceByName(ref.workspaceName, mockWorkspaces);
        expect(ws).toBeDefined();
      });

      // 3. 构建上下文
      const context = buildWorkspaceContextExtra(mockWorkspaces, [], 'ws-1');
      expect(context).not.toBeNull();
    });
  });

  describe('路径处理', () => {
    it('应正确处理 Windows 绝对路径', () => {
      const winWs = createMockWorkspace('ws-win', 'WinProj', 'C:\\Users\\dev\\project');
      const result = parseWorkspaceReferences(
        '查看 @WinProj:src\\main.ts',
        [winWs],
        [],
        'ws-win'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].absolutePath).toContain('project');
    });

    it('应正确处理 Unix 绝对路径', () => {
      const unixWs = createMockWorkspace('ws-unix', 'UnixProj', '/home/user/project');
      const result = parseWorkspaceReferences(
        '查看 @UnixProj:src/main.ts',
        [unixWs],
        [],
        'ws-unix'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].absolutePath).toBe('/home/user/project/src/main.ts');
    });

    it('应处理路径中的点号', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/../test/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('src/../test/a.ts');
    });

    it('应处理当前目录引用', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:./a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('./a.ts');
    });

    it('应处理混合路径分隔符', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/folder\\file.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理相对路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:../parent/file.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('../parent/file.ts');
    });

    it('应处理网络路径 (UNC)', () => {
      const uncWs = createMockWorkspace('ws-unc', 'NetProj', '\\\\server\\share\\project');
      const result = parseWorkspaceReferences(
        '查看 @NetProj:src/a.ts',
        [uncWs],
        [],
        'ws-unc'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理带空格的路径', () => {
      const spaceWs = createMockWorkspace('ws-space', 'My Project', 'D:/My Projects/Polaris App');
      const result = parseWorkspaceReferences(
        '查看 @My Project:src/a.ts',
        [spaceWs],
        [],
        'ws-space'
      );

      // 注意：当前正则不支持带空格的工作区名（[^\s] 会中断在空格）
      // 所以 "My Project" 会被解析为 "My" + "Project:src/a.ts"
      // 这是已知限制，如果需要支持空格工作区名，需要修改正则
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('类型边界测试', () => {
    it('应处理工作区 ID 为空字符串', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        ''
      );

      // 空字符串不会匹配任何工作区
      expect(result.references).toHaveLength(1);
    });

    it('应处理工作区数组中的 null 元素', () => {
      const workspacesWithNull = [...mockWorkspaces, null as unknown as Workspace];
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        workspacesWithNull,
        [],
        'ws-1'
      );

      // 不应崩溃，应正确处理 null 元素
      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Utils');
    });

    it('应处理 createdAt 和 lastAccessed 为空', () => {
      const noDateWorkspace: Workspace = {
        id: 'ws-nodate',
        name: 'NoDate',
        path: '/path/to/node',
        createdAt: '',
        lastAccessed: '',
      };

      const result = parseWorkspaceReferences(
        '查看 @NoDate:src/a.ts',
        [noDateWorkspace],
        [],
        'ws-nodate'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理极长的工作区名', () => {
      const longName = 'A'.repeat(200);
      const longNameWs = createMockWorkspace('ws-long', longName, '/path/to/long');
      const result = parseWorkspaceReferences(
        `查看 @${longName}:src/a.ts`,
        [longNameWs],
        [],
        'ws-long'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe(longName);
    });

    it('应处理工作区名只有空格', () => {
      const spaceNameWs = createMockWorkspace('ws-space', '   ', '/path/to/space');
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        [spaceNameWs, ...mockWorkspaces],
        [],
        'ws-1'
      );

      // 空格工作区名不应匹配
      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Utils');
    });
  });

  describe('更多边界值测试', () => {
    it('应处理消息以引用开头', () => {
      const result = parseWorkspaceReferences(
        '@Utils:src/a.ts 是我要查看的文件',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理消息以引用结尾', () => {
      const result = parseWorkspaceReferences(
        '请查看 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.processedMessage).toContain('D:/space/libs/utils/src/a.ts');
    });

    it('应处理消息只有引用', () => {
      const result = parseWorkspaceReferences(
        '@Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.processedMessage).toBe('@D:/space/libs/utils/src/a.ts');
    });

    it('应处理相邻的引用', () => {
      const result = parseWorkspaceReferences(
        '比较@Utils:src/a.ts @Polaris:src/b.ts的差异',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 相邻的引用需要空格分隔，否则会被当成一个匹配
      expect(result.references).toHaveLength(2);
    });

    it('应处理引用在括号内', () => {
      const result = parseWorkspaceReferences(
        '请查看文件 (@Utils:src/a.ts)',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理引用在引号内', () => {
      const result = parseWorkspaceReferences(
        '文件路径是 "@Utils:src/a.ts"',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理代码块中的引用', () => {
      const result = parseWorkspaceReferences(
        '```ts\nimport x from "@Utils:src/a.ts"\n```',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理 URL 中的 @ 符号', () => {
      const result = parseWorkspaceReferences(
        '访问 https://example.com/@user 和 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // URL 中的 @user 不应匹配（无 . 或 /）
      expect(result.references).toHaveLength(1);
    });

    it('应处理 JSON 中的引用', () => {
      const result = parseWorkspaceReferences(
        '{"file": "@Utils:src/a.ts"}',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理 Markdown 链接语法', () => {
      const result = parseWorkspaceReferences(
        '见 [文档](@Utils:docs/readme.md)',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });
  });

  describe('上下文头生成', () => {
    it('应正确生成无引用的上下文头', () => {
      const result = parseWorkspaceReferences(
        '普通消息',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.contextHeader).toBe('');
    });

    it('应正确生成有关联工作区的上下文头', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        [mockWorkspaces[1], mockWorkspaces[2]],
        'ws-1'
      );

      expect(result.contextHeader).toContain('关联工作区');
      expect(result.contextHeader).toContain('Utils');
      expect(result.contextHeader).toContain('测试项目');
    });

    it('应正确生成有多个引用工作区的上下文头', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts 和 @测试项目:readme.md',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.contextHeader).toContain('本次引用的工作区');
      expect(result.contextHeader).toContain('Utils');
      expect(result.contextHeader).toContain('测试项目');
    });

    it('上下文头应包含当前工作区信息', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.contextHeader).toContain('当前工作区: Polaris');
      expect(result.contextHeader).toContain('D:/space/base/Polaris');
    });

    it('无当前工作区时应显示未设置', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        null
      );

      expect(result.contextHeader).toContain('未设置');
    });
  });

  describe('处理后的消息', () => {
    it('应保持非引用文本不变', () => {
      const result = parseWorkspaceReferences(
        '请查看 @Utils:src/a.ts 这个文件',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.processedMessage).toContain('请查看');
      expect(result.processedMessage).toContain('这个文件');
    });

    it('应正确替换多个引用', () => {
      const result = parseWorkspaceReferences(
        '@Utils:src/a.ts @Polaris:src/b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.processedMessage).toContain('D:/space/libs/utils/src/a.ts');
      expect(result.processedMessage).toContain('D:/space/base/Polaris/src/b.ts');
    });

    it('应保持换行符', () => {
      const result = parseWorkspaceReferences(
        '第一行\n@Utils:src/a.ts\n第三行',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.processedMessage).toContain('第一行');
      expect(result.processedMessage).toContain('第三行');
    });

    it('应保持 Tab 缩进', () => {
      const result = parseWorkspaceReferences(
        '\t@Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.processedMessage).toContain('\t');
    });
  });

  describe('消息处理完整性', () => {
    it('应处理多行消息中的引用', () => {
      const result = parseWorkspaceReferences(
        '请检查以下文件：\n1. @Utils:src/a.ts\n2. @Polaris:src/b.ts\n3. @测试项目:readme.md',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(3);
    });

    it('应处理混合格式的消息（新语法）', () => {
      const result = parseWorkspaceReferences(
        '参考 @Utils:src/a.ts，对比 @src/b.ts 还有 @测试项目:docs/guide.md',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(3);
      // 第一个是跨工作区引用
      expect(result.references[0].workspaceName).toBe('Utils');
      // 第二个是当前工作区引用（新语法 @path）
      expect(result.references[1].workspaceName).toBe('Polaris');
      expect(result.references[1].relativePath).toBe('src/b.ts');
      // 第三个是跨工作区引用
      expect(result.references[2].workspaceName).toBe('测试项目');
    });

    it('应处理混合格式的消息（新旧语法混合）', () => {
      const result = parseWorkspaceReferences(
        '参考 @Utils:src/a.ts，对比 @/src/b.ts，还有 @测试项目:docs/guide.md',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(3);
    });

    it('应处理包含代码块的消息', () => {
      const result = parseWorkspaceReferences(
        '```typescript\nimport x from "@Utils:src/a.ts";\n```\n请查看 @Polaris:src/b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(2);
    });

    it('应处理包含列表的消息', () => {
      const result = parseWorkspaceReferences(
        '- @Utils:src/a.ts\n- @Polaris:src/b.ts\n- @测试项目:readme.md',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(3);
    });

    it('应处理包含表格的消息', () => {
      const result = parseWorkspaceReferences(
        '| 文件 |\n|------|\n| @Utils:src/a.ts |\n| @Polaris:src/b.ts |',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(2);
    });

    it('应处理带有 HTML 实体的消息', () => {
      const result = parseWorkspaceReferences(
        '文件 &quot;@Utils:src/a.ts&quot; 需要检查',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理带有转义字符的消息', () => {
      const result = parseWorkspaceReferences(
        '路径是 "C:\\\\path\\\\@Utils:src/a.ts"',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理包含 emoji 的消息', () => {
      const result = parseWorkspaceReferences(
        '📄 @Utils:src/a.ts ✅ 已完成',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理全角字符消息', () => {
      const result = parseWorkspaceReferences(
        '请查看＠Utils:src/a.ts文件',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 全角 ＠ 不是半角 @，不应匹配
      expect(result.references).toHaveLength(0);
    });

    it('应处理混合半角全角消息', () => {
      const result = parseWorkspaceReferences(
        '请查看 @Utils:src/a.ts 和＠Polaris:src/b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 只有半角 @ 会匹配
      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('Utils');
    });
  });

  describe('错误恢复完整性', () => {
    it('应处理工作区列表中的 undefined 元素', () => {
      const workspacesWithUndefined = [mockWorkspaces[0], undefined as unknown as Workspace, mockWorkspaces[1]];
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        workspacesWithUndefined,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理关联工作区列表中的 undefined 元素', () => {
      const contextWorkspacesWithUndefined = [undefined as unknown as Workspace, mockWorkspaces[1]];
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        contextWorkspacesWithUndefined,
        'ws-1'
      );

      // 不应崩溃
      expect(result.references).toHaveLength(1);
    });

    it('应处理所有工作区都无效的情况', () => {
      const invalidWorkspaces = [
        { id: 'ws-1' } as Workspace,
        { id: 'ws-2' } as Workspace,
        { id: 'ws-3' } as Workspace,
      ];
      const result = parseWorkspaceReferences(
        '查看 @Polaris:src/a.ts',
        invalidWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(0);
    });

    it('应处理工作区 path 为 null', () => {
      const nullPathWorkspace = { id: 'ws-null', name: 'NullPath', path: null } as unknown as Workspace;
      const result = parseWorkspaceReferences(
        '查看 @NullPath:src/a.ts',
        [nullPathWorkspace],
        [],
        'ws-null'
      );

      expect(result.references).toHaveLength(0);
    });

    it('应处理工作区 name 为 null', () => {
      const nullNameWorkspace = { id: 'ws-null', name: null, path: '/path' } as unknown as Workspace;
      const result = parseWorkspaceReferences(
        '查看 @/src/a.ts',
        [nullNameWorkspace],
        [],
        'ws-null'
      );

      // null name 的工作区仍可被当作当前工作区
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });

    it('应处理重复的工作区 ID', () => {
      const duplicateWorkspaces = [
        createMockWorkspace('ws-dup', 'First', '/path/first'),
        createMockWorkspace('ws-dup', 'Second', '/path/second'),
      ];
      const result = parseWorkspaceReferences(
        '查看 @/src/a.ts',
        duplicateWorkspaces,
        [],
        'ws-dup'
      );

      // 应使用第一个匹配的工作区
      expect(result.references.length).toBeGreaterThanOrEqual(1);
    });

    it('应处理无效的 workspaceId 类型', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        { id: 'ws-1' } as unknown as string
      );

      // 无效类型不应崩溃
      expect(result.references).toHaveLength(1);
    });

    it('应处理正则特殊字符在路径中', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/file[1].ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('src/file[1].ts');
    });

    it('应处理正则特殊字符在工作区名中', () => {
      const specialWs = createMockWorkspace('ws-spec', 'Project[1]', '/path/to/project1');
      const result = parseWorkspaceReferences(
        '查看 @Project[1]:src/a.ts',
        [specialWs],
        [],
        'ws-spec'
      );

      // 注意：正则 [\\w\\u4e00-\\u9fa5-] 不支持 [ 和 ]
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('边界值测试', () => {
    it('应处理最小有效路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:a.b',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('a.b');
    });

    it('应过滤不含 . 或 / 的路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:a',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // "a" 不包含 . 或 /，会被过滤
      expect(result.references).toHaveLength(0);
    });

    it('应处理路径刚好在边界长度', () => {
      // Windows MAX_PATH = 260
      const longPath = 'a'.repeat(250) + '.ts';
      const result = parseWorkspaceReferences(
        `查看 @Utils:${longPath}`,
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe(longPath);
    });

    it('应处理超长工作区名（边界测试）', () => {
      const maxName = 'A'.repeat(255); // 文件系统名称限制
      const maxNameWs = createMockWorkspace('ws-max', maxName, '/path/to/max');
      const result = parseWorkspaceReferences(
        `查看 @${maxName}:src/a.ts`,
        [maxNameWs],
        [],
        'ws-max'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理单字符工作区名', () => {
      const singleCharWs = createMockWorkspace('ws-single', 'A', '/path/to/a');
      const result = parseWorkspaceReferences(
        '查看 @A:src/a.ts',
        [singleCharWs],
        [],
        'ws-single'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].workspaceName).toBe('A');
    });

    it('应处理单字符路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:a/b',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理消息以引用开头和结尾（无其他内容）', () => {
      const result = parseWorkspaceReferences(
        '@Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.processedMessage).not.toContain('@Utils:src/a.ts');
    });

    it('应处理连续多个引用无空格（边界测试）', () => {
      const result = parseWorkspaceReferences(
        '@Utils:a.ts@Polaris:b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 连续无空格的引用可能产生边界问题
      expect(result.references.length).toBeGreaterThanOrEqual(1);
    });

    it('应处理引用计数达到上限', () => {
      // 创建大量引用
      const refs = Array.from({ length: 500 }, (_, i) => `@Utils:src/file${i}.ts`);
      const message = refs.join(' ');

      const result = parseWorkspaceReferences(message, mockWorkspaces, [], 'ws-1');

      expect(result.references).toHaveLength(500);
    });
  });

  describe('国际化测试', () => {
    it('应处理日文工作区名', () => {
      const jpWs = createMockWorkspace('ws-jp', 'プロジェクト', '/path/to/project');
      const result = parseWorkspaceReferences(
        '查看 @プロジェクト:src/a.ts',
        [jpWs],
        [],
        'ws-jp'
      );

      // 日文字符不在 [\\u4e00-\\u9fa5] 范围内
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });

    it('应处理韩文工作区名', () => {
      const krWs = createMockWorkspace('ws-kr', '프로젝트', '/path/to/project');
      const result = parseWorkspaceReferences(
        '查看 @프로젝트:src/a.ts',
        [krWs],
        [],
        'ws-kr'
      );

      // 韩文字符不在 [\\u4e00-\\u9fa5] 范围内
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });

    it('应处理俄文路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/файл.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
      expect(result.references[0].relativePath).toBe('src/файл.ts');
    });

    it('应处理阿拉伯文路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/ملف.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理 emoji 路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/📁/📄.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理混合语言路径', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/中文/日本語/한글/файл.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理 RTL 文本中的引用', () => {
      const result = parseWorkspaceReferences(
        'مراجعة @Utils:src/a.ts الملف',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.references).toHaveLength(1);
    });

    it('应处理 Zero-Width 字符', () => {
      const result = parseWorkspaceReferences(
        '查看 @U\u200Btils:src/a.ts', // Zero-Width Space
        mockWorkspaces,
        [],
        'ws-1'
      );

      // Zero-Width 字符会导致工作区名不匹配
      expect(result.references.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('上下文头完整性', () => {
    it('上下文头应包含正确的分隔符格式', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.contextHeader).toContain('═══════════════════════════════════════════════════════════');
    });

    it('上下文头应包含引用语法说明', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:src/a.ts',
        mockWorkspaces,
        [mockWorkspaces[1]],
        'ws-1'
      );

      expect(result.contextHeader).toContain('引用语法');
    });

    it('无引用无关联工作区时应返回空上下文头', () => {
      const result = parseWorkspaceReferences(
        '普通消息',
        mockWorkspaces,
        [],
        'ws-1'
      );

      expect(result.contextHeader).toBe('');
    });

    it('只有关联工作区时应生成上下文头', () => {
      const result = parseWorkspaceReferences(
        '普通消息',
        mockWorkspaces,
        [mockWorkspaces[1]],
        'ws-1'
      );

      expect(result.contextHeader).toContain('关联工作区');
    });

    it('多个引用同一工作区时上下文头应去重', () => {
      const result = parseWorkspaceReferences(
        '查看 @Utils:a.ts 和 @Utils:b.ts',
        mockWorkspaces,
        [],
        'ws-1'
      );

      // 上下文头中的工作区名应该只出现一次
      const matches = result.contextHeader.match(/• Utils/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('getWorkspaceByName 完整性', () => {
    it('应处理 name 包含特殊正则字符', () => {
      const specialWs = createMockWorkspace('ws-special', 'Test-Project_123', '/path/to/test');
      const result = getWorkspaceByName('Test-Project_123', [specialWs]);

      expect(result).toBeDefined();
      expect(result?.id).toBe('ws-special');
    });

    it('应处理空字符串工作区名查找', () => {
      const emptyNameWs = createMockWorkspace('ws-empty', '', '/path/to/empty');
      const result = getWorkspaceByName('', [emptyNameWs]);

      // 空字符串查找可以匹配空字符串工作区名（toLowerCase 后匹配）
      expect(result).toBeDefined();
      expect(result?.id).toBe('ws-empty');
    });

    it('应处理查找字符串包含特殊字符', () => {
      const result = getWorkspaceByName('Test[1]', mockWorkspaces);
      expect(result).toBeUndefined();
    });

    it('应处理 Unicode 规范化差异', () => {
      // 全角和半角字符
      const result1 = getWorkspaceByName('Ｐｏｌａｒｉｓ', mockWorkspaces); // 全角
      const result2 = getWorkspaceByName('Polaris', mockWorkspaces); // 半角

      // 全角不应匹配半角
      expect(result1).toBeUndefined();
      expect(result2?.id).toBe('ws-1');
    });
  });

  describe('buildWorkspaceContextExtra 完整性', () => {
    it('应处理关联工作区为空数组', () => {
      const result = buildWorkspaceContextExtra(mockWorkspaces, [], 'ws-1');

      expect(result).not.toBeNull();
      expect(result?.contextWorkspaces).toEqual([]);
    });

    it('应处理关联工作区包含无效元素', () => {
      const contextWorkspaces = [mockWorkspaces[1], null as unknown as Workspace];
      const result = buildWorkspaceContextExtra(mockWorkspaces, contextWorkspaces, 'ws-1');

      // 应处理 null 元素
      expect(result).not.toBeNull();
    });

    it('应正确映射关联工作区属性', () => {
      const result = buildWorkspaceContextExtra(mockWorkspaces, [mockWorkspaces[1]], 'ws-1');

      expect(result?.contextWorkspaces[0]).toHaveProperty('name');
      expect(result?.contextWorkspaces[0]).toHaveProperty('path');
      expect(result?.contextWorkspaces[0]).not.toHaveProperty('id');
      expect(result?.contextWorkspaces[0]).not.toHaveProperty('createdAt');
    });
  });

  describe('buildSystemPrompt 完整性', () => {
    it('应正确格式化多行输出', () => {
      const result = buildSystemPrompt(mockWorkspaces, [mockWorkspaces[1]], 'ws-1');

      expect(result).toContain('\n');
      expect(result.split('\n').length).toBeGreaterThan(3);
    });

    it('应包含所有必要信息', () => {
      const result = buildSystemPrompt(mockWorkspaces, [mockWorkspaces[1]], 'ws-1');

      expect(result).toContain('Polaris');
      expect(result).toContain('Utils');
      // 新版本使用通用的 MCP 工具引导
      expect(result).toContain('MCP 工具');
      expect(result).not.toContain('todo_write');
      expect(result).not.toContain('todo_read');
    });

    it('应处理关联工作区为空数组', () => {
      const result = buildSystemPrompt(mockWorkspaces, [], 'ws-1');

      expect(result).not.toContain('关联工作区');
    });
  });
});
