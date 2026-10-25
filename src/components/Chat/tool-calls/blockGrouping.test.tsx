/**
 * blockGrouping 分组与折叠行为测试
 *
 * 规则（plans/tool-block-collapse-behavior-fix.md 定稿）：
 * - 连续 thinking/tool_call 相邻成组；仅非空 text 块打断分组；
 *   面板类块（form/plugin_card/artifact_preview 等）不打断（穿透合并）。
 * - 任何 ≥1 块的组都渲染为折叠组；非流式零可见块（仅汇总条）；
 *   流式默认展开；点击汇总条可展开/收起。
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { identifyCollapsibleBlockGroups, renderBlocksWithGrouping } from './blockGrouping';
import type {
  ArtifactPreviewBlock,
  ContentBlock,
  FormBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
} from '@/types';

let seq = 0;
const think = (content: string): ThinkingBlock => ({ type: 'thinking', content });
const tool = (name: string): ToolCallBlock => ({
  type: 'tool_call',
  id: `t-${seq++}`,
  name,
  input: {},
  status: 'completed',
  startedAt: '2026-10-25T00:00:00.000Z',
});
const text = (content: string): TextBlock => ({ type: 'text', content });
const preview = (): ArtifactPreviewBlock => ({
  type: 'artifact_preview',
  previewId: `p-${seq++}`,
  title: '预览面板',
  contentType: 'html',
  html: '<b>panel</b>',
});
const form = (): FormBlock => ({
  type: 'form',
  id: `f-${seq++}`,
  sessionId: 's-1',
  title: '表单面板',
  target: 'cap.todo',
  action: 'create',
  fields: [{ name: 'content', type: 'string', label: '标题', required: true }],
  status: 'pending',
  ok: false,
  createdAt: '2026-10-25T00:00:00.000Z',
});

describe('identifyCollapsibleBlockGroups', () => {
  it('连续 thinking + tool_call 归为一组', () => {
    const groups = identifyCollapsibleBlockGroups([think('a'), tool('Read'), tool('Grep')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].indices).toEqual([0, 1, 2]);
  });

  it('非空文本打断分组（文本自身平铺）', () => {
    const groups = identifyCollapsibleBlockGroups([tool('Read'), text('先看下文件'), tool('Grep')]);
    expect(groups).toHaveLength(2);
    expect(groups[0].indices).toEqual([0]);
    expect(groups[1].indices).toEqual([2]);
  });

  it('空文本（"..."）不打断分组', () => {
    const groups = identifyCollapsibleBlockGroups([tool('Read'), text('...'), tool('Grep')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].indices).toEqual([0, 2]);
  });

  it('面板类块不打断分组：面板前后过程块穿透合并为一组', () => {
    const blocks: ContentBlock[] = [tool('Read'), preview(), tool('Grep')];
    const groups = identifyCollapsibleBlockGroups(blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0].indices).toEqual([0, 2]);
  });

  it('form 交互卡同样不打断分组', () => {
    const blocks: ContentBlock[] = [tool('Read'), form(), tool('Grep')];
    const groups = identifyCollapsibleBlockGroups(blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0].indices).toEqual([0, 2]);
  });
});

describe('renderBlocksWithGrouping', () => {
  it('非流式：单个工具调用也折叠为汇总条，零可见块（工具名不出现）', () => {
    const { container } = render(
      <div>{renderBlocksWithGrouping([tool('Read')], false)}</div>
    );
    // 汇总条存在且为折叠态
    const bar = container.querySelector('button[aria-expanded="false"]');
    expect(bar).toBeTruthy();
    // 折叠态零可见块：工具卡头部（工具名）不应出现
    expect(container.textContent).not.toContain('Read');
  });

  it('非流式：文本分段产生两条汇总条，中间文本平铺可见', () => {
    const { container } = render(
      <div>{renderBlocksWithGrouping([tool('Read'), text('先看下文件'), tool('Grep')], false)}</div>
    );
    const bars = container.querySelectorAll('button[aria-expanded]');
    expect(bars).toHaveLength(2);
    expect(container.textContent).toContain('先看下文件');
  });

  it('面板穿插：一条汇总条 + 面板原序渲染在组外侧', () => {
    const { container } = render(
      <div>{renderBlocksWithGrouping([tool('Read'), form(), tool('Grep')], false)}</div>
    );
    const bars = container.querySelectorAll('button[aria-expanded]');
    expect(bars).toHaveLength(1);
    // form 面板不被折叠吞掉（FormCard 渲染出 role=form）
    expect(container.querySelector('[role="form"]')).toBeTruthy();
  });

  it('流式：无汇总条包装，过程块直接平铺可见', () => {
    // 断言用 thinking 原始 content（不经 i18n）；工具卡头部渲染的是
    // toolConfig.label（测试环境未初始化 i18n，显示 key 原文，不适合断言）
    const { container } = render(
      <div>{renderBlocksWithGrouping([think('先分析一下文件结构'), tool('Read')], true)}</div>
    );
    // 流式期间不渲染汇总条（组渲染器透明，结束后才出现汇总条）
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
    expect(container.textContent).toContain('先分析一下文件结构');
  });

  it('点击汇总条展开显示全部块，再点收起', () => {
    const { container } = render(
      <div>{renderBlocksWithGrouping([think('先分析一下文件结构'), tool('Read')], false)}</div>
    );
    const bar = container.querySelector('button[aria-expanded="false"]')!;
    expect(bar).toBeTruthy();
    // 折叠态零可见块
    expect(container.textContent).not.toContain('先分析一下文件结构');

    fireEvent.click(bar);
    expect(container.querySelector('button[aria-expanded="true"]')).toBeTruthy();
    // 展开后 thinking 内容可见（ThinkingBlockRenderer 折叠预览也含 content 前 60 字）
    expect(container.textContent).toContain('先分析一下文件结构');

    const openBar = container.querySelector('button[aria-expanded="true"]')!;
    fireEvent.click(openBar);
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy();
    expect(container.textContent).not.toContain('先分析一下文件结构');
  });
});
