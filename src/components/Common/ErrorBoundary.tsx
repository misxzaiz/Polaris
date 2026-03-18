/**
 * 全局错误边界 - 捕获渲染崩溃并尝试恢复
 */

import { Component, ReactNode, useEffect } from 'react';
import { createLogger } from '../../utils/logger';

const log = createLogger('ErrorBoundary');

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private recoveryTimeoutId: number | null = null;
  private heartbeatIntervalId: number | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // 保存错误状态到 localStorage，用于调试
    try {
      sessionStorage.setItem('crash_error', error.message);
      sessionStorage.setItem('crash_time', new Date().toISOString());
    } catch {
      // 忽略 sessionStorage 不可用的情况
    }
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    log.error('捕获到渲染错误', error, { componentStack: errorInfo.componentStack });

    // 保存错误信息用于调试
    try {
      sessionStorage.setItem('crash_details', JSON.stringify({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        timestamp: new Date().toISOString()
      }));
    } catch {
      // 忽略 sessionStorage 不可用的情况
    }

    // 3秒后自动尝试恢复
    this.recoveryTimeoutId = window.setTimeout(() => {
      this.attemptRecovery();
    }, 3000);
  }

  componentDidMount() {
    // 检测是否有之前崩溃的记录
    const lastCrash = sessionStorage.getItem('crash_time');
    if (lastCrash) {
      const crashTime = new Date(lastCrash);
      const timeSinceCrash = Date.now() - crashTime.getTime();
      // 如果是最近5秒内崩溃的，记录日志
      if (timeSinceCrash < 5000) {
        console.warn('[ErrorBoundary] 检测到最近有崩溃，已自动恢复');
      }
    }

    // 启动心跳检测
    this.startHeartbeat();
  }

  componentWillUnmount() {
    // 清理定时器
    if (this.recoveryTimeoutId) {
      clearTimeout(this.recoveryTimeoutId);
    }
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
    }
  }

  /** 启动心跳检测，检测主线程是否卡死 */
  private startHeartbeat() {
    let lastHeartbeat = Date.now();

    // 每秒更新心跳
    const updateHeartbeat = () => {
      lastHeartbeat = Date.now();
      sessionStorage.setItem('heartbeat', lastHeartbeat.toString());
    };

    this.heartbeatIntervalId = window.setInterval(updateHeartbeat, 1000);
    updateHeartbeat();
  }

  /** 尝试从错误中恢复 */
  private attemptRecovery() {
    log.info('尝试自动恢复...');

    // 重置错误状态
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });

    // 清除崩溃标记
    try {
      sessionStorage.removeItem('crash_error');
      sessionStorage.removeItem('crash_time');
      sessionStorage.removeItem('crash_details');
    } catch {
      // 忽略 sessionStorage 不可用的情况
    }
  }

  /** 手动重试 */
  handleRetry = () => {
    this.attemptRecovery();
  };

  /** 重新加载页面 */
  handleReload = () => {
    // 先保存当前状态
    this.saveCurrentState();
    window.location.reload();
  };

  /** 保存当前状态用于恢复 */
  private saveCurrentState() {
    try {
      // 触发一个事件让其他组件保存状态
      window.dispatchEvent(new CustomEvent('app:crash-save'));
    } catch {
      // 忽略 dispatch 失败的情况
    }
  }

  render() {
    if (this.state.hasError) {
      // 自定义错误 UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="fixed inset-0 bg-background-base flex items-center justify-center z-50 p-4">
          <div className="max-w-md w-full bg-background-panel rounded-2xl shadow-xl p-8 text-center">
            {/* 错误图标 */}
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-danger-faint flex items-center justify-center">
              <svg className="w-8 h-8 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>

            {/* 标题 */}
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              应用遇到错误
            </h2>

            {/* 描述 */}
            <p className="text-text-secondary mb-6">
              正在自动恢复...如果没有响应，请点击下方按钮
            </p>

            {/* 错误信息（开发模式） */}
            {import.meta.env.DEV && this.state.error && (
              <details className="mb-6 text-left">
                <summary className="cursor-pointer text-xs text-text-tertiary mb-2">
                  错误详情
                </summary>
                <pre className="text-xs text-text-muted bg-background-surface rounded p-3 overflow-auto max-h-40">
                  {this.state.error.message}
                </pre>
              </details>
            )}

            {/* 按钮组 */}
            <div className="flex flex-col gap-3">
              <button
                onClick={this.handleRetry}
                className="w-full px-4 py-3 bg-primary hover:bg-primary-hover text-white rounded-xl font-medium transition-colors"
              >
                自动恢复中...
              </button>
              <button
                onClick={this.handleReload}
                className="w-full px-4 py-3 bg-background-surface hover:bg-background-hover border border-border rounded-xl font-medium transition-colors text-text-primary"
              >
                刷新页面
              </button>
            </div>

            {/* 提示 */}
            <p className="text-xs text-text-tertiary mt-6">
              您的聊天内容已自动保存
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * 检测是否白屏的 Hook
 */
export function useWhiteScreenDetection(enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;

    let checkCount = 0;
    const maxChecks = 3;

    // 每秒检查页面是否响应
    const checkInterval = setInterval(() => {
      const heartbeat = sessionStorage.getItem('heartbeat');
      const heartbeatTime = heartbeat ? parseInt(heartbeat, 10) : 0;
      const timeSinceHeartbeat = Date.now() - heartbeatTime;

      // 如果超过5秒没有心跳，可能卡死了
      if (timeSinceHeartbeat > 5000) {
        checkCount++;

        if (checkCount >= maxChecks) {
          console.warn('[WhiteScreenDetection] 检测到可能的白屏，尝试恢复');
          clearInterval(checkInterval);

          // 尝试触发恢复
          window.dispatchEvent(new CustomEvent('app:recover'));
        }
      } else {
        checkCount = 0;
      }
    }, 1000);

    return () => clearInterval(checkInterval);
  }, [enabled]);
}
