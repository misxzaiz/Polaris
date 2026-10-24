/**
 * AgentRunBlockRenderer 组件测试
 *
 * 测试范围（对齐 440163a3 精简设计：agent 运行态由动态岛接管实时展示，
 * 消息流内仅保留极简历史行 + 可展开的嵌套工具列表）：
 * - 渲染：agentType、状态图标、工具计数、耗时、错误信息
 * - 交互：点击展开/折叠嵌套工具列表
 * - 状态：running/success/error/canceled 的图标表达
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentRunBlockRenderer } from './AgentRunBlockRenderer';
import type { AgentRunBlock, AgentNestedToolCall } from '../../types';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'status.pending': '等待中',
        'status.running': '运行中',
        'status.completed': '已完成',
        'status.failed': '失败',
        'status.canceled': '已取消',
      };
      return translations[key] || key;
    },
  }),
}));

// 测试数据工厂
function createNestedToolCall(overrides?: Partial<AgentNestedToolCall>): AgentNestedToolCall {
  return {
    id: 'tool-1',
    name: 'read_file',
    status: 'completed',
    summary: '读取文件内容',
    ...overrides,
  };
}

function createAgentRunBlock(overrides?: Partial<AgentRunBlock>): AgentRunBlock {
  return {
    id: 'test-agent-id',
    type: 'agent_run',
    agentType: 'TestAgent',
    status: 'running',
    progressMessage: '正在处理',
    progressPercent: 50,
    toolCalls: [createNestedToolCall()],
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentRunBlockRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('渲染', () => {
    it('应该显示 Agent 类型', () => {
      const block = createAgentRunBlock({ agentType: 'CodeReviewer' });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('CodeReviewer')).toBeInTheDocument();
    });

    it('运行中状态应显示旋转状态图标（无文本标签）', () => {
      const { container } = render(<AgentRunBlockRenderer block={createAgentRunBlock({ status: 'running' })} />);

      // 精简设计：状态用图标表达（Loader2 + animate-spin），不再渲染文本标签
      expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('成功状态应显示完成图标（绿色，无文本标签）', () => {
      const { container } = render(<AgentRunBlockRenderer block={createAgentRunBlock({ status: 'success' })} />);

      expect(container.querySelector('.text-green-500')).toBeInTheDocument();
      expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    });

    it('错误状态应显示失败标签与错误信息', () => {
      const block = createAgentRunBlock({ status: 'error', error: '出错了' });
      render(<AgentRunBlockRenderer block={block} />);

      // 错误态保留文本标签（行内「失败」标记 + 详情区错误信息）
      expect(screen.getByText('失败')).toBeInTheDocument();
      expect(screen.getByText('出错了')).toBeInTheDocument();
    });

    it('取消状态应显示取消图标（灰色，无文本标签）', () => {
      const { container } = render(<AgentRunBlockRenderer block={createAgentRunBlock({ status: 'canceled' })} />);

      expect(container.querySelector('.text-gray-500')).toBeInTheDocument();
    });

    // 注：440163a3 精简设计后，进度消息（progressMessage）与进度条（progressPercent）
    // 不再于消息流内渲染（实时进度由动态岛承载），对应用例随之移除。

    it('运行中状态应显示工具完成计数（done/total）', () => {
      const block = createAgentRunBlock({
        status: 'running',
        toolCalls: [
          createNestedToolCall({ id: 'tool-1', status: 'completed' }),
          createNestedToolCall({ id: 'tool-2', status: 'pending' }),
        ],
      });
      render(<AgentRunBlockRenderer block={block} />);

      // 精简行内计数：已完成/总数
      expect(screen.getByText('1/2')).toBeInTheDocument();
    });

    it('应该显示错误信息', () => {
      const block = createAgentRunBlock({ status: 'error', error: '连接超时' });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('连接超时')).toBeInTheDocument();
    });

    it('应该显示耗时', () => {
      const block = createAgentRunBlock({
        duration: 5000, // 5 秒
      });
      render(<AgentRunBlockRenderer block={block} />);

      // formatDuration 返回 5.0s 格式
      expect(screen.getByText(/5\.?0?s/)).toBeInTheDocument();
    });
  });

  describe('展开/折叠', () => {
    it('默认应该折叠工具调用列表', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'hidden_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      // 工具调用列表默认折叠，不显示工具名称
      expect(screen.queryByText('hidden_tool')).not.toBeInTheDocument();
    });

    it('点击行应展开显示工具调用列表', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'visible_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      // 极简历史行本身是原生 button，点击切换展开
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('visible_tool')).toBeInTheDocument();
    });

    it('展开后显示工具摘要', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'test_tool', summary: '测试工具摘要' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('测试工具摘要')).toBeInTheDocument();
    });

    // 注：精简设计展开态仅渲染嵌套工具行（名称 + 摘要），
    // 旧的「工具调用」列表标题与块级 output 展示已移除，对应用例随之移除。

    it('再次点击应折叠工具调用列表', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'toggle_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button');

      // 展开
      fireEvent.click(header);
      expect(screen.getByText('toggle_tool')).toBeInTheDocument();

      // 折叠
      fireEvent.click(header);
      expect(screen.queryByText('toggle_tool')).not.toBeInTheDocument();
    });

    it('无工具调用时不显示展开箭头且点击不展开', () => {
      const { container } = render(<AgentRunBlockRenderer block={createAgentRunBlock({ toolCalls: [] })} />);

      // 无 ChevronDown 箭头
      expect(container.querySelector('svg.lucide-chevron-down')).not.toBeInTheDocument();

      // 点击无展开行为（hasToolCalls=false 时 onClick 直接返回）
      fireEvent.click(screen.getByRole('button'));
      expect(screen.queryByText('read_file')).not.toBeInTheDocument();
    });

    // 注：展开行是原生 <button>，Enter/Space 激活由浏览器原生处理；
    // jsdom 的 keyDown 不合成 click，故不再保留手写 keyDown 用例。
  });

  describe('无障碍', () => {
    it('极简历史行应为原生 button（可聚焦键盘可达）', () => {
      const block = createAgentRunBlock({ agentType: 'MyAgent' });
      render(<AgentRunBlockRenderer block={block} />);

      // 精简设计移除了 region 容器与 aria-label，行的可访问名称来自其文本内容
      const row = screen.getByRole('button');
      expect(row).toBeInTheDocument();
      expect(row.textContent).toContain('MyAgent');
    });

    // 注：440163a3 精简设计后不再有 region role / aria-label / aria-expanded 属性，
    // 对应用例随之移除；展开态语义由原生 button 的点击行为承担。
  });

  describe('嵌套工具调用状态', () => {
    it('应显示已完成工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'completed', name: 'completed_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('completed_tool')).toBeInTheDocument();
    });

    it('应显示运行中工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'running', name: 'running_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('running_tool')).toBeInTheDocument();
    });

    it('应显示失败工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'failed', name: 'failed_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('failed_tool')).toBeInTheDocument();
    });

    it('应显示等待中工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'pending', name: 'pending_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('pending_tool')).toBeInTheDocument();
    });

    it('应显示多个工具调用', () => {
      const block = createAgentRunBlock({
        toolCalls: [
          createNestedToolCall({ id: 'tool-1', name: 'first_tool' }),
          createNestedToolCall({ id: 'tool-2', name: 'second_tool' }),
          createNestedToolCall({ id: 'tool-3', name: 'third_tool' }),
        ],
      });
      render(<AgentRunBlockRenderer block={block} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('first_tool')).toBeInTheDocument();
      expect(screen.getByText('second_tool')).toBeInTheDocument();
      expect(screen.getByText('third_tool')).toBeInTheDocument();
    });
  });
});
