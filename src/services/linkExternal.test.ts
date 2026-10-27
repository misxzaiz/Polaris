import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as windowService from '@/services/tauri/windowService';
import {
  shouldOpenExternal,
  openExternalLink,
  registerExternalLinkGlobalHandler,
  EXTERNAL_LINK_SELECTOR,
} from './linkExternal';

vi.mock('@/services/tauri/windowService', () => ({
  openInBrowser: vi.fn(),
}));
vi.mock('@/services/transport', () => ({
  /* windowService 内部引用，mock 掉避免真实 IPC */
}));
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/mobile/platform', () => ({
  isMobileTauriRuntime: vi.fn(),
}));

import { isMobileTauriRuntime } from '@/mobile/platform';
const mockIsMobileTauriRuntime = vi.mocked(isMobileTauriRuntime);
const openInBrowserMock = vi.mocked(windowService.openInBrowser);

/** 把一个真实锚点挂到 body，返回销毁函数 */
function mountAnchor(host: HTMLElement): () => void {
  document.body.appendChild(host);
  return () => host.remove();
}

function makeExternalAnchor(): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = 'https://example.com';
  a.target = '_blank';
  return a;
}

describe('shouldOpenExternal', () => {
  const cases: Array<[string | null | undefined, boolean, string]> = [
    ['https://example.com', true, 'https 外链'],
    ['http://example.com', true, 'http 外链'],
    ['mailto:foo@bar.com', false, 'mailto 系统处理不外投'],
    ['tel:+8613800000000', false, 'tel 系统处理不外投'],
    ['#/chat/abc', false, 'hash 路由'],
    ['/chat/abc', false, '相对路由'],
    ['/api/foo', false, 'api 静态资源'],
    ['assets/logo.png', false, '相对静态'],
    ['blob:http://localhost/x', false, 'blob 不误拦（由入口分支负责）'],
    ['data:text/html,hi', false, 'data 不误拦'],
    ['javascript:alert(1)', false, 'javascript 禁止外投'],
    ['', false, '空串'],
    [null, false, 'null'],
    [undefined, false, 'undefined'],
    ['  https://example.com/path  ', true, '带空白仍识别'],
  ];

  it.each(cases)('%s → %s (%s)', (href, expected) => {
    expect(shouldOpenExternal(href)).toBe(expected);
  });
});

describe('openExternalLink', () => {
  beforeEach(() => {
    openInBrowserMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('调用 openInBrowser（opener → 系统浏览器）', async () => {
    openInBrowserMock.mockResolvedValue(undefined);
    await openExternalLink('https://example.com');
    expect(openInBrowserMock).toHaveBeenCalledWith('https://example.com');
  });

  it('opener 失败时兜底 window.open', async () => {
    openInBrowserMock.mockRejectedValue(new Error('opener unavailable'));
    const winOpen = vi.fn();
    vi.stubGlobal('open', winOpen);
    await openExternalLink('https://example.com');
    expect(winOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });
});

describe('createExternalClickHandler（经由 document capture 触发）', () => {
  let cleanupListeners: () => void;

  beforeEach(() => {
    mockIsMobileTauriRuntime.mockReturnValue(true);
    openInBrowserMock.mockReset();
    openInBrowserMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanupListeners?.();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const setup = () => {
    cleanupListeners = registerExternalLinkGlobalHandler();
  };

  /** 构造一个可 cancel 的 click 事件，记录 preventDefault/stopPropagation */
  const dispatchClickOn = (targetEl: HTMLElement, opts: { ctrlKey?: boolean } = {}) => {
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: opts.ctrlKey ?? false,
    });
    const rec = { preventDefault: false, stopPropagation: false };
    event.preventDefault = vi.fn(() => { rec.preventDefault = true; });
    event.stopPropagation = vi.fn(() => { rec.stopPropagation = true; });
    targetEl.dispatchEvent(event);
    return rec;
  };

  it('命中 target=_blank 外链 → preventDefault + stopPropagation + openExternalLink', () => {
    setup();
    const anchor = makeExternalAnchor();
    const unmount = mountAnchor(anchor);
    const rec = dispatchClickOn(anchor);
    unmount();

    expect(rec.preventDefault).toBe(true);
    expect(rec.stopPropagation).toBe(true);
    expect(openInBrowserMock).toHaveBeenCalledWith('https://example.com');
  });

  it('点击 anchor 内部的 span 也能匹配（closest 向上）', () => {
    setup();
    const anchor = makeExternalAnchor();
    const span = document.createElement('span');
    anchor.appendChild(span);
    const unmount = mountAnchor(anchor);
    const rec = dispatchClickOn(span);
    unmount();

    expect(rec.preventDefault).toBe(true);
    expect(openInBrowserMock).toHaveBeenCalledWith('https://example.com');
  });

  it('应用内路由链接不拦截', () => {
    setup();
    const a = document.createElement('a');
    a.href = '/chat/abc';
    a.target = '_blank';
    const unmount = mountAnchor(a);
    const rec = dispatchClickOn(a);
    unmount();

    expect(rec.preventDefault).toBe(false);
    expect(openInBrowserMock).not.toHaveBeenCalled();
  });

  it('修饰键（ctrl）点击保留浏览器语义，不拦截', () => {
    setup();
    const anchor = makeExternalAnchor();
    const unmount = mountAnchor(anchor);
    const rec = dispatchClickOn(anchor, { ctrlKey: true });
    unmount();

    expect(rec.preventDefault).toBe(false);
    expect(openInBrowserMock).not.toHaveBeenCalled();
  });

  it('data-keep-in-app 显式跳过', () => {
    setup();
    const a = document.createElement('a');
    a.href = 'https://inside.example.com';
    a.target = '_blank';
    a.setAttribute('data-keep-in-app', '1');
    const unmount = mountAnchor(a);
    const rec = dispatchClickOn(a);
    unmount();

    expect(rec.preventDefault).toBe(false);
    expect(openInBrowserMock).not.toHaveBeenCalled();
  });

  it('末尾的 span 后代点击命中最近的 anchor', () => {
    setup();
    const outer = makeExternalAnchor();
    const inner = document.createElement('a');
    inner.href = 'https://inner.example.com';
    inner.target = '_blank';
    outer.appendChild(inner);
    const unmount = mountAnchor(outer);
    const rec = dispatchClickOn(inner);
    unmount();

    // 最近的是 inner，应拦截 inner href
    expect(rec.preventDefault).toBe(true);
    expect(openInBrowserMock).toHaveBeenCalledWith('https://inner.example.com');
  });
});

describe('registerExternalLinkGlobalHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('移动端注册 capture，返回取消函数；桌面端不注册', () => {
    mockIsMobileTauriRuntime.mockReturnValue(true);
    const addSpy = vi.spyOn(document, 'addEventListener');
    let cleanup = registerExternalLinkGlobalHandler();
    expect(addSpy).toHaveBeenCalledWith('click', expect.any(Function), true);
    cleanup();

    // 桌面端
    mockIsMobileTauriRuntime.mockReturnValue(false);
    addSpy.mockClear();
    cleanup = registerExternalLinkGlobalHandler();
    expect(addSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it('EXTERNAL_LINK_SELECTOR 声明正确', () => {
    expect(EXTERNAL_LINK_SELECTOR).toContain('a[target="_blank"]');
    expect(EXTERNAL_LINK_SELECTOR).toContain('a[data-open-external]');
  });
});