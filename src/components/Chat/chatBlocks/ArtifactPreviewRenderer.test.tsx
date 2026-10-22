import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { ArtifactPreviewRenderer } from '@/components/Chat/chatBlocks/ArtifactPreviewRenderer';
import type { ArtifactPreviewBlock } from '@/types';

/** jsdom 无 ResizeObserver，用可控 mock：记录实例供测试触发宽度回调 */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  static width = 800;
  callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    MockResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  /** 触发回调，把当前静态宽度传给渲染器（模拟容器 resize） */
  fire(width: number) {
    MockResizeObserver.width = width;
    const entry = {
      borderBoxSize: [{ inlineSize: width }],
      contentRect: { width },
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

function makeBlock(overrides: Partial<ArtifactPreviewBlock> = {}): ArtifactPreviewBlock {
  return {
    type: 'artifact_preview',
    html: '<!DOCTYPE html><html><head><title>周报</title></head><body><h1>hello</h1></body></html>',
    title: '本周收听周报卡片',
    description: '近 7 天收听数据可视化',
    ...overrides,
  } as ArtifactPreviewBlock;
}

describe('ArtifactPreviewRenderer 移动端窄屏适配', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('桌面宽容器（800px）：narrow 不触发，iframe 高度为 420px 上限', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    const frame = container.querySelector('div[class*="overflow-hidden"]');
    // 高度来自内联 style（frameHeight=420）
    expect((frame as HTMLElement).style.height).toBe('420px');
    // 按钮保持大尺寸（h-7 = 28px）
    const buttons = container.querySelectorAll('button[class*="h-7"]');
    expect(buttons.length).toBe(5);
  });

  it('窄容器（375px）：narrow 触发，iframe 高度 16:9 自适应保底 240px', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    act(() => {
      MockResizeObserver.instances[0]?.fire(375);
    });
    const frame = container.querySelector('div[class*="overflow-hidden"]');
    // 375 * 9/16 = 210.9 < 240 下限 → 保底 240px（手机屏占比显著低于 420px）
    expect((frame as HTMLElement).style.height).toBe('240px');
    // 按钮压缩为小尺寸（h-6 = 24px）
    const smallButtons = container.querySelectorAll('button[class*="h-6"]');
    expect(smallButtons.length).toBe(5);
    const largeButtons = container.querySelectorAll('button[class*="h-7"]');
    expect(largeButtons.length).toBe(0);
  });

  it('窄容器且宽度极小（240px）：iframe 高度保底 240px', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    act(() => {
      MockResizeObserver.instances[0]?.fire(240);
    });
    const frame = container.querySelector('div[class*="overflow-hidden"]');
    // 240 * 9/16 = 135 < 240 下限 → 保底 240
    expect((frame as HTMLElement).style.height).toBe('240px');
  });

  it('全屏按钮：Web 模式 requestFullscreen 失败（iOS）→ 降级伪全屏（Portal 出现）', async () => {
    // 模拟 iOS：requestFullscreen 不存在/reject
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: () => Promise.reject(new Error('not supported on iOS')),
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: () => Promise.resolve(),
    });

    const { container, getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    const fsButton = getByTitle('全屏预览');
    await act(async () => {
      fireEvent.click(fsButton);
    });
    // requestFullscreen reject → catch 分支 setIsFullscreen(true) → 渲染伪全屏 Portal
    const portal = document.querySelector('div[role="dialog"]');
    expect(portal).toBeTruthy();
    expect(portal?.textContent).toContain('退出全屏');

    // 退出全屏可恢复：选中 Portal 里「退出全屏」按钮（ExternalLink 按钮在它前面，需按文本定位）
    const dialog = document.querySelector('div[role="dialog"]');
    const exitBtn = Array.from(dialog!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('退出全屏')
    );
    await act(async () => {
      fireEvent.click(exitBtn as HTMLElement);
    });
    expect(document.querySelector('div[role="dialog"]')).toBeFalsy();
  });
});
