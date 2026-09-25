/**
 * runArtifacts 共享数据源工具测试
 *
 * 覆盖三个数据源的提取逻辑（底部操作区与灵动岛共用）：
 * - extractFileChanges：apply_patch / Edit / Write 工具 → 变更文件列表（去重合并）
 * - extractArtifacts：artifact_preview / plugin_card(result) → 产物预览（同 id 新版本覆盖）
 * - extractProcessBlocks：过程块筛选
 */

import { describe, it, expect } from 'vitest';
import {
  extractFileChanges,
  extractArtifacts,
  extractProcessBlocks,
  splitFilePath,
  computeDiffStats,
} from './runArtifacts';
import type { ContentBlock, ToolCallBlock, ArtifactPreviewBlock } from '@/types';

function toolCall(overrides: Partial<ToolCallBlock> & { id: string; name: string }): ToolCallBlock {
  return {
    type: 'tool_call',
    status: 'completed',
    input: {},
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:00:01.000Z',
    duration: 1000,
    ...overrides,
  };
}

describe('extractFileChanges', () => {
  it('apply_patch 多文件补丁提取 modified/deleted', () => {
    const blocks: ContentBlock[] = [
      toolCall({
        id: 't1',
        name: 'apply_patch',
        patchData: [
          { type: 'add', filePath: 'src/a.ts', chunkCount: 1, addedLines: 5, removedLines: 0, oldContent: '', newContent: 'x' },
          { type: 'update', filePath: 'src/b.ts', chunkCount: 1, addedLines: 2, removedLines: 1, oldContent: 'a', newContent: 'b' },
          { type: 'delete', filePath: 'src/old.ts', chunkCount: 1, addedLines: 0, removedLines: 10, oldContent: 'y', newContent: '' },
        ],
      }),
    ];
    const files = extractFileChanges(blocks);
    expect(files).toHaveLength(3);
    expect(files.find(f => f.fullPath === 'src/a.ts')).toMatchObject({ changeType: 'modified', fileName: 'a.ts', dirPath: 'src/' });
    expect(files.find(f => f.fullPath === 'src/old.ts')?.changeType).toBe('deleted');
  });

  it('Edit 工具提取 diffData 并标注 modified', () => {
    const blocks: ContentBlock[] = [
      toolCall({
        id: 't2',
        name: 'Edit',
        diffData: {
          filePath: 'src/components/Chat/x.tsx',
          oldContent: 'old',
          newContent: 'new',
          diffString: '--- a\n+++ b\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra',
          firstChangedLine: 1,
        },
      }),
    ];
    const files = extractFileChanges(blocks);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      fullPath: 'src/components/Chat/x.tsx',
      changeType: 'modified',
      fileName: 'x.tsx',
    });
    expect(files[0].diffData?.filePath).toBe('src/components/Chat/x.tsx');
  });

  it('Write 工具提取 created + newContent', () => {
    const blocks: ContentBlock[] = [
      toolCall({ id: 't3', name: 'Write', input: { file_path: 'notes/readme.md', content: '# 说明' } }),
    ];
    const files = extractFileChanges(blocks);
    expect(files[0]).toMatchObject({ fullPath: 'notes/readme.md', changeType: 'created' });
    expect(files[0].newContent).toBe('# 说明');
  });

  it('同一文件多次修改去重合并（保留 diff 数据）', () => {
    const blocks: ContentBlock[] = [
      toolCall({
        id: 't4',
        name: 'apply_patch',
        patchData: [
          { type: 'update', filePath: 'src/x.ts', chunkCount: 1, addedLines: 1, removedLines: 0, oldContent: '', newContent: 'a' },
        ],
      }),
      toolCall({
        id: 't5',
        name: 'Edit',
        diffData: { filePath: 'src/x.ts', oldContent: 'a', newContent: 'b', diffString: '+b\n-a' },
      }),
    ];
    const files = extractFileChanges(blocks);
    expect(files).toHaveLength(1);
    expect(files[0].changeType).toBe('modified');
    expect(files[0].diffData?.newContent).toBe('b');
  });

  it('跳过非 completed 工具块', () => {
    const blocks: ContentBlock[] = [
      toolCall({ id: 't6', name: 'Edit', status: 'running', diffData: { filePath: 'src/y.ts', oldContent: '', newContent: 'z' } }),
    ];
    expect(extractFileChanges(blocks)).toHaveLength(0);
  });
});

describe('extractArtifacts', () => {
  it('提取 artifact_preview 块（保序去重）', () => {
    const a1: ArtifactPreviewBlock = {
      type: 'artifact_preview', previewId: 'p1', title: '预览一', contentType: 'html', html: '<h1>1</h1>', version: 1,
    };
    const a2: ArtifactPreviewBlock = {
      type: 'artifact_preview', previewId: 'p2', title: '预览二', contentType: 'html', html: '<h1>2</h1>', version: 1,
    };
    const arts = extractArtifacts([a1, a2]);
    expect(arts.map(a => a.previewId)).toEqual(['p1', 'p2']);
  });

  it('同 previewId 新版本覆盖旧版本', () => {
    const v1: ArtifactPreviewBlock = {
      type: 'artifact_preview', previewId: 'p1', title: '旧版', contentType: 'html', html: '<h1>v1</h1>', version: 1,
    };
    const v3: ArtifactPreviewBlock = {
      type: 'artifact_preview', previewId: 'p1', title: '新版', contentType: 'html', html: '<h1>v3</h1>', version: 3, versionLabel: 'v3',
    };
    const arts = extractArtifacts([v1, v3]);
    expect(arts).toHaveLength(1);
    expect(arts[0].title).toBe('新版');
    expect(arts[0].version).toBe(3);
  });

  it('plugin_card(result, 含 html+previewId) 转为产物预览', () => {
    const card = {
      type: 'plugin_card',
      pluginId: 'mcp__polaris-prd-preview__preview_html',
      mode: 'result',
      status: 'ready',
      data: { previewId: 'prd-1', title: 'PRD 原型', html: '<h1>prd</h1>', version: 2, versionLabel: 'v2' },
    } as unknown as ContentBlock;
    const arts = extractArtifacts([card]);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({
      previewId: 'prd-1',
      title: 'PRD 原型',
      contentType: 'html',
      version: 2,
    });
  });
});

describe('extractProcessBlocks', () => {
  it('筛选过程块并保留顺序', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: '非空文本也是过程块' },
      { type: 'thinking', content: '思考' },
      { type: 'text', content: '' },
      { type: 'text', content: '...' },
      toolCall({ id: 't1', name: 'bash' }),
    ];
    const process = extractProcessBlocks(blocks);
    expect(process.map(b => b.type)).toEqual(['text', 'thinking', 'tool_call']);
  });
});

describe('splitFilePath / computeDiffStats', () => {
  it('拆分文件路径', () => {
    expect(splitFilePath('src/a/b.ts')).toEqual({ fileName: 'b.ts', dirPath: 'src/a/' });
    expect(splitFilePath('C:\\win\\x.js')).toEqual({ fileName: 'x.js', dirPath: 'C:/win/' });
    expect(splitFilePath('single.txt')).toEqual({ fileName: 'single.txt', dirPath: '' });
  });

  it('从 diffString 统计 +/- 行数', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@\n old\n+new1\n+new2\n-removed';
    expect(computeDiffStats({ filePath: 'x', newContent: '', diffString: diff })).toEqual({ added: 2, removed: 1 });
  });
});
