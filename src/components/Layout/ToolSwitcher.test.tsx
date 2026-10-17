/**
 * ToolSwitcher 组件测试
 *
 * 覆盖重构后的关键行为：
 * - hover / click 打开焦点语义（hover 不抢焦点，click 30ms 后聚焦搜索框）
 * - pinned 常用项 4 列、溢出项 3 列的高密度布局
 * - role="listbox" / role="option" / aria-selected 语义
 * - 锚定到触发按钮（含窄窗 clamp）
 * - 搜索过滤 / 空结果 / 重开清空 query / Esc / 外部 mousedown 关闭
 *
 * react-i18next 已在 src/test/setup.ts 全局 mock，t() 返回 key 本身。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolSwitcher } from './ToolSwitcher';
import type { ToolSwitcherItem, ToolGroupId } from './ToolSwitcher';

// 用轻量 SVG 代替 lucide 图标，避免图标库依赖影响测试稳定性
const makeIcon = (name: string) => {
  const Icon = ({ size = 16, className }: { size?: number; className?: string }) => (
    <svg data-testid={`icon-${name}`} width={size} height={size} className={className} />
  );
  Icon.displayName = `Icon-${name}`;
  return Icon;
};

const PINNED_IDS = ['files', 'git', 'browser', 'terminal'];
const OVERFLOW_IDS = [
  'todo',
  'translate',
  'scheduler',
  'requirement',
  'personalHub',
  'developer',
  'integration',
  'aiConsole',
  'demoPlugin',
];

function makeItems(activePanel?: string): ToolSwitcherItem[] {
  const all = [...PINNED_IDS, ...OVERFLOW_IDS];
  return all.map((id) => ({
    id,
    icon: makeIcon(id),
    label: `label-${id}`,
    description: `desc-${id}`,
    group: 'context' as ToolGroupId,
    active: activePanel === id,
    onSelect: vi.fn(),
  }));
}

function renderSwitcher(props: Partial<React.ComponentProps<typeof ToolSwitcher>> = {}) {
  return render(
    <ToolSwitcher isOpen={true} items={makeItems()} onClose={() => {}} {...props} />
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolSwitcher 渲染与语义', () => {
  it('isOpen=false 时渲染空容器', () => {
    const { container } = renderSwitcher({ isOpen: false });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('打开时容器为 role="listbox"，选项为 role="option" 且带 aria-selected', () => {
    renderSwitcher({ items: makeItems('git') });
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();

    // 激活项 git 应标记 aria-selected="true"
    const activeOption = screen.getByRole('option', { name: 'label-git' });
    expect(activeOption).toHaveAttribute('aria-selected', 'true');

    // 未激活项应标记 aria-selected="false"
    const inactiveOption = screen.getByRole('option', { name: 'label-todo' });
    expect(inactiveOption).toHaveAttribute('aria-selected', 'false');
  });

  it('pinned 项渲染为 4 列网格，溢出项渲染为 3 列网格', () => {
    const { container } = renderSwitcher();
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    const grids = listbox.querySelectorAll('.grid');

    // 两个网格：pinned 在前（grid-cols-4），overflow 在后（grid-cols-3）
    expect(grids).toHaveLength(2);
    expect(grids[0].className).toContain('grid-cols-4');
    expect(grids[0].querySelectorAll('button[role="option"]')).toHaveLength(PINNED_IDS.length);
    expect(grids[1].className).toContain('grid-cols-3');
    expect(grids[1].querySelectorAll('button[role="option"]')).toHaveLength(OVERFLOW_IDS.length);
  });

  it('点击选项触发 onSelect 并关闭浮层', () => {
    const items = makeItems();
    const target = items.find((item) => item.id === 'todo')!;
    const onClose = vi.fn();
    renderSwitcher({ items, onClose });

    fireEvent.click(screen.getByRole('option', { name: 'label-todo' }));
    expect(target.onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ToolSwitcher hover / click 焦点语义', () => {
  it('openMode="hover" 不聚焦搜索框（不抢焦点）', () => {
    renderSwitcher({ openMode: 'hover' });
    expect(screen.getByPlaceholderText('labels.searchTools')).not.toHaveFocus();
  });

  it('openMode="click" 在 30ms 后聚焦搜索框', () => {
    vi.useFakeTimers();
    renderSwitcher({ openMode: 'click' });
    const input = screen.getByPlaceholderText('labels.searchTools');
    expect(input).not.toHaveFocus();

    vi.advanceTimersByTime(30);
    expect(input).toHaveFocus();
  });
});

describe('ToolSwitcher 锚定与关闭', () => {
  it('锚定到触发按钮：左缘对齐、下缘 +6px；窄窗超界 clamp 兜底', () => {
    // 模拟触发按钮位于窗口右下方，验证 clamp 生效
    const anchor = document.createElement('button');
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      left: 900,
      top: 68,
      right: 948,
      bottom: 1000,
      width: 48,
      height: 32,
    } as DOMRect);

    // jsdom 的 offsetWidth/offsetHeight 恒为 0，覆盖为面板尺寸以验证锚定公式
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 360 });
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 400 });

    try {
      const { container } = renderSwitcher({ anchorRef: { current: anchor } });
      const menu = container.querySelector('[role="listbox"]') as HTMLElement;

      // left = max(8, min(900, innerWidth - 360 - 8))；right 侧越界 → clamp
      const expectedLeft = Math.max(8, Math.min(900, window.innerWidth - 360 - 8));
      const expectedTop = Math.min(1000 + 6, window.innerHeight - 400 - 8);
      expect(menu.style.left).toBe(`${expectedLeft}px`);
      expect(menu.style.top).toBe(`${expectedTop}px`);
    } finally {
      delete (proto as unknown as { offsetWidth?: number }).offsetWidth;
      delete (proto as unknown as { offsetHeight?: number }).offsetHeight;
    }
  });

  it('Esc 关闭浮层', () => {
    const onClose = vi.fn();
    renderSwitcher({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('浮层外 mousedown 关闭浮层', () => {
    const onClose = vi.fn();
    renderSwitcher({ onClose });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('浮层上的 mousedown 不关闭浮层', () => {
    const onClose = vi.fn();
    renderSwitcher({ onClose });
    fireEvent.mouseDown(screen.getByRole('option', { name: 'label-todo' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('转发 onMouseEnter / onMouseLeave 到浮层容器', () => {
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();
    renderSwitcher({ onMouseEnter, onMouseLeave });

    fireEvent.mouseEnter(screen.getByRole('listbox'));
    expect(onMouseEnter).toHaveBeenCalledTimes(1);

    fireEvent.mouseLeave(screen.getByRole('listbox'));
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
  });
});

describe('ToolSwitcher 搜索过滤', () => {
  it('按关键字过滤选项', () => {
    const { container } = renderSwitcher();
    fireEvent.change(screen.getByPlaceholderText('labels.searchTools'), {
      target: { value: 'label-git' },
    });

    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(listbox.textContent).toContain('label-git');
  });

  it('无匹配时展示空结果状态', () => {
    renderSwitcher();
    fireEvent.change(screen.getByPlaceholderText('labels.searchTools'), {
      target: { value: 'zzz-not-exist' },
    });
    expect(screen.getByText('status.noResults')).toBeInTheDocument();
  });

  it('重开浮层后清空搜索词', () => {
    const { rerender } = renderSwitcher();
    fireEvent.change(screen.getByPlaceholderText('labels.searchTools'), {
      target: { value: 'label-git' },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);

    rerender(<ToolSwitcher isOpen={false} items={makeItems()} onClose={() => {}} />);
    rerender(<ToolSwitcher isOpen items={makeItems()} onClose={() => {}} />);

    const input = screen.getByPlaceholderText('labels.searchTools') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
  });
});
