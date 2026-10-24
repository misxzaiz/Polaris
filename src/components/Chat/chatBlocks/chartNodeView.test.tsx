import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { ChartNodeView, niceMax } from '@/components/Chat/chatBlocks/chartNodeView';
import { renderTemplateNodes } from '@/components/Chat/chatBlocks/uiTemplateNodes';
import type { UiTemplateNode } from '@/plugin-system/uiFrameTypes';

function makeChart(overrides: Partial<Extract<UiTemplateNode, { type: 'chart' }>> = {}): Extract<UiTemplateNode, { type: 'chart' }> {
  return {
    type: 'chart',
    chartType: 'line',
    labels: ['4月', '5月', '6月'],
    datasets: [
      { label: 'A 基金', data: [2.81, 3.15, 3.94] },
      { label: 'B 基金', data: [1.74, 1.65, 1.52] },
    ],
    ...overrides,
  };
}

const renderCtx = { disabled: true, values: {}, onValue: () => {} };

describe('niceMax 刻度取整', () => {
  it('向上取整到 1/2/5×10^k', () => {
    expect(niceMax(3.94)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(80)).toBe(100);
    expect(niceMax(200)).toBe(200);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
  });
});

describe('ChartNodeView 渲染', () => {
  it('line：折线 + 每点 title + 图例', () => {
    const { container } = render(<ChartNodeView node={makeChart()} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(container.querySelectorAll('polyline').length).toBe(2);
    // 每条折线 3 个数据点，各带 hover title
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles.some((t) => t?.includes('A 基金 · 6月: 3.94'))).toBe(true);
    // 图例含两个数据集标签
    expect(container.textContent).toContain('A 基金');
    expect(container.textContent).toContain('B 基金');
  });

  it('bar：矩形条与 title', () => {
    const { container } = render(<ChartNodeView node={makeChart({ chartType: 'bar' })} />);
    // 2 数据集 × 3 标签 = 6 根柱
    expect(container.querySelectorAll('rect').length).toBe(6);
  });

  it('pie：扇区 path + 图例百分比；单扇区 100% 退化为 circle', () => {
    const { container } = render(
      <ChartNodeView node={makeChart({ chartType: 'pie', labels: ['x', 'y'], datasets: [{ label: '占比', data: [3, 1] }] })} />,
    );
    expect(container.querySelectorAll('path').length).toBe(2);
    expect(container.textContent).toContain('75%');
    expect(container.textContent).toContain('25%');

    const single = render(
      <ChartNodeView node={makeChart({ chartType: 'pie', labels: ['only'], datasets: [{ label: '占比', data: [9] }] })} />,
    );
    expect(single.container.querySelectorAll('path').length).toBe(0);
    expect(single.container.querySelectorAll('circle').length).toBe(1);
  });

  it('showLegend=false 时不渲染图例；自定义 color 直接生效', () => {
    const { container } = render(
      <ChartNodeView
        node={makeChart({ showLegend: false, datasets: [{ label: 'A', data: [1, 2], color: '#f59e0b' }] })}
      />,
    );
    // 图例项是 span.inline-flex；关闭后应为 0（hover title 不算图例）
    expect(container.querySelectorAll('span.inline-flex').length).toBe(0);
    const line = container.querySelector('polyline');
    // jsdom 会把 #f59e0b 归一化为 rgb 形式
    expect(line?.getAttribute('style')).toContain('rgb(245, 158, 11)');
  });

  it('默认系列色走主题 CSS 变量（style 注入）', () => {
    const { container } = render(<ChartNodeView node={makeChart()} />);
    const line = container.querySelector('polyline');
    expect(line?.getAttribute('style')).toContain('rgb(var(--c-primary))');
  });

  it('NaN 数据点被钳制为 0，不产生 NaN 坐标', () => {
    const node = makeChart({ datasets: [{ label: 'A', data: [1, Number.NaN, 3] }] });
    const { container } = render(<ChartNodeView node={node} />);
    const points = container.querySelector('polyline')?.getAttribute('points') ?? '';
    expect(points).not.toContain('NaN');
  });
});

describe('renderTemplateNodes 集成（chart 可嵌套）', () => {
  it('vstack 内的 chart 经统一入口渲染', () => {
    const nodes: UiTemplateNode[] = [
      { type: 'vstack', children: [{ type: 'text', content: '标题' }, makeChart()] },
    ];
    const { container } = render(<div>{renderTemplateNodes(nodes, renderCtx)}</div>);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.textContent).toContain('标题');
    expect(container.textContent).toContain('A 基金');
  });
});
