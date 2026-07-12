/**
 * 内容块错误边界
 *
 * 用于包装单个内容块渲染器，防止单个组件崩溃影响整个聊天界面。
 * 当内容块渲染出错时，显示友好的错误提示，而不是白屏。
 */

import { Component, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ContentBlock } from '@/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('ContentBlockErrorBoundary');

interface ContentBlockErrorBoundaryProps {
  children: ReactNode;
  /** 内容块信息，用于错误日志 */
  blockType?: ContentBlock['type'];
  /** 内容块 ID，用于错误日志 */
  blockId?: string;
}

interface ContentBlockErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryKey: number;
}

/**
 * 内容块错误边界组件
 */
export class ContentBlockErrorBoundary extends Component<
  ContentBlockErrorBoundaryProps,
  ContentBlockErrorBoundaryState
> {
  constructor(props: ContentBlockErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryKey: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ContentBlockErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const { blockType, blockId } = this.props;

    // 记录错误日志
    log.error('内容块渲染错误', error, {
      blockType,
      blockId,
      componentStack: errorInfo.componentStack,
    });
  }

  handleRetry = () => {
    this.setState(prev => ({ hasError: false, error: null, retryKey: prev.retryKey + 1 }));
  };

  render() {
    if (this.state.hasError) {
      return <ContentBlockFallback blockType={this.props.blockType} onRetry={this.handleRetry} />;
    }

    // key 变更强制 React 重新挂载子组件树，确保 retry 生效
    return <div key={this.state.retryKey}>{this.props.children}</div>;
  }
}

/**
 * 内容块错误回退组件
 */
function ContentBlockFallback({
  blockType,
  onRetry,
}: {
  blockType?: ContentBlock['type'];
  onRetry: () => void;
}) {
  const { t } = useTranslation('chat');

  const blockTypeLabels: Record<string, string> = {
    text: t('errorBlock.textBlock'),
    thinking: t('errorBlock.thinkingBlock'),
    tool_call: t('errorBlock.toolCallBlock'),
    question: t('errorBlock.questionBlock'),
    plan_mode: t('errorBlock.planModeBlock'),
    agent_run: t('errorBlock.agentRunBlock'),
    tool_group: t('errorBlock.toolGroupBlock'),
  };

  const blockLabel = blockType ? blockTypeLabels[blockType] || blockType : t('errorBlock.contentBlock');

  return (
    <div className="my-2 px-3 py-2 rounded-lg border border-error/30 bg-error-faint">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-error font-medium">
            {t('errorBlock.title')}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {t('errorBlock.description', { blockType: blockLabel })}
          </div>
        </div>
        <button
          onClick={onRetry}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary
                     hover:text-text-primary hover:bg-background-hover rounded transition-colors"
          aria-label={t('errorBlock.retry')}
        >
          <RefreshCw className="w-3 h-3" />
          <span>{t('errorBlock.retry')}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * 高阶组件：为内容块渲染器添加错误边界
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  getBlockInfo: (props: P) => { blockType?: ContentBlock['type']; blockId?: string }
) {
  const WithErrorBoundary = (props: P) => {
    const { blockType, blockId } = getBlockInfo(props);

    return (
      <ContentBlockErrorBoundary blockType={blockType} blockId={blockId}>
        <WrappedComponent {...props} />
      </ContentBlockErrorBoundary>
    );
  };

  WithErrorBoundary.displayName = `WithErrorBoundary(${WrappedComponent.displayName || WrappedComponent.name || 'Component'})`;

  return WithErrorBoundary;
}

export default ContentBlockErrorBoundary;
