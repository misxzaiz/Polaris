/**
 * SettingsSidebar 布局切换测试
 *
 * 背景:设置页左右/上下布局由容器实测宽驱动(wide prop),
 * 不再依赖 CSS 媒体查询(WebView2 分数缩放下媒体查询会陈旧/部分失效,
 * 见 plans/settings-layout-width-driven.md)。
 *
 * 测试范围:
 * - wide=true:竖栏(w-56/flex-col/border-r)、搜索框可见、导航纵向列表
 * - wide=false:横条(border-b)、搜索框隐藏、导航横向滚动
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SettingsSidebar } from './SettingsSidebar';

// Mock react-i18next(项目标准范式,key 即文案)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

function makeProps(overrides: Partial<Parameters<typeof SettingsSidebar>[0]> = {}) {
  return {
    wide: true,
    activeTab: 'general' as const,
    onTabChange: vi.fn(),
    searchQuery: '',
    onSearchChange: vi.fn(),
    ...overrides,
  };
}

describe('SettingsSidebar 布局切换', () => {
  it('wide=true 渲染竖栏:侧栏 w-56 纵向、搜索框可见、导航纵向列表', () => {
    const { container } = render(<SettingsSidebar {...makeProps({ wide: true })} />);

    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain('w-56');
    expect(outer.className).toContain('flex-col');
    expect(outer.className).toContain('border-r');

    // 搜索框可见(block)
    const search = container.querySelector('input[type="text"]');
    expect(search).not.toBeNull();
    const searchWrapper = search!.parentElement!.parentElement as HTMLElement;
    expect(searchWrapper.className).toContain('block');
    expect(searchWrapper.className).not.toContain('hidden');

    // 导航纵向列表(flex-col + overflow-y-auto),不含横向滚动
    const nav = container.querySelector('nav') as HTMLElement;
    expect(nav.className).toContain('flex-col');
    expect(nav.className).toContain('overflow-y-auto');
    expect(nav.className).not.toContain('overflow-x-auto');
  });

  it('wide=false 渲染横条:侧栏 border-b 横向、搜索框隐藏、导航横向滚动', () => {
    const { container } = render(<SettingsSidebar {...makeProps({ wide: false })} />);

    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain('border-b');
    expect(outer.className).not.toContain('w-56');
    expect(outer.className).not.toContain('flex-col');
    expect(outer.className).not.toContain('border-r');

    // 搜索框隐藏(hidden)
    const search = container.querySelector('input[type="text"]');
    expect(search).not.toBeNull();
    const searchWrapper = search!.parentElement!.parentElement as HTMLElement;
    expect(searchWrapper.className).toContain('hidden');

    // 导航横向滚动,不含纵向列表类
    const nav = container.querySelector('nav') as HTMLElement;
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.className).not.toContain('flex-col');
  });

  it('选中态指示随布局切换:宽布局右边框条,窄布局底边框条', () => {
    const { container, rerender } = render(<SettingsSidebar {...makeProps({ wide: true })} />);
    const activeBtn = (container.querySelector('nav button') as HTMLElement);
    expect(activeBtn.className).toContain('border-r-2');
    expect(activeBtn.className).not.toContain('border-b-2');

    rerender(<SettingsSidebar {...makeProps({ wide: false })} />);
    expect(activeBtn.className).toContain('border-b-2');
    expect(activeBtn.className).not.toContain('border-r-2');
  });
});
