import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExternalLink } from './ExternalLink';
import * as linkExternal from '@/services/linkExternal';
import * as platform from '@/mobile/platform';

vi.mock('@/services/linkExternal', () => ({
  openExternalLink: vi.fn(),
}));

const openExternalLinkMock = vi.mocked(linkExternal.openExternalLink);

describe('ExternalLink', () => {
    beforeEach(() => {
    // Desktop by default
    vi.spyOn(platform, 'isMobileTauriRuntime').mockReturnValue(false);
    openExternalLinkMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('桌面端：渲染普通 a 标签，不拦截点击', () => {
    render(<ExternalLink href="https://example.com">点击我</ExternalLink>);
    const a = screen.getByRole('link', { name: /点击我/i });
    expect(a).toHaveAttribute('href', 'https://example.com');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.click(a);
    expect(openExternalLinkMock).not.toHaveBeenCalled();
  });

  it('移动端：点击触发 openExternalLink 并阻止默认导航', () => {
    vi.spyOn(platform, 'isMobileTauriRuntime').mockReturnValue(true);
    render(<ExternalLink href="https://example.com">点击我</ExternalLink>);
    const a = screen.getByRole('link', { name: /点击我/i });

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const prevent = vi.fn();
    const stop = vi.fn();
    event.preventDefault = prevent;
    event.stopPropagation = stop;
    Object.defineProperty(event, 'target', { value: a });

    fireEvent(a, event);

    expect(prevent).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(openExternalLinkMock).toHaveBeenCalledWith('https://example.com');
  });

  it('透传 className / style / 其他 prop', () => {
    render(
      <ExternalLink href="https://example.com" className="custom" style={{ color: 'red' }}>
        文本
      </ExternalLink>,
    );
    const a = screen.getByRole('link', { name: /文本/i });
    expect(a).toHaveClass('custom');
    expect(a).toHaveStyle('color: rgb(255, 0, 0)');
  });
});