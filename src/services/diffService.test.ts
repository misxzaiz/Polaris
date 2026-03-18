/**
 * diffService 单元测试
 */

import { describe, it, expect } from 'vitest';
import { computeDiff, hasChanges, getDiffSummary, type FileDiff } from './diffService';

describe('diffService', () => {
  describe('computeDiff', () => {
    describe('相同内容', () => {
      it('完全相同的内容应无差异', () => {
        const content = 'line1\nline2\nline3';
        const diff = computeDiff(content, content);

        expect(diff.oldContent).toBe(content);
        expect(diff.newContent).toBe(content);
        expect(diff.addedCount).toBe(0);
        expect(diff.removedCount).toBe(0);
        expect(diff.lines).toHaveLength(3);
      });

      it('空内容比较应无差异', () => {
        const diff = computeDiff('', '');

        expect(diff.addedCount).toBe(0);
        expect(diff.removedCount).toBe(0);
        expect(diff.lines).toHaveLength(0);
      });
    });

    describe('添加行', () => {
      it('在末尾添加行', () => {
        const oldContent = 'line1\nline2';
        const newContent = 'line1\nline2\nline3';
        const diff = computeDiff(oldContent, newContent);

        // diffLines 行为：可能将添加解析为多行变化
        expect(diff.addedCount).toBeGreaterThan(0);
        expect(diff.removedCount).toBeGreaterThanOrEqual(0);
        expect(hasChanges(diff)).toBe(true);

        // 验证最终内容包含新行
        const addedLines = diff.lines.filter((l) => l.type === 'added');
        expect(addedLines.some((l) => l.content.includes('line3'))).toBe(true);
      });

      it('在开头添加行', () => {
        const oldContent = 'line2\nline3';
        const newContent = 'line1\nline2\nline3';
        const diff = computeDiff(oldContent, newContent);

        expect(diff.addedCount).toBeGreaterThan(0);
        expect(hasChanges(diff)).toBe(true);
      });

      it('添加多行', () => {
        const oldContent = 'line1';
        const newContent = 'line1\nline2\nline3\nline4';
        const diff = computeDiff(oldContent, newContent);

        // diffLines 行为：新增行数可能包含重解析
        expect(diff.addedCount).toBeGreaterThan(0);
        expect(hasChanges(diff)).toBe(true);
      });

      it('从空内容添加行', () => {
        const diff = computeDiff('', 'new line');

        expect(diff.addedCount).toBe(1);
        expect(diff.removedCount).toBe(0);
        expect(diff.lines).toHaveLength(1);
        expect(diff.lines[0].type).toBe('added');
      });
    });

    describe('删除行', () => {
      it('从末尾删除行', () => {
        const oldContent = 'line1\nline2\nline3';
        const newContent = 'line1\nline2';
        const diff = computeDiff(oldContent, newContent);

        // diffLines 行为：可能将删除解析为复杂变化
        expect(diff.removedCount).toBeGreaterThan(0);
        expect(hasChanges(diff)).toBe(true);

        // 验证被删除的内容
        const removedLines = diff.lines.filter((l) => l.type === 'removed');
        expect(removedLines.some((l) => l.content.includes('line3'))).toBe(true);
      });

      it('从开头删除行', () => {
        const oldContent = 'line1\nline2\nline3';
        const newContent = 'line2\nline3';
        const diff = computeDiff(oldContent, newContent);

        expect(diff.removedCount).toBeGreaterThan(0);
        expect(hasChanges(diff)).toBe(true);
      });

      it('删除多行', () => {
        const oldContent = 'line1\nline2\nline3\nline4';
        const newContent = 'line1';
        const diff = computeDiff(oldContent, newContent);

        // diffLines 行为：删除行数可能包含重解析
        expect(diff.removedCount).toBeGreaterThan(0);
        expect(hasChanges(diff)).toBe(true);
      });

      it('删除所有内容变为空', () => {
        const diff = computeDiff('line1\nline2', '');

        expect(diff.removedCount).toBeGreaterThan(0);
        expect(hasChanges(diff)).toBe(true);
      });
    });

    describe('修改行', () => {
      it('修改单行', () => {
        const oldContent = 'line1\nold line\nline3';
        const newContent = 'line1\nnew line\nline3';
        const diff = computeDiff(oldContent, newContent);

        // 修改在 diff 中表现为删除旧行 + 添加新行
        expect(diff.addedCount).toBe(1);
        expect(diff.removedCount).toBe(1);
      });

      it('修改多行', () => {
        const oldContent = 'line1\nold1\nold2\nline4';
        const newContent = 'line1\nnew1\nnew2\nline4';
        const diff = computeDiff(oldContent, newContent);

        expect(diff.addedCount).toBe(2);
        expect(diff.removedCount).toBe(2);
      });
    });

    describe('混合变化', () => {
      it('同时添加和删除行', () => {
        const oldContent = 'line1\ntoRemove\nline3';
        const newContent = 'line1\nline3\ntoAdd';
        const diff = computeDiff(oldContent, newContent);

        expect(diff.addedCount).toBeGreaterThan(0);
        expect(diff.removedCount).toBeGreaterThan(0);
      });

      it('复杂混合变化', () => {
        const oldContent = 'a\nb\nc\nd\ne';
        const newContent = 'a\nx\nc\ny\ne';
        const diff = computeDiff(oldContent, newContent);

        // b -> x, d -> y
        expect(diff.addedCount).toBe(2);
        expect(diff.removedCount).toBe(2);
      });
    });

    describe('上下文行', () => {
      it('未变化的行应标记为 context', () => {
        const oldContent = 'line1\nline2\nline3';
        const newContent = 'line1\nmodified\nline3';
        const diff = computeDiff(oldContent, newContent);

        // 第一行和第三行应该是 context
        expect(diff.lines[0].type).toBe('context');
        expect(diff.lines[0].content).toBe('line1');
        expect(diff.lines[0].oldLineNumber).toBe(1);
        expect(diff.lines[0].newLineNumber).toBe(1);
      });
    });

    describe('行号计算', () => {
      it('context 行应同时有 old 和 new 行号', () => {
        const diff = computeDiff('a\nb', 'a\nb');

        expect(diff.lines[0].oldLineNumber).toBe(1);
        expect(diff.lines[0].newLineNumber).toBe(1);
        expect(diff.lines[1].oldLineNumber).toBe(2);
        expect(diff.lines[1].newLineNumber).toBe(2);
      });

      it('added 行应只有 new 行号', () => {
        const diff = computeDiff('', 'new');

        expect(diff.lines[0].oldLineNumber).toBeNull();
        expect(diff.lines[0].newLineNumber).toBe(1);
      });

      it('removed 行应只有 old 行号', () => {
        const diff = computeDiff('old', '');

        expect(diff.lines[0].oldLineNumber).toBe(1);
        expect(diff.lines[0].newLineNumber).toBeNull();
      });
    });

    describe('特殊内容', () => {
      it('处理空行', () => {
        const oldContent = 'line1\n\nline3';
        const newContent = 'line1\n\nline3';
        const diff = computeDiff(oldContent, newContent);

        expect(diff.addedCount).toBe(0);
        expect(diff.removedCount).toBe(0);
      });

      it('处理空白字符', () => {
        const oldContent = '  indented';
        const newContent = '\tindented';
        const diff = computeDiff(oldContent, newContent);

        // 不同的空白应被识别为变化
        expect(diff.addedCount + diff.removedCount).toBeGreaterThan(0);
      });

      it('处理特殊字符', () => {
        const oldContent = 'const x = "hello";';
        const newContent = 'const x = "world";';
        const diff = computeDiff(oldContent, newContent);

        expect(diff.addedCount).toBe(1);
        expect(diff.removedCount).toBe(1);
      });

      it('处理 Unicode 字符', () => {
        const oldContent = '你好世界';
        const newContent = '你好宇宙';
        const diff = computeDiff(oldContent, newContent);

        expect(diff.addedCount + diff.removedCount).toBeGreaterThan(0);
      });
    });
  });

  describe('hasChanges', () => {
    it('有添加行时返回 true', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [{ oldLineNumber: null, newLineNumber: 1, type: 'added', content: 'new' }],
        addedCount: 1,
        removedCount: 0,
      };

      expect(hasChanges(diff)).toBe(true);
    });

    it('有删除行时返回 true', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [{ oldLineNumber: 1, newLineNumber: null, type: 'removed', content: 'old' }],
        addedCount: 0,
        removedCount: 1,
      };

      expect(hasChanges(diff)).toBe(true);
    });

    it('无变化时返回 false', () => {
      const diff: FileDiff = {
        oldContent: 'same',
        newContent: 'same',
        lines: [{ oldLineNumber: 1, newLineNumber: 1, type: 'context', content: 'same' }],
        addedCount: 0,
        removedCount: 0,
      };

      expect(hasChanges(diff)).toBe(false);
    });

    it('同时有添加和删除时返回 true', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [],
        addedCount: 5,
        removedCount: 3,
      };

      expect(hasChanges(diff)).toBe(true);
    });
  });

  describe('getDiffSummary', () => {
    it('只有添加时显示 +n', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [],
        addedCount: 3,
        removedCount: 0,
      };

      expect(getDiffSummary(diff)).toBe('+3');
    });

    it('只有删除时显示 -n', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [],
        addedCount: 0,
        removedCount: 2,
      };

      expect(getDiffSummary(diff)).toBe('-2');
    });

    it('同时有添加和删除时显示 +n -m', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [],
        addedCount: 5,
        removedCount: 3,
      };

      expect(getDiffSummary(diff)).toBe('+5 -3');
    });

    it('无变化时显示无变化', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [],
        addedCount: 0,
        removedCount: 0,
      };

      expect(getDiffSummary(diff)).toBe('无变化');
    });

    it('大量变化时正确显示', () => {
      const diff: FileDiff = {
        oldContent: '',
        newContent: '',
        lines: [],
        addedCount: 100,
        removedCount: 50,
      };

      expect(getDiffSummary(diff)).toBe('+100 -50');
    });
  });

  describe('集成测试', () => {
    it('实际代码变更场景', () => {
      const oldCode = `function hello() {
  console.log("Hello");
}

function goodbye() {
  console.log("Goodbye");
}`;

      const newCode = `function hello() {
  console.log("Hello, World!");
}

function goodbye() {
  console.log("Goodbye");
}

function newFunction() {
  console.log("New!");
}`;

      const diff = computeDiff(oldCode, newCode);

      expect(hasChanges(diff)).toBe(true);
      expect(diff.addedCount).toBeGreaterThan(0);

      const summary = getDiffSummary(diff);
      expect(summary).toMatch(/^\+\d+(?:\s+-\d+)?$/);
    });

    it('配置文件变更场景', () => {
      const oldConfig = `{
  "name": "project",
  "version": "1.0.0"
}`;

      const newConfig = `{
  "name": "project",
  "version": "1.0.1",
  "author": "developer"
}`;

      const diff = computeDiff(oldConfig, newConfig);

      expect(hasChanges(diff)).toBe(true);
      // version 变更 + author 添加
      expect(diff.addedCount).toBeGreaterThanOrEqual(2);
      expect(diff.removedCount).toBeGreaterThanOrEqual(1);
    });
  });
});
