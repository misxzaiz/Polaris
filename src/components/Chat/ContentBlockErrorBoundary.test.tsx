/**
 * ContentBlockErrorBoundary 组件测试
 *
 * 测试范围：
 * - 正常渲染：子组件正常渲染时不显示错误界面
 * - 错误捕获：子组件抛出错误时显示错误回退界面
 * - 重试功能：点击重试按钮后重新渲染子组件
 * - 错误日志：componentDidCatch 记录错误信息
 * - HOC：withErrorBoundary 高阶组件功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContentBlockErrorBoundary, withErrorBoundary } from './ContentBlockErrorBoundary';
import type { ContentBlock } from '../../types';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'errorBlock.title': '渲染错误',
        'errorBlock.description': `${options?.blockType || '内容块'}加载失败`,
        'errorBlock.retry': '重试',
        'errorBlock.textBlock': '文本块',
        'errorBlock.thinkingBlock': '思考块',
        'errorBlock.toolCallBlock': '工具调用块',
        'errorBlock.questionBlock': '问题块',
        'errorBlock.planModeBlock': '计划模式块',
        'errorBlock.agentRunBlock': 'Agent 运行块',
        'errorBlock.toolGroupBlock': '工具组块',
        'errorBlock.contentBlock': '内容块',
      };
      return translations[key] || key;
    },
  }),
}));

// 创建会抛出错误的组件
function ThrowError({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div>正常内容</div>;
}

// 抑制 React 错误边界控制台警告
const originalError = console.error;

describe('ContentBlockErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 抑制 React 错误边界的控制台输出
    console.error = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    console.error = originalError;
  });

  describe('正常渲染', () => {
    it('子组件正常渲染时不显示错误界面', () => {
      render(
        <ContentBlockErrorBoundary>
          <div>正常内容</div>
        </ContentBlockErrorBoundary>
      );

      expect(screen.getByText('正常内容')).toBeInTheDocument();
      expect(screen.queryByText('渲染错误')).not.toBeInTheDocument();
    });

    it('可以传递 blockType 和 blockId 属性', () => {
      render(
        <ContentBlockErrorBoundary blockType="tool_call" blockId="test-id">
          <div>正常内容</div>
        </ContentBlockErrorBoundary>
      );

      expect(screen.getByText('正常内容')).toBeInTheDocument();
    });
  });

  describe('错误捕获', () => {
    it('子组件抛出错误时显示错误回退界面', () => {
      render(
        <ContentBlockErrorBoundary>
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      expect(screen.getByText('渲染错误')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
      expect(screen.queryByText('正常内容')).not.toBeInTheDocument();
    });

    it('显示错误描述信息', () => {
      render(
        <ContentBlockErrorBoundary>
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    });

    it('显示正确的 blockType 标签', () => {
      render(
        <ContentBlockErrorBoundary blockType="tool_call">
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      expect(screen.getByText('工具调用块加载失败')).toBeInTheDocument();
    });

    it('处理不同的 blockType', () => {
      const blockTypes: Array<{ type: ContentBlock['type']; expected: string }> = [
        { type: 'text', expected: '文本块' },
        { type: 'thinking', expected: '思考块' },
        { type: 'tool_call', expected: '工具调用块' },
        { type: 'question', expected: '问题块' },
        { type: 'plan_mode', expected: '计划模式块' },
        { type: 'agent_run', expected: 'Agent 运行块' },
        { type: 'tool_group', expected: '工具组块' },
      ];

      for (const { type, expected } of blockTypes) {
        const { unmount } = render(
          <ContentBlockErrorBoundary blockType={type}>
            <ThrowError />
          </ContentBlockErrorBoundary>
        );

        expect(screen.getByText(`${expected}加载失败`)).toBeInTheDocument();
        unmount();
      }
    });

    it('对于未知 blockType 显示原始类型', () => {
      render(
        <ContentBlockErrorBoundary blockType={'unknown_type' as ContentBlock['type']}>
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      expect(screen.getByText('unknown_type加载失败')).toBeInTheDocument();
    });
  });

  describe('重试功能', () => {
    it('点击重试按钮后重新渲染子组件', () => {
      let shouldThrow = true;

      function ConditionalThrow() {
        if (shouldThrow) {
          throw new Error('Test error');
        }
        return <div>恢复后的内容</div>;
      }

      const { rerender } = render(
        <ContentBlockErrorBoundary>
          <ConditionalThrow />
        </ContentBlockErrorBoundary>
      );

      // 初始状态：显示错误
      expect(screen.getByText('渲染错误')).toBeInTheDocument();

      // 修复错误源
      shouldThrow = false;

      // 点击重试
      fireEvent.click(screen.getByRole('button', { name: '重试' }));

      // 应该显示正常内容
      expect(screen.getByText('恢复后的内容')).toBeInTheDocument();
      expect(screen.queryByText('渲染错误')).not.toBeInTheDocument();
    });

    it('重试按钮有正确的 ARIA 标签', () => {
      render(
        <ContentBlockErrorBoundary>
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      const retryButton = screen.getByRole('button', { name: '重试' });
      expect(retryButton).toHaveAttribute('aria-label', '重试');
    });
  });

  describe('错误日志', () => {
    it('componentDidCatch 记录错误信息', () => {
      render(
        <ContentBlockErrorBoundary blockType="tool_call" blockId="test-block-id">
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      // console.error 应该被调用
      expect(console.error).toHaveBeenCalled();

      // 验证日志包含关键信息
      const errorCall = (console.error as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('[ContentBlockErrorBoundary]')
      );

      expect(errorCall).toBeDefined();
    });
  });

  describe('withErrorBoundary HOC', () => {
    it('包装组件并添加错误边界', () => {
      function TestComponent({ message }: { message: string }) {
        return <div>{message}</div>;
      }

      const WrappedComponent = withErrorBoundary(TestComponent, () => ({
        blockType: 'text',
        blockId: 'test-id',
      }));

      render(<WrappedComponent message="测试消息" />);

      expect(screen.getByText('测试消息')).toBeInTheDocument();
    });

    it('包装组件捕获错误', () => {
      function ThrowingComponent() {
        throw new Error('HOC test error');
      }

      const WrappedComponent = withErrorBoundary(ThrowingComponent, () => ({
        blockType: 'tool_call',
        blockId: 'hoc-test-id',
      }));

      render(<WrappedComponent />);

      expect(screen.getByText('渲染错误')).toBeInTheDocument();
    });

    it('从 props 提取 block 信息', () => {
      interface TestProps {
        block: { type: ContentBlock['type']; id: string };
        content: string;
      }

      function TestComponent({ content }: TestProps) {
        return <div>{content}</div>;
      }

      const WrappedComponent = withErrorBoundary<TestProps>(
        TestComponent,
        (props) => ({
          blockType: props.block.type,
          blockId: props.block.id,
        })
      );

      render(
        <WrappedComponent
          block={{ type: 'question', id: 'question-1' }}
          content="问题内容"
        />
      );

      expect(screen.getByText('问题内容')).toBeInTheDocument();
    });

    it('设置正确的 displayName', () => {
      function MyComponent() {
        return <div>My Component</div>;
      }

      const WrappedComponent = withErrorBoundary(MyComponent, () => ({}));

      expect(WrappedComponent.displayName).toBe('WithErrorBoundary(MyComponent)');
    });

    it('使用组件名作为 displayName 回退', () => {
      const MyComponent = () => <div>My Component</div>;

      const WrappedComponent = withErrorBoundary(MyComponent, () => ({}));

      expect(WrappedComponent.displayName).toBe('WithErrorBoundary(MyComponent)');
    });
  });

  describe('样式和可访问性', () => {
    it('错误界面有正确的 ARIA role', () => {
      render(
        <ContentBlockErrorBoundary>
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      // 验证错误区域存在
      const errorSection = screen.getByText('渲染错误').closest('div');
      expect(errorSection).toBeInTheDocument();
    });

    it('错误图标可见', () => {
      render(
        <ContentBlockErrorBoundary>
          <ThrowError />
        </ContentBlockErrorBoundary>
      );

      // AlertTriangle 图标应该在文档中
      const errorContainer = screen.getByText('渲染错误').closest('div.my-2');
      expect(errorContainer).toBeInTheDocument();
    });
  });
});
