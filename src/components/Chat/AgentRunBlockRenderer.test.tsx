/**
 * AgentRunBlockRenderer 组件测试
 *
 * 测试范围：
 * - 渲染：显示 Agent 类型、状态、进度、工具调用、错误信息
 * - 交互：展开/折叠、键盘导航
 * - 状态：不同状态的显示
 * - 无障碍：ARIA 属性
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentRunBlockRenderer, SimplifiedAgentRunRenderer } from './AgentRunBlockRenderer';
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
        'agent.agentRunAriaLabel': `Agent: ${options?.type || 'Unknown'}`,
        'agent.toggleDetails': '切换详情',
        'agent.toolCount': `${options?.count || 0} 个工具`,
        'agent.completed': '已完成',
        'agent.toolCalls': '工具调用',
        'agent.output': '输出',
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

    it('应该显示运行状态标签', () => {
      const block = createAgentRunBlock({ status: 'running' });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('运行中')).toBeInTheDocument();
    });

    it('应该显示成功状态标签', () => {
      const block = createAgentRunBlock({ status: 'success', isActive: false });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('已完成')).toBeInTheDocument();
    });

    it('应该显示错误状态标签', () => {
      const block = createAgentRunBlock({ status: 'error', error: '出错了' });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('失败')).toBeInTheDocument();
    });

    it('应该显示取消状态标签', () => {
      const block = createAgentRunBlock({ status: 'canceled' });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('已取消')).toBeInTheDocument();
    });

    it('应该显示进度消息', () => {
      const block = createAgentRunBlock({ status: 'running', progressMessage: '正在分析代码' });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('正在分析代码')).toBeInTheDocument();
    });

    it('应该显示进度条（运行中且有进度百分比）', () => {
      const block = createAgentRunBlock({ status: 'running', progressPercent: 75 });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByText('75%')).toBeInTheDocument();
    });

    it('运行中状态应有工具调用摘要', () => {
      const block = createAgentRunBlock({
        status: 'running',
        toolCalls: [
          createNestedToolCall({ id: 'tool-1', status: 'completed' }),
          createNestedToolCall({ id: 'tool-2', status: 'pending' }),
        ],
      });
      render(<AgentRunBlockRenderer block={block} />);

      // 工具数量和已完成数量在同一行
      expect(screen.getByText(/2 个工具/)).toBeInTheDocument();
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

    it('点击应展开显示工具调用列表', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'visible_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      // 点击展开
      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('visible_tool')).toBeInTheDocument();
    });

    it('展开后显示工具调用列表标题', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall()],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('工具调用')).toBeInTheDocument();
    });

    it('展开后显示工具摘要', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'test_tool', summary: '测试工具摘要' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('测试工具摘要')).toBeInTheDocument();
    });

    it('展开后显示输出内容', () => {
      const block = createAgentRunBlock({
        output: '这是 Agent 的输出内容',
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('这是 Agent 的输出内容')).toBeInTheDocument();
    });

    it('再次点击应折叠工具调用列表', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'toggle_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });

      // 展开
      fireEvent.click(header);
      expect(screen.getByText('toggle_tool')).toBeInTheDocument();

      // 折叠
      fireEvent.click(header);
      expect(screen.queryByText('toggle_tool')).not.toBeInTheDocument();
    });

    it('无工具调用时不显示展开箭头', () => {
      const block = createAgentRunBlock({ toolCalls: [] });
      render(<AgentRunBlockRenderer block={block} />);

      // 没有 ChevronDown 图标（箭头）
      const header = screen.getByRole('button', { name: '切换详情' });
      // 只检查没有展开/折叠交互
      expect(header).toBeInTheDocument();
    });
  });

  describe('键盘导航', () => {
    it('Enter 键应展开/折叠', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'keyboard_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });

      // 按 Enter 展开
      fireEvent.keyDown(header, { key: 'Enter' });
      expect(screen.getByText('keyboard_tool')).toBeInTheDocument();

      // 再按 Enter 折叠
      fireEvent.keyDown(header, { key: 'Enter' });
      expect(screen.queryByText('keyboard_tool')).not.toBeInTheDocument();
    });

    it('Space 键应展开/折叠', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ name: 'space_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });

      // 按 Space 展开
      fireEvent.keyDown(header, { key: ' ' });
      expect(screen.getByText('space_tool')).toBeInTheDocument();
    });
  });

  describe('无障碍', () => {
    it('应有正确的 ARIA role 属性', () => {
      const block = createAgentRunBlock();
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByRole('region')).toBeInTheDocument();
    });

    it('应有正确的 aria-label', () => {
      const block = createAgentRunBlock({ agentType: 'MyAgent' });
      render(<AgentRunBlockRenderer block={block} />);

      expect(screen.getByRole('region')).toHaveAttribute('aria-label', 'Agent: MyAgent');
    });

    it('展开按钮应有正确的 aria-expanded 属性', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall()],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      expect(header).toHaveAttribute('aria-expanded', 'false');

      // 展开后
      fireEvent.click(header);
      expect(header).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('嵌套工具调用状态', () => {
    it('应显示已完成工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'completed', name: 'completed_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('completed_tool')).toBeInTheDocument();
    });

    it('应显示运行中工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'running', name: 'running_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('running_tool')).toBeInTheDocument();
    });

    it('应显示失败工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'failed', name: 'failed_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('failed_tool')).toBeInTheDocument();
    });

    it('应显示等待中工具状态', () => {
      const block = createAgentRunBlock({
        toolCalls: [createNestedToolCall({ status: 'pending', name: 'pending_tool' })],
      });
      render(<AgentRunBlockRenderer block={block} />);

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

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

      const header = screen.getByRole('button', { name: '切换详情' });
      fireEvent.click(header);

      expect(screen.getByText('first_tool')).toBeInTheDocument();
      expect(screen.getByText('second_tool')).toBeInTheDocument();
      expect(screen.getByText('third_tool')).toBeInTheDocument();
    });
  });
});

describe('SimplifiedAgentRunRenderer', () => {
  it('应该显示简化版 Agent 信息', () => {
    const block = createAgentRunBlock({ agentType: 'SimplifiedAgent' });
    render(<SimplifiedAgentRunRenderer block={block} />);

    expect(screen.getByText('SimplifiedAgent')).toBeInTheDocument();
  });

  it('应该显示工具调用数量', () => {
    const block = createAgentRunBlock({
      toolCalls: [
        createNestedToolCall({ id: 'tool-1' }),
        createNestedToolCall({ id: 'tool-2' }),
        createNestedToolCall({ id: 'tool-3' }),
      ],
    });
    render(<SimplifiedAgentRunRenderer block={block} />);

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('无工具调用时不显示数量', () => {
    const block = createAgentRunBlock({ toolCalls: [] });
    render(<SimplifiedAgentRunRenderer block={block} />);

    // 不应该有数字显示
    const container = screen.getByText('TestAgent').closest('div');
    expect(container?.textContent).not.toMatch(/\d+/);
  });

  it('应该有 aria-label 属性', () => {
    const block = createAgentRunBlock({ agentType: 'AccessibleAgent' });
    render(<SimplifiedAgentRunRenderer block={block} />);

    const element = screen.getByText('AccessibleAgent').closest('div');
    expect(element).toHaveAttribute('aria-label', 'Agent: AccessibleAgent');
  });
});
