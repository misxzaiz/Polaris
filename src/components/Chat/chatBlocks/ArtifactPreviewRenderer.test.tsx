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

describe('ArtifactPreviewRenderer 尺寸自适应', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('统一高度（与格宽解耦）：min(75vh, 760) = 675px（旧版按格宽降级 16:9 导致"没有加高"）', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    act(() => {
      MockResizeObserver.instances[0]?.fire(800);
    });
    // innerHeight=900 → 75vh = 675px；640 旧上限已移除
    const frame = container.querySelector('div[class*="overflow-hidden"]');
    expect((frame as HTMLElement).style.height).toBe('675px');
  });

  it('默认 350px 会话格（窄格）：同样 675px，不再降级到 16:9 的 240px', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    act(() => {
      MockResizeObserver.instances[0]?.fire(350);
    });
    const frame = container.querySelector('div[class*="overflow-hidden"]');
    expect((frame as HTMLElement).style.height).toBe('675px');
  });
});

describe('ArtifactPreviewRenderer 应用内全屏', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('点击全屏：出现应用内覆盖层（Portal role=dialog），内容为该卡 html', async () => {
    const html = '<!DOCTYPE html><html><body><h1>原型 A</h1></body></html>';
    const { getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock({ html, title: '原型 A' })} />);
    const fsButton = getByTitle('全屏预览');
    await act(async () => {
      fireEvent.click(fsButton);
    });
    const dialog = document.querySelector('div[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('原型 A');
    expect(dialog?.textContent).toContain('退出全屏');
    expect(dialog?.textContent).toContain('铺满');
  });

  it('全屏默认铺满档，可切换到等比并记忆在 localStorage', async () => {
    const { getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    const fsButton = getByTitle('全屏预览');
    await act(async () => {
      fireEvent.click(fsButton);
    });
    const dialog = document.querySelector('div[role="dialog"]');
    // 默认铺满（用户定）：内容区 h-full w-full
    expect(dialog?.textContent).toContain('铺满');

    // 切换等比：当前按钮文本为「铺满」，点击切到「等比」
    const ratioBtn = Array.from(dialog!.querySelectorAll('button')).find((b) => b.textContent?.includes('铺满'));
    await act(async () => {
      fireEvent.click(ratioBtn as HTMLElement);
    });
    expect(dialog?.textContent).toContain('等比');
    // 已写入 localStorage（v2 key）
    expect(localStorage.getItem('polaris.preview.fsmode.v2')).toBe('ratio');
  });

  it('退出全屏：Portal 消失，卡片回归消息流', async () => {
    const { getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    const fsButton = getByTitle('全屏预览');
    await act(async () => {
      fireEvent.click(fsButton);
    });
    expect(document.querySelector('div[role="dialog"]')).toBeTruthy();

    const dialog = document.querySelector('div[role="dialog"]');
    const exitBtn = Array.from(dialog!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('退出全屏')
    );
    await act(async () => {
      fireEvent.click(exitBtn as HTMLElement);
    });
    expect(document.querySelector('div[role="dialog"]')).toBeFalsy();
  });

  it('Escape 键退出全屏', async () => {
    const { getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    const fsButton = getByTitle('全屏预览');
    await act(async () => {
      fireEvent.click(fsButton);
    });
    expect(document.querySelector('div[role="dialog"]')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(document.querySelector('div[role="dialog"]')).toBeFalsy();
  });
});

describe('ArtifactPreviewRenderer 更多菜单与信息密度', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 打开底部状态条的「更多」菜单（后续断言基于菜单项） */
  async function openMore(container: HTMLElement) {
    const moreBtn = Array.from(container.querySelectorAll('footer button[class*="h-6"]')).find((b) =>
      b.getAttribute('title') === '更多操作'
    );
    await act(async () => {
      fireEvent.click(moreBtn as HTMLElement);
    });
  }

  it('底部状态条常驻 全屏/加宽/更多 三个图标按钮（加宽直达，不埋菜单）', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    const footer = container.querySelector('footer');
    const buttons = footer!.querySelectorAll('button[class*="h-6"]');
    expect(buttons.length).toBe(3); // 全屏/加宽/更多
  });

  it('点击更多展开 元信息行/新窗/复制/路径/下载/源码（加宽已在底栏，菜单不再重复）', async () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock({ sourcePath: '.polaris/previews/abc/index.html' })} />);
    await openMore(container);
    const menu = container.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.textContent).not.toContain('加宽预览');
    expect(menu?.textContent).toContain('在新标签页打开');
    expect(menu?.textContent).toContain('复制 HTML');
    expect(menu?.textContent).toContain('复制路径');
    expect(menu?.textContent).toContain('下载 HTML');
    expect(menu?.textContent).toContain('查看源码');
  });

  it('标题在底部状态条，预览区直通卡片上缘（无头部栏）', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock({ title: '底部条标题' })} />);
    const footer = container.querySelector('footer');
    expect(footer!.textContent).toContain('底部条标题');
    // section 的第一个子元素是预览区（无 header）
    expect(container.querySelector('section')!.firstElementChild!.tagName).toBe('DIV');
  });
});

describe('ArtifactPreviewRenderer 加载骨架', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('iframe onLoad 前显示骨架，load 后移除（防白闪）', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
    const iframe = container.querySelector('iframe')!;
    act(() => {
      fireEvent.load(iframe);
    });
    expect(container.querySelector('.animate-pulse')).toBeFalsy();
  });
});

describe('ArtifactPreviewRenderer iframe 滚动条细化', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('向 srcDoc 注入细滚动条 CSS（不改动存储的 html）', () => {
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcdoc).toContain('::-webkit-scrollbar');
    expect(srcdoc).toContain('scrollbar-width: thin');
    // 注入点必须在 doctype 之后（不触发怪异模式）
    expect(srcdoc.toUpperCase().startsWith('<!DOCTYPE HTML>')).toBe(true);
  });

  it('无 head/body 的裸 html：CSS 追加在末尾，源码查看仍展示原始 html', async () => {
    const raw = '<div>bare</div>';
    const { container } = render(<ArtifactPreviewRenderer block={makeBlock({ html: raw })} />);
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcdoc).toContain(raw);
    expect(srcdoc).toContain('::-webkit-scrollbar');

    // 源码查看展示原始内容（不含注入的 CSS）
    const moreBtn = Array.from(container.querySelectorAll('footer button[class*="h-6"]')).find((b) =>
      b.getAttribute('title') === '更多操作'
    );
    await act(async () => {
      fireEvent.click(moreBtn as HTMLElement);
    });
    const sourceItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find((b) =>
      b.textContent?.includes('查看源码')
    );
    await act(async () => {
      fireEvent.click(sourceItem as HTMLElement);
    });
    const pre = container.querySelector('pre')!;
    expect(pre.textContent).toBe(raw);
  });
});

describe('ArtifactPreviewRenderer 弹出加宽（×2 breakout）', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    // jsdom rect 全 0；mock 卡片 rect 使 ×2 计算可断言（400×2=800 < 1024-32）
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 400, height: 500, left: 100, top: 100, right: 500, bottom: 600,
      x: 100, y: 100, toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 底栏「加宽」按钮直达（不再经由菜单） */
  async function expandViaBar(getByTitle: (title: string) => HTMLElement) {
    await act(async () => {
      fireEvent.click(getByTitle('加宽预览（×2）'));
    });
  }

  it('点击加宽：body 出现 fixed 面板（宽 = 卡片×2），收起后消失', async () => {
    const { getByTitle, container } = render(<ArtifactPreviewRenderer block={makeBlock({ title: '加宽目标' })} />);
    await expandViaBar(getByTitle);
    const panel = document.querySelector('div[role="dialog"][aria-label*="加宽预览"]') as HTMLElement | null;
    expect(panel).toBeTruthy();
    expect(panel!.style.width).toBe('800px');
    expect(panel!.textContent).toContain('加宽目标');
    // 卡片本体仍在消息流
    expect(container.querySelector('section')).toBeTruthy();

    const collapseBtn = Array.from(panel!.querySelectorAll('button')).find((b) => b.title === '收起加宽');
    await act(async () => {
      fireEvent.click(collapseBtn as HTMLElement);
    });
    expect(document.querySelector('div[role="dialog"][aria-label*="加宽预览"]')).toBeFalsy();
  });

  it('Escape 先收加宽面板', async () => {
    const { getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    await expandViaBar(getByTitle);
    expect(document.querySelector('div[role="dialog"][aria-label*="加宽预览"]')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(document.querySelector('div[role="dialog"][aria-label*="加宽预览"]')).toBeFalsy();
  });

  it('与全屏互斥：加宽状态下点全屏，加宽面板收起', async () => {
    const { getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    await expandViaBar(getByTitle);
    await act(async () => {
      fireEvent.click(getByTitle('全屏预览'));
    });
    expect(document.querySelector('div[role="dialog"][aria-label*="加宽预览"]')).toBeFalsy();
    expect(document.querySelector('div[role="dialog"][aria-label*="全屏预览"]')).toBeTruthy();
  });
});

describe('ArtifactPreviewRenderer 全屏等比档', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('等比档按实测宽高比约束（aspect-ratio），非固定正方形', async () => {
    const { getByTitle } = render(<ArtifactPreviewRenderer block={makeBlock()} />);
    await act(async () => {
      fireEvent.click(getByTitle('全屏预览'));
    });
    const dialog = document.querySelector('div[role="dialog"][aria-label*="全屏预览"]')!;
    // 默认铺满 → 切到等比档再断言
    const toggleBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.includes('铺满'));
    await act(async () => {
      fireEvent.click(toggleBtn as HTMLElement);
    });
    // jsdom rect 为 0 → 走 9/16 兜底比例；关键是存在 aspect-ratio 约束
    const ratioBox = Array.from(dialog.querySelectorAll('div')).find((d) => d.style.aspectRatio);
    expect(ratioBox).toBeTruthy();
    // jsdom 会把 0.5625 规范化为 "0.5625 / 1"
    expect(ratioBox!.style.aspectRatio).toContain('0.5625');
  });
});

describe('ArtifactPreviewRenderer 版本 pills', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    MockResizeObserver.width = 800;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const v1: ArtifactPreviewBlock = {
    type: 'artifact_preview', previewId: 'p1', title: '原型 v1', contentType: 'html',
    html: '<html><body>v1</body></html>', version: 1, requirementId: 'REQ-1',
  } as ArtifactPreviewBlock;
  const v2: ArtifactPreviewBlock = {
    type: 'artifact_preview', previewId: 'p2', title: '原型 v2', contentType: 'html',
    html: '<html><body>v2</body></html>', version: 2, requirementId: 'REQ-1',
  } as ArtifactPreviewBlock;

  it('≥2 版时出现 pills，默认显示最新版', () => {
    const { container } = render(<ArtifactPreviewRenderer block={v1} versions={[v1, v2]} />);
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
    // 默认 = 最新版：标题与 srcdoc 都是 v2
    expect(container.querySelector('footer')!.textContent).toContain('原型 v2');
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('v2');
  });

  it('切到 v1：srcdoc 与标题切为 v1 内容', async () => {
    const { container } = render(<ArtifactPreviewRenderer block={v1} versions={[v1, v2]} />);
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    const v1Tab = tabs.find((t) => t.textContent === 'v1')!;
    await act(async () => {
      fireEvent.click(v1Tab);
    });
    expect(container.querySelector('footer')!.textContent).toContain('原型 v1');
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('>v1<');
  });

  it('单版本（versions 长度 1）不出 pills', () => {
    const { container } = render(<ArtifactPreviewRenderer block={v2} versions={[v2]} />);
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });
});