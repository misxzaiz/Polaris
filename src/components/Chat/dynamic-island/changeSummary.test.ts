/**
 * changeSummary 派生函数测试
 *
 * 覆盖（plans/dynamic-island-change-summary-plan.md 第十节验收）：
 * - 多引擎工具名归一（claude str_replace_editor / simpleai edit_file / write_file）
 * - apply_patch 多文件补丁（add/update/delete 映射）
 * - 同文件多次操作累加、MRU 排序、上限裁剪
 * - failed / running 块不计入文件操作
 * - bash 后台任务：启动回执 ≠ 任务结束（completed 块仍计 running）
 * - 历史消息 WeakMap 缓存不被 currentBlocks 污染
 */

import { describe, it, expect } from 'vitest';
import { deriveChangeSummary, EMPTY_CHANGE_SUMMARY, MAX_DIFF_CHARS, MAX_FILES } from './changeSummary';
import type { AssistantChatMessage, ChatMessage, ToolCallBlock } from '@/types';

function toolBlock(overrides?: Partial<ToolCallBlock>): ToolCallBlock {
  return {
    type: 'tool_call',
    id: 'tc-1',
    name: 'str_replace_editor',
    input: {},
    status: 'completed',
    startedAt: '2026-10-27T10:00:00.000Z',
    ...overrides,
  };
}

function assistantMessage(blocks: ToolCallBlock[], timestamp = '2026-10-27T10:00:00.000Z'): ChatMessage {
  return {
    id: 'msg-1',
    type: 'assistant',
    timestamp,
    blocks,
  } as AssistantChatMessage;
}

describe('deriveChangeSummary - 文件操作', () => {
  it('edit 块从 diffData 计行数，同文件多次操作累加', () => {
    const msg = assistantMessage([
      toolBlock({
        id: 'tc-1',
        name: 'str_replace_editor',
        input: { file_path: 'src/a.ts' },
        diffData: { filePath: 'src/a.ts', oldContent: 'a\nb\nc', newContent: 'a\nb\nc\nd\ne' },
        startedAt: '2026-10-27T10:00:01.000Z',
      }),
      toolBlock({
        id: 'tc-2',
        name: 'edit_file',
        input: { path: 'src/a.ts' },
        diffData: { filePath: 'src/a.ts', oldContent: 'x', newContent: 'x\ny' },
        startedAt: '2026-10-27T10:00:02.000Z',
      }),
    ]);

    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.totalFiles).toBe(1);
    expect(s.files[0].filePath).toBe('src/a.ts');
    expect(s.files[0].opCount).toBe(2);
    expect(s.files[0].addedLines).toBe(7); // edit1 +5（3→5 行）+ edit2 +2（1→2 行）
    expect(s.files[0].removedLines).toBe(4); // edit1 −3 + edit2 −1
    expect(s.files[0].lastKind).toBe('edit');
    expect(s.totalAdded).toBe(7);
    expect(s.totalRemoved).toBe(4);
    // lastDiff 记录最近一次操作（tc-2）的 diff 内容，覆盖 tc-1 的
    expect(s.files[0].lastDiff).toEqual({ oldContent: 'x', newContent: 'x\ny', truncated: false });
  });

  it('edit 块无 diffData 时回退从 input 推导（多引擎格式）', () => {
    const msg = assistantMessage([
      toolBlock({
        name: 'str_replace_editor',
        input: { file_path: 'src/b.ts', old_string: '1\n2\n3', new_string: '1\n2' },
      }),
      toolBlock({
        id: 'tc-2',
        name: 'edit_file',
        input: { path: 'src/c.ts', old_string: 'a', new_string: 'a\nb\nc' },
      }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.totalFiles).toBe(2);
    const b = s.files.find(f => f.filePath === 'src/b.ts')!;
    expect(b.addedLines).toBe(2);
    expect(b.removedLines).toBe(3);
    const c = s.files.find(f => f.filePath === 'src/c.ts')!;
    expect(c.addedLines).toBe(3);
    expect(c.removedLines).toBe(1);
  });

  it('write 块计入新增行数，kind 为 write', () => {
    const msg = assistantMessage([
      toolBlock({
        name: 'write_file',
        input: { path: 'src/new.ts', content: 'line1\nline2\nline3\n' },
      }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.files[0].addedLines).toBe(3);
    expect(s.files[0].removedLines).toBe(0);
    expect(s.files[0].lastKind).toBe('write');
  });

  it('apply_patch 按文件类型映射：add→write / update→edit / delete→delete', () => {
    const msg = assistantMessage([
      toolBlock({
        name: 'apply_patch',
        patchData: [
          { type: 'add', filePath: 'new.ts', chunkCount: 1, addedLines: 10, removedLines: 0, oldContent: '', newContent: '' },
          { type: 'update', filePath: 'upd.ts', chunkCount: 2, addedLines: 4, removedLines: 6, oldContent: '', newContent: '' },
          { type: 'delete', filePath: 'del.ts', chunkCount: 1, addedLines: 0, removedLines: 8, oldContent: '', newContent: '' },
        ],
      }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.totalFiles).toBe(3);
    const kinds = Object.fromEntries(s.files.map(f => [f.filePath, f.lastKind]));
    expect(kinds['new.ts']).toBe('write');
    expect(kinds['upd.ts']).toBe('edit');
    expect(kinds['del.ts']).toBe('delete');
    expect(s.totalAdded).toBe(14);
    expect(s.totalRemoved).toBe(14);
  });

  it('delete_file 记操作不计行数', () => {
    const msg = assistantMessage([
      toolBlock({ name: 'delete_file', input: { path: 'tmp.log' } }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.files[0]).toMatchObject({ filePath: 'tmp.log', lastKind: 'delete', addedLines: 0, removedLines: 0, opCount: 1 });
    // 删除操作无 diff 内容
    expect(s.files[0].lastDiff).toBeUndefined();
  });

  it('diff 内容超 MAX_DIFF_CHARS 截断并标记 truncated', () => {
    const big = 'x'.repeat(MAX_DIFF_CHARS + 100);
    const msg = assistantMessage([
      toolBlock({ name: 'write_file', input: { path: 'big.ts', content: big } }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.files[0].lastDiff?.truncated).toBe(true);
    expect(s.files[0].lastDiff?.newContent?.length).toBe(MAX_DIFF_CHARS);
    // 统计口径不受截断影响
    expect(s.files[0].addedLines).toBe(1);
  });

  it('failed / running / pending 块不计入文件操作', () => {
    const msg = assistantMessage([
      toolBlock({ id: 'tc-f', status: 'failed', input: { file_path: 'x.ts' }, diffData: { filePath: 'x.ts', newContent: 'abc' } }),
      toolBlock({ id: 'tc-r', status: 'running', input: { file_path: 'y.ts' }, diffData: { filePath: 'y.ts', newContent: 'abc' } }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.totalFiles).toBe(0);
    expect(s.files).toEqual([]);
  });

  it('按 lastOpAt 降序（MRU）并裁剪到 MAX_FILES', () => {
    const blocks = Array.from({ length: MAX_FILES + 5 }, (_, i) =>
      toolBlock({
        id: `tc-${i}`,
        name: 'write_file',
        input: { path: `f${i}.ts`, content: 'a' },
        startedAt: new Date(Date.UTC(2026, 9, 27, 10, 0, i)).toISOString(),
      }),
    );
    const s = deriveChangeSummary([assistantMessage(blocks)], undefined, 0);
    expect(s.totalFiles).toBe(MAX_FILES);
    // 最新写的 f{last} 排第一
    expect(s.files[0].filePath).toBe(`f${MAX_FILES + 4}.ts`);
  });
});

describe('deriveChangeSummary - 后台 bash 任务', () => {
  it('启动中（running 块）计为 running；启动回执（completed 块）仍是 running 而非结束', () => {
    const history = assistantMessage([
      toolBlock({ id: 'tc-b2', name: 'Bash', input: { command: 'pnpm test:run' }, status: 'completed', taskId: 'bash-2', startedAt: '2026-10-27T10:00:01.000Z' }),
    ]);
    const current = [
      toolBlock({ id: 'tc-b1', name: 'Bash', input: { command: 'pnpm dev' }, status: 'running', taskId: 'bash-1', startedAt: '2026-10-27T10:00:02.000Z' }),
    ];
    const s = deriveChangeSummary([history], current, 0);
    // 流式中的启动块与已回执的启动块都计 running（completed 只是启动回执）
    expect(s.backgroundTasks).toHaveLength(2);
    expect(s.backgroundTasks.every(t => t.status === 'running')).toBe(true);
    expect(s.runningBgCount).toBe(2);
    expect(s.backgroundTasks.map(t => t.label)).toEqual(['pnpm dev', 'pnpm test:run']);
  });

  it('failed 块计为 failed 且排序置顶', () => {
    const msg = assistantMessage([
      toolBlock({ id: 'tc-b1', name: 'Bash', input: { command: 'ok.cmd' }, status: 'completed', taskId: 'bash-1', startedAt: '2026-10-27T10:00:01.000Z' }),
      toolBlock({ id: 'tc-b2', name: 'Bash', input: { command: 'bad.cmd' }, status: 'failed', taskId: 'bash-2', startedAt: '2026-10-27T10:00:02.000Z' }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.backgroundTasks[0]).toMatchObject({ taskId: 'bash-2', status: 'failed' });
    expect(s.runningBgCount).toBe(1);
  });

  it('同 taskId upsert 去重', () => {
    const msg = assistantMessage([
      toolBlock({ id: 'tc-b1', name: 'Bash', input: { command: 'a' }, status: 'running', taskId: 'bash-1' }),
      toolBlock({ id: 'tc-b2', name: 'Bash', input: { command: 'a' }, status: 'completed', taskId: 'bash-1' }),
    ]);
    const s = deriveChangeSummary([msg], undefined, 0);
    expect(s.backgroundTasks).toHaveLength(1);
    expect(s.backgroundTasks[0].status).toBe('running');
  });
});

describe('deriveChangeSummary - 历史与流式合并', () => {
  it('历史消息与 currentBlocks 合并；WeakMap 缓存不被流式更新污染', () => {
    const history = assistantMessage([
      toolBlock({
        name: 'str_replace_editor',
        input: { file_path: 'src/a.ts' },
        diffData: { filePath: 'src/a.ts', oldContent: 'a', newContent: 'a\nb' },
      }),
    ]);

    const first = deriveChangeSummary([history], [toolBlock({
      id: 'tc-cur',
      name: 'str_replace_editor',
      input: { file_path: 'src/a.ts' },
      diffData: { filePath: 'src/a.ts', oldContent: 'x', newContent: 'x\ny\nz' },
    })], 0);
    expect(first.files[0].opCount).toBe(2);
    expect(first.files[0].addedLines).toBe(5); // 历史 +2（1→2 行）+ 流式 +3（1→3 行）
    expect(first.files[0].removedLines).toBe(2); // 历史 −1 + 流式 −1

    // 同 messages 引用、currentBlocks 变化：历史份额不变（缓存未被污染）
    const second = deriveChangeSummary([history], undefined, 0);
    expect(second.files[0].opCount).toBe(1);
    expect(second.files[0].addedLines).toBe(2); // 历史块自身：newContent 'a\nb' 2 行
    expect(second.files[0].removedLines).toBe(1);

    const third = deriveChangeSummary([history], [toolBlock({
      id: 'tc-cur2',
      name: 'write_file',
      input: { path: 'other.ts', content: '1' },
    })], 0);
    expect(third.files.find(f => f.filePath === 'src/a.ts')?.opCount).toBe(1);
    expect(third.totalFiles).toBe(2);
  });

  it('非 assistant 消息与无块消息忽略', () => {
    const msgs: ChatMessage[] = [
      { id: 'u1', type: 'user', timestamp: 't', content: 'hi' } as ChatMessage,
      { id: 'a1', type: 'assistant', timestamp: 't', blocks: [] } as AssistantChatMessage,
    ];
    const s = deriveChangeSummary(msgs, undefined, 0);
    expect(s).toMatchObject({ totalFiles: 0, totalAdded: 0, totalRemoved: 0, runningBgCount: 0 });
  });

  it('空输入返回空汇总', () => {
    expect(deriveChangeSummary([], undefined, 0)).toEqual(EMPTY_CHANGE_SUMMARY);
  });
});
