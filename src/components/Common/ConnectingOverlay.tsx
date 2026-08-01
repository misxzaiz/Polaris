/**
 * 连接中蒙板组件
 *
 * 连接中时显示增强动画（双圈 spinner + 动态文字轮播 + 消息条 + 进度条），
 * 失败/鉴权时保持原有功能 UI。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '@/stores';
import { Button, ClaudePathSelector } from './index';
import { isWindows } from '@/utils/path';
import { currentMode } from '@/services/transport';
import { createLogger } from '@/utils/logger';
import { getSelectedEngineHealth } from '@/utils/engineHealth';

const log = createLogger('ConnectingOverlay');

/** 连接中轮播的状态消息 */
const STATUS_MESSAGES = [
  { title: '正在连接 AI 引擎', detail: '正在检测引擎路径' },
  { title: '正在连接 AI 引擎', detail: '验证 CLI 版本' },
  { title: '正在连接 AI 引擎', detail: '加载配置文件' },
  { title: '正在连接 AI 引擎', detail: '引擎就绪' },
];

/** 连接中轮播的详情消息（纯文本，无 emoji） */
const CAROUSEL_MESSAGES = [
  '检测引擎 CLI 路径',
  '验证 CLI 版本兼容性',
  '加载应用配置文件',
  '扫描已安装插件',
  '同步工作区数据',
  '准备就绪',
];

export function ConnectingOverlay() {
  const { t } = useTranslation('common');
  const { config, healthStatus, connectionState, error, retryConnection, submitToken } = useConfigStore();
  const selectedEngine = getSelectedEngineHealth(config, healthStatus);
  const engineType = selectedEngine.engineId;
  const [showPathInput, setShowPathInput] = useState(false);
  const [tempPath, setTempPath] = useState(selectedEngine.cliPath);
  const [tokenInput, setTokenInput] = useState('');

  // 动态文字轮播状态
  const [statusIndex, setStatusIndex] = useState(0);
  const [carouselIndex, setCarouselIndex] = useState(0);

  // 前向进度条（只增不减）
  const [progress, setProgress] = useState(8);

  useEffect(() => {
    setTempPath(selectedEngine.cliPath);
  }, [selectedEngine.cliPath]);

  // 连接中时启动文字轮播
  const isConnecting = connectionState === 'connecting';
  const isFailed = connectionState === 'failed';
  const needsToken = connectionState === 'needsToken';

  useEffect(() => {
    if (!isConnecting) {
      setStatusIndex(0);
      setCarouselIndex(0);
      return;
    }

    const statusTimer = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_MESSAGES.length);
    }, 2000);

    const carouselTimer = setInterval(() => {
      setCarouselIndex((i) => (i + 1) % CAROUSEL_MESSAGES.length);
    }, 2200);

    // 前向进度条：每 800ms 推进，增量递减
    const progressTimer = setInterval(() => {
      setProgress((prev) => {
        const maxProgress = 95;
        const remaining = maxProgress - prev;
        if (remaining < 0.5) return prev;
        const step = Math.max(0.5, remaining * 0.12);
        return Math.min(maxProgress, prev + step);
      });
    }, 800);

    return () => {
      clearInterval(statusTimer);
      clearInterval(carouselTimer);
      clearInterval(progressTimer);
    };
  }, [isConnecting]);

  // Defense-in-depth: even if connectionState is 'failed', detect auth errors from the error message
  const isUnauthorizedError =
    currentMode === 'http' &&
    typeof error === 'string' &&
    /unauthorized|forbidden|401|403/i.test(error);
  const shouldShowTokenInput = needsToken || isUnauthorizedError;
  const shouldShowCliFailure = isFailed && !shouldShowTokenInput;

  log.info('Overlay state', {
    currentMode,
    connectionState,
    isConnecting,
    isFailed,
    needsToken,
    isUnauthorizedError,
    shouldShowTokenInput,
    shouldShowCliFailure,
    error: typeof error === 'string' ? error : error ? String(error) : null,
  });

  const handleRetry = async () => {
    // Always go through retryConnection — it handles both auth detection and CLI health check
    await retryConnection();
  };

  const handlePathSubmit = async () => {
    if (!tempPath.trim()) return;
    await retryConnection(tempPath.trim());
    setShowPathInput(false);
  };

  const handleTokenSubmit = async () => {
    if (!tokenInput.trim()) return;
    await submitToken(tokenInput.trim());
  };

  // ========== 连接中：增强动画 ==========
  if (isConnecting) {
    const currentStatus = STATUS_MESSAGES[statusIndex];

    return (
      <div className="fixed inset-0 bg-background-base flex items-center justify-center z-50">
        <div className="w-[360px] flex flex-col items-center gap-7">

          {/* 增强 spinner：双圈反向旋转 + 中心光晕 */}
          <div className="relative w-[72px] h-[72px]">
            {/* 背景圈 */}
            <div className="absolute inset-0 border-[3px] border-border-subtle rounded-full" />
            {/* 主旋转弧（蓝紫渐变） */}
            <div className="absolute inset-0 border-[3px] border-transparent border-t-primary border-r-accent-ai rounded-full"
              style={{ animation: 'polaris-spin 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite' }} />
            {/* 内圈反向旋转 */}
            <div className="absolute inset-[4px] border-[2px] border-transparent border-b-primary/30 border-l-accent-ai/30 rounded-full"
              style={{ animation: 'polaris-spin-rev 2s linear infinite' }} />
            {/* 中心光晕 */}
            <div className="absolute top-1/2 left-1/2 w-2 h-2 -mt-1 -ml-1 rounded-full bg-primary"
              style={{ animation: 'polaris-glow 1.5s ease-in-out infinite' }} />
          </div>

          {/* 动态标题 */}
          <div className="text-center">
            <h2 className="text-lg font-semibold text-text-primary min-h-[28px] transition-opacity duration-300">
              {currentStatus.title}
            </h2>
            <div className="flex items-center justify-center gap-1 mt-2 text-sm text-text-secondary min-h-[20px]">
              <span key={statusIndex} className="transition-opacity duration-300">{currentStatus.detail}</span>
              <span className="inline-flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-primary/60" style={{ animation: 'polaris-blink 1.2s infinite' }} />
                <span className="w-1 h-1 rounded-full bg-primary/60" style={{ animation: 'polaris-blink 1.2s infinite 0.2s' }} />
                <span className="w-1 h-1 rounded-full bg-primary/60" style={{ animation: 'polaris-blink 1.2s infinite 0.4s' }} />
              </span>
            </div>
          </div>

          {/* 消息条：淡入淡出切换，无滚动 */}
          <div className="w-full h-9 bg-background-surface/50 border border-border-subtle rounded-lg flex items-center justify-center">
            <span
              key={carouselIndex}
              className="text-xs text-text-muted transition-opacity duration-300"
            >
              · {CAROUSEL_MESSAGES[carouselIndex]}
            </span>
          </div>

          {/* 前向进度条：只增不减 */}
          <div className="w-full flex items-center gap-2">
            <div className="flex-1 h-[2px] bg-border-subtle rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-accent-ai"
                style={{ width: `${progress}%`, transition: 'width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)' }}
              />
            </div>
            <span className="text-[11px] text-text-muted flex-shrink-0">{t('connection.connectingHint')}</span>
          </div>
        </div>
      </div>
    );
  }

  // ========== 错误 / 鉴权状态：保持原有功能 UI ==========

  return (
    <div className="fixed inset-0 bg-background-base flex items-center justify-center z-50">
      <div className="text-center space-y-6">
        {/* 错误图标 */}
        <div className="flex items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-danger-faint flex items-center justify-center">
            <svg className="w-8 h-8 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
        </div>

        {/* 文字提示 */}
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-text-primary">
            {shouldShowTokenInput ? t('connection.tokenRequired') : t('connection.connectFailed')}
          </h2>
          <p className="text-sm text-text-secondary">
            {shouldShowTokenInput ? t('connection.tokenRequiredHint') : t('connection.connectFailedHintEngine', { name: selectedEngine.name })}
          </p>
        </div>

        {/* Token 输入界面 (Web 模式鉴权) */}
        {shouldShowTokenInput && currentMode === 'http' && (
          <div className="space-y-3 w-full max-w-sm px-4">
            <div className="bg-background-surface p-4 rounded-lg space-y-3">
              <p className="text-sm text-text-secondary">{t('connection.tokenPrompt')}</p>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleTokenSubmit(); }}
                placeholder={t('connection.tokenPlaceholder')}
                className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary"
                autoFocus
              />
            </div>
            <Button
              onClick={handleTokenSubmit}
              variant="primary"
              className="w-full"
              disabled={!tokenInput.trim()}
            >
              {t('connection.tokenSubmit')}
            </Button>
          </div>
        )}

        {/* CLI 诊断 — 仅桌面端 */}
        {currentMode !== 'http' && shouldShowCliFailure && (
          <div className="text-xs text-text-tertiary space-y-3 max-w-md px-4">
            <p className="text-danger font-medium">{error || t('connection.cliNotFoundEngine', { name: selectedEngine.name })}</p>
            {selectedEngine.cliPath && (
              <p>{t('connection.currentPath')} <code className="bg-background-surface px-1 py-0.5 rounded break-all">{selectedEngine.cliPath}</code></p>
            )}

            <div className="bg-background-surface p-3 rounded-lg space-y-2 overflow-x-auto">
              <p className="font-medium text-text-secondary">{t('connection.diagnosis')}</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>{t('connection.diagnosis1Engine', { name: selectedEngine.name })}</li>
                <li>{t('connection.diagnosis2')}</li>
                <li>{t('connection.diagnosis3', { command: selectedEngine.command })}</li>
                <li>{t('connection.diagnosis4')}</li>
              </ul>
            </div>

            <div className="bg-background-surface p-3 rounded-lg space-y-2 overflow-x-auto">
              <p className="font-medium text-text-secondary">{t('connection.solutions')}</p>
              <ol className="space-y-1 list-decimal list-inside">
                <li>{t('connection.solution1Engine', { name: selectedEngine.name })} <code className="px-1 py-0.5 rounded">{selectedEngine.command} --version</code></li>
                <li>{t('connection.solution2')} <code className="px-1 py-0.5 rounded">{isWindows ? `where ${selectedEngine.command}` : `which ${selectedEngine.command}`}</code></li>
                <li>{t('connection.solution4')} <code className="px-1 py-0.5 rounded break-all">{engineType === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @anthropic-ai/claude-code'}</code></li>
              </ol>
            </div>
          </div>
        )}

        {/* 重试按钮 */}
        {currentMode !== 'http' && shouldShowCliFailure && (
          <div className="space-y-3">
            {!showPathInput ? (
              <div className="space-y-2">
                <Button onClick={handleRetry} variant="primary" className="w-full">
                  {t('connection.retryDetection')}
                </Button>
                <Button onClick={() => setShowPathInput(true)} variant="ghost" className="w-full">
                  {t('connection.setCliPath', { name: selectedEngine.name })}
                </Button>
              </div>
            ) : (
              <div className="space-y-4 w-full max-w-md">
                <div className="bg-background-surface p-4 rounded-lg">
                  <p className="text-sm text-text-secondary mb-3">
                    {t('connection.pathSelectorHintEngine', { name: selectedEngine.name })}
                  </p>
                  <ClaudePathSelector
                    value={tempPath}
                    onChange={setTempPath}
                    engineType={engineType}
                    compact
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={handlePathSubmit} variant="primary" className="flex-1" disabled={!tempPath.trim()}>
                    {t('connection.saveAndRetry')}
                  </Button>
                  <Button onClick={() => { setShowPathInput(false); setTempPath(selectedEngine.cliPath); }} variant="ghost" className="flex-1">
                    {t('buttons.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}