/**
 * 连接中蒙板组件
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores';
import { Button, ClaudePathSelector } from './index';
import { isWindows } from '../../utils/path';
import { currentMode } from '../../services/transport';
import { createLogger } from '../../utils/logger';
import { getSelectedEngineHealth } from '../../utils/engineHealth';

const log = createLogger('ConnectingOverlay');

export function ConnectingOverlay() {
  const { t } = useTranslation('common');
  const { config, healthStatus, connectionState, error, retryConnection, submitToken } = useConfigStore();
  const selectedEngine = getSelectedEngineHealth(config, healthStatus);
  const engineType = selectedEngine.engineId;
  const [showPathInput, setShowPathInput] = useState(false);
  const [tempPath, setTempPath] = useState(selectedEngine.cliPath);
  const [tokenInput, setTokenInput] = useState('');

  useEffect(() => {
    setTempPath(selectedEngine.cliPath);
  }, [selectedEngine.cliPath]);

  const isConnecting = connectionState === 'connecting';
  const isFailed = connectionState === 'failed';
  const needsToken = connectionState === 'needsToken';

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

  return (
    <div className="fixed inset-0 bg-background-base flex items-center justify-center z-50">
      <div className="text-center space-y-6">
        {/* 加载动画或错误图标 */}
        <div className="flex items-center justify-center">
          {isConnecting ? (
            <div className="relative">
              {/* 外圈 */}
              <div className="w-16 h-16 border-4 border-border-subtle rounded-full" />
              {/* 内圈 - 旋转动画 */}
              <div className="absolute inset-0 w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : shouldShowTokenInput || shouldShowCliFailure ? (
            <div className="w-16 h-16 rounded-full bg-danger-faint flex items-center justify-center">
              <svg className="w-8 h-8 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
          ) : null}
        </div>

        {/* 文字提示 */}
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-text-primary">
            {isConnecting ? t('connection.connectingEngine', { name: selectedEngine.name }) : shouldShowTokenInput ? t('connection.tokenRequired') : shouldShowCliFailure ? t('connection.connectFailed') : ''}
          </h2>
          <p className="text-sm text-text-secondary">
            {isConnecting ? t('connection.connectingHint') : shouldShowTokenInput ? t('connection.tokenRequiredHint') : shouldShowCliFailure ? t('connection.connectFailedHintEngine', { name: selectedEngine.name }) : ''}
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

        {/* 连接状态详情 — CLI 诊断仅在桌面端显示，Web 端无法操作服务器 CLI */}
        {currentMode !== 'http' && selectedEngine.version ? (
          <p className="text-xs text-text-tertiary">
            {t('connection.detectedVersion', { version: selectedEngine.version })}
          </p>
        ) : currentMode !== 'http' && shouldShowCliFailure ? (
          <div className="text-xs text-text-tertiary space-y-3 max-w-md px-4">
            <p className="text-danger font-medium">{error || t('connection.cliNotFoundEngine', { name: selectedEngine.name })}</p>
            {selectedEngine.cliPath && (
              <p>{t('connection.currentPath')} <code className="bg-background-surface px-1 py-0.5 rounded break-all">{selectedEngine.cliPath}</code></p>
            )}

            {/* 详细诊断信息 */}
            <div className="bg-background-surface p-3 rounded-lg space-y-2 overflow-x-auto">
              <p className="font-medium text-text-secondary">{t('connection.diagnosis')}</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>{t('connection.diagnosis1Engine', { name: selectedEngine.name })}</li>
                <li>{t('connection.diagnosis2')}</li>
                <li>{t('connection.diagnosis3', { command: selectedEngine.command })}</li>
                <li>{t('connection.diagnosis4')}</li>
              </ul>
            </div>

            {/* 引导式帮助 */}
            <div className="bg-background-surface p-3 rounded-lg space-y-2 overflow-x-auto">
              <p className="font-medium text-text-secondary">{t('connection.solutions')}</p>
              <ol className="space-y-1 list-decimal list-inside">
                <li>{t('connection.solution1Engine', { name: selectedEngine.name })} <code className="px-1 py-0.5 rounded">{selectedEngine.command} --version</code></li>
                <li>{t('connection.solution2')} <code className="px-1 py-0.5 rounded">{isWindows ? `where ${selectedEngine.command}` : `which ${selectedEngine.command}`}</code></li>
                <li>{t('connection.solution4')} <code className="px-1 py-0.5 rounded break-all">{engineType === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @anthropic-ai/claude-code'}</code></li>
              </ol>
            </div>
          </div>
        ) : currentMode !== 'http' && !shouldShowTokenInput ? (
          <p className="text-xs text-text-tertiary">
            {t('connection.detectingEngine', { name: selectedEngine.name })}
          </p>
        ) : null}

        {/* 连接失败时的操作按钮 — 仅桌面端显示 CLI 路径设置 */}
        {currentMode !== 'http' && shouldShowCliFailure && (
          <div className="space-y-3">
            {!showPathInput ? (
              <div className="space-y-2">
                <Button
                  onClick={handleRetry}
                  variant="primary"
                  className="w-full"
                >
                  {t('connection.retryDetection')}
                </Button>
                <Button
                  onClick={() => setShowPathInput(true)}
                  variant="ghost"
                  className="w-full"
                >
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
                  <Button
                    onClick={handlePathSubmit}
                    variant="primary"
                    className="flex-1"
                    disabled={!tempPath.trim()}
                  >
                    {t('connection.saveAndRetry')}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowPathInput(false);
                      setTempPath(selectedEngine.cliPath);
                    }}
                    variant="ghost"
                    className="flex-1"
                  >
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
